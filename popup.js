/**
 * GridSnap — Popup Script
 */
"use strict";

// ── Tab switching ────────────────────────────────────────────────────────────
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
  });
});

// ── DOM handles ──────────────────────────────────────────────────────────────
const btnStart = document.getElementById("btn-start");
const btnStop = document.getElementById("btn-stop");
const statusEl = document.getElementById("status");
const advancedToggle = document.getElementById("advancedToggle");
const advancedPanel = document.getElementById("advancedPanel");

const maxHeightInput = document.getElementById("maxHeight");
const columnGapInput = document.getElementById("columnGap");
const exportFormatSelect = document.getElementById("exportFormat");
const matchSensitivityInput = document.getElementById("matchSensitivity");

// ── Load saved settings ──────────────────────────────────────────────────────
chrome.storage.local.get({
  maxColumnHeight: 2000,
  columnGap: 20,
  exportFormat: "png",
  matchSensitivity: 0.92,
  advancedOpen: false
}, (result) => {
  maxHeightInput.value = result.maxColumnHeight;
  columnGapInput.value = result.columnGap;
  exportFormatSelect.value = result.exportFormat;
  matchSensitivityInput.value = result.matchSensitivity;

  if (result.advancedOpen) {
    advancedToggle.classList.add("open");
    advancedPanel.classList.add("open");
  }
});

// ── Advanced toggle ──────────────────────────────────────────────────────────
advancedToggle.addEventListener("click", () => {
  const isOpen = advancedToggle.classList.toggle("open");
  advancedPanel.classList.toggle("open", isOpen);
  chrome.storage.local.set({ advancedOpen: isOpen });
});

// ── Save settings on change ──────────────────────────────────────────────────
maxHeightInput.addEventListener("change", () => {
  const val = Math.max(200, Math.min(20000, parseInt(maxHeightInput.value, 10) || 2000));
  maxHeightInput.value = val;
  chrome.storage.local.set({ maxColumnHeight: val });
});

columnGapInput.addEventListener("change", () => {
  const val = Math.max(0, Math.min(100, parseInt(columnGapInput.value, 10) || 20));
  columnGapInput.value = val;
  chrome.storage.local.set({ columnGap: val });
});

exportFormatSelect.addEventListener("change", () => {
  chrome.storage.local.set({ exportFormat: exportFormatSelect.value });
});

matchSensitivityInput.addEventListener("change", () => {
  const val = Math.max(0.70, Math.min(0.99, parseFloat(matchSensitivityInput.value) || 0.92));
  matchSensitivityInput.value = val;
  chrome.storage.local.set({ matchSensitivity: val });
});

// ── Start session ────────────────────────────────────────────────────────────
btnStart.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  // Guard against restricted pages (chrome://, edge://, about:, etc.)
  if (!tab.url || /^(chrome|edge|about|devtools):/.test(tab.url)) {
    statusEl.textContent = "Cannot capture on this page — open a regular website";
    return;
  }

  // Save all settings before starting
  await chrome.storage.local.set({
    maxColumnHeight: parseInt(maxHeightInput.value, 10) || 2000,
    columnGap: parseInt(columnGapInput.value, 10) || 20,
    exportFormat: exportFormatSelect.value,
    matchSensitivity: parseFloat(matchSensitivityInput.value) || 0.92
  });

  // Ensure content script is injected (handles pages loaded before extension install)
  try {
    await chrome.tabs.sendMessage(tab.id, { action: "ping" });
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"]
      });
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ["content.css"]
      });
    } catch (err) {
      statusEl.textContent = "Cannot inject into this page";
      return;
    }
  }

  // Route through background so it initializes session state
  chrome.runtime.sendMessage({ action: "startSession", tabId: tab.id }, (resp) => {
    if (chrome.runtime.lastError) {
      statusEl.textContent = "Error: " + chrome.runtime.lastError.message;
      return;
    }
    btnStart.disabled = true;
    btnStop.style.display = "block";
    statusEl.textContent = "Draw a selection rectangle on the page";
    statusEl.classList.add("active");
    // Close popup so it doesn't interfere with the page
    setTimeout(() => window.close(), 300);
  });
});

// ── Stop session ─────────────────────────────────────────────────────────────
btnStop.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    chrome.tabs.sendMessage(tab.id, { action: "stopSession" });
    chrome.runtime.sendMessage({ action: "sessionCancelled" });
  }
  btnStart.disabled = false;
  btnStop.style.display = "none";
  statusEl.textContent = "Ready";
  statusEl.classList.remove("active");
});
