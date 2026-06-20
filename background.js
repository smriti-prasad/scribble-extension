// This runs in the background, separate from any webpage.
// In later phases it'll help coordinate messages, but for now
// it just confirms the extension installed correctly.

console.log("Scribble background worker running.");

chrome.runtime.onInstalled.addListener(() => {
  console.log("Scribble extension installed.");
});
