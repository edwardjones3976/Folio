import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_HITS, parseQuery, search } from '../../src/shared/search.ts';
import type { SearchDoc } from '../../src/shared/search.ts';

const docs: SearchDoc[] = [
  { key: 'h1', role: 'human', seq: 0, exchange: 1, text: 'How do I plan drip irrigation?', rendered: true },
  {
    key: 'a1',
    role: 'assistant',
    seq: 1,
    exchange: 1,
    text: 'Use pressure-compensating emitters every 30 cm.\nAdd a backflow preventer at the tap.',
    rendered: true,
  },
  { key: 'h2', role: 'human', seq: 2, exchange: 2, text: 'What about the Backflow Preventer brand?', rendered: true },
  { key: 'a2', role: 'assistant', seq: 3, exchange: 2, text: 'Any certified backflow device works. Café naïve note.', rendered: false },
];

describe('parseQuery', () => {
  it('splits words and keeps quoted phrases together, ignoring duplicates', () => {
    assert.deepEqual(parseQuery('drip "backflow preventer"  Drip tap'), ['drip', 'backflow preventer', 'tap']);
    assert.deepEqual(parseQuery('   '), []);
    assert.deepEqual(parseQuery('""'), []);
  });

  it('caps very long queries', () => {
    assert.ok(parseQuery('a'.repeat(1000))[0]!.length <= 200);
  });
});

describe('search', () => {
  it('matches case-insensitively and requires every term', () => {
    const result = search(docs, 'BACKFLOW tap');
    assert.deepEqual(result.hits.map((h) => h.key), ['a1']);
  });

  it('matches exact phrases in chronological order and reports counts', () => {
    const result = search(docs, '"backflow preventer"');
    assert.deepEqual(result.hits.map((h) => h.key), ['a1', 'h2']);
    assert.equal(result.total, 2);
    assert.equal(result.truncated, false);
  });

  it('returns snippets with marked matches and line breaks shown inline', () => {
    const [hit] = search(docs, 'emitters').hits;
    assert.ok(hit);
    const marked = hit.snippet.filter((p) => p.match).map((p) => p.text);
    assert.deepEqual(marked, ['emitters']);
    assert.ok(hit.snippet.map((p) => p.text).join('').includes('⏎'));
    assert.equal(hit.firstTerm, 'emitters');
  });

  it('searches messages seen earlier but no longer loaded, and labels them', () => {
    const result = search(docs, 'certified');
    assert.equal(result.hits[0]?.rendered, false);
    assert.equal(result.searchedLoaded, 3);
    assert.equal(result.searchedNotLoaded, 1);
  });

  it('handles accented text', () => {
    assert.equal(search(docs, 'CAFÉ').hits[0]?.key, 'a2');
  });

  it('returns no hits for an empty query', () => {
    const result = search(docs, '  ');
    assert.equal(result.hits.length, 0);
    assert.deepEqual(result.terms, []);
  });

  it('truncates to the hit limit and says so', () => {
    const many: SearchDoc[] = Array.from({ length: MAX_HITS + 25 }, (_, i) => ({
      key: `k${i}`,
      role: 'assistant',
      seq: i,
      exchange: i,
      text: `needle ${i}`,
      rendered: true,
    }));
    const result = search(many, 'needle');
    assert.equal(result.hits.length, MAX_HITS);
    assert.equal(result.total, MAX_HITS + 25);
    assert.equal(result.truncated, true);
  });

  it('adds ellipses when the snippet is cut from long text', () => {
    const long = `${'lorem ipsum '.repeat(30)}target${' dolor sit'.repeat(30)}`;
    const [hit] = search([{ key: 'x', role: 'assistant', seq: 0, exchange: 1, text: long, rendered: true }], 'target').hits;
    assert.equal(hit?.snippet[0]?.text, '…');
    assert.equal(hit?.snippet[hit.snippet.length - 1]?.text, '…');
  });
});
