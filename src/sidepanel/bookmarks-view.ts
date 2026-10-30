// Bookmarks view: list, edit, delete and reopen saved bookmarks.
import { NOTE_MAX, TITLE_MAX } from '../shared/storage.ts';
import type { Bookmark } from '../shared/storage.ts';
import type { Resolution } from '../shared/types.ts';
import { formatDate, h } from './dom.ts';

export interface BookmarkActions {
  open(bookmark: Bookmark): void;
  save(bookmark: Bookmark, title: string, note: string): void;
  remove(bookmark: Bookmark): void;
}

export type BookmarkCheck = Resolution | { status: 'unchecked'; note: string };

export function describeCheck(check: BookmarkCheck): { text: string; tone: 'ok' | 'warn' | 'muted' } {
  switch (check.status) {
    case 'exact':
      return { text: 'Found in this page', tone: 'ok' };
    case 'changed':
      return { text: `Found, but changed: ${check.note}`, tone: 'warn' };
    case 'ambiguous':
      return { text: `Ambiguous: ${check.note}`, tone: 'warn' };
    case 'unresolved':
      if (check.reason === 'other-conversation') return { text: 'In another conversation (Open will navigate there)', tone: 'muted' };
      return { text: `Unresolved: ${check.note}`, tone: 'warn' };
    default:
      return { text: check.note, tone: 'muted' };
  }
}

function editor(bookmark: Bookmark, actions: BookmarkActions, done: () => void): HTMLFormElement {
  const titleId = `bm-title-${bookmark.id}`;
  const noteId = `bm-note-${bookmark.id}`;
  const title = h('input', { id: titleId, type: 'text', maxlength: TITLE_MAX, value: bookmark.title, required: true });
  const note = h('textarea', { id: noteId, rows: 3, maxlength: NOTE_MAX });
  note.value = bookmark.note;
  const form = h(
    'form',
    { class: 'bookmark-editor', 'aria-label': `Edit bookmark ${bookmark.title}` },
    h('label', { for: titleId, text: 'Title' }),
    title,
    h('label', { for: noteId, text: 'Note' }),
    note,
    h(
      'div',
      { class: 'row' },
      h('button', { type: 'submit', class: 'primary', text: 'Save' }),
      h('button', { type: 'button', class: 'cancel', text: 'Cancel' }),
    ),
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    actions.save(bookmark, title.value, note.value);
  });
  form.querySelector('.cancel')!.addEventListener('click', done);
  form.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') done();
  });
  queueMicrotask(() => title.focus());
  return form;
}

export function renderBookmarks(
  list: HTMLElement,
  summary: HTMLElement,
  items: Bookmark[],
  invalid: number,
  checks: Map<string, BookmarkCheck>,
  scope: { conversationId: string | null; onlyCurrent: boolean },
  actions: BookmarkActions,
  editingId: string | null,
  setEditing: (id: string | null) => void,
): void {
  // Live updates (snapshots, bookmark checks) re-render this list often. An open
  // editor stays the same DOM node, never detached, so its draft and focus survive.
  const kept =
    editingId === null
      ? null
      : (Array.from(list.children).find(
          (li): li is HTMLElement => li instanceof HTMLElement && li.dataset.bookmarkId === editingId && li.querySelector('.bookmark-editor') !== null,
        ) ?? null);
  for (const child of Array.from(list.children)) if (child !== kept) child.remove();
  let keptPlaced = false;
  const visible = items
    .filter((b) => !scope.onlyCurrent || b.conversation.id === scope.conversationId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const invalidNote = invalid > 0 ? ` ${invalid} stored record(s) failed validation and are ignored; see Settings > Stored data.` : '';
  summary.textContent =
    (visible.length === 0
      ? scope.onlyCurrent
        ? 'No bookmarks for this conversation. Use ☆ in the Outline to add one.'
        : 'No bookmarks yet. Use ☆ in the Outline to add one.'
      : `${visible.length} ${visible.length === 1 ? 'bookmark' : 'bookmarks'}.`) + invalidNote;

  for (const bookmark of visible) {
    const check = checks.get(bookmark.id) ?? { status: 'unchecked' as const, note: 'Not checked (open its conversation to check).' };
    const state = describeCheck(check);
    const details: HTMLElement[] = [
      h('h3', { class: 'bookmark-title', text: bookmark.title }),
      ...(bookmark.note ? [h('p', { class: 'bookmark-note', text: bookmark.note })] : []),
      h(
        'p',
        { class: 'bookmark-meta' },
        `${bookmark.conversation.title || 'Untitled conversation'} · exchange ${bookmark.exchange} · ${bookmark.anchor.role === 'human' ? 'prompt' : "Claude's reply"} · saved `,
        h('time', { datetime: bookmark.createdAt, text: formatDate(bookmark.createdAt) }),
      ),
      h('p', { class: `bookmark-status ${state.tone}`, 'data-status': check.status, text: state.text }),
    ];
    if (kept && bookmark.id === editingId) {
      // Refresh the saved details around the open editor; leave the editor untouched.
      for (const child of Array.from(kept.children)) if (!child.classList.contains('bookmark-editor')) child.remove();
      kept.prepend(...details);
      keptPlaced = true;
      continue;
    }
    const item = h('li', { class: 'bookmark', 'data-bookmark-id': bookmark.id }, ...details);
    if (editingId === bookmark.id) {
      item.append(editor(bookmark, actions, () => setEditing(null)));
    } else {
      const open = h('button', { type: 'button', class: 'primary', 'data-action': 'open', text: 'Open', 'aria-label': `Open bookmark ${bookmark.title}` });
      const edit = h('button', { type: 'button', 'data-action': 'edit', text: 'Edit', 'aria-label': `Edit bookmark ${bookmark.title}` });
      const remove = h('button', { type: 'button', 'data-action': 'delete', text: 'Delete', 'aria-label': `Delete bookmark ${bookmark.title}` });
      open.addEventListener('click', () => actions.open(bookmark));
      edit.addEventListener('click', () => setEditing(bookmark.id));
      remove.addEventListener('click', () => actions.remove(bookmark));
      item.append(h('div', { class: 'row actions' }, open, edit, remove));
    }
    if (kept && !keptPlaced) list.insertBefore(item, kept);
    else list.append(item);
  }
  if (kept && !keptPlaced) kept.remove();
}
