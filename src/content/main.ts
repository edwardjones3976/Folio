// Content script for https://claude.ai/* (the only origin in the manifest).
//
// - Reads the enable setting first; when Folio is disabled it reads nothing from
//   the page and only answers that it is disabled.
// - Never reads cookies, storage of the page, form fields or the message composer.
// - Makes no network requests. It talks only to Folio's own side panel, over a
//   port the panel opens; it never messages a panel that is not open.
// - "Erase all Folio data" empties the in-memory index, including messages seen
//   earlier; it stays empty until the user re-indexes or the page path changes.
import { claudeAdapter } from '../adapters/claude.ts';
import { ERASE_INDEX, PING, PORT_NAME, isPanelRequest } from '../shared/protocol.ts';
import type { ContentPush, ContentReply, PanelRequest, PingReply } from '../shared/protocol.ts';
import { search } from '../shared/search.ts';
import { SETTINGS_KEY, parseSettings } from '../shared/storage.ts';
import { computeCoverage } from '../shared/coverage.ts';
import type { Resolution, Snapshot } from '../shared/types.ts';
import { LiveIndex } from './indexer.ts';
import { clearHighlights, jumpTo } from './navigate.ts';

const DEBOUNCE_MS = 250;
const MAX_WAIT_MS = 1000;

const index = new LiveIndex(claudeAdapter, document, location);
const ports = new Set<chrome.runtime.Port>();
/** False until the enable setting has been read; nothing is reported before that. */
let settingsLoaded = false;
let enabled = false;
let observer: MutationObserver | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let maxWaitTimer: ReturnType<typeof setTimeout> | undefined;
/** Page path at "Erase all Folio data"; while set, the index stays empty. */
let erasedPath: string | null = null;

const ERASED_NOTE = "Folio's index of this page was erased. Choose Re-index this page in the Folio panel to read it again.";
const ERASED_RESOLUTION: Resolution = { status: 'unresolved', reason: 'not-loaded', note: ERASED_NOTE };

/** True while the erase pause applies; it ends when the page moves to another path. */
function erased(): boolean {
  if (erasedPath !== null && erasedPath !== location.pathname) erasedPath = null;
  return erasedPath !== null;
}

/** The only way the index is (re)built from the page. */
function refreshIndex(): boolean {
  return enabled && !erased() && index.refresh();
}

function emptySnapshot(state: 'disabled' | 'erased', label: string): Snapshot {
  return {
    provider: 'claude.ai',
    state,
    conversation: null,
    messages: [],
    coverage: computeCoverage([], []),
    strategy: { id: 'none', label, stable: true },
    revision: -1,
  };
}

function currentSnapshot(): Snapshot {
  if (!enabled) return emptySnapshot('disabled', 'Folio is turned off for claude.ai');
  return erased() ? emptySnapshot('erased', 'Index erased') : index.snapshot();
}

function broadcast(): void {
  const message: ContentPush = { type: 'snapshot', snapshot: currentSnapshot() };
  for (const port of ports) {
    try {
      port.postMessage(message);
    } catch {
      ports.delete(port);
    }
  }
}

function runRefresh(): void {
  clearTimeout(debounceTimer);
  clearTimeout(maxWaitTimer);
  debounceTimer = undefined;
  maxWaitTimer = undefined;
  if (refreshIndex()) broadcast();
}

function scheduleRefresh(): void {
  if (!enabled) return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runRefresh, DEBOUNCE_MS);
  maxWaitTimer ??= setTimeout(runRefresh, MAX_WAIT_MS);
}

function enable(): void {
  if (enabled) return;
  enabled = true;
  refreshIndex();
  observer = new MutationObserver(scheduleRefresh);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['data-is-streaming', 'aria-busy'],
  });
  window.addEventListener('popstate', scheduleRefresh);
  broadcast();
}

function disable(): void {
  enabled = false;
  observer?.disconnect();
  observer = null;
  window.removeEventListener('popstate', scheduleRefresh);
  clearTimeout(debounceTimer);
  clearTimeout(maxWaitTimer);
  maxWaitTimer = undefined;
  index.clear();
  clearHighlights(document);
  broadcast();
}

/** "Erase all Folio data": forget everything indexed, including messages virtualization removed. */
function eraseIndex(): void {
  erasedPath = location.pathname;
  clearTimeout(debounceTimer);
  clearTimeout(maxWaitTimer);
  maxWaitTimer = undefined;
  index.clear();
  clearHighlights(document);
  broadcast();
}

function applySettings(raw: unknown): void {
  settingsLoaded = true;
  if (parseSettings(raw).enabled) enable();
  else disable();
}

function reply(port: chrome.runtime.Port, message: ContentReply | ContentPush): void {
  try {
    port.postMessage(message);
  } catch {
    ports.delete(port);
  }
}

function handle(port: chrome.runtime.Port, request: PanelRequest): void {
  const { requestId } = request;
  if (!settingsLoaded) {
    reply(port, { type: 'error', requestId, message: 'Folio is still starting in this tab. Try again in a moment.' });
    return;
  }
  if (!enabled) {
    reply(port, { type: 'error', requestId, message: 'Folio is turned off for claude.ai. Turn it on in Settings.' });
    return;
  }
  if (request.type === 'reindex') {
    erasedPath = null;
    index.clear();
    refreshIndex();
    broadcast();
    reply(port, { type: 'reindex', requestId });
    return;
  }
  if (refreshIndex()) broadcast();
  const isErased = erased();
  switch (request.type) {
    case 'jump': {
      if (isErased) {
        reply(port, { type: 'jump', requestId, result: { status: 'unresolved', note: ERASED_NOTE } });
        return;
      }
      const { resolution, message } = index.locate(request.anchor);
      // Only an exact or changed match navigates; ambiguous and unresolved targets are labelled instead.
      if (!message || (resolution.status !== 'exact' && resolution.status !== 'changed')) {
        const status = resolution.status === 'ambiguous' ? 'ambiguous' : 'unresolved';
        reply(port, { type: 'jump', requestId, result: { status, note: resolution.note ?? 'Not found.' } });
        return;
      }
      const outcome = jumpTo(document, message, {
        headingIndex: request.anchor.headingIndex,
        headingText: request.anchor.headingText,
        highlightTerm: request.highlightTerm,
      });
      const notes = [resolution.note, outcome.headingFallback ? 'The saved heading was not found; showing the start of the message.' : '']
        .filter(Boolean)
        .join(' ');
      reply(port, {
        type: 'jump',
        requestId,
        result: {
          status: resolution.status === 'changed' ? 'jumped-changed' : 'jumped',
          note: notes,
          ...(outcome.headingFallback ? { headingFallback: true } : {}),
        },
      });
      return;
    }
    case 'search': {
      const result = search(index.searchDocs(), String(request.query));
      const notLoaded = result.searchedNotLoaded > 0 ? ` and ${result.searchedNotLoaded} seen earlier but no longer loaded` : '';
      const coverage = isErased
        ? `Nothing was searched. ${ERASED_NOTE}`
        : `Searched ${result.searchedLoaded} messages loaded in this page${notLoaded}. ` +
          'Not searched: messages claude.ai has not loaded, other branch versions, images, files and artifacts.';
      reply(port, { type: 'search', requestId, result, coverage });
      return;
    }
    case 'anchor-for':
      reply(port, { type: 'anchor-for', requestId, anchor: index.anchorFor(request.key, request.headingIndex) });
      return;
    case 'resolve':
      reply(port, {
        type: 'resolve',
        requestId,
        results: request.anchors.slice(0, 500).map((anchor) => (isErased ? ERASED_RESOLUTION : index.locate(anchor).resolution)),
      });
      return;
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME || port.sender?.id !== chrome.runtime.id) return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener((message: unknown) => {
    if (!isPanelRequest(message)) return;
    try {
      handle(port, message);
    } catch (error) {
      reply(port, { type: 'error', requestId: message.requestId, message: `Folio could not complete the request: ${String(error)}` });
    }
  });
  // Before settings load, applySettings() will broadcast the first snapshot.
  if (!settingsLoaded) return;
  if (refreshIndex()) broadcast();
  else reply(port, { type: 'snapshot', snapshot: currentSnapshot() });
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return undefined;
  const type = (message as { type?: unknown } | null)?.type;
  if (type === ERASE_INDEX) {
    eraseIndex();
    sendResponse({ ok: true });
    return undefined;
  }
  if (type !== PING) return undefined;
  const state = settingsLoaded ? currentSnapshot().state : 'starting';
  const response: PingReply = { ok: true, provider: 'claude.ai', url: location.href, state };
  sendResponse(response);
  return undefined;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && SETTINGS_KEY in changes) applySettings(changes[SETTINGS_KEY]?.newValue);
});

chrome.storage.local.get(SETTINGS_KEY).then(
  (data) => applySettings(data[SETTINGS_KEY]),
  () => applySettings(undefined),
);
