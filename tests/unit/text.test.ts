import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { anchorPrefix, digest, excerpt, foldCase, normalizeText, PREFIX_LENGTH, truncate } from '../../src/shared/text.ts';

const NBSP = String.fromCodePoint(0xa0);
const NARROW_NBSP = String.fromCodePoint(0x202f);
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
const BOM = String.fromCodePoint(0xfeff);
const SMILE = String.fromCodePoint(0x1f600);

describe('normalizeText', () => {
  it('unifies newlines, non-breaking spaces and zero-width characters', () => {
    assert.equal(normalizeText('a\r\nb\rc'), 'a\nb\nc');
    assert.equal(normalizeText(`a${NBSP}${NBSP}b${NARROW_NBSP}c`), 'a b c');
    assert.equal(normalizeText(`ze${ZERO_WIDTH_SPACE}ro${BOM}`), 'zero');
  });

  it('trims lines and limits blank-line runs but keeps wording and case', () => {
    assert.equal(normalizeText('  Hello   World  \n\n\n\n  Next\tLine '), 'Hello World\n\nNext Line');
  });
});

describe('digest', () => {
  it('is deterministic 16-hex and sensitive to small changes', () => {
    const a = digest('The answer is 42.');
    assert.match(a, /^[0-9a-f]{16}$/);
    assert.equal(a, digest('The answer is 42.'));
    assert.notEqual(a, digest('The answer is 43.'));
    assert.notEqual(digest(''), digest(' '));
  });

  it('has no collisions across 20,000 distinct synthetic messages', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i++) seen.add(digest(`Message number ${i} about topic ${i % 97}`));
    assert.equal(seen.size, 20_000);
  });
});

describe('excerpt, truncate, anchorPrefix', () => {
  it('uses the first non-empty line', () => {
    assert.equal(excerpt('\n\nFirst line\nSecond'), 'First line');
  });

  it('truncates on code point boundaries with an ellipsis', () => {
    assert.equal(truncate('abcdef', 4), 'abc…');
    assert.equal(truncate(SMILE.repeat(4), 3), `${SMILE}${SMILE}…`);
    assert.equal(truncate('short', 10), 'short');
  });

  it('keeps PREFIX_LENGTH code points', () => {
    assert.equal(anchorPrefix('x'.repeat(500)).length, PREFIX_LENGTH);
  });
});

describe('foldCase', () => {
  it('lower-cases while preserving string length', () => {
    const inputs = ['ÉCOLE Café', 'İstanbul', 'ẞtraße', 'ΣΊΣΥΦΟΣ', 'שלום'];
    for (const input of inputs) assert.equal(foldCase(input).length, input.length, input);
    assert.equal(foldCase('ÉCOLE Café'), 'école café');
  });
});
