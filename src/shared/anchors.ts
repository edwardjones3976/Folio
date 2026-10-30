// Resolves a stored MessageAnchor against the messages Folio currently knows.
//
// Like a W3C Web Annotation TextQuoteSelector (exact text plus the text before
// and after it), an anchor is the message's content digest plus the identity of
// the messages around it. When both sides are known, both must agree. Position
// is never used.
// - A side (the previous or the next message) that both the anchor and the
//   candidate name, and that differs, rules the candidate out.
// - "exact" needs identical text, exactly one candidate left, and both sides
//   matching. There are no exceptions. A side where nothing was known when the
//   anchor was made (the first or latest known message) can never be matched:
//   Folio cannot tell that claude.ai has loaded the whole conversation, so
//   "nothing there" is never confirmed, and a copy of the same text that was
//   never loaded could fit as well. A side that is unknown because the page has
//   not loaded it never counts either.
// - A single remaining candidate without that confirmation is "probable": it is
//   reported, never jumped to. Several are "ambiguous".
// - "changed" (a message whose text differs) needs at least MIN_PREFIX_MATCH
//   identical opening characters plus the same neighbour confirmation, so short
//   messages, and anchors saved without context, never match as changed.
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

/**
 * One side of a candidate compared with the anchor:
 * - 'match' / 'conflict': both name a message there, the same one or not;
 * - 'unsaved': nothing was known on that side when the anchor was made;
 * - 'unloaded': the anchor names a message there, but none is known there now.
 */
type Side = 'match' | 'conflict' | 'unsaved' | 'unloaded';

interface Scored {
  index: number;
  candidate: AnchorCandidate;
  before: Side;
  after: Side;
}

const NOT_LOADED: Resolution = {
  status: 'unresolved',
  reason: 'not-loaded',
  note: 'The message was seen earlier but is not loaded in the page now. Scroll the chat to load it, then try again.',
};

const NOT_FOUND: Resolution = {
  status: 'unresolved',
  reason: 'not-found',
  note: 'No loaded message matches. It may be on another branch, not loaded yet, edited, or deleted.',
};

const LEGACY: Resolution = {
  status: 'ambiguous',
  note: 'This bookmark was saved by an earlier Folio version without the surrounding messages needed to confirm it. Bookmark the message again.',
};

function compare(saved: string | null | undefined, now: string | null): Side {
  if (!saved) return 'unsaved';
  if (!now) return 'unloaded';
  return saved === now ? 'match' : 'conflict';
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

const conflicts = (s: Scored) => s.before === 'conflict' || s.after === 'conflict';

/** True when the neighbours identify the only remaining candidate: both sides match (rules at the top of this file). */
function confirmed(s: Scored): boolean {
  return s.before === 'match' && s.after === 'match';
}

/** Why the only remaining candidate is not confirmed, in the user's terms. */
function unconfirmedReason(s: Scored): string {
  const unloaded = [s.before === 'unloaded' ? 'before' : '', s.after === 'unloaded' ? 'after' : ''].filter(Boolean);
  if (unloaded.length > 0) {
    return `the message ${unloaded.join(' and ')} it is not loaded, so Folio cannot compare it with the saved one. Scroll the chat to load the messages around it, then try again`;
  }
  if (s.before !== 'match' && s.after !== 'match') return 'no message next to it was known when this was saved, so nothing can confirm it';
  const [side, other] = s.before === 'match' ? ['before', 'after'] : ['after', 'before'];
  return `only the message ${side} it can be compared. No message ${other} it was known when this was saved, and Folio confirms a message only when the messages on both sides of it match`;
}

function resolveIdentical(same: readonly Scored[]): Resolution {
  const viable = same.filter((s) => !conflicts(s));
  if (viable.length === 0) {
    return {
      status: 'unresolved',
      reason: 'not-found',
      note: same.every((s) => s.before === 'conflict')
        ? 'A message with the same text is in the page, but the message before it differs, so it is a different message. The saved one may be on another branch or not loaded.'
        : 'A message with the same text is in the page, but the message after it differs from when this was saved. It may be another copy of the same text, or the conversation after it was edited or regenerated; Folio will not guess.',
    };
  }
  if (viable.length > 1) {
    if (viable.every((s) => !s.candidate.rendered)) return NOT_LOADED;
    return {
      status: 'ambiguous',
      note: `${viable.length} messages have identical text, and the messages around them do not tell them apart; Folio will not guess which one was saved.`,
    };
  }
  const only = viable[0]!;
  if (!confirmed(only)) {
    return { status: 'probable', index: only.index, note: `One message has the saved text, but ${unconfirmedReason(only)}.` };
  }
  if (!only.candidate.rendered) return NOT_LOADED;
  return same.length > 1
    ? { status: 'exact', index: only.index, note: `${same.length} messages have identical text; matched by the messages around it.` }
    : { status: 'exact', index: only.index };
}

function resolveChanged(anchor: MessageAnchor, candidates: readonly AnchorCandidate[]): Resolution {
  if (anchor.prefix.length < MIN_PREFIX_MATCH) return NOT_FOUND;
  const viable = score(anchor, candidates, (c) => c.role === anchor.role && similarOpening(anchor.prefix, c.text)).filter((s) => !conflicts(s));
  if (viable.length === 0) return NOT_FOUND;
  if (viable.length > 1) {
    if (viable.every((s) => !s.candidate.rendered)) return NOT_LOADED;
    return { status: 'ambiguous', note: `${viable.length} messages start the same way and none matches exactly; Folio will not guess.` };
  }
  const only = viable[0]!;
  if (!confirmed(only)) {
    return {
      status: 'probable',
      index: only.index,
      note: `One message starts the same way but its text differs, and ${unconfirmedReason(only)}.`,
    };
  }
  if (!only.candidate.rendered) return NOT_LOADED;
  return {
    status: 'changed',
    index: only.index,
    note: 'The message text differs from when it was saved (edited, regenerated or still streaming); matched by its opening text and the messages around it.',
  };
}

export function resolveAnchor(anchor: MessageAnchor, conversationId: string | null, candidates: readonly AnchorCandidate[]): Resolution {
  if (conversationId !== anchor.conversationId) {
    return { status: 'unresolved', reason: 'other-conversation', note: 'This bookmark belongs to a different claude.ai conversation.' };
  }
  const same = score(anchor, candidates, (c) => c.role === anchor.role && c.digest === anchor.digest);
  if (!anchor.context) {
    // Without context nothing can confirm a match, whether the text is identical or changed.
    const similar = anchor.prefix.length >= MIN_PREFIX_MATCH && candidates.some((c) => c.role === anchor.role && similarOpening(anchor.prefix, c.text));
    return same.length > 0 || similar ? LEGACY : NOT_FOUND;
  }
  return same.length > 0 ? resolveIdentical(same) : resolveChanged(anchor, candidates);
}
