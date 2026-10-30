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
const NEIGHBOUR = /^(human|assistant):[0-9a-f]{16}$/;

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

/** A stored neighbour id, null for "none known", or undefined when malformed. */
function parseNeighbour(raw: unknown): string | null | undefined {
  if (raw === null) return null;
  return typeof raw === 'string' && NEIGHBOUR.test(raw) ? raw : undefined;
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
  // A malformed context is dropped, not trusted: without context an anchor never resolves as exact.
  if (isRecord(raw.context)) {
    const before = parseNeighbour(raw.context.before);
    const after = parseNeighbour(raw.context.after);
    if (before !== undefined && after !== undefined) anchor.context = { before, after };
  }
  // Likewise a malformed count: without it an unknown neighbour never confirms a match.
  if (Number.isInteger(raw.copies) && (raw.copies as number) >= 1) anchor.copies = raw.copies as number;
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
  /**
   * Records that failed validation (including later duplicates of a bookmark's
   * id). They are ignored, and kept in storage untouched until an erase, or
   * until the bookmark whose id they carry is deleted.
   */
  invalid: number;
}

/** One stored entry, in stored order: a valid bookmark, or a record kept exactly as found. */
type Slot = { bookmark: Bookmark } | { raw: unknown };

/** Stored entries in order, or null when the stored value itself is unreadable. */
function slotsOf(raw: unknown): Slot[] | null {
  if (raw === undefined) return [];
  if (!isRecord(raw) || !Array.isArray(raw.items)) return null;
  const seen = new Set<string>();
  return raw.items.map((entry): Slot => {
    const bookmark = parseBookmark(entry);
    if (!bookmark || seen.has(bookmark.id)) return { raw: entry };
    seen.add(bookmark.id);
    return { bookmark };
  });
}

export function parseBookmarks(raw: unknown): ParsedBookmarks {
  const slots = slotsOf(raw);
  if (!slots) return { items: [], invalid: 1 };
  const items = slots.flatMap((slot) => ('bookmark' in slot ? [slot.bookmark] : []));
  return { items, invalid: slots.length - items.length };
}

export async function loadBookmarks(area: StorageAreaLike): Promise<ParsedBookmarks> {
  const data = await area.get(BOOKMARKS_KEY);
  return parseBookmarks(data[BOOKMARKS_KEY]);
}

/**
 * Reads the stored entries, lets `change` edit the valid ones, and writes them
 * back. Records that failed validation keep their place and content, and other
 * fields of the stored value are kept, so adding and editing never delete data;
 * deleting a bookmark removes only records carrying its id, and an erase removes
 * everything. An unreadable stored value is never overwritten.
 */
async function modifyBookmarks<R>(area: StorageAreaLike, change: (slots: Slot[]) => { slots: Slot[] | null; result: R }): Promise<R> {
  const raw = (await area.get(BOOKMARKS_KEY))[BOOKMARKS_KEY];
  const slots = slotsOf(raw);
  if (!slots) {
    throw new Error('The stored bookmarks are unreadable, so Folio will not change them. Download stored data in Settings to keep a copy, then use Erase bookmarks to start again.');
  }
  const { slots: next, result } = change(slots);
  if (!next) return result;
  const store: BookmarkStore & Record<string, unknown> = {
    ...(isRecord(raw) ? raw : {}),
    version: 1,
    items: next.map((slot) => ('bookmark' in slot ? slot.bookmark : slot.raw)) as Bookmark[],
  };
  await area.set({ [BOOKMARKS_KEY]: store });
  return result;
}

function isBookmarkSlot(slot: Slot, id: string): slot is { bookmark: Bookmark } {
  return 'bookmark' in slot && slot.bookmark.id === id;
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
  return modifyBookmarks(area, (slots) => ({ slots: [...slots, { bookmark: candidate }], result: candidate }));
}

export async function updateBookmark(
  area: StorageAreaLike,
  id: string,
  patch: { title?: string; note?: string },
  now: Date,
): Promise<Bookmark | null> {
  return modifyBookmarks(area, (slots) => {
    const index = slots.findIndex((slot) => isBookmarkSlot(slot, id));
    if (index < 0) return { slots: null, result: null };
    const current = (slots[index] as { bookmark: Bookmark }).bookmark;
    const next: Bookmark = {
      ...current,
      title: patch.title !== undefined ? truncate(patch.title.trim() || current.title, TITLE_MAX) : current.title,
      note: patch.note !== undefined ? patch.note.slice(0, NOTE_MAX) : current.note,
      updatedAt: now.toISOString(),
    };
    return { slots: slots.map((slot, i) => (i === index ? { bookmark: next } : slot)), result: next };
  });
}

/** True for any stored record carrying `id`: the bookmark itself, or an ignored record (such as a duplicate) with that id. */
function carriesId(slot: Slot, id: string): boolean {
  return 'bookmark' in slot ? slot.bookmark.id === id : isRecord(slot.raw) && slot.raw.id === id;
}

/**
 * Deletes the bookmark `id` together with every ignored record carrying the same
 * id, so a duplicate can never take its place on the next read. Returns false,
 * changing nothing, when no valid bookmark has that id.
 */
export async function deleteBookmark(area: StorageAreaLike, id: string): Promise<boolean> {
  return modifyBookmarks(area, (slots) =>
    slots.some((slot) => isBookmarkSlot(slot, id))
      ? { slots: slots.filter((slot) => !carriesId(slot, id)), result: true }
      : { slots: null, result: false },
  );
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
