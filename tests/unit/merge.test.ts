import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mergeLoaded } from '../../src/shared/merge.ts';

const item = (key: string) => ({ key, rendered: true });
const keys = (list: { key: string; rendered: boolean }[]) => list.map((i) => `${i.key}${i.rendered ? '' : '?'}`).join(' ');

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

  it('keeps everything as not loaded when nothing is loaded', () => {
    const known = mergeLoaded([], ['a', 'b'].map(item));
    assert.equal(keys(mergeLoaded(known, [])), 'a? b?');
  });
});
