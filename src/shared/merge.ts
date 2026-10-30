// Keeps track of messages that were seen earlier in this page session but are no
// longer in the DOM (for example removed by list virtualization), so coverage can
// report them instead of silently forgetting them.

export interface Mergeable {
  /** Content identity (`role:digest`). Identical messages share it. */
  id: string;
  rendered: boolean;
}

/**
 * Where the loaded window sits in the known list: the offset (known index minus
 * loaded index) of the longest run of consecutive identical messages. Identical
 * messages elsewhere cannot outvote a longer run. Returns null when nothing
 * matches or two different offsets tie, so a duplicate is never guessed into
 * place.
 */
function alignment(known: readonly Mergeable[], current: readonly Mergeable[]): number | null {
  const positions = new Map<string, number[]>();
  known.forEach((item, j) => positions.set(item.id, [...(positions.get(item.id) ?? []), j]));
  const longest = new Map<number, number>();
  let previous = new Map<number, number>();
  current.forEach((item, i) => {
    const runs = new Map<number, number>();
    for (const j of positions.get(item.id) ?? []) {
      const run = (previous.get(j - 1) ?? 0) + 1;
      runs.set(j, run);
      if (run > (longest.get(j - i) ?? 0)) longest.set(j - i, run);
    }
    previous = runs;
  });
  let best = 0;
  let offset: number | null = null;
  let tied = false;
  for (const [candidate, run] of longest) {
    if (run > best) {
      best = run;
      offset = candidate;
      tied = false;
    } else if (run === best) {
      tied = true;
    }
  }
  return tied ? null : offset;
}

/**
 * Merges the currently loaded messages (`current`, in page order) into the
 * previously known list.
 *
 * - Loaded messages keep their page order and replace the known messages they
 *   line up with.
 * - A previously known message that is no longer loaded is kept (marked not
 *   rendered) only when it lies outside the loaded window AND the loaded message
 *   at that boundary is the same message as before. That is the shape of
 *   virtualization: the window slides, the boundary message stays the same.
 * - Missing messages inside the window, or beyond a boundary message that is new
 *   (a reply that is still streaming, an edit or a retry replaced it), are
 *   dropped instead of being reported as still existing. So is everything else
 *   when the window cannot be placed unambiguously.
 */
export function mergeLoaded<T extends Mergeable>(known: readonly T[], current: readonly T[]): T[] {
  if (current.length === 0) return known.map((item) => ({ ...item, rendered: false }));
  const loaded = current.map((item) => ({ ...item, rendered: true }));
  const offset = alignment(known, current);
  if (offset === null) return loaded;
  const end = offset + current.length;
  const before = offset > 0 && known[offset]!.id === current[0]!.id ? known.slice(0, offset) : [];
  const after = end < known.length && known[end - 1]?.id === current[current.length - 1]!.id ? known.slice(end) : [];
  const unloaded = (item: T): T => ({ ...item, rendered: false });
  return [...before.map(unloaded), ...loaded, ...after.map(unloaded)];
}
