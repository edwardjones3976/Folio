// Resolves a stored MessageAnchor against the messages Folio currently knows.
// Resolution never trusts position alone: a target must match by content digest,
// or by a sufficiently long unique text prefix (reported as "changed").
import type { MessageAnchor, Resolution, Role } from './types.ts';

export interface AnchorCandidate {
  role: Role;
  digest: string;
  occurrence: number;
  /** Position among loaded messages, or -1 when the message is not loaded. */
  ordinal: number;
  text: string;
  rendered: boolean;
}

/** Minimum shared prefix (characters) to accept a changed message as the same one. */
export const MIN_PREFIX_MATCH = 24;

function sharedPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

function closestByOrdinal(indices: number[], candidates: readonly AnchorCandidate[], ordinal: number): number {
  return indices.reduce((best, i) =>
    Math.abs(candidates[i]!.ordinal - ordinal) < Math.abs(candidates[best]!.ordinal - ordinal) ? i : best,
  );
}

export function resolveAnchor(
  anchor: MessageAnchor,
  conversationId: string | null,
  candidates: readonly AnchorCandidate[],
): Resolution {
  if (conversationId !== anchor.conversationId) {
    return { status: 'unresolved', reason: 'other-conversation', note: 'This bookmark belongs to a different claude.ai conversation.' };
  }

  const sameDigest = candidates
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.role === anchor.role && c.digest === anchor.digest);
  if (sameDigest.length > 0) {
    const loaded = sameDigest.filter(({ c }) => c.rendered);
    if (loaded.length === 0) {
      return {
        status: 'unresolved',
        reason: 'not-loaded',
        note: 'The message was seen earlier but is not loaded in the page now. Scroll the chat to load it, then try again.',
      };
    }
    const byOccurrence = loaded.find(({ c }) => c.occurrence === anchor.occurrence);
    if (byOccurrence) {
      const note = loaded.length > 1 ? `${loaded.length} loaded messages have identical text; matched by occurrence.` : undefined;
      return note ? { status: 'exact', index: byOccurrence.i, note } : { status: 'exact', index: byOccurrence.i };
    }
    const index = closestByOrdinal(loaded.map(({ i }) => i), candidates, anchor.ordinal);
    return { status: 'exact', index, note: 'Identical text appears more than once; matched the nearest position.' };
  }

  const prefix = anchor.prefix;
  const byPrefix = candidates
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.role === anchor.role && c.rendered)
    .filter(({ c }) => {
      const shared = sharedPrefixLength(prefix, c.text);
      return shared >= Math.min(MIN_PREFIX_MATCH, prefix.length) && shared >= Math.min(prefix.length, c.text.length) * 0.6 && shared > 0;
    });
  if (byPrefix.length === 1) {
    return {
      status: 'changed',
      index: byPrefix[0]!.i,
      note: 'The message text differs from when it was saved (edited, regenerated or still streaming); matched by its opening text.',
    };
  }
  if (byPrefix.length > 1) {
    return {
      status: 'unresolved',
      reason: 'ambiguous',
      note: `${byPrefix.length} messages start the same way and none matches exactly; Folio will not guess.`,
    };
  }
  return {
    status: 'unresolved',
    reason: 'not-found',
    note: 'No loaded message matches. It may be on another branch, not loaded yet, edited, or deleted.',
  };
}
