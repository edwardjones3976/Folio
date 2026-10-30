import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MIN_PREFIX_MATCH, resolveAnchor } from '../../src/shared/anchors.ts';
import type { AnchorCandidate } from '../../src/shared/anchors.ts';
import { anchorPrefix, digest } from '../../src/shared/text.ts';
import type { MessageAnchor, Resolution, Role } from '../../src/shared/types.ts';

const CONV = 'abcdef12-3456';

type Msg = [Role, string] | [Role, string, 'not-loaded'];

/** Known messages in order, with neighbours (`role:digest`) computed the way the live index does. */
function known(messages: Msg[]): AnchorCandidate[] {
  const ids = messages.map(([role, text]) => `${role}:${digest(text)}`);
  return messages.map(([role, text, loaded], i) => ({
    role,
    text,
    digest: digest(text),
    rendered: loaded !== 'not-loaded',
    before: ids[i - 1] ?? null,
    after: ids[i + 1] ?? null,
  }));
}

/** The anchor the live index would save for message `index` of `messages`. */
function anchorAt(messages: Msg[], index: number): MessageAnchor {
  const target = known(messages)[index]!;
  return {
    provider: 'claude.ai',
    conversationId: CONV,
    role: target.role,
    digest: target.digest,
    occurrence: 0,
    ordinal: index,
    prefix: anchorPrefix(target.text),
    context: { before: target.before, after: target.after },
  };
}

const at = (r: Resolution) => (r.status === 'exact' || r.status === 'changed' ? r.index : null);
const reason = (r: Resolution) => (r.status === 'unresolved' ? r.reason : null);

const answer = 'Use the expand and contract pattern: add new columns, dual-write, backfill, then switch reads.';
const chat: Msg[] = [
  ['human', 'How do I migrate the users table?'],
  ['assistant', answer],
  ['human', 'Continue'],
  ['assistant', 'Step two: backfill in batches of 10 000 rows.'],
  ['human', 'Continue'],
  ['assistant', 'Step three: switch reads behind a flag.'],
];

describe('resolveAnchor', () => {
  it('resolves by content and context even when the position changed', () => {
    const anchor = anchorAt(chat, 1);
    const result = resolveAnchor(anchor, CONV, known([['human', 'A newly loaded earlier prompt'], ['assistant', 'x'], ...chat]));
    assert.deepEqual(result, { status: 'exact', index: 3 });
  });

  it('refuses anchors from another conversation', () => {
    const result = resolveAnchor(anchorAt(chat, 1), 'other-conversation', known(chat));
    assert.equal(reason(result), 'other-conversation');
  });

  it('tells identical messages apart by the messages around them', () => {
    const first = resolveAnchor(anchorAt(chat, 2), CONV, known(chat));
    const second = resolveAnchor(anchorAt(chat, 4), CONV, known(chat));
    assert.deepEqual([first.status, at(first)], ['exact', 2]);
    assert.deepEqual([second.status, at(second)], ['exact', 4]);
  });

  it('reports a message seen earlier but not loaded now', () => {
    const list: Msg[] = chat.map(([role, text], i) => (i < 2 ? [role, text, 'not-loaded'] : [role, text]));
    assert.equal(reason(resolveAnchor(anchorAt(chat, 1), CONV, known(list))), 'not-loaded');
  });

  it('accepts an edited or still-streaming message by its opening text, labelled as changed', () => {
    const edited: Msg[] = [chat[0]!, ['assistant', `${answer} Also add a feature flag.`]];
    const result = resolveAnchor(anchorAt(chat, 1), CONV, known(edited));
    assert.deepEqual([result.status, at(result)], ['changed', 1]);
  });

  it('refuses to guess when several messages share the opening text', () => {
    const variants: Msg[] = [
      chat[0]!,
      ['assistant', `${answer} Variant A with more words.`],
      chat[2]!,
      chat[0]!,
      ['assistant', `${answer} Variant B with more words.`],
      chat[2]!,
    ];
    assert.equal(resolveAnchor(anchorAt(chat, 1), CONV, known(variants)).status, 'ambiguous');
  });

  it('does not match short unrelated messages that share a few characters', () => {
    const saved: Msg[] = [['assistant', 'Yes, that works well for small tables.']];
    const result = resolveAnchor(anchorAt(saved, 0), CONV, known([['assistant', 'Yes, but consider the index first.']]));
    assert.equal(reason(result), 'not-found');
  });

  it('never resolves by position alone', () => {
    const result = resolveAnchor(anchorAt(chat, 1), CONV, known([chat[0]!, ['assistant', 'Completely different reply text here.']]));
    assert.equal(result.status, 'unresolved');
  });

  it('does not match across roles', () => {
    const result = resolveAnchor(anchorAt(chat, 1), CONV, known([['human', answer]]));
    assert.equal(result.status, 'unresolved');
  });
});

describe('resolveAnchor: duplicates on partially loaded pages (review finding 1)', () => {
  it('does not report the earlier "Continue" as exact when only it is loaded (the review probe)', () => {
    const anchor = anchorAt(chat, 4);
    const onlyEarlier = resolveAnchor(anchor, CONV, known([['human', 'Continue']]));
    assert.equal(onlyEarlier.status, 'ambiguous');
    assert.equal(at(onlyEarlier), null);
  });

  it('does not report it as exact when the page starts mid-conversation at the earlier copy', () => {
    const result = resolveAnchor(anchorAt(chat, 4), CONV, known(chat.slice(2, 4)));
    assert.equal(result.status, 'ambiguous');
  });

  it('reports a copy whose previous message differs as a different message', () => {
    const result = resolveAnchor(anchorAt(chat, 4), CONV, known(chat.slice(0, 4)));
    assert.equal(reason(result), 'not-found');
  });

  it('is ambiguous, never exact, when identical messages also have identical neighbours', () => {
    const loop: Msg[] = [
      ['human', 'Continue'],
      ['assistant', 'Done.'],
      ['human', 'Continue'],
      ['assistant', 'Done.'],
      ['human', 'Continue'],
      ['assistant', 'Done.'],
    ];
    assert.equal(resolveAnchor(anchorAt(loop, 2), CONV, known(loop)).status, 'ambiguous');
  });

  it('confirms the head of a mid-conversation page by the next message', () => {
    const result = resolveAnchor(anchorAt(chat, 4), CONV, known(chat.slice(4)));
    assert.deepEqual([result.status, at(result)], ['exact', 0]);
  });

  it('never reports anchors saved without context as exact', () => {
    const { context: _context, ...legacy } = anchorAt(chat, 1);
    assert.equal(resolveAnchor(legacy, CONV, known(chat)).status, 'ambiguous');
  });
});

describe('resolveAnchor: short messages (review finding 2)', () => {
  it('does not take "Nothing else is required" for a missing "No" (the review probe)', () => {
    const saved: Msg[] = [['human', 'Should I add an index?'], ['assistant', 'No']];
    const page: Msg[] = [['human', 'Should I add an index?'], ['assistant', 'Nothing else is required']];
    const result = resolveAnchor(anchorAt(saved, 1), CONV, known(page));
    assert.equal(reason(result), 'not-found');
  });

  it(`needs ${MIN_PREFIX_MATCH} identical opening characters for "changed", whatever the saved length`, () => {
    const short = 'Short reply of 23 chars';
    assert.equal(short.length, MIN_PREFIX_MATCH - 1);
    const saved: Msg[] = [['assistant', short]];
    assert.equal(reason(resolveAnchor(anchorAt(saved, 0), CONV, known([['assistant', `${short} and more`]]))), 'not-found');
    const exact = resolveAnchor(anchorAt(saved, 0), CONV, known([['human', 'q'], ['assistant', short]]));
    assert.equal(exact.status, 'ambiguous', 'a short exact match still needs a confirming neighbour');
  });
});
