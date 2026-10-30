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
  const all = known(messages);
  const target = all[index]!;
  return {
    provider: 'claude.ai',
    conversationId: CONV,
    role: target.role,
    digest: target.digest,
    occurrence: 0,
    ordinal: index,
    prefix: anchorPrefix(target.text),
    context: { before: target.before, after: target.after },
    copies: all.filter((c) => c.role === target.role && c.digest === target.digest).length,
  };
}

/** The index of the message a jump would navigate to; null when it would not navigate. */
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

  it('accepts a message that kept streaming after it was saved by its opening text, labelled as changed', () => {
    const saved: Msg[] = [chat[0]!, ['assistant', answer.slice(0, 60)]];
    const now: Msg[] = [chat[0]!, ['assistant', answer], chat[2]!];
    const result = resolveAnchor(anchorAt(saved, 1), CONV, known(now));
    assert.deepEqual([result.status, at(result)], ['changed', 1]);
  });

  it('accepts a changed message whose neighbours both still match, labelled as changed', () => {
    const edited: Msg[] = [chat[0]!, ['assistant', `${answer} Also add a feature flag.`], chat[2]!];
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
    assert.equal(onlyEarlier.status, 'probable');
    assert.equal(at(onlyEarlier), null);
  });

  it('does not report it as exact when the page starts mid-conversation at the earlier copy', () => {
    const result = resolveAnchor(anchorAt(chat, 4), CONV, known(chat.slice(2, 4)));
    assert.equal(reason(result), 'not-found', 'the message after the earlier copy differs from the saved one');
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

  it('does not confirm the head of a mid-conversation page by the next message alone', () => {
    const result = resolveAnchor(anchorAt(chat, 4), CONV, known(chat.slice(4)));
    assert.equal(result.status, 'probable', 'the saved previous message is not loaded, so it cannot be compared');
    assert.equal(at(result), null);
  });

  it('never reports anchors saved without context as exact', () => {
    const { context: _context, ...legacy } = anchorAt(chat, 1);
    assert.equal(resolveAnchor(legacy, CONV, known(chat)).status, 'ambiguous');
  });
});

describe('resolveAnchor: both neighbours must agree (review finding 1, correction 2)', () => {
  // The two review probes, rebuilt as the live index would see them.
  const prompt = 'Summarize the incident report in two lines.';
  const reply = 'The deploy failed at 14:02. It was rolled back at 14:09.';
  const repeated: Msg[] = [
    ['human', prompt],
    ['assistant', reply],
    ['human', 'Who approved the deploy?'],
    ['assistant', 'Nobody; the pipeline ran on merge.'],
    ['human', prompt],
    ['assistant', reply],
    ['human', 'Write the follow-up email.'],
  ];
  const loop: Msg[] = [
    ['human', 'Continue'],
    ['assistant', 'Done.'],
    ['human', 'Continue'],
    ['assistant', 'Done.'],
  ];

  it('probe 1: the second identical reply is not exact on a page holding only the earlier exchange and its different follow-up', () => {
    const anchor = anchorAt(repeated, 5);
    const result = resolveAnchor(anchor, CONV, known(repeated.slice(0, 3)));
    assert.notEqual(result.status, 'exact');
    assert.equal(at(result), null);
    assert.equal(reason(result), 'not-found', 'a conflicting next message rules the earlier copy out');
  });

  it('probe 1 without the follow-up loaded: only one side can be compared, so it is at most probable', () => {
    const result = resolveAnchor(anchorAt(repeated, 5), CONV, known(repeated.slice(0, 2)));
    assert.equal(result.status, 'probable');
    assert.equal(at(result), null);
  });

  it('probe 2: the later "Continue" is not exact when only the earlier "Continue"/"Done." pair is loaded', () => {
    const result = resolveAnchor(anchorAt(loop, 2), CONV, known(loop.slice(0, 2)));
    assert.notEqual(result.status, 'exact');
    assert.equal(result.status, 'probable');
    assert.equal(at(result), null);
  });

  it('still finds the saved copy when the whole conversation is loaded', () => {
    const result = resolveAnchor(anchorAt(repeated, 5), CONV, known(repeated));
    assert.deepEqual([result.status, at(result)], ['exact', 5]);
  });

  it('is ambiguous when a fully confirmed copy has another copy whose unknown side might also match', () => {
    // The page starts at the saved "Continue" (true position 2): its previous message is not loaded.
    const longer: Msg[] = [...loop, ['human', 'Continue'], ['assistant', 'Done.']];
    const result = resolveAnchor(anchorAt(longer, 2), CONV, known(longer.slice(2)));
    assert.equal(result.status, 'ambiguous');
  });

  it('confirms the latest reply by the message before it when nothing followed it and its text was unique', () => {
    const anchor = anchorAt([chat[0]!, chat[1]!], 1);
    assert.deepEqual([anchor.context, anchor.copies], [{ before: `human:${digest(chat[0]![1])}`, after: null }, 1]);
    const continued = resolveAnchor(anchor, CONV, known(chat));
    assert.deepEqual([continued.status, at(continued)], ['exact', 1]);
  });

  it('confirms the first known message by the message after it when nothing was known before it and its text was unique', () => {
    const anchor = anchorAt(chat.slice(4), 0);
    assert.equal(anchor.copies, 1);
    const result = resolveAnchor(anchor, CONV, known(chat));
    assert.deepEqual([result.status, at(result)], ['exact', 4]);
  });

  it('never confirms by one side when other copies of the text were known when it was saved', () => {
    // The latest "Continue", saved while an earlier one was known: nothing was known after it.
    const anchor = anchorAt(loop.slice(0, 3), 2);
    assert.deepEqual([anchor.context?.after, anchor.copies], [null, 2]);
    const page = known(loop.slice(1, 3));
    assert.equal(resolveAnchor(anchor, CONV, page).status, 'probable');
    assert.equal(resolveAnchor({ ...anchor, copies: 1 }, CONV, page).status, 'exact', 'the same evidence suffices for text that was unique');
  });

  it('never confirms by one side when the anchor does not record how many copies there were', () => {
    const { copies: _copies, ...older } = anchorAt([chat[0]!, chat[1]!], 1);
    const result = resolveAnchor(older, CONV, known(chat));
    assert.equal(result.status, 'probable');
    assert.equal(at(result), null);
  });

  it('does not confirm a message when no message next to it was known when it was saved', () => {
    const result = resolveAnchor(anchorAt([chat[1]!], 0), CONV, known(chat));
    assert.equal(result.status, 'probable');
  });

  it('applies the same rules to changed text: a conflicting next message rules it out', () => {
    const anchor = anchorAt(repeated, 5);
    const edited: Msg[] = [repeated[0]!, ['assistant', `${reply} Root cause: an expired certificate.`], repeated[2]!];
    assert.equal(reason(resolveAnchor(anchor, CONV, known(edited))), 'not-found');
  });

  it('never matches changed text for anchors saved without context (README: legacy bookmarks)', () => {
    const { context: _context, ...legacy } = anchorAt(chat, 1);
    const edited: Msg[] = [chat[0]!, ['assistant', `${answer} Also add a feature flag.`], chat[2]!];
    const result = resolveAnchor(legacy, CONV, known(edited));
    assert.equal(result.status, 'ambiguous');
    assert.equal(at(result), null);
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
    assert.equal(exact.status, 'probable', 'a short exact match still needs a confirming neighbour');
  });
});
