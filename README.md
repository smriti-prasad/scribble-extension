# Scribble - Page Notes

A Chrome extension that lets you highlight text, attach notes, and draw freehand directly on any webpage — and have it all persist exactly where you left it, every time you revisit that page.

## What it does

- **Highlight text** - select/drag across any text on a page and it's instantly highlighted
- **Attach notes** - a small 📝 icon appears next to every highlight; click it to write a note tied to that exact spot
- **Freehand drawing** - toggle draw mode from the floating toolbar and sketch directly on top of the page, with an eraser, undo, and redo
- **Persistence** - highlights, notes, and drawings are saved per-URL using `chrome.storage.local`, so they're automatically restored the next time you open that page

Everything lives directly on the page itself — no sidebar, no separate app. It works on any site.

## Installation

1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions`
3. Toggle on **Developer mode** (top-right corner)
4. Click **Load unpacked** and select the project folder
5. Pin the extension via the puzzle-piece icon in your toolbar for easy access

## How to use

**Highlighting & notes**
- Click and drag across any text to highlight it
- Click the 📝 icon that appears right after the highlight to open a note box
- Type your note and hit **Save**
- Click the icon again anytime to reopen and edit the note
- Use **Remove highlight** inside the note popup to delete a highlight entirely

**Drawing**
- Click the ✏️ button in the floating toolbar (bottom-right of the page) to turn on draw mode
- Click and drag your mouse to draw freehand
- Use 🧽 to erase parts of your drawing
- Click ✏️ again to turn off draw mode and interact with the page normally

All annotations reload automatically the next time you visit the same URL.

## Notes & limitations

- Highlights are matched by exact text + surrounding context, so they should survive minor page changes but may not relocate correctly if a page's content changes significantly
- Drawings and undo/redo history are tied to the current browser session's canvas; the final drawing state is what gets saved
- Works on standard pages; some highly dynamic single-page apps may behave inconsistently

## Tech

Built with vanilla JavaScript, the Chrome Extensions Manifest V3 API, and `chrome.storage.local` for persistence. No external dependencies.
