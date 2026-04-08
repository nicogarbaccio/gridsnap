/**
 * GridSnap — Preview Page
 *
 * Fetches the stitched canvas + individual snaps from the background
 * and renders a preview with download buttons.
 */
"use strict";

const root = document.getElementById("content");

chrome.runtime.sendMessage({ action: "getPreviewData" }, (data) => {
  if (!data || !data.canvasDataUrl) {
    root.innerHTML = '<div class="loading">No preview data available. Run a capture session first.</div>';
    return;
  }
  render(data);
});

function render(data) {
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

    <div class="section-title">Assembled Canvas</div>
    <div class="canvas-preview">
      <img id="canvas-img" src="${data.canvasDataUrl}" alt="Assembled GridSnap canvas">
    </div>

    <div class="section-title">Individual Snaps</div>
    <div class="snaps-grid" id="snaps-grid"></div>
  `;

  // Download full canvas
  document.getElementById("btn-download-all").addEventListener("click", () => {
    downloadDataUrl(data.canvasDataUrl, `GridSnap_${ts}.png`);
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
}

function downloadDataUrl(dataUrl, filename) {
  chrome.runtime.sendMessage({
    action: "downloadImage",
    dataUrl: dataUrl,
    filename: filename
  });
}
