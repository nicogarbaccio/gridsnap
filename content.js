/**
 * GridSnap — Content Script
 *
 * Handles:
 *  1. Selection overlay UI (draw a bounding box for the "Focus Zone")
 *  2. HUD display showing session stats
 *  3. Hotkey listeners (S = snap, B = column break, Enter = finish)
 *  4. Communication with the background service worker
 */

(() => {
  "use strict";

  // ── State ──────────────────────────────────────────────────────────────────
  let active = false;
  let phase = "idle"; // idle | selecting | capturing
  let focusZone = null; // {x, y, w, h} in viewport px
  let snapCount = 0;
  let columnCount = 1;

  // Selection drag state
  let dragStart = null;

  // DOM handles
  let overlay = null;
  let selectionBox = null;
  let hud = null;
  let flash = null;

  // ── Bootstrap ──────────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.action) {
      case "startSession":
        startSession();
        sendResponse({ ok: true });
        break;
      case "stopSession":
        teardown();
        sendResponse({ ok: true });
        break;
      case "snapResult":
        onSnapResult(msg);
        break;
      case "exportResult":
        onExportResult(msg);
        break;
      case "ping":
        sendResponse({ ok: true });
        break;
    }
    return false;
  });

  // ── Session lifecycle ──────────────────────────────────────────────────────
  function startSession() {
    if (active) return;
    active = true;
    phase = "selecting";
    snapCount = 0;
    columnCount = 1;
    createOverlay();
  }

  function teardown() {
    active = false;
    phase = "idle";
    focusZone = null;
    snapCount = 0;
    columnCount = 1;
    removeOverlay();
  }

  // ── Overlay & Selection UI ─────────────────────────────────────────────────
  function createOverlay() {
    removeOverlay();

    overlay = document.createElement("div");
    overlay.id = "gridsnap-overlay";
    document.documentElement.appendChild(overlay);

    selectionBox = document.createElement("div");
    selectionBox.id = "gridsnap-selection";
    selectionBox.style.display = "none";
    document.documentElement.appendChild(selectionBox);

    flash = document.createElement("div");
    flash.id = "gridsnap-flash";
    flash.style.display = "none";
    document.documentElement.appendChild(flash);

    // mousedown on overlay to start drag
    overlay.addEventListener("mousedown", onMouseDown);
    // mousemove and mouseup on document so we never lose the drag,
    // even if the cursor leaves the overlay or viewport edge
    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("mouseup", onMouseUp, true);
    document.addEventListener("keydown", onKeyDown);
  }

  function removeOverlay() {
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("mouseup", onMouseUp, true);
    document.removeEventListener("keydown", onKeyDown);
    overlay?.remove();
    selectionBox?.remove();
    hud?.remove();
    flash?.remove();
    overlay = null;
    selectionBox = null;
    hud = null;
    flash = null;
  }

  // ── Mouse handlers (selection phase) ───────────────────────────────────────
  function onMouseDown(e) {
    if (phase !== "selecting") return;
    e.preventDefault();
    e.stopPropagation();

    // Reset any previous partial selection and start fresh
    dragStart = { x: e.clientX, y: e.clientY };
    selectionBox.style.display = "block";
    // Start with zero-size box at the click point
    selectionBox.style.left = e.clientX + "px";
    selectionBox.style.top = e.clientY + "px";
    selectionBox.style.width = "0px";
    selectionBox.style.height = "0px";
    selectionBox.dataset.dimensions = "";
  }

  function onMouseMove(e) {
    if (phase !== "selecting" || !dragStart) return;
    e.preventDefault();
    // Clamp coordinates to viewport so the box doesn't go offscreen
    const cx = Math.max(0, Math.min(e.clientX, window.innerWidth));
    const cy = Math.max(0, Math.min(e.clientY, window.innerHeight));
    updateSelectionBox(cx, cy);
  }

  function onMouseUp(e) {
    if (phase !== "selecting" || !dragStart) return;
    e.preventDefault();

    const cx = Math.max(0, Math.min(e.clientX, window.innerWidth));
    const cy = Math.max(0, Math.min(e.clientY, window.innerHeight));
    const rect = computeRect(dragStart.x, dragStart.y, cx, cy);
    dragStart = null;

    // Too small — treat as a click, not a drag. Keep overlay up so user can retry.
    if (rect.w < 20 || rect.h < 20) {
      selectionBox.style.display = "none";
      return;
    }

    focusZone = rect;
    phase = "capturing";

    // Remove the dark overlays — keep just the dashed border on the selection
    overlay.style.background = "none";
    overlay.style.pointerEvents = "none";
    selectionBox.style.boxShadow = "none";

    // Position flash element to match focus zone
    flash.style.display = "block";
    flash.style.left = focusZone.x + "px";
    flash.style.top = focusZone.y + "px";
    flash.style.width = focusZone.w + "px";
    flash.style.height = focusZone.h + "px";

    createHUD();
    updateHUD();

    // Notify background of the focus zone
    chrome.runtime.sendMessage({
      action: "setFocusZone",
      zone: focusZone,
      devicePixelRatio: window.devicePixelRatio
    });
  }

  function updateSelectionBox(cx, cy) {
    const rect = computeRect(dragStart.x, dragStart.y, cx, cy);
    selectionBox.style.left = rect.x + "px";
    selectionBox.style.top = rect.y + "px";
    selectionBox.style.width = rect.w + "px";
    selectionBox.style.height = rect.h + "px";
    selectionBox.dataset.dimensions = `${rect.w} × ${rect.h}`;
  }

  function computeRect(x1, y1, x2, y2) {
    return {
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      w: Math.abs(x2 - x1),
      h: Math.abs(y2 - y1)
    };
  }

  // ── HUD ────────────────────────────────────────────────────────────────────
  function createHUD() {
    hud?.remove();
    hud = document.createElement("div");
    hud.id = "gridsnap-hud";
    document.documentElement.appendChild(hud);
  }

  let hudStatus = "ready"; // "ready" | "capturing" | "processing"

  function updateHUD(statusOverride) {
    if (!hud) return;
    if (statusOverride) hudStatus = statusOverride;

    const statusConfig = {
      ready:      { label: "Ready", cssClass: "status-ready" },
      capturing:  { label: "Capturing…", cssClass: "status-capturing" },
      processing: { label: "Processing…", cssClass: "status-processing" }
    };
    const st = statusConfig[hudStatus] || statusConfig.ready;

    hud.innerHTML = `
      <div class="hud-title">GridSnap</div>
      <div class="hud-status ${st.cssClass}"><span class="status-dot"></span>${st.label}</div>
      <div class="hud-row"><span class="hud-key">Zone</span><span class="hud-val">${focusZone.w}×${focusZone.h}</span></div>
      <div class="hud-row"><span class="hud-key">Snaps</span><span class="hud-val">${snapCount}</span></div>
      <div class="hud-row"><span class="hud-key">Columns</span><span class="hud-val">${columnCount}</span></div>
      <hr class="hud-divider">
      <div class="hud-hotkeys">
        <kbd>S</kbd> Snap &nbsp; <kbd>B</kbd> Column Break &nbsp; <kbd>Enter</kbd> Finish
      </div>
    `;
  }

  // ── Hotkeys ────────────────────────────────────────────────────────────────
  function onKeyDown(e) {
    // Ignore if user is typing in an input
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) return;

    if (phase === "selecting" && e.key === "Escape") {
      teardown();
      chrome.runtime.sendMessage({ action: "sessionCancelled" });
      return;
    }

    if (phase !== "capturing") return;

    switch (e.key.toLowerCase()) {
      case "s":
        e.preventDefault();
        doSnap();
        break;
      case "b":
        e.preventDefault();
        doColumnBreak();
        break;
      case "enter":
        e.preventDefault();
        doFinish();
        break;
      case "escape":
        e.preventDefault();
        teardown();
        chrome.runtime.sendMessage({ action: "sessionCancelled" });
        break;
    }
  }

  // ── Actions ────────────────────────────────────────────────────────────────
  function doSnap() {
    updateHUD("capturing");

    // Flash effect
    flash.classList.add("active");
    setTimeout(() => flash.classList.remove("active"), 150);

    // Make the selection border invisible without hiding any elements —
    // avoids the visual flash that visibility:hidden causes.
    if (selectionBox) selectionBox.style.borderColor = "transparent";

    // Brief repaint window, then capture
    setTimeout(() => {
      chrome.runtime.sendMessage({ action: "snap" });
      if (selectionBox) selectionBox.style.borderColor = "";
      updateHUD("processing");
    }, 50);
  }

  function onSnapResult(msg) {
    if (msg.ok) {
      snapCount = msg.snapCount;
      columnCount = msg.columnCount;
    }
    updateHUD("ready");
  }

  function doColumnBreak() {
    chrome.runtime.sendMessage({ action: "columnBreak" });
    columnCount++;
    updateHUD();
  }

  function doFinish() {
    // Show a processing indicator
    if (hud) {
      hud.innerHTML = `<div class="hud-title">Processing...</div><div style="color:#bdc3c7;opacity:0.5;font-size:12px;">Stitching ${snapCount} snaps into grid</div>`;
    }
    chrome.runtime.sendMessage({ action: "finish" });
  }

  function onExportResult(msg) {
    if (msg.ok) {
      teardown();
    } else {
      if (hud) {
        hud.innerHTML = `<div class="hud-title" style="color:#c0392b;">Export Failed</div><div style="color:#bdc3c7;opacity:0.5;font-size:12px;">${msg.error}</div>`;
      }
      setTimeout(teardown, 3000);
    }
  }
})();
