import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeCoverage } from '../../src/shared/coverage.ts';
import { STATIC_FEATURES, pageFeatures } from '../../src/shared/features.ts';
import { isPanelRequest } from '../../src/shared/protocol.ts';
import type { Snapshot } from '../../src/shared/types.ts';
import { message, sequence } from './helpers.ts';

const STATUSES = new Set(['working', 'partial', 'blocked', 'not_implemented']);

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  const messages = sequence([message('human', 'q'), message('assistant', 'a')]);
  return {
    provider: 'claude.ai',
    state: 'ready',
    conversation: { provider: 'claude.ai', id: 'abcdefgh', url: 'https://claude.ai/chat/abcdefgh', title: 'T' },
    messages,
    coverage: computeCoverage(messages, []),
    strategy: { id: 'semantic-attributes', label: 'claude.ai data attributes', stable: true },
    revision: 1,
    ...overrides,
  };
}

describe('feature statuses', () => {
  it('use only the contract vocabulary', () => {
    for (const report of [...STATIC_FEATURES, ...pageFeatures(null, 'x'), ...pageFeatures(snapshot(), 'x')]) {
      assert.ok(STATUSES.has(report.status), `${report.id}: ${report.status}`);
      assert.ok(report.detail.length > 0);
    }
  });

  it('are blocked without a usable page and say why', () => {
    const reports = pageFeatures(snapshot({ state: 'disabled', messages: [] }), 'unused');
    assert.equal(reports.find((r) => r.id === 'outline')?.status, 'blocked');
    assert.match(reports.find((r) => r.id === 'search')!.detail, /turned off/);
    assert.equal(pageFeatures(null, 'Not on claude.ai').find((r) => r.id === 'jump')?.detail, 'Not on claude.ai');
  });

  it('are partial with fallback selectors or partial coverage, working otherwise', () => {
    assert.equal(pageFeatures(snapshot(), '').find((r) => r.id === 'outline')?.status, 'working');
    const fallback = snapshot({ strategy: { id: 'class-fallback', label: 'x', stable: false } });
    assert.equal(pageFeatures(fallback, '').find((r) => r.id === 'outline')?.status, 'partial');
    const partialMessages = sequence([message('assistant', 'a')]);
    const partial = snapshot({
      messages: partialMessages,
      coverage: computeCoverage(partialMessages, [{ code: 'first-not-human', severity: 'warning', message: 'm' }]),
    });
    assert.equal(pageFeatures(partial, '').find((r) => r.id === 'search')?.status, 'partial');
  });

  it('declare unbuilt work as not_implemented rather than offering controls for it', () => {
    assert.equal(STATIC_FEATURES.find((f) => f.id === 'archive')?.status, 'not_implemented');
    assert.equal(STATIC_FEATURES.find((f) => f.id === 'chapters')?.status, 'partial');
  });
});

describe('isPanelRequest', () => {
  it('accepts only known request shapes', () => {
    assert.equal(isPanelRequest({ type: 'search', requestId: 1, query: 'x' }), true);
    assert.equal(isPanelRequest({ type: 'go', requestId: 2, key: 'human:0123456789abcdef:1', revision: 7 }), true);
    assert.equal(isPanelRequest({ type: 'search', requestId: '1' }), false);
    assert.equal(isPanelRequest({ type: 'eval', requestId: 1 }), false);
    assert.equal(isPanelRequest(null), false);
    assert.equal(isPanelRequest('jump'), false);
  });
});
