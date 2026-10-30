import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveAnchor } from '../../src/shared/anchors.ts';
import type { AnchorCandidate } from '../../src/shared/anchors.ts';
import { anchorPrefix, digest } from '../../src/shared/text.ts';
import type { MessageAnchor, Role } from '../../src/shared/types.ts';

const CONV = 'abcdef12-3456';

function candidate(role: Role, text: string, ordinal: number, occurrence = 0, rendered = true): AnchorCandidate {
  return { role, text, digest: digest(text), occurrence, ordinal: rendered ? ordinal : -1, rendered };
}

function anchorOf(role: Role, text: string, ordinal: number, occurrence = 0): MessageAnchor {
  return { provider: 'claude.ai', conversationId: CONV, role, digest: digest(text), occurrence, ordinal, prefix: anchorPrefix(text) };
}

const answer = 'Use the expand and contract pattern: add new columns, dual-write, backfill, then switch reads.';

describe('resolveAnchor', () => {
  it('resolves by digest even when the position changed', () => {
    const list = [candidate('human', 'new earlier prompt', 0), candidate('assistant', 'x', 1), candidate('assistant', answer, 2)];
    const result = resolveAnchor(anchorOf('assistant', answer, 0), CONV, list);
    assert.deepEqual(result, { status: 'exact', index: 2 });
  });

  it('refuses anchors from another conversation', () => {
    const result = resolveAnchor(anchorOf('assistant', answer, 0), 'other-conversation', [candidate('assistant', answer, 0)]);
    assert.equal(result.status, 'unresolved');
    assert.equal(result.status === 'unresolved' && result.reason, 'other-conversation');
  });

  it('uses occurrence to pick among identical messages', () => {
    const list = [candidate('human', 'Continue', 0, 0), candidate('assistant', 'one', 1), candidate('human', 'Continue', 2, 1)];
    const result = resolveAnchor(anchorOf('human', 'Continue', 2, 1), CONV, list);
    assert.equal(result.status, 'exact');
    assert.equal(result.status === 'exact' && result.index, 2);
  });

  it('reports a message seen earlier but not loaded now', () => {
    const result = resolveAnchor(anchorOf('assistant', answer, 5), CONV, [candidate('assistant', answer, 5, 0, false)]);
    assert.equal(result.status === 'unresolved' && result.reason, 'not-loaded');
  });

  it('accepts an edited or still-streaming message by its opening text, labelled as changed', () => {
    const edited = `${answer} Also add a feature flag.`;
    const result = resolveAnchor(anchorOf('assistant', answer, 1), CONV, [candidate('assistant', edited, 1)]);
    assert.equal(result.status, 'changed');
  });

  it('refuses to guess when several messages share the opening text', () => {
    const a = `${answer} Variant A with more words.`;
    const b = `${answer} Variant B with more words.`;
    const result = resolveAnchor(anchorOf('assistant', answer, 1), CONV, [candidate('assistant', a, 0), candidate('assistant', b, 1)]);
    assert.equal(result.status === 'unresolved' && result.reason, 'ambiguous');
  });

  it('does not match short unrelated messages that share a few characters', () => {
    const result = resolveAnchor(anchorOf('assistant', 'Yes, that works well for small tables.', 0), CONV, [
      candidate('assistant', 'Yes, but consider the index first.', 0),
    ]);
    assert.equal(result.status === 'unresolved' && result.reason, 'not-found');
  });

  it('never resolves by position alone', () => {
    const result = resolveAnchor(anchorOf('assistant', answer, 1), CONV, [candidate('human', 'q', 0), candidate('assistant', 'Completely different reply text here.', 1)]);
    assert.equal(result.status, 'unresolved');
  });

  it('does not match across roles', () => {
    const result = resolveAnchor(anchorOf('human', answer, 0), CONV, [candidate('assistant', answer, 0)]);
    assert.equal(result.status, 'unresolved');
  });
});
