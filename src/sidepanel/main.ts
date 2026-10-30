// Side panel entry point. Renders from chrome.storage.local (settings and
// bookmarks, kept current with storage.onChanged) and from snapshots that the
// content script pushes over the port while this panel is open.
import { STATIC_FEATURES, pageFeatures } from '../shared/features.ts';
import type { Exchange } from '../shared/outline.ts';
import {
  BOOKMARKS_KEY,
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  addBookmark,
  conversationUrl,
  deleteBookmark,
  loadBookmarks,
  loadSettings,
  parseSettings,
  updateBookmark,
} from '../shared/storage.ts';
import type { Bookmark, Settings } from '../shared/storage.ts';
import type { JumpResult, MessageAnchor, MessageSummary, Snapshot } from '../shared/types.ts';
import { renderBookmarks } from './bookmarks-view.ts';
import type { BookmarkCheck } from './bookmarks-view.ts';
import { TabConnection, UNAVAILABLE_DETAIL } from './connection.ts';
import type { ConnectionState } from './connection.ts';
import { announce, arrowNavigation, byId, clear, h } from './dom.ts';
import { renderOutline } from './outline.ts';
import { renderSearchResults } from './search-view.ts';
import { applyAppearance, initSettings, renderFeatureTable, showSettings } from './settings-view.ts';

const area = chrome.storage.local;
const TABS = ['outline', 'search', 'bookmarks', 'settings'] as const;
type TabName = (typeof TABS)[number];
const PENDING_OPEN_MS = 20_000;
const PENDING_RETRY_MS = 8_000;

let settings: Settings = { ...DEFAULT_SETTINGS };
let connectionState: ConnectionState = { kind: 'connecting' };
let bookmarks: Bookmark[] = [];
let invalidBookmarks = 0;
let checks = new Map<string, BookmarkCheck>();
let editingBookmark: string | null = null;
let onlyCurrentConversation = true;
let pendingOpen: { bookmark: Bookmark; startedAt: number; busy: boolean } | null = null;
let checkTimer: ReturnType<typeof setTimeout> | undefined;

function snapshot(): Snapshot | null {
  return connectionState.kind === 'connected' ? connectionState.snapshot : null;
}

function readySnapshot(): Snapshot | null {
  const s = snapshot();
  return s && s.state === 'ready' ? s : null;
}

function report(message: string): void {
  byId('action-status').textContent = message;
  announce(message);
}

// --- Status ------------------------------------------------------------------

function pageStatus(): { text: string; state: string } {
  if (connectionState.kind === 'connecting') return { text: 'Connecting to the current tab…', state: 'connecting' };
  if (connectionState.kind === 'unavailable') return { text: connectionState.detail, state: 'unavailable' };
  const s = connectionState.snapshot;
  switch (s.state) {
    case 'disabled':
      return { text: 'Folio is turned off for claude.ai. Turn it on in Settings.', state: 'blocked' };
    case 'no-conversation':
      return { text: 'No conversation is open in this claude.ai tab. Open a chat to use the outline, search and bookmarks.', state: 'blocked' };
    case 'no-messages':
      return {
        text: 'No messages were recognized on this page. claude.ai may still be loading or may have changed its layout; Folio will not guess.',
        state: 'blocked',
      };
    case 'ready':
      return { text: s.coverage.statement, state: s.coverage.level === 'partial' || !s.strategy.stable ? 'partial' : 'ok' };
  }
}

function renderStatus(): void {
  const status = pageStatus();
  byId('status').dataset.state = status.state;
  byId('status-text').textContent = status.text;

  const s = snapshot();
  byId('conversation-title').textContent = s?.conversation ? s.conversation.title : '';

  const features = pageFeatures(s, connectionState.kind === 'unavailable' ? UNAVAILABLE_DETAIL : 'Not connected to a claude.ai tab yet.');
  const chips = byId('feature-chips');
  clear(chips);
  for (const feature of features) {
    chips.append(h('li', { 'data-feature': feature.id, 'data-status': feature.status, text: `${feature.name}: ${feature.status}` }));
  }
  renderFeatureTable([...features, ...STATIC_FEATURES]);

  const details = byId<HTMLDetailsElement>('coverage-details');
  const ready = readySnapshot();
  details.hidden = !ready;
  const signals = byId('coverage-signals');
  clear(signals);
  if (ready) {
    for (const signal of ready.coverage.signals) {
      signals.append(h('li', { 'data-code': signal.code, 'data-severity': signal.severity, text: signal.message }));
    }
    if (ready.coverage.signals.length === 0) signals.append(h('li', { text: 'No signs of missing content were detected in the loaded page.' }));
    byId('coverage-strategy').textContent = `Messages recognized by: ${ready.strategy.label}.`;
  }
}

// --- Jumping -----------------------------------------------------------------

function describeJump(result: JumpResult, description: string): string {
  if (result.status === 'jumped') return `Jumped to ${description}.${result.note ? ` ${result.note}` : ''}`;
  if (result.status === 'jumped-changed') return `Jumped to ${description}, but it has changed. ${result.note}`;
  return `Could not jump to ${description}. ${result.note}`;
}

async function jumpToAnchor(anchor: MessageAnchor, description: string, highlightTerm?: string): Promise<JumpResult | null> {
  try {
    const reply = await connection.request({ type: 'jump', anchor, ...(highlightTerm ? { highlightTerm } : {}) });
    if (reply.type !== 'jump') return null;
    report(describeJump(reply.result, description));
    return reply.result;
  } catch (error) {
    report(`Could not jump to ${description}. ${(error as Error).message}`);
    return null;
  }
}

async function anchorFor(message: MessageSummary, headingIndex?: number): Promise<MessageAnchor | null> {
  const reply = await connection.request({ type: 'anchor-for', key: message.key, ...(headingIndex === undefined ? {} : { headingIndex }) });
  return reply.type === 'anchor-for' ? reply.anchor : null;
}

async function jumpToMessage(message: MessageSummary, description: string, headingIndex?: number, highlightTerm?: string): Promise<void> {
  try {
    const anchor = await anchorFor(message, headingIndex);
    if (!anchor) {
      report(`Could not jump to ${description}. The page changed and Folio no longer has this message; the outline will refresh.`);
      return;
    }
    await jumpToAnchor(anchor, description, highlightTerm);
  } catch (error) {
    report(`Could not jump to ${description}. ${(error as Error).message}`);
  }
}

// --- Outline -------------------------------------------------------------------

function renderOutlineView(): void {
  renderOutline(byId('outline-list'), byId('outline-summary'), readySnapshot(), settings.showHeadings, {
    jump: (message, description, headingIndex) => void jumpToMessage(message, description, headingIndex),
    bookmark: (exchange, message) => void bookmarkMessage(exchange, message),
  });
}

async function bookmarkMessage(exchange: Exchange, message: MessageSummary): Promise<void> {
  const s = readySnapshot();
  if (!s?.conversation) {
    report('Cannot bookmark: no claude.ai conversation is connected.');
    return;
  }
  try {
    const anchor = await anchorFor(message);
    if (!anchor) {
      report('Cannot bookmark: the page changed and this message is no longer indexed.');
      return;
    }
    await addBookmark(
      area,
      { title: exchange.label, conversation: { id: s.conversation.id, title: s.conversation.title }, exchange: exchange.number, anchor },
      new Date(),
      crypto.randomUUID(),
    );
    report(`Bookmarked exchange ${exchange.number}. Add a note in the Bookmarks view.`);
  } catch (error) {
    report(`Could not save the bookmark. ${(error as Error).message}`);
  }
}

// --- Search ----------------------------------------------------------------------

async function runSearch(query: string): Promise<void> {
  const summary = byId('search-summary');
  if (!readySnapshot()) {
    summary.textContent = 'Search needs an open claude.ai conversation with Folio turned on.';
    clear(byId('search-results'));
    return;
  }
  try {
    const reply = await connection.request({ type: 'search', query });
    if (reply.type !== 'search') return;
    renderSearchResults(byId('search-results'), summary, byId('search-coverage'), reply.result, reply.coverage, (hit) => {
      const s = readySnapshot();
      const message = s?.messages.find((m) => m.key === hit.key);
      const description = `the match in exchange ${hit.exchange}`;
      if (!message) report(`Could not jump to ${description}. The page changed; search again.`);
      else void jumpToMessage(message, description, undefined, hit.firstTerm);
    });
    announce(summary.textContent ?? '');
  } catch (error) {
    summary.textContent = `Search failed. ${(error as Error).message}`;
  }
}

// --- Bookmarks -----------------------------------------------------------------

function renderBookmarksView(): void {
  const conversationId = snapshot()?.conversation?.id ?? null;
  renderBookmarks(
    byId('bookmark-list'),
    byId('bookmarks-summary'),
    bookmarks,
    invalidBookmarks,
    checks,
    { conversationId, onlyCurrent: onlyCurrentConversation && conversationId !== null },
    {
      open: (bookmark) => void openBookmark(bookmark),
      save: (bookmark, title, note) => {
        updateBookmark(area, bookmark.id, { title, note }, new Date()).then(
          () => {
            editingBookmark = null;
            renderBookmarksView();
            report('Bookmark saved.');
          },
          (error: unknown) => report(`Could not save the bookmark. ${String(error)}`),
        );
      },
      remove: (bookmark) => {
        deleteBookmark(area, bookmark.id).then(
          () => report(`Deleted bookmark "${bookmark.title}".`),
          (error: unknown) => report(`Could not delete the bookmark. ${String(error)}`),
        );
      },
    },
    editingBookmark,
    (id) => {
      editingBookmark = id;
      renderBookmarksView();
      if (id === null) byId('bookmark-list').querySelector<HTMLElement>('[data-action="edit"]')?.focus();
    },
  );
}

async function reloadBookmarks(): Promise<void> {
  const parsed = await loadBookmarks(area);
  bookmarks = parsed.items;
  invalidBookmarks = parsed.invalid;
  renderBookmarksView();
  scheduleChecks();
}

function scheduleChecks(): void {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(() => void checkBookmarks(), 150);
}

/** Resolves bookmarks of the open conversation so unresolved anchors are reported. */
async function checkBookmarks(): Promise<void> {
  const s = readySnapshot();
  const next = new Map<string, BookmarkCheck>();
  const here = s?.conversation ? bookmarks.filter((b) => b.conversation.id === s.conversation!.id) : [];
  for (const bookmark of bookmarks) {
    if (s?.conversation && bookmark.conversation.id !== s.conversation.id) {
      next.set(bookmark.id, { status: 'unresolved', reason: 'other-conversation', note: 'In another conversation.' });
    }
  }
  if (here.length > 0) {
    try {
      const reply = await connection.request({ type: 'resolve', anchors: here.map((b) => b.anchor) });
      if (reply.type === 'resolve') here.forEach((b, i) => reply.results[i] && next.set(b.id, reply.results[i]!));
    } catch {
      // Leave these unchecked; the status line already explains the connection state.
    }
  }
  checks = next;
  renderBookmarksView();
}

async function openBookmark(bookmark: Bookmark): Promise<void> {
  const url = conversationUrl(bookmark.conversation.id);
  if (!url) {
    report('This bookmark has an invalid conversation id and cannot be opened.');
    return;
  }
  if (!settings.enabled) {
    report('Folio is turned off for claude.ai. Turn it on in Settings to open bookmarks.');
    return;
  }
  const s = readySnapshot();
  const description = `bookmark "${bookmark.title}"`;
  if (s?.conversation?.id === bookmark.conversation.id) {
    const result = await jumpToAnchor(bookmark.anchor, description);
    if (result) recordJumpCheck(bookmark, result);
    return;
  }
  pendingOpen = { bookmark, startedAt: Date.now(), busy: false };
  const sameTab = connectionState.kind === 'connected' || connection.pinned;
  report(`Opening the conversation for ${description}…`);
  try {
    await connection.open(url, sameTab);
  } catch (error) {
    pendingOpen = null;
    report(`Could not open the conversation. ${(error as Error).message}`);
  }
}

function recordJumpCheck(bookmark: Bookmark, result: JumpResult): void {
  const check: BookmarkCheck =
    result.status === 'jumped'
      ? { status: 'exact', index: 0 }
      : result.status === 'jumped-changed'
        ? { status: 'changed', index: 0, note: result.note }
        : { status: 'unresolved', reason: 'not-found', note: result.note };
  checks.set(bookmark.id, check);
  renderBookmarksView();
}

/** After "Open" navigated to another conversation, jump once its messages load. */
async function continuePendingOpen(): Promise<void> {
  if (!pendingOpen || pendingOpen.busy) return;
  const pending = pendingOpen;
  const age = Date.now() - pending.startedAt;
  const description = `bookmark "${pending.bookmark.title}"`;
  if (age > PENDING_OPEN_MS) {
    pendingOpen = null;
    report(`Opened the conversation, but could not find ${description} in time. Its anchor is unresolved.`);
    return;
  }
  const s = readySnapshot();
  if (!s || s.conversation?.id !== pending.bookmark.conversation.id) return;
  pending.busy = true;
  try {
    const reply = await connection.request({ type: 'jump', anchor: pending.bookmark.anchor });
    if (reply.type !== 'jump') return;
    if (reply.result.status === 'unresolved' && Date.now() - pending.startedAt < PENDING_RETRY_MS) return; // messages may still be loading
    pendingOpen = null;
    report(describeJump(reply.result, description));
    recordJumpCheck(pending.bookmark, reply.result);
  } catch {
    // retried on the next snapshot
  } finally {
    pending.busy = false;
  }
}

// --- Tabs ------------------------------------------------------------------------

function selectTab(name: TabName, focusTab: boolean): void {
  for (const tab of TABS) {
    const selected = tab === name;
    const button = byId(`tab-${tab}`);
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    byId(`panel-${tab}`).hidden = !selected;
    if (selected && focusTab) button.focus();
  }
}

function initTabs(): void {
  const tablist = byId('tablist');
  for (const tab of TABS) byId(`tab-${tab}`).addEventListener('click', () => selectTab(tab, false));
  tablist.addEventListener('keydown', (event) => {
    const current = TABS.findIndex((t) => byId(`tab-${t}`).getAttribute('aria-selected') === 'true');
    let next = current;
    if (event.key === 'ArrowRight') next = (current + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') next = (current - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    else return;
    event.preventDefault();
    selectTab(TABS[next]!, true);
  });
  document.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement;
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
    if (target.closest('input, textarea, select, [contenteditable]')) return;
    event.preventDefault();
    selectTab('search', false);
    byId('search-input').focus();
  });
}

// --- Wiring ----------------------------------------------------------------------

function onConnectionState(state: ConnectionState): void {
  const previousConversation = snapshot()?.conversation?.id ?? null;
  connectionState = state;
  renderStatus();
  renderOutlineView();
  if ((snapshot()?.conversation?.id ?? null) !== previousConversation) {
    clear(byId('search-results'));
    byId('search-summary').textContent = '';
    byId('search-coverage').textContent = '';
  }
  renderBookmarksView();
  scheduleChecks();
  void continuePendingOpen();
}

function pinnedTabId(): number | null {
  const raw = new URLSearchParams(location.search).get('tabId');
  if (raw === null || !/^\d{1,10}$/.test(raw)) return null;
  return Number(raw);
}

const connection = new TabConnection(pinnedTabId(), onConnectionState);

async function main(): Promise<void> {
  initTabs();
  initSettings(area);
  arrowNavigation(byId('outline-list'), '[data-nav="outline"]');
  arrowNavigation(byId('search-results'), '[data-nav="results"]');

  byId<HTMLFormElement>('search-form').addEventListener('submit', (event) => {
    event.preventDefault();
    void runSearch(byId<HTMLInputElement>('search-input').value);
  });
  for (const radio of Array.from(document.querySelectorAll<HTMLInputElement>('input[name="bookmark-scope"]'))) {
    radio.addEventListener('change', () => {
      onlyCurrentConversation = radio.value === 'current' && radio.checked;
      renderBookmarksView();
    });
  }

  settings = await loadSettings(area);
  applyAppearance(settings);
  showSettings(settings);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (SETTINGS_KEY in changes) {
      settings = parseSettings(changes[SETTINGS_KEY]?.newValue);
      applyAppearance(settings);
      showSettings(settings);
      renderOutlineView();
    }
    if (BOOKMARKS_KEY in changes) void reloadBookmarks();
  });

  await reloadBookmarks();
  renderStatus();
  await connection.start();
}

main().catch((error: unknown) => {
  byId('status-text').textContent = `Folio could not start: ${String(error)}`;
});
