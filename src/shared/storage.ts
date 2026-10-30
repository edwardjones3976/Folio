// Local persistence for settings and bookmarks (chrome.storage.local in the
// extension; any StorageArea-like object in tests). Everything read back is
// validated, because stored data may be corrupted or edited by other tools.
import { truncate } from './text.ts';
import type { MessageAnchor, Role } from './types.ts';

export const SETTINGS_KEY = 'folio.settings';
export const BOOKMARKS_KEY = 'folio.bookmarks';
export const FOLIO_KEYS = [SETTINGS_KEY, BOOKMARKS_KEY];

export interface StorageAreaLike {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  getBytesInUse?(keys?: string | string[] | null): Promise<number>;
}

export type Theme = 'system' | 'light' | 'dark' | 'contrast';
export type TextSize = 'normal' | 'large' | 'larger';

export interface Settings {
  version: 1;
  /** When false the content script reads nothing from claude.ai pages. */
  enabled: boolean;
  theme: Theme;
  textSize: TextSize;
  showHeadings: boolean;
}

export const DEFAULT_SETTINGS: Settings = { version: 1, enabled: true, theme: 'system', textSize: 'normal', showHeadings: true };

const THEMES: readonly Theme[] = ['system', 'light', 'dark', 'contrast'];
const TEXT_SIZES: readonly TextSize[] = ['normal', 'large', 'larger'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseSettings(raw: unknown): Settings {
  if (!isRecord(raw)) return { ...DEFAULT_SETTINGS };
  return {
    version: 1,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_SETTINGS.enabled,
    theme: THEMES.includes(raw.theme as Theme) ? (raw.theme as Theme) : DEFAULT_SETTINGS.theme,
    textSize: TEXT_SIZES.includes(raw.textSize as TextSize) ? (raw.textSize as TextSize) : DEFAULT_SETTINGS.textSize,
    showHeadings: typeof raw.showHeadings === 'boolean' ? raw.showHeadings : DEFAULT_SETTINGS.showHeadings,
  };
}

export async function loadSettings(area: StorageAreaLike): Promise<Settings> {
  const data = await area.get(SETTINGS_KEY);
  return parseSettings(data[SETTINGS_KEY]);
}

export async function saveSettings(area: StorageAreaLike, patch: Partial<Omit<Settings, 'version'>>): Promise<Settings> {
  const next = parseSettings({ ...(await loadSettings(area)), ...patch });
  await area.set({ [SETTINGS_KEY]: next });
  return next;
}

// --- Bookmarks -------------------------------------------------------------

export const TITLE_MAX = 200;
export const NOTE_MAX = 2000;
const CONVERSATION_ID = /^[A-Za-z0-9_-]{6,80}$/;
const DIGEST = /^[0-9a-f]{16}$/;

export interface Bookmark {
  id: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  note: string;
  conversation: { provider: 'claude.ai'; id: string; title: string };
  /** Exchange number when saved (display only; anchors resolve by content). */
  exchange: number;
  anchor: MessageAnchor;
}

export interface BookmarkStore {
  version: 1;
  items: Bookmark[];
}

/** The only URL Folio will open for a bookmark, rebuilt from a validated id. */
export function conversationUrl(conversationId: string): string | null {
  return CONVERSATION_ID.test(conversationId) ? `https://claude.ai/chat/${conversationId}` : null;
}

export function isValidConversationId(id: unknown): id is string {
  return typeof id === 'string' && CONVERSATION_ID.test(id);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));
}

function parseAnchor(raw: unknown): MessageAnchor | null {
  if (!isRecord(raw)) return null;
  const role = raw.role as Role;
  if (raw.provider !== 'claude.ai' || !isValidConversationId(raw.conversationId)) return null;
  if (role !== 'human' && role !== 'assistant') return null;
  if (typeof raw.digest !== 'string' || !DIGEST.test(raw.digest)) return null;
  if (!Number.isInteger(raw.occurrence) || (raw.occurrence as number) < 0) return null;
  if (!Number.isInteger(raw.ordinal)) return null;
  if (typeof raw.prefix !== 'string') return null;
  const anchor: MessageAnchor = {
    provider: 'claude.ai',
    conversationId: raw.conversationId,
    role,
    digest: raw.digest,
    occurrence: raw.occurrence as number,
    ordinal: raw.ordinal as number,
    prefix: raw.prefix.slice(0, 200),
  };
  if (Number.isInteger(raw.headingIndex) && typeof raw.headingText === 'string') {
    anchor.headingIndex = raw.headingIndex as number;
    anchor.headingText = raw.headingText.slice(0, 300);
  }
  return anchor;
}

function parseBookmark(raw: unknown): Bookmark | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.length === 0 || raw.id.length > 80) return null;
  if (!isIsoDate(raw.createdAt) || !isIsoDate(raw.updatedAt)) return null;
  if (typeof raw.title !== 'string' || typeof raw.note !== 'string') return null;
  const conversation = raw.conversation;
  if (!isRecord(conversation) || conversation.provider !== 'claude.ai' || !isValidConversationId(conversation.id)) return null;
  const anchor = parseAnchor(raw.anchor);
  if (!anchor || anchor.conversationId !== conversation.id) return null;
  return {
    id: raw.id,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    title: truncate(raw.title, TITLE_MAX),
    note: raw.note.slice(0, NOTE_MAX),
    conversation: {
      provider: 'claude.ai',
      id: conversation.id,
      title: typeof conversation.title === 'string' ? truncate(conversation.title, TITLE_MAX) : '',
    },
    exchange: Number.isInteger(raw.exchange) ? (raw.exchange as number) : 0,
    anchor,
  };
}

export interface ParsedBookmarks {
  items: Bookmark[];
  /** Records that failed validation and are ignored (not deleted). */
  invalid: number;
}

export function parseBookmarks(raw: unknown): ParsedBookmarks {
  if (raw === undefined) return { items: [], invalid: 0 };
  if (!isRecord(raw) || !Array.isArray(raw.items)) return { items: [], invalid: 1 };
  const items: Bookmark[] = [];
  let invalid = 0;
  const seen = new Set<string>();
  for (const entry of raw.items) {
    const bookmark = parseBookmark(entry);
    if (!bookmark || seen.has(bookmark.id)) invalid += 1;
    else {
      seen.add(bookmark.id);
      items.push(bookmark);
    }
  }
  return { items, invalid };
}

export async function loadBookmarks(area: StorageAreaLike): Promise<ParsedBookmarks> {
  const data = await area.get(BOOKMARKS_KEY);
  return parseBookmarks(data[BOOKMARKS_KEY]);
}

async function writeBookmarks(area: StorageAreaLike, items: Bookmark[]): Promise<void> {
  const store: BookmarkStore = { version: 1, items };
  await area.set({ [BOOKMARKS_KEY]: store });
}

export interface NewBookmark {
  title: string;
  note?: string;
  conversation: { id: string; title: string };
  exchange: number;
  anchor: MessageAnchor;
}

export async function addBookmark(area: StorageAreaLike, input: NewBookmark, now: Date, id: string): Promise<Bookmark> {
  const stamp = now.toISOString();
  const candidate = parseBookmark({
    id,
    createdAt: stamp,
    updatedAt: stamp,
    title: input.title.trim() || 'Untitled bookmark',
    note: input.note ?? '',
    conversation: { provider: 'claude.ai', ...input.conversation },
    exchange: input.exchange,
    anchor: input.anchor,
  });
  if (!candidate) throw new Error('Bookmark rejected: invalid conversation or anchor.');
  const { items } = await loadBookmarks(area);
  await writeBookmarks(area, [...items, candidate]);
  return candidate;
}

export async function updateBookmark(
  area: StorageAreaLike,
  id: string,
  patch: { title?: string; note?: string },
  now: Date,
): Promise<Bookmark | null> {
  const { items } = await loadBookmarks(area);
  const index = items.findIndex((b) => b.id === id);
  if (index < 0) return null;
  const current = items[index]!;
  const next: Bookmark = {
    ...current,
    title: patch.title !== undefined ? truncate(patch.title.trim() || current.title, TITLE_MAX) : current.title,
    note: patch.note !== undefined ? patch.note.slice(0, NOTE_MAX) : current.note,
    updatedAt: now.toISOString(),
  };
  items[index] = next;
  await writeBookmarks(area, items);
  return next;
}

export async function deleteBookmark(area: StorageAreaLike, id: string): Promise<boolean> {
  const { items } = await loadBookmarks(area);
  const remaining = items.filter((b) => b.id !== id);
  if (remaining.length === items.length) return false;
  await writeBookmarks(area, remaining);
  return true;
}

/** Erases all bookmarks, including records that failed validation. */
export async function eraseBookmarks(area: StorageAreaLike): Promise<void> {
  await area.remove(BOOKMARKS_KEY);
}

/** Erases every Folio key; settings return to defaults on next read. */
export async function eraseAll(area: StorageAreaLike): Promise<void> {
  const data = await area.get(null);
  await area.remove(Object.keys(data));
}

export interface StoredDataReport {
  data: Record<string, unknown>;
  bytesInUse: number | null;
}

/** Exactly what is in storage, unfiltered, for the "Inspect stored data" view. */
export async function inspectStorage(area: StorageAreaLike): Promise<StoredDataReport> {
  const data = await area.get(null);
  const bytesInUse = area.getBytesInUse ? await area.getBytesInUse(null) : null;
  return { data, bytesInUse };
}
