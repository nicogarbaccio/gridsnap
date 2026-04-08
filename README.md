# GridSnap

A Chrome extension for capturing, stitching, and exporting multi-screenshot documentation from any webpage. Built for QA engineers who need to document content rendered in Canvas elements, IFRAMEs, or other layouts that don't support native scrolling capture.

## What It Does

GridSnap lets you define a region on any webpage, take multiple screenshots as you scroll, and automatically assembles them into a single grid image. It handles overlapping content between snaps using pixel-matching, so you don't need to scroll with precision.

The final output is a multi-column image where screenshots are stacked vertically and wrap into new columns based on a configurable height limit — similar to how text flows in a newspaper layout.

## Installation

1. Download or clone this repository.
2. Open Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode** using the toggle in the top-right corner.
4. Click **Load unpacked**.
5. Select the `gridsnap` folder (the one containing `manifest.json`).
6. The GridSnap icon will appear in your Chrome toolbar. You may need to click the puzzle piece icon and pin it.

## How to Use

### 1. Start a Session

Navigate to the page you want to capture, then click the GridSnap icon in the toolbar and press **Start Capture Session**.

### 2. Draw a Focus Zone

Click and drag on the page to draw a rectangle around the area you want to capture. This is your "Focus Zone" — only this region will be included in each snap.

### 3. Snap Screenshots

Scroll the page to reveal new content, then press **S** to take a snap. Repeat as many times as needed. You don't need to scroll precisely — GridSnap detects overlapping areas and removes duplicates automatically.

For best results, leave about 10–30% overlap between each scroll.

### 4. Column Breaks (Optional)

Press **B** to start a new column in the output image. This is useful for separating logical sections — for example, capturing paytable screens in one column and game rules in another.

### 5. Finish and Export

Press **Enter** to finish. A preview tab opens showing:

- The full assembled grid image
- Each individual snap

You can download the entire grid or any individual snap from the preview page.

## Hotkeys

| Key | Action |
|-----|--------|
| **S** | Take a snap |
| **B** | Force a new column |
| **Enter** | Finish session and open preview |
| **Esc** | Cancel session |

## Advanced Settings

Click **Advanced Settings** in the popup to access:

| Setting | Default | Description |
|---------|---------|-------------|
| Max Column Height | 2000px | Snaps auto-wrap to a new column when the combined height exceeds this value |
| Column Gap | 20px | Horizontal spacing between columns in the output image |
| Export Format | PNG | Choose PNG (lossless), JPEG (smaller), or WebP (smallest) |
| Match Sensitivity | 0.92 | How strict the overlap detection is. Lower this if stitching misaligns |

## Limitations

- Cannot run on browser-internal pages (`chrome://`, `about://`, etc.)
- Captures the visible viewport only — the Focus Zone must be on screen when you press **S**
- Very fast animations within the Focus Zone may cause slight differences between snaps, which can affect overlap detection. Lower the Match Sensitivity setting if this happens.
