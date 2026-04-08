/**
 * GridSnap — Stitcher (runs in Offscreen Document)
 *
 * Core pipeline:
 *  1. Decode all snap images into ImageBitmaps
 *  2. For consecutive snaps in the same column, compute vertical overlap
 *     using normalized cross-correlation on a pixel strip
 *  3. Stack snaps vertically with overlap removed
 *  4. Apply grid-wrap: if a column exceeds MAX_COLUMN_HEIGHT, auto-break
 *  5. Assemble final multi-column canvas and export as PNG data URL
 */

"use strict";

// ── Constants ────────────────────────────────────────────────────────────────
const COLUMN_GAP = 20;           // px gap between columns
const CORRELATION_STRIP_H = 200; // height of strip to search for overlap
const CORRELATION_STEP = 1;      // pixel step when scanning offsets
const MIN_OVERLAP = 10;          // minimum overlap to consider valid
const CORRELATION_THRESHOLD = 0.92; // minimum NCC score to accept a match

// ── Message handler ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
  if (msg.action === "stitch") {
    processStitch(msg).then((result) => {
      chrome.runtime.sendMessage({ action: "stitchResult", ...result });
    });
    // Don't return true — we respond via a separate message, not sendResponse
  }
  return false;
});

// ── Main Pipeline ────────────────────────────────────────────────────────────
async function processStitch({
  snaps, maxColumnHeight, focusZoneWidth, focusZoneHeight,
  columnGap: columnGapIn, exportFormat: exportFormatIn, matchSensitivity: matchSensitivityIn
}) {
  // Use message values with fallbacks to module-level defaults
  const gap = columnGapIn ?? COLUMN_GAP;
  const sensitivity = matchSensitivityIn ?? CORRELATION_THRESHOLD;
  const format = exportFormatIn || "png";

  try {
    // 1. Decode all snaps to bitmaps
    const bitmaps = await Promise.all(
      snaps.map(async (snap) => {
        const resp = await fetch(snap.dataUrl);
        const blob = await resp.blob();
        return {
          bitmap: await createImageBitmap(blob),
          columnIndex: snap.columnIndex
        };
      })
    );

    // 2. Group snaps by column (user-assigned via columnBreak)
    const userColumns = groupByColumn(bitmaps);

    // 3. For each user-column, compute overlaps and stitch vertically,
    //    then apply grid-wrap to split into sub-columns if needed
    const allColumns = [];

    for (const colSnaps of userColumns) {
      const stitchedStrips = stitchColumnWithOverlap(colSnaps, sensitivity);
      const wrapped = gridWrap(stitchedStrips, maxColumnHeight);
      allColumns.push(...wrapped);
    }

    // 4. Assemble the multi-column grid
    if (allColumns.length === 0) {
      throw new Error("No columns to assemble");
    }

    const totalWidth = allColumns.reduce((sum, col) => sum + col.width, 0) +
      gap * (allColumns.length - 1);
    const maxHeight = Math.max(...allColumns.map((col) => col.height));

    const final = new OffscreenCanvas(totalWidth, maxHeight);
    const ctx = final.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, totalWidth, maxHeight);

    let x = 0;
    for (const col of allColumns) {
      ctx.drawImage(col.canvas, x, 0);
      x += col.width + gap;
    }

    // Clean up bitmaps
    bitmaps.forEach((b) => b.bitmap.close());

    // Convert to data URL using the chosen export format
    const mimeType = format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png";
    const blobOpts = { type: mimeType };
    if (mimeType === "image/jpeg") blobOpts.quality = 0.92;
    if (mimeType === "image/webp") blobOpts.quality = 0.90;

    let blob;
    try {
      blob = await final.convertToBlob(blobOpts);
    } catch {
      // Fallback to PNG if format not supported
      blob = await final.convertToBlob({ type: "image/png" });
    }
    const dataUrl = await blobToDataUrl(blob);

    return { ok: true, dataUrl };
  } catch (err) {
    console.error("GridSnap stitch error:", err);
    return { ok: false, error: err.message };
  }
}

// ── Group by Column ──────────────────────────────────────────────────────────
function groupByColumn(bitmaps) {
  const map = new Map();
  for (const b of bitmaps) {
    if (!map.has(b.columnIndex)) map.set(b.columnIndex, []);
    map.get(b.columnIndex).push(b.bitmap);
  }
  const sorted = [...map.entries()].sort((a, b) => a[0] - b[0]);
  return sorted.map(([, arr]) => arr);
}

// ── Vertical Stitching with Cross-Correlation Overlap Detection ──────────────
function stitchColumnWithOverlap(bitmapList, matchSensitivity) {
  if (bitmapList.length === 0) return [];

  let currentCanvas = bitmapToCanvas(bitmapList[0]);

  for (let i = 1; i < bitmapList.length; i++) {
    const nextCanvas = bitmapToCanvas(bitmapList[i]);
    const overlap = findOverlap(currentCanvas, nextCanvas, matchSensitivity);
    currentCanvas = verticalJoin(currentCanvas, nextCanvas, overlap);
  }

  return [currentCanvas];
}

/**
 * Find the vertical overlap between the bottom of `top` and the top of `bottom`
 * using normalized cross-correlation on a central horizontal strip.
 *
 * Strategy: take a thin strip from the bottom edge of the top image (the "template"),
 * then slide it down through the top portion of the bottom image. The offset with the
 * highest NCC score above the threshold is the overlap.
 */
function findOverlap(topCanvas, bottomCanvas, matchSensitivity) {
  const w = Math.min(topCanvas.width, bottomCanvas.width);
  const maxScan = Math.min(topCanvas.height, bottomCanvas.height, CORRELATION_STRIP_H);

  if (maxScan < MIN_OVERLAP) return 0;

  const topCtx = topCanvas.getContext("2d", { willReadFrequently: true });
  const botCtx = bottomCanvas.getContext("2d", { willReadFrequently: true });

  // Sample the center 50% of width for speed
  const sampleX = Math.floor(w * 0.25);
  const sampleW = Math.floor(w * 0.5);

  // Template: thin strip from the very bottom of the top image
  const stripH = Math.min(80, maxScan);
  const templateData = topCtx.getImageData(
    sampleX, topCanvas.height - stripH, sampleW, stripH
  ).data;

  let bestOffset = 0;
  let bestScore = -1;

  // Slide: for each candidate overlap amount, extract the corresponding
  // region from the bottom image and compare
  for (let offset = MIN_OVERLAP; offset <= maxScan; offset += CORRELATION_STEP) {
    const yInBottom = offset - stripH;
    if (yInBottom < 0) continue;

    const candidateData = botCtx.getImageData(
      sampleX, yInBottom, sampleW, stripH
    ).data;

    const score = normalizedCrossCorrelation(templateData, candidateData);

    if (score > bestScore) {
      bestScore = score;
      bestOffset = offset;
    }
  }

  const threshold = matchSensitivity ?? CORRELATION_THRESHOLD;
  return bestScore >= threshold ? bestOffset : 0;
}

/**
 * Normalized Cross-Correlation (NCC) on luminance channel.
 * Returns value in [-1, 1]; 1.0 = perfect match.
 */
function normalizedCrossCorrelation(dataA, dataB) {
  const n = dataA.length / 4;
  let sumA = 0, sumB = 0;

  for (let i = 0; i < n; i++) {
    const idx = i * 4;
    sumA += 0.299 * dataA[idx] + 0.587 * dataA[idx + 1] + 0.114 * dataA[idx + 2];
    sumB += 0.299 * dataB[idx] + 0.587 * dataB[idx + 1] + 0.114 * dataB[idx + 2];
  }

  const meanA = sumA / n;
  const meanB = sumB / n;

  let num = 0, denomA = 0, denomB = 0;

  for (let i = 0; i < n; i++) {
    const idx = i * 4;
    const dA = (0.299 * dataA[idx] + 0.587 * dataA[idx + 1] + 0.114 * dataA[idx + 2]) - meanA;
    const dB = (0.299 * dataB[idx] + 0.587 * dataB[idx + 1] + 0.114 * dataB[idx + 2]) - meanB;
    num += dA * dB;
    denomA += dA * dA;
    denomB += dB * dB;
  }

  const denom = Math.sqrt(denomA * denomB);
  return denom === 0 ? 0 : num / denom;
}

// ── Canvas Helpers ───────────────────────────────────────────────────────────
function bitmapToCanvas(bitmap) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  return canvas;
}

function verticalJoin(topCanvas, bottomCanvas, overlap) {
  const w = Math.max(topCanvas.width, bottomCanvas.width);
  const h = topCanvas.height + bottomCanvas.height - overlap;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(topCanvas, 0, 0);
  ctx.drawImage(bottomCanvas, 0, topCanvas.height - overlap);
  return canvas;
}

// ── Grid Wrap ────────────────────────────────────────────────────────────────
/**
 * Splits any stitched strip that exceeds maxColumnHeight into multiple
 * sub-columns. Returns array of {canvas, width, height}.
 */
function gridWrap(strips, maxColumnHeight) {
  const columns = [];

  for (const strip of strips) {
    if (strip.height <= maxColumnHeight) {
      columns.push({ canvas: strip, width: strip.width, height: strip.height });
      continue;
    }

    let y = 0;
    while (y < strip.height) {
      const sliceH = Math.min(maxColumnHeight, strip.height - y);
      const chunk = new OffscreenCanvas(strip.width, sliceH);
      const ctx = chunk.getContext("2d");
      ctx.drawImage(strip, 0, y, strip.width, sliceH, 0, 0, strip.width, sliceH);
      columns.push({ canvas: chunk, width: strip.width, height: sliceH });
      y += sliceH;
    }
  }

  return columns;
}

// ── Utility ──────────────────────────────────────────────────────────────────
function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}
