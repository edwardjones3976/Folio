// Service worker: only makes the toolbar button open Folio's side panel.
// It handles no messages, stores nothing and makes no network requests.

function openPanelOnActionClick(): void {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error: unknown) => {
    console.warn('Folio: could not set side panel behavior', error);
  });
}

chrome.runtime.onInstalled.addListener(openPanelOnActionClick);
chrome.runtime.onStartup.addListener(openPanelOnActionClick);
openPanelOnActionClick();
