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
import type { JumpResult, Resolution, Snapshot } from '../shared/types.ts';
import { LiveIndex } from './indexer.ts';
import type { Located } from './indexer.ts';
import { clearHighlights, jumpTo } from './navigate.ts';
import type { JumpOptions } from './navigate.ts';

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
const PAGE_CHANGED = 'The page changed after this list was shown.';
const FOUND_AGAIN = 'The page changed after this list was shown; Folio found the same message again.';
const LIST_EXPIRED =
  'The page changed after this list was shown, and Folio no longer has that version of it. Choose the entry again from the updated list, or search again.';

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

/** Scrolls to and highlights a located message; only an exact or changed match navigates. */
function navigate(located: Located, options: JumpOptions): JumpResult {
  const { resolution, message } = located;
  if (!message || (resolution.status !== 'exact' && resolution.status !== 'changed')) {
    // Probable, ambiguous and unresolved targets are labelled instead.
    const status = resolution.status === 'probable' || resolution.status === 'ambiguous' ? resolution.status : 'unresolved';
    return { status, note: resolution.note ?? 'Not found.' };
  }
  const outcome = jumpTo(document, message, options);
  const note = [resolution.note, outcome.headingFallback ? 'The heading was not found; showing the start of the message.' : ''].filter(Boolean).join(' ');
  return {
    status: resolution.status === 'changed' ? 'jumped-changed' : 'jumped',
    note,
    ...(outcome.headingFallback ? { headingFallback: true } : {}),
  };
}

/**
 * Outline and search clicks: follows the entry the panel showed (LiveIndex.target),
 * by live identity while the list's version of the index is current, otherwise by
 * its anchor, as strictly as a bookmark. Only a page that still shows what the
 * index holds is followed; when the entry cannot be followed as it is, the index
 * is rebuilt from the page and the entry is asked for again.
 */
function go(request: Extract<PanelRequest, { type: 'go' }>): JumpResult {
  const { key, revision, headingIndex, highlightTerm } = request;
  if (typeof key !== 'string' || !Number.isInteger(revision)) return { status: 'unresolved', note: 'Invalid request.' };
  let target = index.target(key, revision);
  if (!target?.message) {
    if (refreshIndex()) broadcast();
    target = index.target(key, revision);
  }
  if (!target) return { status: 'unresolved', note: LIST_EXPIRED };
  const heading = headingIndex === undefined ? undefined : target.shown.headings[headingIndex];
  const result = navigate(target, {
    ...(heading ? { headingIndex: heading.index, headingText: heading.text } : {}),
    ...(highlightTerm ? { highlightTerm: String(highlightTerm) } : {}),
  });
  if (!target.stale) return result;
  const found = result.status === 'jumped' || result.status === 'jumped-changed';
  return { ...result, note: [found ? FOUND_AGAIN : PAGE_CHANGED, result.note].filter(Boolean).join(' ') };
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
  // Outline and search clicks and new bookmarks name a message as the panel showed
  // it, so they must not rebuild the index first; every other request reads the page now.
  if (request.type !== 'go' && request.type !== 'anchor-for' && refreshIndex()) broadcast();
  const isErased = erased();
  switch (request.type) {
    case 'jump': {
      // A stored bookmark: resolved by its anchor.
      const result = isErased
        ? { status: 'unresolved' as const, note: ERASED_NOTE }
        : navigate(index.locate(request.anchor), {
            headingIndex: request.anchor.headingIndex,
            headingText: request.anchor.headingText,
            highlightTerm: request.highlightTerm,
          });
      reply(port, { type: 'jump', requestId, result });
      return;
    }
    case 'go':
      reply(port, { type: 'jump', requestId, result: isErased ? { status: 'unresolved', note: ERASED_NOTE } : go(request) });
      return;
    case 'search': {
      const result = search(index.searchDocs(), String(request.query));
      const notLoaded = result.searchedNotLoaded > 0 ? ` and ${result.searchedNotLoaded} seen earlier but no longer loaded` : '';
      const coverage = isErased
        ? `Nothing was searched. ${ERASED_NOTE}`
        : `Searched ${result.searchedLoaded} messages loaded in this page${notLoaded}. ` +
          'Not searched: messages claude.ai has not loaded, other branch versions, images, files and artifacts.';
      reply(port, { type: 'search', requestId, result, coverage, revision: index.keepForSearch() });
      return;
    }
    case 'anchor-for': {
      const anchor = isErased || !Number.isInteger(request.revision) ? null : index.anchorFor(request.key, request.headingIndex, request.revision);
      reply(port, { type: 'anchor-for', requestId, anchor });
      return;
    }
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
