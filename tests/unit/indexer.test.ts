// The live index driven by an in-memory adapter (synthetic messages, no DOM):
// the review probes for receipts codex-20261030T064426Z-740188 and
// codex-20261030T071243Z-520675, rebuilt as the reviewer described them.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DiscoveredMessage, SiteAdapter } from '../../src/adapters/types.ts';
import { LiveIndex } from '../../src/content/indexer.ts';
import type { Targeted } from '../../src/content/indexer.ts';
import { digest } from '../../src/shared/text.ts';
import type { MessageAnchor, Resolution, Role } from '../../src/shared/types.ts';

const CONV = 'abcdef12-3456';

/** A stand-in for a message element: only its identity and `isConnected` are used. */
const element = () => ({ isConnected: true }) as unknown as Element;
const detach = (el: Element) => Object.assign(el, { isConnected: false });

function msg(role: Role, text: string, el: Element = element(), streaming = false): DiscoveredMessage {
  return { element: el, role, text, headings: [], branch: null, streaming };
}

/** A synthetic page: `messages` is what the adapter discovers, in page order. */
function page(messages: DiscoveredMessage[] = []) {
  const state = { messages };
  const adapter: SiteAdapter = {
    id: 'claude.ai',
    label: 'claude.ai',
    conversation: () => ({ provider: 'claude.ai', id: CONV, url: `https://claude.ai/chat/${CONV}`, title: 'Synthetic' }),
    discover: () => ({ messages: state.messages, strategy: { id: 'semantic-attributes', label: 'synthetic', stable: true }, signals: [] }),
    branchSignature: () => '',
  };
  const index = new LiveIndex(adapter, {} as Document, { href: `https://claude.ai/chat/${CONV}`, pathname: `/chat/${CONV}` });
  index.refresh();
  return { state, index };
}

/** What the content script does for an outline or search click (main.ts `go`). */
function go(index: LiveIndex, key: string, revision: number): Targeted | null {
  let target = index.target(key, revision);
  if (!target?.message) {
    index.refresh();
    target = index.target(key, revision, target?.differs === true);
  }
  return target;
}

const navigates = (r: Resolution) => r.status === 'exact' || r.status === 'changed';

describe('LiveIndex: a one-sided match is never exact (review finding 1)', () => {
  it('the review probe: anchors saved while only the later "Continue"/"Done." exchange was known do not resolve to the earlier one', () => {
    const later = page([msg('human', 'Continue'), msg('assistant', 'Done.')]);
    const { revision, messages } = later.index.snapshot();
    const anchors = messages.map((m) => later.index.anchorFor(m.key, undefined, revision)!);
    const ids = [`human:${digest('Continue')}`, `assistant:${digest('Done.')}`];
    assert.deepEqual(anchors.map((a) => [a.context, a.copies]), [
      [{ before: null, after: ids[1] }, 1],
      [{ before: ids[0], after: null }, 1],
    ]);

    const earlier = page([msg('human', 'Continue'), msg('assistant', 'Done.')]);
    const located = anchors.map((a) => earlier.index.locate(a));
    assert.deepEqual(located.map((l) => l.resolution.status), ['probable', 'probable'], 'ff66a57: exact index 0 and exact index 1');
    assert.deepEqual(located.map((l) => l.message), [null, null]);
  });

  it('a bookmark of the latest reply is not confirmed even after the conversation continues and its text is unique', () => {
    const p = page([msg('human', 'How do I migrate the users table?'), msg('assistant', 'Use expand and contract.')]);
    const { revision, messages } = p.index.snapshot();
    const anchor = p.index.anchorFor(messages[1]!.key, undefined, revision)!;
    p.state.messages = [...p.state.messages, msg('human', 'Continue'), msg('assistant', 'Step two: backfill.')];
    p.index.refresh();
    const located = p.index.locate(anchor);
    assert.equal(located.resolution.status, 'probable');
    assert.match(located.resolution.status === 'probable' ? located.resolution.note : '', /No message after it was known when this was saved/);
    assert.equal(located.message, null);
  });
});

describe('LiveIndex: a current-generation click checks the page first (review finding 2)', () => {
  const chat = () => [
    msg('human', 'How do I migrate the users table?'),
    msg('assistant', 'Use the expand and contract pattern: add new columns, dual-write, backfill, then switch reads.'),
    msg('human', 'How large should the batches be?'),
    msg('assistant', 'Start with 10 000 rows and measure lock time.'),
  ];

  it('the review probe: an element whose text changed before the refresh is not followed as exact', () => {
    const p = page(chat());
    const { revision, messages } = p.index.snapshot();
    const key = messages[1]!.key;
    p.state.messages = p.state.messages.map((m, i) => (i === 1 ? { ...m, text: 'Completely different text the page now shows in this element.' } : m));

    const before = p.index.target(key, revision)!;
    assert.equal(before.stale, false);
    assert.notEqual(before.resolution.status, 'exact', 'ff66a57: stale false, exact, and an element holding the other text');
    assert.equal(before.message, null);

    const after = go(p.index, key, revision)!;
    assert.equal(after.stale, true, 'resolved again after the refresh');
    assert.deepEqual([after.resolution.status, after.resolution.status === 'unresolved' && after.resolution.reason], ['unresolved', 'not-found']);
    assert.equal(after.message, null);
  });

  it('after the refresh, the anchor rules decide: a message that only grew, with both neighbours unchanged, is "changed"', () => {
    const p = page(chat());
    const { revision, messages } = p.index.snapshot();
    p.state.messages = p.state.messages.map((m, i) => (i === 1 ? { ...m, text: `${m.text} Keep the old columns until reads have switched.` } : m));
    const after = go(p.index, messages[1]!.key, revision)!;
    assert.deepEqual([after.stale, after.resolution.status], [true, 'changed']);
    assert.equal(after.message?.element, p.state.messages[1]!.element);
  });

  it('an element the page reused for an identical copy of the message is not followed', () => {
    const [P, R] = ['Summarize the incident report in two lines.', 'The deploy failed at 14:02. It was rolled back at 14:09.'];
    const els = Array.from({ length: 6 }, element);
    const p = page([msg('human', P, els[0]), msg('assistant', R, els[1]), msg('human', 'Who approved it?', els[2]), msg('human', P, els[3]), msg('assistant', R, els[4]), msg('human', 'Write the email.', els[5])]);
    const { revision, messages } = p.index.snapshot();
    // Before Folio refreshes, the later reply's element shows the earlier reply.
    p.state.messages = [msg('human', P, els[0]), msg('assistant', R, els[4]), msg('human', 'Who approved it?', els[2])];
    const before = p.index.target(messages[4]!.key, revision)!;
    assert.deepEqual([before.stale, before.resolution.status, before.message], [false, 'unresolved', null]);
    const after = go(p.index, messages[4]!.key, revision)!;
    assert.ok(!navigates(after.resolution), after.resolution.status);
    assert.equal(after.message, null);
  });

  it('follows the clicked element while the page is unchanged, even among identical exchanges', () => {
    const els = Array.from({ length: 4 }, element);
    const p = page([msg('human', 'Continue', els[0]), msg('assistant', 'Done.', els[1]), msg('human', 'Continue', els[2]), msg('assistant', 'Done.', els[3])]);
    const { revision, messages } = p.index.snapshot();
    const target = p.index.target(messages[2]!.key, revision)!;
    assert.deepEqual([target.stale, target.resolution, target.message?.element === els[2]], [false, { status: 'exact', index: 2 }, true]);
  });

  it('tolerates a reply that is still being written, except as the target itself', () => {
    const p = page([...chat().slice(0, 3), msg('assistant', 'Start with 10 000', element(), true)]);
    const { revision, messages } = p.index.snapshot();
    p.state.messages = p.state.messages.map((m, i) => (i === 3 ? { ...m, text: `${m.text} rows and measure lock time.` } : m));
    const prompt = p.index.target(messages[0]!.key, revision)!;
    assert.deepEqual([prompt.resolution.status, prompt.message?.element === p.state.messages[0]!.element], ['exact', true]);
    const streaming = p.index.target(messages[3]!.key, revision)!;
    assert.deepEqual([streaming.resolution.status, streaming.message], ['unresolved', null], 'its own text changed');
  });
});

describe('LiveIndex: an earlier generation is found again only by its anchor (review finding 3)', () => {
  const [P, R] = ['Summarize the incident report in two lines.', 'The deploy failed at 14:02. It was rolled back at 14:09.'];

  it('the review probe: the later reply, whose element now shows the earlier reply, is not exact to the earlier reply', () => {
    const els = Array.from({ length: 6 }, element);
    const p = page([msg('human', P, els[0]), msg('assistant', R, els[1]), msg('human', 'Who approved it?', els[2]), msg('human', P, els[3]), msg('assistant', R, els[4]), msg('human', 'Write the email.', els[5])]);
    const { revision, messages } = p.index.snapshot();
    const saved: MessageAnchor = p.index.anchorFor(messages[4]!.key, undefined, revision)!;
    p.state.messages = [msg('human', P, els[0]), msg('assistant', R, els[4]), msg('human', 'Who approved it?', els[2])];
    p.index.refresh();
    assert.deepEqual(p.index.snapshot().messages.map((m) => m.rendered), [true, true, true, false, false, false]);

    const went = go(p.index, messages[4]!.key, revision)!;
    assert.equal(went.stale, true);
    assert.deepEqual([went.resolution.status, went.resolution.status === 'unresolved' && went.resolution.reason], ['unresolved', 'not-loaded'], 'ff66a57: exact index 1');
    assert.equal(went.message, null);
    assert.deepEqual(went.resolution, p.index.locate(saved).resolution, 'the same answer as the saved anchor');
  });

  it('finds a message again when both of its neighbours still match', () => {
    const p = page([msg('human', 'Continue'), msg('assistant', 'Done.'), msg('human', 'Continue'), msg('assistant', 'Done.')]);
    const { revision, messages } = p.index.snapshot();
    p.state.messages = [...p.state.messages, msg('human', 'Summarize everything so far.')];
    p.index.refresh();
    const first = go(p.index, messages[1]!.key, revision)!;
    assert.deepEqual([first.stale, first.resolution.status, first.message?.element === p.state.messages[1]!.element], [true, 'exact', true]);
    const second = go(p.index, messages[2]!.key, revision)!;
    assert.deepEqual([second.resolution.status, second.message], ['ambiguous', null], 'the first prompt could also have a "Done." before it');
  });

  it('does not follow the element of an entry drawn before earlier messages loaded', () => {
    const els = Array.from({ length: 4 }, element);
    const p = page([msg('human', 'Continue', els[2]), msg('assistant', 'Done.', els[3])]);
    const { revision, messages } = p.index.snapshot();
    p.state.messages = [msg('human', 'Continue', els[0]), msg('assistant', 'Done.', els[1]), ...p.state.messages];
    p.index.refresh();
    for (const shown of messages) {
      const went = go(p.index, shown.key, revision)!;
      assert.ok(!navigates(went.resolution), `${shown.key}: ${went.resolution.status}`);
      assert.equal(went.message, null);
    }
    const now = p.index.snapshot();
    const fresh = go(p.index, now.messages[2]!.key, now.revision)!;
    assert.deepEqual([fresh.stale, fresh.message?.element === els[2]], [false, true], 'the updated list reaches it by live identity');
  });
});

describe('LiveIndex: a changed element mapping invalidates the click (review receipt codex-20261030T071243Z-520675)', () => {
  const exchanges = (els: Element[]) => [msg('human', 'Continue', els[0]), msg('assistant', 'Done.', els[1]), msg('human', 'Continue', els[2]), msg('assistant', 'Done.', els[3])];
  /** The loaded window slides back: an older identical pair loads, the earlier pair keeps its elements, the later pair is detached. */
  const slideBack = (els: Element[]) => {
    detach(els[2]!);
    detach(els[3]!);
    return [msg('human', 'Continue'), msg('assistant', 'Done.'), msg('human', 'Continue', els[0]), msg('assistant', 'Done.', els[1])];
  };
  const shape = (t: Targeted) => JSON.stringify({ stale: t.stale, status: t.resolution.status, hasMessage: t.message !== null });

  it('the review probe: the later "Continue", clicked after the window slid back, is not exact to the earlier one', () => {
    const els = Array.from({ length: 4 }, element);
    const p = page(exchanges(els));
    const { revision, messages } = p.index.snapshot();
    const key = messages[2]!.key;
    const saved = p.index.anchorFor(key, undefined, revision)!;
    p.state.messages = slideBack(els);

    const before = p.index.target(key, revision)!;
    assert.deepEqual([before.stale, before.resolution.status, before.message], [false, 'unresolved', null], 'the page check refuses');

    const after = go(p.index, key, revision)!;
    assert.ok(!navigates(after.resolution), `a12b193: ${shape(after)} at index 2, the earlier pair's prompt`);
    assert.equal(after.message, null);
    assert.equal(after.stale, true);
    assert.equal(after.resolution.status, 'ambiguous');
    assert.deepEqual(after.resolution, p.index.locate(saved).resolution, 'the same answer as the saved anchor');
    assert.equal(before.differs, true, 'the refusal is reported, so the retry is resolved by anchor');
  });

  it('the review probe with the refresh before the click: the refresh starts a new generation and the click is found again only by its anchor', () => {
    const els = Array.from({ length: 4 }, element);
    const p = page(exchanges(els));
    const { revision, messages } = p.index.snapshot();
    const saved = p.index.anchorFor(messages[2]!.key, undefined, revision)!;
    p.state.messages = slideBack(els);
    assert.equal(p.index.refresh(), true, 'a12b193: false, the element change was discarded');
    assert.equal(p.index.snapshot().revision, revision + 1);

    for (const shown of messages) {
      const went = go(p.index, shown.key, revision)!;
      assert.equal(went.stale, true);
      assert.ok(!navigates(went.resolution), `${shown.key}: ${shape(went)}`);
      assert.equal(went.message, null);
    }
    assert.deepEqual(go(p.index, messages[2]!.key, revision)!.resolution, p.index.locate(saved).resolution);

    // The updated list names what the page shows now: its third entry is the page's third message.
    const now = p.index.snapshot();
    const fresh = go(p.index, now.messages[2]!.key, now.revision)!;
    assert.deepEqual([fresh.stale, fresh.message?.element === els[0]], [false, true]);
  });

  it('a refresh that finds the same messages in other elements starts a new generation', () => {
    const p = page([
      msg('human', 'How do I migrate the users table?'),
      msg('assistant', 'Use the expand and contract pattern: add new columns, dual-write, backfill, then switch reads.'),
      msg('human', 'How large should the batches be?'),
      msg('assistant', 'Start with 10 000 rows and measure lock time.'),
    ]);
    const { revision, messages } = p.index.snapshot();
    assert.equal(p.index.refresh(), false, 'an unchanged page keeps its generation');
    p.state.messages = p.state.messages.map((m) => ({ ...m, element: element() }));
    assert.equal(p.index.refresh(), true);
    const now = p.index.snapshot();
    assert.deepEqual([now.revision, now.messages.map((m) => m.key)], [revision + 1, messages.map((m) => m.key)]);

    const old = go(p.index, messages[1]!.key, revision)!;
    assert.deepEqual([old.stale, old.resolution.status, old.message?.element === p.state.messages[1]!.element], [true, 'exact', true], 'both neighbours confirm it');
    const fresh = go(p.index, now.messages[0]!.key, now.revision)!;
    assert.deepEqual([fresh.stale, fresh.message?.element === p.state.messages[0]!.element], [false, true]);
  });

  it('a retry after a detected mismatch is resolved by its anchor even when the generation is unchanged', () => {
    const els = Array.from({ length: 4 }, element);
    const p = page(exchanges(els));
    const { revision, messages } = p.index.snapshot();
    const retried = p.index.target(messages[2]!.key, revision, true)!;
    assert.deepEqual([retried.stale, retried.resolution.status, retried.message], [true, 'ambiguous', null], 'a12b193: exact index 2');

    const unique = page([msg('human', 'Plan the migration.'), msg('assistant', 'Expand, then contract.'), msg('human', 'And the batches?')]);
    const list = unique.index.snapshot();
    const confirmed = unique.index.target(list.messages[1]!.key, list.revision, true)!;
    assert.deepEqual([confirmed.stale, confirmed.resolution.status, confirmed.message?.element === unique.state.messages[1]!.element], [true, 'exact', true]);
  });
});
