// Resolves a stored MessageAnchor against the messages Folio currently knows.
//
// Like a W3C Web Annotation TextQuoteSelector (exact text plus the text before
// and after it), an anchor is the message's content digest plus the identity of
// the messages around it. Resolution follows the same order as fuzzy
// re-anchoring: exact text confirmed by context first, then a long matching
// opening ("changed"), otherwise it reports failure. Position is never used.
// - "exact" needs identical text AND a confirming neighbour. A different
//   previous message rules a candidate out: in claude.ai the messages before a
//   message never change without it becoming a different message.
// - Identical messages that context cannot tell apart are "ambiguous".
// - "changed" needs at least MIN_PREFIX_MATCH identical opening characters, so
//   short messages only ever match exactly.
import type { MessageAnchor, Resolution, Role } from './types.ts';

export interface AnchorCandidate {
  role: Role;
  digest: string;
  text: string;
  rendered: boolean;
  /** `role:digest` of the previous known message, or null when none is known. */
  before: string | null;
  /** `role:digest` of the next known message, or null when none is known. */
  after: string | null;
}

/** Minimum shared opening (characters) to accept a changed message as the same one. Never lowered. */
export const MIN_PREFIX_MATCH = 24;

export function messageId(role: Role, digest: string): string {
  return `${role}:${digest}`;
}

type Evidence = 'match' | 'mismatch' | 'unknown';

interface Scored {
  index: number;
  candidate: AnchorCandidate;
  before: Evidence;
  after: Evidence;
}

const NOT_LOADED: Resolution = {
  status: 'unresolved',
  reason: 'not-loaded',
  note: 'The message was seen earlier but is not loaded in the page now. Scroll the chat to load it, then try again.',
};

function compare(saved: string | null | undefined, now: string | null): Evidence {
  if (!saved || !now) return 'unknown';
  return saved === now ? 'match' : 'mismatch';
}

function sharedPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

function similarOpening(prefix: string, text: string): boolean {
  const shared = sharedPrefixLength(prefix, text);
  return shared >= MIN_PREFIX_MATCH && shared >= Math.min(prefix.length, text.length) * 0.6;
}

function score(anchor: MessageAnchor, candidates: readonly AnchorCandidate[], keep: (c: AnchorCandidate) => boolean): Scored[] {
  return candidates.flatMap((candidate, index) =>
    keep(candidate)
      ? [{ index, candidate, before: compare(anchor.context?.before, candidate.before), after: compare(anchor.context?.after, candidate.after) }]
      : [],
  );
}

/**
 * Candidates whose neighbours confirm them. When several do, those whose next
 * message differs are set aside only if that leaves exactly one; a neighbour
 * that is merely unknown never decides.
 */
function confirmedOf(scored: readonly Scored[]): Scored[] {
  const confirmed = scored.filter((s) => s.before === 'match' || (s.before === 'unknown' && s.after === 'match'));
  if (confirmed.length <= 1) return confirmed;
  const consistent = confirmed.filter((s) => s.after !== 'mismatch');
  return consistent.length === 1 ? consistent : confirmed;
}

function resolveIdentical(anchor: MessageAnchor, same: readonly Scored[]): Resolution {
  if (!anchor.context) {
    return {
      status: 'ambiguous',
      note: 'This bookmark was saved by an earlier Folio version without the surrounding messages needed to confirm it. Bookmark the message again.',
    };
  }
  const confirmed = confirmedOf(same);
  if (confirmed.length === 1) {
    const { index, candidate } = confirmed[0]!;
    if (!candidate.rendered) return NOT_LOADED;
    return same.length > 1
      ? { status: 'exact', index, note: `${same.length} messages have identical text; matched by the messages around it.` }
      : { status: 'exact', index };
  }
  if (confirmed.length > 1) {
    if (confirmed.every((s) => !s.candidate.rendered)) return NOT_LOADED;
    return {
      status: 'ambiguous',
      note: `${confirmed.length} messages have identical text and identical neighbouring messages; Folio will not guess which one was saved.`,
    };
  }
  if (same.every((s) => s.before === 'mismatch')) {
    return {
      status: 'unresolved',
      reason: 'not-found',
      note: 'A message with the same text is in the page, but the message before it differs, so it is a different message. The saved one may be on another branch or not loaded.',
    };
  }
  return {
    status: 'ambiguous',
    note: 'A message with the same text is in the page, but the messages around it are not loaded or have changed, so Folio cannot confirm it is the saved one. Scroll the chat to load the surrounding messages, then try again.',
  };
}

function resolveChanged(anchor: MessageAnchor, candidates: readonly AnchorCandidate[]): Resolution {
  const notFound: Resolution = {
    status: 'unresolved',
    reason: 'not-found',
    note: 'No loaded message matches. It may be on another branch, not loaded yet, edited, or deleted.',
  };
  if (anchor.prefix.length < MIN_PREFIX_MATCH) return notFound;
  const similar = score(anchor, candidates, (c) => c.role === anchor.role && c.rendered && similarOpening(anchor.prefix, c.text)).filter(
    (s) => s.before !== 'mismatch',
  );
  const chosen = similar.length > 1 ? confirmedOf(similar) : similar;
  if (chosen.length === 1) {
    return {
      status: 'changed',
      index: chosen[0]!.index,
      note: 'The message text differs from when it was saved (edited, regenerated or still streaming); matched by its opening text.',
    };
  }
  if (similar.length > 1) {
    return {
      status: 'ambiguous',
      note: `${similar.length} messages start the same way and none matches exactly; Folio will not guess.`,
    };
  }
  return notFound;
}

export function resolveAnchor(anchor: MessageAnchor, conversationId: string | null, candidates: readonly AnchorCandidate[]): Resolution {
  if (conversationId !== anchor.conversationId) {
    return { status: 'unresolved', reason: 'other-conversation', note: 'This bookmark belongs to a different claude.ai conversation.' };
  }
  const same = score(anchor, candidates, (c) => c.role === anchor.role && c.digest === anchor.digest);
  return same.length > 0 ? resolveIdentical(anchor, same) : resolveChanged(anchor, candidates);
}
