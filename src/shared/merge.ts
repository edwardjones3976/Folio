// Keeps track of messages that were seen earlier in this page session but are no
// longer in the DOM (for example removed by list virtualization), so coverage can
// report them instead of silently forgetting them.

export interface Mergeable {
  key: string;
  rendered: boolean;
}

/**
 * Merges the currently loaded messages (`current`, in page order) into the
 * previously known list.
 *
 * - Loaded messages keep their page order.
 * - A previously known message that is no longer loaded is kept (marked not
 *   rendered) only when it lies outside the loaded range AND the loaded message
 *   at that boundary was itself already known. That is the shape of
 *   virtualization: the window slides, the boundary message stays the same.
 * - Missing messages inside the loaded range, or beyond a boundary message that
 *   is new (a reply that is still streaming, an edit or a retry replaced it), are
 *   dropped instead of being reported as still existing.
 */
export function mergeLoaded<T extends Mergeable>(known: readonly T[], current: readonly T[]): T[] {
  const result: T[] = known.map((item) => ({ ...item, rendered: false }));
  const matched = new Set<T>();
  let pos = -1;
  for (const item of current) {
    let idx = -1;
    for (let i = pos + 1; i < result.length; i++) {
      if (!result[i]!.rendered && result[i]!.key === item.key) {
        idx = i;
        break;
      }
    }
    const next = { ...item, rendered: true };
    if (idx >= 0) {
      result[idx] = next;
      matched.add(next);
      pos = idx;
    } else {
      result.splice(pos + 1, 0, next);
      pos += 1;
    }
  }

  const first = result.findIndex((item) => item.rendered);
  if (first < 0) return result;
  let last = first;
  result.forEach((item, i) => {
    if (item.rendered) last = i;
  });
  const keepBefore = matched.has(result[first]!);
  const keepAfter = matched.has(result[last]!);
  return result.filter((item, i) => item.rendered || (i < first && keepBefore) || (i > last && keepAfter));
}
