import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeCoverage } from '../../src/shared/coverage.ts';
import { buildExchanges, exchangeNumbers } from '../../src/shared/outline.ts';
import { message, sequence } from './helpers.ts';

describe('buildExchanges', () => {
  it('groups each prompt with the replies that follow it', () => {
    const msgs = sequence([
      message('human', 'First question'),
      message('assistant', 'First answer'),
      message('human', 'Second question'),
      message('assistant', 'Second answer'),
      message('assistant', 'Follow-up reply'),
    ]);
    const exchanges = buildExchanges(msgs);
    assert.equal(exchanges.length, 2);
    assert.equal(exchanges[0]!.label, 'First question');
    assert.equal(exchanges[0]!.labelSource, 'prompt-excerpt');
    assert.equal(exchanges[1]!.replies.length, 2);
    const numbers = exchangeNumbers(exchanges);
    assert.equal(numbers.get(msgs[4]!.key), 2);
  });

  it('labels a leading reply without a loaded prompt as a reply excerpt', () => {
    const exchanges = buildExchanges(sequence([message('assistant', 'Orphan reply text'), message('human', 'Next')]));
    assert.equal(exchanges[0]!.labelSource, 'reply-excerpt');
    assert.equal(exchanges[0]!.prompt, null);
    assert.equal(exchanges[0]!.label, 'Orphan reply text');
  });

  it('labels prompts without readable text explicitly instead of inventing a label', () => {
    const exchanges = buildExchanges(sequence([message('human', ''), message('assistant', '')]));
    assert.equal(exchanges[0]!.labelSource, 'no-text');
    assert.equal(exchanges[0]!.label, 'Prompt without readable text');
  });

  it('reports whether an exchange is loaded', () => {
    const msgs = sequence([message('human', 'q'), message('assistant', 'a', { rendered: false }), message('human', 'q2', { rendered: false })]);
    const exchanges = buildExchanges(msgs);
    assert.equal(exchanges[0]!.loaded, 'some');
    assert.equal(exchanges[1]!.loaded, 'none');
  });
});

describe('computeCoverage', () => {
  it('never claims completeness when nothing suggests missing content', () => {
    const coverage = computeCoverage(sequence([message('human', 'q'), message('assistant', 'a')]), []);
    assert.equal(coverage.level, 'loaded-only');
    assert.match(coverage.statement, /Indexed 2 messages loaded in this claude\.ai page\./);
    assert.match(coverage.statement, /cannot confirm/);
  });

  it('reports partial coverage for warning signals and not-loaded messages', () => {
    const coverage = computeCoverage(
      sequence([message('human', 'q'), message('assistant', 'a', { rendered: false })]),
      [{ code: 'loading-indicator', severity: 'warning', message: 'loading' }],
    );
    assert.equal(coverage.level, 'partial');
    assert.equal(coverage.notRenderedCount, 1);
    assert.ok(coverage.signals.some((s) => s.code === 'not-rendered'));
    assert.match(coverage.statement, /plus 1 seen earlier/);
  });

  it('counts branch points and mentions that only shown versions are indexed', () => {
    const coverage = computeCoverage(
      sequence([message('human', 'q', { branch: { current: 2, total: 3 } }), message('assistant', 'a')]),
      [{ code: 'branches', severity: 'info', message: 'branches', count: 1 }],
    );
    assert.equal(coverage.branchPoints, 1);
    assert.equal(coverage.level, 'loaded-only');
    assert.match(coverage.statement, /Only the version shown at 1 branch point is indexed/);
  });

  it('reports none when nothing is indexed', () => {
    assert.equal(computeCoverage([], []).level, 'none');
  });
});
