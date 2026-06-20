// Runs inside every webpage. Handles text-selection highlighting, attached notes,
// and persisting/restoring both via chrome.storage.local.

console.log("Scribble content script loaded on:", window.location.href);

let highlightCount = 0;
let activeIcon = null; // the icon currently showing an open note box, if any

// The key all of this page's highlights are stored under.
// Using the full URL (including query string) means scribble.com/article?id=1
// and scribble.com/article?id=2 get separate sets of notes.
const STORAGE_KEY = window.location.href;

// Drawings are stored separately from highlights, under their own key, so a
// page's freehand scribble doesn't get mixed in with the highlights array.
const DRAWING_STORAGE_KEY = window.location.href + "::drawing";

// How many characters of surrounding text to save, so we can re-find the
// highlighted text reliably even if the page has minor changes on reload.
const CONTEXT_LENGTH = 40;

init();

async function init() {
  await restoreHighlights();
  createToolbar();
  createDrawingCanvas();
  await restoreDrawing();
}

// Listen for text selection finishing (mouse released after a drag)
document.addEventListener("mouseup", async (e) => {
  if (e.target.closest(".scribble-icon") || e.target.closest(".scribble-note-popup")) {
    return;
  }

  const selection = window.getSelection();
  const text = selection.toString().trim();

  if (!text || selection.isCollapsed) {
    return;
  }

  const range = selection.getRangeAt(0);
  const contextBefore = getContextBefore(range, CONTEXT_LENGTH);
  const contextAfter = getContextAfter(range, CONTEXT_LENGTH);

  const created = wrapSelectionInHighlight(range, text);
  selection.removeAllRanges();

  if (created) {
    // Await this fully before anything else can touch storage (e.g. a fast
    // click on the note icon + Save) — otherwise the note-save can race ahead
    // of this initial write and find no matching entry to attach itself to.
    await saveHighlight({
      id: created.highlightId,
      text,
      contextBefore,
      contextAfter,
      noteText: "",
    });
  }
});

/**
 * Wraps the given range's contents in highlight <mark> elements, then attaches
 * a note icon right after the last one. Returns { highlightId } on success, or
 * null if nothing could be wrapped.
 *
 * Handles both the simple case (selection entirely inside one element, e.g. one
 * <p>) and the harder case (selection crosses multiple elements, e.g. spans two
 * paragraphs, or includes part of a <strong>/<a> inline tag). In the multi-node
 * case we can't use range.surroundContents() directly — it only works when the
 * range's start and end share a common parent — so instead we find every text
 * node the range touches and wrap each one individually. All the resulting
 * <mark> elements share the same data-scribble-id, so they're treated as one
 * logical highlight for removal/restoration purposes.
 */
function wrapSelectionInHighlight(range, selectedText, savedNoteText) {
  highlightCount++;
  const highlightId = "scribble-highlight-" + Date.now() + "-" + highlightCount;

  const marks = wrapRangeAcrossNodes(range, highlightId);

  if (marks.length === 0) {
    console.warn("Scribble: couldn't wrap this selection — no text nodes found in range.");
    return null;
  }

  const icon = createNoteIcon(highlightId, savedNoteText);
  marks[marks.length - 1].after(icon);

  if (savedNoteText) {
    icon.dataset.noteText = savedNoteText;
    icon.classList.add("scribble-icon-filled");
  }

  return { highlightId };
}

/**
 * Wraps every text node intersected by `range` in its own <mark>, trimming
 * partial nodes at the boundaries so only the actually-selected characters
 * get wrapped. Returns the array of <mark> elements created, in document order.
 */
function wrapRangeAcrossNodes(range, highlightId) {
  // Fast path: if the range fits inside one parent, surroundContents works
  // fine and is simpler/cheaper than the manual walk below.
  try {
    const mark = document.createElement("mark");
    mark.className = "scribble-highlight";
    mark.dataset.scribbleId = highlightId;
    const clonedRange = range.cloneRange();
    clonedRange.surroundContents(mark);
    return [mark];
  } catch (err) {
    // Range spans multiple elements — fall through to the manual approach.
  }

  const textNodes = getTextNodesInRange(range);
  const marks = [];

  // Process in reverse so wrapping earlier nodes doesn't invalidate the
  // DOM positions/offsets we already computed for later ones.
  for (let i = textNodes.length - 1; i >= 0; i--) {
    const { node, startOffset, endOffset } = textNodes[i];
    if (startOffset >= endOffset) continue; // nothing to wrap on this node

    const nodeRange = document.createRange();
    nodeRange.setStart(node, startOffset);
    nodeRange.setEnd(node, endOffset);

    const mark = document.createElement("mark");
    mark.className = "scribble-highlight";
    mark.dataset.scribbleId = highlightId;

    try {
      nodeRange.surroundContents(mark);
      marks.unshift(mark); // keep document order since we're iterating backwards
    } catch (err) {
      console.warn("Scribble: skipped a text node it couldn't wrap.", err);
    }
  }

  return marks;
}

/**
 * Finds every text node that intersects `range`, along with the portion of
 * each node (start/end character offsets) that's actually inside the range.
 */
function getTextNodesInRange(range) {
  const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  const results = [];
  let node;
  while ((node = walker.nextNode())) {
    let startOffset = 0;
    let endOffset = node.textContent.length;

    if (node === range.startContainer) {
      startOffset = range.startOffset;
    }
    if (node === range.endContainer) {
      endOffset = range.endOffset;
    }

    results.push({ node, startOffset, endOffset });
  }

  return results;
}

function createNoteIcon(highlightId, savedNoteText) {
  const icon = document.createElement("span");
  icon.className = "scribble-icon";
  icon.dataset.scribbleId = highlightId;
  icon.title = "Add a note";
  icon.textContent = "📝";

  icon.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleNotePopup(icon, highlightId, savedNoteText);
  });

  return icon;
}

function toggleNotePopup(icon, highlightId, existingText) {
  if (activeIcon && activeIcon !== icon) {
    closeActivePopup();
  }

  const existingPopup = icon.nextElementSibling?.classList?.contains("scribble-note-popup")
    ? icon.nextElementSibling
    : null;

  if (existingPopup) {
    closeActivePopup();
    return;
  }

  const popup = document.createElement("div");
  popup.className = "scribble-note-popup";

  const textarea = document.createElement("textarea");
  textarea.placeholder = "Type your note...";
  textarea.value = icon.dataset.noteText || existingText || "";

  const closeRow = document.createElement("div");
  closeRow.className = "scribble-note-popup-actions";

  const saveBtn = document.createElement("button");
  saveBtn.textContent = "Save";
  saveBtn.addEventListener("click", () => {
    icon.dataset.noteText = textarea.value;
    icon.classList.toggle("scribble-icon-filled", textarea.value.trim().length > 0);
    updateHighlightNoteText(highlightId, textarea.value);
    closeActivePopup();
  });

  const deleteBtn = document.createElement("button");
  deleteBtn.textContent = "Remove highlight";
  deleteBtn.className = "scribble-delete-btn";
  deleteBtn.addEventListener("click", () => {
    removeHighlight(highlightId);
  });

  closeRow.appendChild(saveBtn);
  closeRow.appendChild(deleteBtn);

  popup.appendChild(textarea);
  popup.appendChild(closeRow);

  icon.after(popup);
  textarea.focus();

  activeIcon = icon;
}

function closeActivePopup() {
  if (!activeIcon) return;
  const popup = activeIcon.nextElementSibling;
  if (popup && popup.classList.contains("scribble-note-popup")) {
    popup.remove();
  }
  activeIcon = null;
}

function removeHighlight(highlightId) {
  // A single logical highlight may be made of several <mark> elements if it
  // crossed multiple text nodes/elements — unwrap all of them.
  const marks = document.querySelectorAll(`mark.scribble-highlight[data-scribble-id="${highlightId}"]`);
  const icon = document.querySelector(`span.scribble-icon[data-scribble-id="${highlightId}"]`);

  closeActivePopup();

  marks.forEach((mark) => {
    const parent = mark.parentNode;
    while (mark.firstChild) {
      parent.insertBefore(mark.firstChild, mark);
    }
    parent.removeChild(mark);
    parent.normalize(); // merge adjacent text nodes back together
  });

  if (icon) icon.remove();

  deleteHighlightFromStorage(highlightId);
}

document.addEventListener("click", (e) => {
  if (e.target.closest(".scribble-icon") || e.target.closest(".scribble-note-popup")) {
    return;
  }
  closeActivePopup();
});

// ---------- Context capture (for re-finding text on reload) ----------

function getContextBefore(range, length) {
  const preRange = range.cloneRange();
  preRange.collapse(true); // collapse to start
  preRange.setStart(document.body, 0);
  const fullText = preRange.toString();
  return fullText.slice(Math.max(0, fullText.length - length));
}

function getContextAfter(range, length) {
  const postRange = range.cloneRange();
  postRange.collapse(false); // collapse to end
  postRange.setEnd(document.body, document.body.childNodes.length);
  const fullText = postRange.toString();
  return fullText.slice(0, length);
}

// ---------- Storage ----------
//
// chrome.storage.local.get + set is a read-modify-write — if two of these
// overlap (e.g. you highlight two spans in quick succession), the second
// write can stomp on the first because it read stale data before the first
// write landed. mutateHighlights() forces every read-modify-write through a
// single chain so they always run one at a time, in order.

let storageQueue = Promise.resolve();

function mutateHighlights(mutator) {
  storageQueue = storageQueue.then(async () => {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const highlights = result[STORAGE_KEY] || [];
    const updated = mutator(highlights) || highlights;
    await chrome.storage.local.set({ [STORAGE_KEY]: updated });
    return updated;
  });
  return storageQueue;
}

async function getStoredHighlights() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] || [];
}

async function saveHighlight(entry) {
  await mutateHighlights((highlights) => {
    highlights.push(entry);
  });
}

async function updateHighlightNoteText(highlightId, noteText) {
  await mutateHighlights((highlights) => {
    const match = highlights.find((h) => h.id === highlightId);
    if (match) {
      match.noteText = noteText;
    } else {
      console.error("Scribble: tried to save a note for a highlight not yet in storage:", highlightId);
    }
  });
}

async function deleteHighlightFromStorage(highlightId) {
  await mutateHighlights((highlights) => highlights.filter((h) => h.id !== highlightId));
}

// ---------- Restoring highlights on page load ----------

/**
 * Walks all text nodes in the page, looking for each saved highlight's text
 * (optionally confirmed by surrounding context), and re-wraps matches.
 */
async function restoreHighlights() {
  const highlights = await getStoredHighlights();
  if (highlights.length === 0) return;

  for (const entry of highlights) {
    const range = findRangeForText(entry.text, entry.contextBefore, entry.contextAfter);
    if (!range) {
      console.warn("Scribble: couldn't relocate highlight on reload:", entry.text.slice(0, 30));
      continue;
    }

    const marks = wrapRangeAcrossNodes(range, entry.id);
    if (marks.length === 0) {
      console.warn("Scribble: failed to re-wrap restored highlight.", entry.text.slice(0, 30));
      continue;
    }

    const icon = createNoteIcon(entry.id, entry.noteText);
    marks[marks.length - 1].after(icon);
    if (entry.noteText) {
      icon.dataset.noteText = entry.noteText;
      icon.classList.add("scribble-icon-filled");
    }
  }
}

/**
 * Searches all text nodes on the page for a match of `text`. If multiple
 * matches exist, prefers the one whose surrounding context matches best.
 * Returns a Range spanning the match, or null if not found.
 */
function findRangeForText(text, contextBefore, contextAfter) {
  const { fullText, nodeMap } = buildFlatTextMap(document.body);

  const candidates = [];
  let startIndex = fullText.indexOf(text);
  while (startIndex !== -1) {
    candidates.push(startIndex);
    startIndex = fullText.indexOf(text, startIndex + 1);
  }

  if (candidates.length === 0) return null;

  let bestIndex = candidates[0];

  if (candidates.length > 1) {
    // Multiple matches on the page (e.g. a common phrase) — disambiguate using
    // the saved context snippets, same as the single-match case but compared
    // directly against the flat text map instead of building real Ranges,
    // which is much cheaper when there are many candidates.
    let bestScore = -1;
    for (const idx of candidates) {
      const before = fullText.slice(Math.max(0, idx - contextBefore.length), idx);
      const after = fullText.slice(idx + text.length, idx + text.length + contextAfter.length);
      const score = (before === contextBefore ? 1 : 0) + (after === contextAfter ? 1 : 0);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = idx;
      }
    }
  }

  return buildRangeFromFlatOffsets(nodeMap, bestIndex, bestIndex + text.length);
}

/**
 * Concatenates all text-node content under `root` into one string, while
 * recording which (node, localOffset) each character of that string maps to.
 * This lets us search for a saved highlight's text as a single contiguous
 * string even when it was originally split across multiple DOM nodes/elements
 * (e.g. it crosses a <p> boundary, or wraps part of a <strong> tag).
 */
function buildFlatTextMap(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.parentElement?.closest(".scribble-icon, .scribble-note-popup")) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let fullText = "";
  const nodeMap = []; // one entry per text node: { node, start, end } in flat-text coordinates

  let node;
  while ((node = walker.nextNode())) {
    const content = node.textContent;
    if (content.length === 0) continue;
    nodeMap.push({ node, start: fullText.length, end: fullText.length + content.length });
    fullText += content;
  }

  return { fullText, nodeMap };
}

/**
 * Converts a [start, end) range expressed in flat-text coordinates (from
 * buildFlatTextMap) back into a real DOM Range, which may start in one text
 * node and end in a different one if the match crossed element boundaries.
 */
function buildRangeFromFlatOffsets(nodeMap, flatStart, flatEnd) {
  const startEntry = nodeMap.find((n) => flatStart >= n.start && flatStart < n.end);
  const endEntry = nodeMap.find((n) => flatEnd > n.start && flatEnd <= n.end);

  if (!startEntry || !endEntry) return null;

  const range = document.createRange();
  range.setStart(startEntry.node, flatStart - startEntry.start);
  range.setEnd(endEntry.node, flatEnd - endEntry.start);
  return range;
}

// ---------- Floating toolbar ----------

let drawModeOn = false;

/**
 * Injects a small floating toolbar (bottom-right corner) with a draw-mode
 * toggle and, once drawing is active, an eraser toggle. This sits alongside
 * the highlight/note feature — it doesn't replace or interfere with text
 * selection at all when draw mode is off.
 */
function createToolbar() {
  const toolbar = document.createElement("div");
  toolbar.id = "scribble-toolbar";

  const drawBtn = document.createElement("button");
  drawBtn.id = "scribble-draw-toggle";
  drawBtn.textContent = "✏️";
  drawBtn.title = "Toggle freehand drawing";

  drawBtn.addEventListener("click", () => {
    setDrawMode(!drawModeOn);
  });

  const eraseBtn = document.createElement("button");
  eraseBtn.id = "scribble-erase-toggle";
  eraseBtn.textContent = "🧽";
  eraseBtn.title = "Eraser";
  // Hidden until draw mode is on — erasing only makes sense while drawing
  eraseBtn.style.display = "none";

  eraseBtn.addEventListener("click", () => {
    setEraserMode(!isEraserMode);
  });

  toolbar.appendChild(drawBtn);
  toolbar.appendChild(eraseBtn);
  document.body.appendChild(toolbar);
}

function setEraserMode(on) {
  isEraserMode = on;
  applyDrawStyle();
  const eraseBtn = document.getElementById("scribble-erase-toggle");
  if (eraseBtn) {
    eraseBtn.classList.toggle("scribble-erase-active", on);
  }
}

function setDrawMode(on) {
  drawModeOn = on;
  const canvas = document.getElementById("scribble-canvas");
  const drawBtn = document.getElementById("scribble-draw-toggle");
  const eraseBtn = document.getElementById("scribble-erase-toggle");

  if (canvas) {
    canvas.style.pointerEvents = on ? "auto" : "none";
  }
  if (drawBtn) {
    drawBtn.classList.toggle("scribble-draw-active", on);
  }
  if (eraseBtn) {
    eraseBtn.style.display = on ? "flex" : "none";
  }
  if (!on) {
    // Don't carry eraser mode silently into the next time draw mode is turned on
    setEraserMode(false);
  }
}

// ---------- Drawing canvas ----------

let drawCtx = null;
let isDrawing = false;
let lastX = 0;
let lastY = 0;
let saveDrawingTimeout = null;
let strokeColor = "#e6433c";
let strokeWidth = 3;
let isEraserMode = false;

function applyDrawStyle() {
  if (!drawCtx) return;
  drawCtx.lineCap = "round";
  drawCtx.lineJoin = "round";
  if (isEraserMode) {
    drawCtx.globalCompositeOperation = "destination-out";
    drawCtx.lineWidth = strokeWidth * 4; // eraser feels better a bit chunkier
  } else {
    drawCtx.globalCompositeOperation = "source-over";
    drawCtx.strokeStyle = strokeColor;
    drawCtx.lineWidth = strokeWidth;
  }
}

/**
 * Creates a full-page canvas overlay used for freehand drawing. It's always
 * present in the DOM, but pointer-events are off by default so it doesn't
 * block clicks, text selection, or links on the underlying page unless draw
 * mode is explicitly turned on via the toolbar.
 */
function createDrawingCanvas() {
  const canvas = document.createElement("canvas");
  canvas.id = "scribble-canvas";
  canvas.style.pointerEvents = "none"; // off until draw mode is toggled on

  document.body.appendChild(canvas);
  drawCtx = canvas.getContext("2d");
  applyDrawStyle();

  // Size it now, then keep re-sizing as the page's actual content grows —
  // a one-time measurement at load time misses lazy-loaded images, infinite
  // scroll, and content that streams in after the content script runs, which
  // is exactly why drawing used to stop working partway down long pages.
  resizeCanvasPreservingContent();

  canvas.addEventListener("mousedown", startDrawing);
  canvas.addEventListener("mousemove", draw);
  canvas.addEventListener("mouseup", stopDrawing);
  canvas.addEventListener("mouseleave", stopDrawing);

  window.addEventListener("resize", resizeCanvasPreservingContent);

  // ResizeObserver catches the page growing taller even when the *window*
  // itself never resizes — e.g. a blog lazy-loading images, or content
  // streaming in below the fold as you scroll.
  const resizeObserver = new ResizeObserver(() => {
    resizeCanvasPreservingContent();
  });
  resizeObserver.observe(document.body);
}

function getCanvasPoint(e) {
  const canvas = document.getElementById("scribble-canvas");
  const rect = canvas.getBoundingClientRect();
  // The canvas is position:absolute, so it scrolls with the document and
  // getBoundingClientRect() already accounts for scroll position — adding
  // window.scrollY on top of that double-counts it and throws off every
  // stroke as soon as you've scrolled at all.
  return {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top,
  };
}

function startDrawing(e) {
  if (!drawModeOn) return;
  isDrawing = true;
  const point = getCanvasPoint(e);
  lastX = point.x;
  lastY = point.y;
}

function draw(e) {
  if (!isDrawing || !drawModeOn) return;
  const point = getCanvasPoint(e);

  drawCtx.beginPath();
  drawCtx.moveTo(lastX, lastY);
  drawCtx.lineTo(point.x, point.y);
  drawCtx.stroke();

  lastX = point.x;
  lastY = point.y;
}

function stopDrawing() {
  if (!isDrawing) return;
  isDrawing = false;
  scheduleDrawingSave();
}

/**
 * Debounces saving the canvas to storage — toDataURL on a large canvas isn't
 * free, so we wait a beat after the last stroke rather than saving on every
 * single mouseup.
 */
function scheduleDrawingSave() {
  clearTimeout(saveDrawingTimeout);
  saveDrawingTimeout = setTimeout(saveDrawing, 800);
}

async function saveDrawing() {
  const canvas = document.getElementById("scribble-canvas");
  if (!canvas) return;
  const dataUrl = canvas.toDataURL("image/png");
  await chrome.storage.local.set({ [DRAWING_STORAGE_KEY]: dataUrl });
}

async function restoreDrawing() {
  const result = await chrome.storage.local.get(DRAWING_STORAGE_KEY);
  const dataUrl = result[DRAWING_STORAGE_KEY];
  if (!dataUrl) return;

  const img = new Image();
  img.onload = () => {
    drawCtx.drawImage(img, 0, 0);
  };
  img.src = dataUrl;
}

/**
 * Resizes the canvas (e.g. on window resize, or the page growing taller as
 * content loads) while preserving whatever was already drawn, since naively
 * changing canvas.width/height clears it instantly.
 */
function resizeCanvasPreservingContent() {
  const canvas = document.getElementById("scribble-canvas");
  if (!canvas || !drawCtx) {
    // drawCtx isn't set up yet on the very first call from createDrawingCanvas()
    // — just size it directly, nothing to preserve.
    if (canvas) {
      canvas.width = window.innerWidth;
      canvas.height = document.documentElement.scrollHeight;
      applyDrawStyle();
    }
    return;
  }

  const isFirstSize = canvas.width === 0 && canvas.height === 0;
  const newWidth = window.innerWidth;
  const newHeight = document.documentElement.scrollHeight;

  if (isFirstSize) {
    canvas.width = newWidth;
    canvas.height = newHeight;
    applyDrawStyle();
    return;
  }

  // Avoid pointless work if nothing actually changed
  if (canvas.width === newWidth && canvas.height === newHeight) return;

  const snapshot = canvas.toDataURL("image/png");

  canvas.width = newWidth;
  canvas.height = newHeight;
  applyDrawStyle(); // resizing wipes lineCap/strokeStyle/etc back to defaults

  const img = new Image();
  img.onload = () => {
    drawCtx.drawImage(img, 0, 0);
  };
  img.src = snapshot;
}
