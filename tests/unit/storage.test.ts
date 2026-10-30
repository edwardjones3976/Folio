import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BOOKMARKS_KEY,
  DEFAULT_SETTINGS,
  NOTE_MAX,
  SETTINGS_KEY,
  addBookmark,
  conversationUrl,
  deleteBookmark,
  eraseAll,
  eraseBookmarks,
  inspectStorage,
  loadBookmarks,
  loadSettings,
  parseBookmarks,
  parseSettings,
  saveSettings,
  updateBookmark,
} from '../../src/shared/storage.ts';
import type { NewBookmark } from '../../src/shared/storage.ts';
import { digest } from '../../src/shared/text.ts';
import { MemoryStorage } from './helpers.ts';

const CONV = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-29T12:00:00.000Z');

function newBookmark(overrides: Partial<NewBookmark> = {}): NewBookmark {
  return {
    title: 'Water needs',
    note: 'Remember the 25 mm figure',
    conversation: { id: CONV, title: 'Planning drip irrigation' },
    exchange: 1,
    anchor: { provider: 'claude.ai', conversationId: CONV, role: 'assistant', digest: digest('reply'), occurrence: 0, ordinal: 1, prefix: 'reply' },
    ...overrides,
  };
}

describe('settings', () => {
  it('defaults when nothing or garbage is stored', async () => {
    assert.deepEqual(parseSettings(undefined), DEFAULT_SETTINGS);
    assert.deepEqual(parseSettings('corrupt'), DEFAULT_SETTINGS);
    assert.deepEqual(parseSettings({ enabled: 'yes', theme: 'neon', textSize: 99 }), DEFAULT_SETTINGS);
  });

  it('saves validated patches', async () => {
    const area = new MemoryStorage();
    await saveSettings(area, { enabled: false, theme: 'contrast' });
    const loaded = await loadSettings(area);
    assert.equal(loaded.enabled, false);
    assert.equal(loaded.theme, 'contrast');
    assert.equal(loaded.textSize, 'normal');
  });
});

describe('bookmarks', () => {
  it('adds, lists, updates and deletes', async () => {
    const area = new MemoryStorage();
    const created = await addBookmark(area, newBookmark(), NOW, 'id-1');
    assert.equal(created.createdAt, NOW.toISOString());
    assert.equal(created.conversation.provider, 'claude.ai');

    const later = new Date('2026-10-29T13:00:00.000Z');
    const updated = await updateBookmark(area, 'id-1', { title: 'Renamed', note: 'x'.repeat(NOTE_MAX + 50) }, later);
    assert.equal(updated?.title, 'Renamed');
    assert.equal(updated?.note.length, NOTE_MAX);
    assert.equal(updated?.updatedAt, later.toISOString());
    assert.equal(updated?.createdAt, NOW.toISOString());

    assert.equal((await loadBookmarks(area)).items.length, 1);
    assert.equal(await deleteBookmark(area, 'id-1'), true);
    assert.equal(await deleteBookmark(area, 'id-1'), false);
    assert.equal((await loadBookmarks(area)).items.length, 0);
  });

  it('keeps a title when an update tries to blank it', async () => {
    const area = new MemoryStorage();
    await addBookmark(area, newBookmark(), NOW, 'id-1');
    const updated = await updateBookmark(area, 'id-1', { title: '   ' }, NOW);
    assert.equal(updated?.title, 'Water needs');
  });

  it('rejects bookmarks whose anchor does not match the conversation', async () => {
    const area = new MemoryStorage();
    const bad = newBookmark();
    bad.anchor = { ...bad.anchor, conversationId: 'zzzzzzzz-other' };
    await assert.rejects(addBookmark(area, bad, NOW, 'id-x'), /invalid conversation or anchor/);
  });

  it('ignores corrupted records without deleting the valid ones', async () => {
    const area = new MemoryStorage();
    await addBookmark(area, newBookmark(), NOW, 'good');
    const store = (await area.get(BOOKMARKS_KEY))[BOOKMARKS_KEY] as { items: unknown[] };
    store.items.push(
      { id: 'bad-1', title: 42 },
      { ...(store.items[0] as object), id: 'bad-2', conversation: { provider: 'claude.ai', id: 'javascript:alert(1)' } },
      { ...(store.items[0] as object) },
    );
    await area.set({ [BOOKMARKS_KEY]: store });
    const parsed = await loadBookmarks(area);
    assert.deepEqual(parsed.items.map((b) => b.id), ['good']);
    assert.equal(parsed.invalid, 3);
    assert.deepEqual(parseBookmarks('garbage'), { items: [], invalid: 1 });
  });

  it('keeps a valid anchor context and drops a malformed one', async () => {
    const area = new MemoryStorage();
    const before = `human:${digest('prompt')}`;
    const withContext = newBookmark();
    withContext.anchor = { ...withContext.anchor, context: { before, after: null } };
    assert.deepEqual((await addBookmark(area, withContext, NOW, 'ok')).anchor.context, { before, after: null });
    const tampered = newBookmark();
    tampered.anchor = { ...tampered.anchor, context: { before: 'javascript:alert(1)', after: null } };
    assert.equal((await addBookmark(area, tampered, NOW, 'bad')).anchor.context, undefined);
  });

  it('only ever builds https://claude.ai/chat/<id> URLs from validated ids', () => {
    assert.equal(conversationUrl(CONV), `https://claude.ai/chat/${CONV}`);
    assert.equal(conversationUrl('../../evil'), null);
    assert.equal(conversationUrl('javascript:alert(1)'), null);
    assert.equal(conversationUrl('x'), null);
  });

  it('surfaces storage write failures instead of losing them silently', async () => {
    const area = new MemoryStorage();
    area.failNextSet = true;
    await assert.rejects(addBookmark(area, newBookmark(), NOW, 'id-1'), /quota/);
    assert.equal((await loadBookmarks(area)).items.length, 0);
  });
});

describe('records that failed validation are never dropped by ordinary writes (review finding 5)', () => {
  const INVALID = { id: 'broken', title: 42, note: ['kept as found'] };

  async function storeWithInvalid(): Promise<MemoryStorage> {
    const area = new MemoryStorage();
    await addBookmark(area, newBookmark(), NOW, 'good-1');
    const store = area.data[BOOKMARKS_KEY] as { items: unknown[] };
    store.items.unshift(structuredClone(INVALID));
    (store as Record<string, unknown>).exportedBy = 'another tool';
    return area;
  }

  const stored = (area: MemoryStorage) => area.data[BOOKMARKS_KEY] as { items: { id: unknown }[]; exportedBy?: string };

  it('add keeps the invalid record, in place and unchanged', async () => {
    const area = await storeWithInvalid();
    await addBookmark(area, newBookmark(), NOW, 'good-2');
    assert.deepEqual(stored(area).items[0], INVALID);
    assert.deepEqual(stored(area).items.map((b) => b.id), ['broken', 'good-1', 'good-2']);
    assert.equal(stored(area).exportedBy, 'another tool');
    assert.equal((await loadBookmarks(area)).invalid, 1);
  });

  it('update keeps the invalid record', async () => {
    const area = await storeWithInvalid();
    assert.equal((await updateBookmark(area, 'good-1', { note: 'edited' }, NOW))?.note, 'edited');
    assert.deepEqual(stored(area).items[0], INVALID);
    assert.equal(stored(area).items.length, 2);
  });

  it('delete removes only the chosen bookmark', async () => {
    const area = await storeWithInvalid();
    assert.equal(await deleteBookmark(area, 'good-1'), true);
    assert.deepEqual(stored(area).items, [INVALID]);
    assert.equal(await deleteBookmark(area, 'broken'), false, 'an invalid record is not deleted by id');
    assert.deepEqual(stored(area).items, [INVALID]);
  });

  it('refuses to overwrite a stored value that is unreadable as a whole', async () => {
    const area = new MemoryStorage();
    area.data[BOOKMARKS_KEY] = 'corrupted';
    await assert.rejects(addBookmark(area, newBookmark(), NOW, 'id-1'), /unreadable/);
    assert.equal(area.data[BOOKMARKS_KEY], 'corrupted');
    await eraseBookmarks(area);
    assert.equal(BOOKMARKS_KEY in area.data, false, 'only an explicit erase removes it');
  });
});

describe('erase and inspect', () => {
  it('erases bookmarks only, or everything', async () => {
    const area = new MemoryStorage();
    await saveSettings(area, { theme: 'dark' });
    await addBookmark(area, newBookmark(), NOW, 'id-1');
    await eraseBookmarks(area);
    assert.deepEqual(Object.keys(area.data), [SETTINGS_KEY]);
    await addBookmark(area, newBookmark(), NOW, 'id-2');
    area.data['unexpected.key'] = { leftover: true };
    await eraseAll(area);
    assert.deepEqual(area.data, {});
  });

  it('shows exactly what is stored, including unknown keys', async () => {
    const area = new MemoryStorage();
    await addBookmark(area, newBookmark(), NOW, 'id-1');
    area.data['unexpected.key'] = 1;
    const report = await inspectStorage(area);
    assert.deepEqual(Object.keys(report.data).sort(), [BOOKMARKS_KEY, 'unexpected.key']);
    assert.ok((report.bytesInUse ?? 0) > 0);
  });
});
