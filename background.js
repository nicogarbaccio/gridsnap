/**
 * GridSnap — Background Service Worker
 *
 * Coordinates the capture pipeline:
 *  1. Receives focus zone from content script
 *  2. Captures visible tab on each "snap" command
 *  3. Crops to focus zone
 *  4. Delegates stitching/grid-wrapping to the offscreen document
 *  5. Triggers download of the final assembled image
 */

"use strict";

// ── Session State ────────────────────────────────────────────────────────────
let session = null;

function resetSession() {
  session = {
    tabId: null,
    focusZone: null,       // {x, y, w, h} in CSS px
    devicePixelRatio: 1,
    snaps: [],             // Array of {dataUrl, columnIndex}
    currentColumn: 0,
    maxColumnHeight: 10000,
    columnGap: 20,
    exportFormat: "png",
    matchSensitivity: 0.92,
    forceNewColumn: false
  };
}

// ── Settings ─────────────────────────────────────────────────────────────────
async function loadSettings() {
  return await chrome.storage.local.get({
    maxColumnHeight: 10000,
    columnGap: 20,
    exportFormat: "png",
    matchSensitivity: 0.92
  });
}

// ── Message Router ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // tabId comes from the content script's sender, or explicitly from the popup
  const tabId = sender.tab?.id || msg.tabId;

  switch (msg.action) {
    case "startSession":
      handleStartSession(tabId, sendResponse);
      return true;

    case "setFocusZone":
      if (session) {
        session.focusZone = msg.zone;
        session.devicePixelRatio = msg.devicePixelRatio || 1;
      }
      sendResponse({ ok: true });
      break;

    case "snap":
      handleSnap(tabId);
      break;

    case "columnBreak":
      if (session) {
        session.forceNewColumn = true;
      }
      sendResponse({ ok: true });
      break;

    case "finish":
      handleFinish(tabId);
      break;

    case "sessionCancelled":
      resetSession();
      break;

    case "getSessionState":
      sendResponse({ active: session !== null && session.tabId !== null });
      break;

    case "getPreviewData":
      sendResponse(previewData);
      break;

    case "downloadImage": {
      const ts = previewData?.timestamp || "export";
      const ext = previewData?.exportFormat || "png";
      const name = msg.filename || `GridSnap_${ts}.${ext}`;
      chrome.downloads.download({ url: msg.dataUrl, filename: name, saveAs: true });
      break;
    }

    // Messages from offscreen document
    case "stitchResult":
      handleStitchResult(msg);
      break;
  }
  return false;
});

// ── Start Session ────────────────────────────────────────────────────────────
async function handleStartSession(tabId, sendResponse) {
  resetSession();
  const settings = await loadSettings();
  session.maxColumnHeight = settings.maxColumnHeight;
  session.columnGap = settings.columnGap;
  session.exportFormat = settings.exportFormat;
  session.matchSensitivity = settings.matchSensitivity;
  session.tabId = tabId;

  // Tell content script to show selection UI
  chrome.tabs.sendMessage(tabId, { action: "startSession" }, () => {
    sendResponse({ ok: true });
  });
}

// ── Snap ─────────────────────────────────────────────────────────────────────
async function handleSnap(tabId) {
  if (!session || !session.focusZone) return;

  try {
    // Capture the entire visible tab
    const dataUrl = await chrome.tabs.captureVisibleTab(null, {
      format: "png"
    });

    // Crop to focus zone using offscreen document
    const croppedDataUrl = await cropImage(dataUrl, session.focusZone, session.devicePixelRatio);

    // Determine column assignment
    if (session.forceNewColumn) {
      session.currentColumn++;
      session.forceNewColumn = false;
    }

    session.snaps.push({
      dataUrl: croppedDataUrl,
      columnIndex: session.currentColumn
    });

    // Notify content script
    chrome.tabs.sendMessage(tabId, {
      action: "snapResult",
      ok: true,
      snapCount: session.snaps.length,
      columnCount: session.currentColumn + 1
    });
  } catch (err) {
    console.error("GridSnap snap error:", err);
    chrome.tabs.sendMessage(tabId, {
      action: "snapResult",
      ok: false,
      error: err.message
    });
  }
}

// ── Crop using OffscreenCanvas in the service worker ─────────────────────────
async function cropImage(dataUrl, zone, dpr) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);

  // Scale zone to device pixels
  const sx = Math.round(zone.x * dpr);
  const sy = Math.round(zone.y * dpr);
  const sw = Math.round(zone.w * dpr);
  const sh = Math.round(zone.h * dpr);

  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  bitmap.close();

  const outBlob = await canvas.convertToBlob({ type: "image/png" });
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.readAsDataURL(outBlob);
  });
}

// ── Finish & Export ──────────────────────────────────────────────────────────
async function handleFinish(tabId) {
  if (!session || session.snaps.length === 0) {
    chrome.tabs.sendMessage(tabId, {
      action: "exportResult",
      ok: false,
      error: "No snaps captured"
    });
    return;
  }

  try {
    // Ensure offscreen document exists for stitching
    await ensureOffscreen();

    // Send all snaps to offscreen doc for stitching
    chrome.runtime.sendMessage({
      action: "stitch",
      snaps: session.snaps,
      maxColumnHeight: session.maxColumnHeight,
      columnGap: session.columnGap,
      exportFormat: session.exportFormat,
      matchSensitivity: session.matchSensitivity,
      focusZoneWidth: Math.round(session.focusZone.w * session.devicePixelRatio),
      focusZoneHeight: Math.round(session.focusZone.h * session.devicePixelRatio),
      devicePixelRatio: session.devicePixelRatio
    });

    // Result handled in handleStitchResult
  } catch (err) {
    console.error("GridSnap finish error:", err);
    chrome.tabs.sendMessage(tabId, {
      action: "exportResult",
      ok: false,
      error: err.message
    });
  }
}

// Preview data stored in memory for the preview page to retrieve
let previewData = null;

async function handleStitchResult(msg) {
  if (!session) return;
  const tabId = session.tabId;

  if (msg.ok) {
    try {
      // Store preview data: full canvas + individual snaps
      const ext = session.exportFormat || "png";
      previewData = {
        canvasDataUrl: msg.dataUrl,
        snaps: session.snaps.map((snap, i) => ({
          dataUrl: snap.dataUrl,
          columnIndex: snap.columnIndex,
          index: i
        })),
        exportFormat: ext,
        timestamp: new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
      };

      // Open preview page in a new tab
      await chrome.tabs.create({
        url: chrome.runtime.getURL("preview.html")
      });

      chrome.tabs.sendMessage(tabId, { action: "exportResult", ok: true });
    } catch (err) {
      chrome.tabs.sendMessage(tabId, {
        action: "exportResult",
        ok: false,
        error: err.message
      });
    }
  } else {
    chrome.tabs.sendMessage(tabId, {
      action: "exportResult",
      ok: false,
      error: msg.error
    });
  }

  // Cleanup offscreen document
  try {
    await chrome.offscreen.closeDocument();
  } catch (_) { /* may already be closed */ }

  resetSession();
}

// ── Offscreen Document Management ────────────────────────────────────────────
async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"]
  });
  if (contexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS"],
      justification: "Image stitching and grid assembly for GridSnap"
    });
  }
}
