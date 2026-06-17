/**
 * GridSnap — Preview Page
 *
 * Fetches the stitched canvas + individual snaps from the background
 * and renders a preview with download buttons and a layout picker
 * for rearranging snaps into different grid configurations.
 */
"use strict";

const root = document.getElementById("content");

// Store data globally so layout changes can re-render
let previewData = null;
let currentLayout = "auto"; // "auto" | "1col" | "2col" | "3col" | "2x2" | "3x3" | "4x4" | "custom"
let customCols = 2;
let customRows = 2;

chrome.runtime.sendMessage({ action: "getPreviewData" }, (data) => {
  if (!data || !data.canvasDataUrl) {
    root.innerHTML = '<div class="loading">No preview data available. Run a capture session first.</div>';
    return;
  }
  previewData = data;
  render();
});

function render() {
  const data = previewData;
  const snapCount = data.snaps.length;
  const ts = data.timestamp;

  root.className = "";
  root.innerHTML = `
    <div class="toolbar">
      <h1>GridSnap Preview</h1>
      <span class="meta">${snapCount} snap${snapCount !== 1 ? "s" : ""} captured</span>
      <span class="spacer"></span>
      <button class="btn-primary" id="btn-download-all">Download Full Canvas</button>
    </div>

    <div class="download-options" id="download-options">
      <span class="download-options-label">Export Settings</span>
      <div class="download-options-row">
        <label>Format</label>
        <select id="dl-format">
          <option value="png">PNG (lossless, larger)</option>
          <option value="jpeg">JPEG (smaller)</option>
          <option value="webp">WebP (smallest)</option>
        </select>
      </div>
      <div class="download-options-row" id="quality-row">
        <label>Quality</label>
        <input type="range" id="dl-quality" min="10" max="100" step="5" value="80">
        <span id="dl-quality-val">80%</span>
      </div>
      <div class="download-options-row" id="scale-row">
        <label>Scale</label>
        <select id="dl-scale">
          <option value="1">100% (original)</option>
          <option value="0.75">75%</option>
          <option value="0.5">50%</option>
          <option value="0.25">25%</option>
        </select>
      </div>
      <div class="download-options-row">
        <span class="dl-estimate" id="dl-estimate">Estimating size…</span>
      </div>
    </div>

    <div class="layout-bar" id="layout-bar">
      <span class="layout-label">Layout</span>
      <button class="layout-btn ${currentLayout === "auto" ? "active" : ""}" data-layout="auto">Auto (Stitched)</button>
      <button class="layout-btn ${currentLayout === "1col" ? "active" : ""}" data-layout="1col">1 Column</button>
      <button class="layout-btn ${currentLayout === "2col" ? "active" : ""}" data-layout="2col">2 Columns</button>
      <button class="layout-btn ${currentLayout === "3col" ? "active" : ""}" data-layout="3col">3 Columns</button>
      <button class="layout-btn ${currentLayout === "2x2" ? "active" : ""}" data-layout="2x2">2×2</button>
      <button class="layout-btn ${currentLayout === "3x3" ? "active" : ""}" data-layout="3x3">3×3</button>
      <button class="layout-btn ${currentLayout === "4x4" ? "active" : ""}" data-layout="4x4">4×4</button>
      <div class="layout-custom">
        <input type="number" id="custom-cols" min="1" max="20" value="${customCols}" aria-label="Columns">
        <span class="layout-x">×</span>
        <input type="number" id="custom-rows" min="1" max="20" value="${customRows}" aria-label="Rows">
        <button class="btn-secondary" id="btn-custom-apply" data-layout="custom">Apply</button>
      </div>
    </div>

    <div class="section-title">Assembled Canvas</div>
    <div class="canvas-preview">
      <img id="canvas-img" src="" alt="Assembled GridSnap canvas">
    </div>

    <div class="section-title" style="display:flex;align-items:center;gap:12px;">
      <span>Individual Snaps</span>
      <button class="btn-secondary" id="btn-download-individual-all" style="font-size:11px;padding:4px 10px;">Download All as ZIP</button>
    </div>
    <div class="snaps-grid" id="snaps-grid"></div>
  `;

  // Bind layout buttons
  document.getElementById("layout-bar").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-layout]");
    if (!btn) return;

    const layout = btn.dataset.layout;

    if (layout === "custom") {
      customCols = Math.max(1, parseInt(document.getElementById("custom-cols").value, 10) || 2);
      customRows = Math.max(1, parseInt(document.getElementById("custom-rows").value, 10) || 2);
    }

    currentLayout = layout;
    updateCanvasImage().then(() => updateEstimate());
    // Update active state on buttons
    document.querySelectorAll(".layout-btn").forEach((b) => b.classList.remove("active"));
    if (layout !== "custom") {
      btn.classList.add("active");
    } else {
      // Remove active from all presets when custom is applied
      document.querySelectorAll(".layout-btn").forEach((b) => b.classList.remove("active"));
    }
  });

  // Download options panel
  const downloadOpts = document.getElementById("download-options");
  const qualityRow = document.getElementById("quality-row");
  const dlFormat = document.getElementById("dl-format");
  const dlQuality = document.getElementById("dl-quality");
  const dlQualityVal = document.getElementById("dl-quality-val");
  const dlScale = document.getElementById("dl-scale");
  const dlEstimate = document.getElementById("dl-estimate");

  dlFormat.addEventListener("change", () => {
    // Hide quality slider for PNG (lossless)
    qualityRow.style.display = dlFormat.value === "png" ? "none" : "flex";
    updateEstimate();
  });

  dlQuality.addEventListener("input", () => {
    dlQualityVal.textContent = dlQuality.value + "%";
    updateEstimate();
  });

  dlScale.addEventListener("change", () => {
    updateEstimate();
  });

  async function updateEstimate() {
    dlEstimate.textContent = "Estimating…";
    try {
      const blob = await getExportBlob();
      const sizeMB = (blob.size / (1024 * 1024)).toFixed(2);
      const sizeKB = (blob.size / 1024).toFixed(0);
      dlEstimate.textContent = blob.size > 1024 * 1024
        ? `≈ ${sizeMB} MB`
        : `≈ ${sizeKB} KB`;
    } catch {
      dlEstimate.textContent = "Unable to estimate";
    }
  }

  /**
   * Creates an export blob from the current canvas image with the selected
   * format, quality, and scale settings.
   */
  async function getExportBlob() {
    const img = document.getElementById("canvas-img");
    const format = dlFormat.value;
    const quality = parseInt(dlQuality.value, 10) / 100;
    const scale = parseFloat(dlScale.value);

    // Load the current canvas image into a bitmap
    const resp = await fetch(img.src);
    const srcBlob = await resp.blob();
    const bitmap = await createImageBitmap(srcBlob);

    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");

    if (format === "jpeg") {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
    }

    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();

    const mimeType = format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png";
    return new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(blob), mimeType, format === "png" ? undefined : quality);
    });
  }

  // Download full canvas with compression settings
  document.getElementById("btn-download-all").addEventListener("click", async () => {
    const btn = document.getElementById("btn-download-all");
    btn.disabled = true;
    btn.textContent = "Exporting…";

    try {
      const format = dlFormat.value;
      const ext = format === "jpeg" ? "jpg" : format;
      const blob = await getExportBlob();
      downloadBlob(blob, `GridSnap_${ts}.${ext}`);
    } catch (err) {
      console.error("Export failed:", err);
    }

    btn.disabled = false;
    btn.textContent = "Download Full Canvas";
  });

  // Render individual snap cards
  const grid = document.getElementById("snaps-grid");
  data.snaps.forEach((snap, i) => {
    const card = document.createElement("div");
    card.className = "snap-card";
    card.innerHTML = `
      <img class="snap-img" src="${snap.dataUrl}" alt="Snap ${i + 1}">
      <div class="snap-footer">
        <span class="snap-label">#${i + 1} <span>col ${snap.columnIndex + 1}</span></span>
        <button class="btn-secondary snap-dl" data-index="${i}">Download</button>
      </div>
    `;
    grid.appendChild(card);
  });

  // Individual download buttons
  grid.addEventListener("click", (e) => {
    const btn = e.target.closest(".snap-dl");
    if (!btn) return;
    const idx = parseInt(btn.dataset.index, 10);
    const snap = data.snaps[idx];
    downloadDataUrl(snap.dataUrl, `GridSnap_${ts}_snap${idx + 1}.png`);
  });

  // Download all individual snaps as a single ZIP
  document.getElementById("btn-download-individual-all").addEventListener("click", async () => {
    const btn = document.getElementById("btn-download-individual-all");
    btn.disabled = true;
    btn.textContent = "Zipping…";

    try {
      const zip = new JSZip();

      for (let i = 0; i < data.snaps.length; i++) {
        const snap = data.snaps[i];
        // Convert data URL to binary
        const base64 = snap.dataUrl.split(",")[1];
        zip.file(`GridSnap_${ts}_snap${i + 1}.png`, base64, { base64: true });
      }

      const blob = await zip.generateAsync({ type: "blob" });
      downloadBlob(blob, `GridSnap_${ts}_snaps.zip`);
    } catch (err) {
      console.error("ZIP creation failed:", err);
    }

    btn.disabled = false;
    btn.textContent = "Download All as ZIP";
  });

  // Initial canvas render
  updateCanvasImage().then(() => updateEstimate());
}

/**
 * Updates the main canvas image based on the current layout selection.
 * "auto" uses the original stitched image from the background.
 * All other layouts reassemble from individual snaps.
 */
async function updateCanvasImage() {
  const img = document.getElementById("canvas-img");

  if (currentLayout === "auto") {
    img.src = previewData.canvasDataUrl;
    return;
  }

  const cols = getLayoutCols();
  const rows = getLayoutRows();
  const dataUrl = await reassemble(cols, rows);
  img.src = dataUrl;
}

/**
 * Returns the number of columns for the current layout.
 */
function getLayoutCols() {
  switch (currentLayout) {
    case "1col": return 1;
    case "2col": return 2;
    case "3col": return 3;
    case "2x2": return 2;
    case "3x3": return 3;
    case "4x4": return 4;
    case "custom": return customCols;
    default: return 1;
  }
}

/**
 * Returns the number of rows for the current layout.
 * For column-based and NxN layouts, rows expand to fit all snaps.
 * Only "custom" mode enforces a fixed row count (truncating extras).
 */
function getLayoutRows() {
  const snapCount = previewData.snaps.length;
  switch (currentLayout) {
    case "1col": return snapCount;
    case "2col": return Math.ceil(snapCount / 2);
    case "3col": return Math.ceil(snapCount / 3);
    case "2x2": return Math.ceil(snapCount / 2);
    case "3x3": return Math.ceil(snapCount / 3);
    case "4x4": return Math.ceil(snapCount / 4);
    case "custom": return customRows;
    default: return snapCount;
  }
}

/**
 * Reassembles individual snaps into a grid layout.
 * Snaps are placed left-to-right, top-to-bottom.
 * Each cell is sized to the max snap dimensions for uniform spacing.
 * Extra cells (if grid is larger than snap count) are left empty.
 */
async function reassemble(cols, rows) {
  const snaps = previewData.snaps;
  const gap = 20; // px gap between cells

  // Load all snap images as bitmaps
  const bitmaps = await Promise.all(
    snaps.map(async (snap) => {
      const resp = await fetch(snap.dataUrl);
      const blob = await resp.blob();
      return createImageBitmap(blob);
    })
  );

  // Find max cell dimensions (uniform grid)
  let cellW = 0;
  let cellH = 0;
  for (const bmp of bitmaps) {
    cellW = Math.max(cellW, bmp.width);
    cellH = Math.max(cellH, bmp.height);
  }

  // Canvas dimensions — only allocate rows actually used by snaps
  const count = Math.min(snaps.length, cols * rows);
  const actualRows = Math.ceil(count / cols);
  const totalW = cols * cellW + (cols - 1) * gap;
  const totalH = actualRows * cellH + (actualRows - 1) * gap;

  const canvas = document.createElement("canvas");
  canvas.width = totalW;
  canvas.height = totalH;
  const ctx = canvas.getContext("2d");

  // Transparent background
  ctx.clearRect(0, 0, totalW, totalH);

  // Place snaps in grid order (left-to-right, top-to-bottom)
  for (let i = 0; i < count; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = col * (cellW + gap);
    const y = row * (cellH + gap);

    // Center the snap within its cell
    const bmp = bitmaps[i];
    const offsetX = Math.floor((cellW - bmp.width) / 2);
    const offsetY = Math.floor((cellH - bmp.height) / 2);

    ctx.drawImage(bmp, x + offsetX, y + offsetY);
  }

  // Cleanup bitmaps
  bitmaps.forEach((bmp) => bmp.close());

  return canvas.toDataURL("image/png");
}

function downloadDataUrl(dataUrl, filename) {
  chrome.runtime.sendMessage({
    action: "downloadImage",
    dataUrl: dataUrl,
    filename: filename
  });
}

/**
 * Downloads a Blob directly from the preview page using an anchor element.
 * Used for ZIP files since blob URLs aren't accessible from the service worker.
 */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
