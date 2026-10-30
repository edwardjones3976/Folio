import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mergeLoaded } from '../../src/shared/merge.ts';

const item = (id: string) => ({ id, rendered: true });
const keys = (list: { id: string; rendered: boolean }[]) => list.map((i) => `${i.id}${i.rendered ? '' : '?'}`).join(' ');

describe('mergeLoaded', () => {
  it('starts from the loaded list', () => {
    assert.equal(keys(mergeLoaded([], ['a', 'b'].map(item))), 'a b');
  });

  it('keeps messages that virtualization removed from the top or bottom, marked not loaded', () => {
    const known = mergeLoaded([], ['a', 'b', 'c', 'd'].map(item));
    assert.equal(keys(mergeLoaded(known, ['c', 'd'].map(item))), 'a? b? c d');
    assert.equal(keys(mergeLoaded(known, ['a', 'b'].map(item))), 'a b c? d?');
  });

  it('places older messages loaded later before the known ones', () => {
    const known = mergeLoaded([], ['c', 'd'].map(item));
    assert.equal(keys(mergeLoaded(known, ['a', 'b', 'c', 'd'].map(item))), 'a b c d');
  });

  it('restores a message when it is loaded again', () => {
    const known = mergeLoaded(mergeLoaded([], ['a', 'b', 'c'].map(item)), ['c'].map(item));
    assert.equal(keys(mergeLoaded(known, ['a', 'b', 'c'].map(item))), 'a b c');
  });

  it('drops a message missing from inside the loaded range (edited or deleted)', () => {
    const known = mergeLoaded([], ['a', 'b', 'c'].map(item));
    assert.equal(keys(mergeLoaded(known, ['a', 'x', 'c'].map(item))), 'a x c');
  });

  it('does not keep a phantom when the last reply changes (streaming or retry)', () => {
    const known = mergeLoaded([], ['a', 'b', 'r1'].map(item));
    assert.equal(keys(mergeLoaded(known, ['a', 'b', 'r2'].map(item))), 'a b r2');
  });

  it('handles duplicate keys in order', () => {
    const known = mergeLoaded([], ['x', 'y', 'x2'].map(item));
    assert.equal(keys(mergeLoaded(known, ['y', 'x2'].map(item))), 'x? y x2');
  });

  it('places a window of duplicates by its longest matching run (review finding 1)', () => {
    const known = mergeLoaded([], ['C', 'a1', 'C', 'a2', 'z'].map(item));
    assert.equal(keys(mergeLoaded(known, ['C', 'a2', 'z'].map(item))), 'C? a1? C a2 z');
    assert.equal(keys(mergeLoaded(known, ['C', 'a1'].map(item))), 'C a1 C? a2? z?');
  });

  it('keeps nothing outside the window when two placements are equally good', () => {
    const known = mergeLoaded([], ['C', 'a', 'C', 'a'].map(item));
    assert.equal(keys(mergeLoaded(known, ['C', 'a'].map(item))), 'C a');
    const gapped = mergeLoaded([], ['C', 'a1', 'C', 'a2', 'x', 'y'].map(item));
    assert.equal(keys(mergeLoaded(gapped, ['C', 'a1', 'x', 'y'].map(item))), 'C a1 x y');
  });

  it('keeps everything as not loaded when nothing is loaded', () => {
    const known = mergeLoaded([], ['a', 'b'].map(item));
    assert.equal(keys(mergeLoaded(known, [])), 'a? b?');
  });
});
