// claude.ai adapter and live index, run in real Chrome against the synthetic
// fixtures (no extension loaded: the code is bundled and injected per page).
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { FIXTURES, fixtureHtmlForPath, fixtureId, fixtureUrl } from '../../fixtures/claude/index.ts';
import type { FixtureName } from '../../fixtures/claude/index.ts';
import { NEEDLE_EXCHANGE, NEEDLE_PHRASE } from '../../fixtures/claude/long.ts';
import type { SearchResult } from '../../src/shared/search.ts';
import type { MessageAnchor, Resolution, Snapshot } from '../../src/shared/types.ts';
import { bundle } from '../../src/tools/bundle.mjs';
import { Browser } from './cdp.ts';
import type { Page } from './cdp.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const HARNESS = bundle(ROOT, join(ROOT, 'tests/browser/harness-entry.ts'));

interface Discovered {
  role: string;
  text: string;
  headings: { level: number; text: string }[];
  branch: { current: number; total: number } | null;
  streaming: boolean;
}

let browser: Browser;
let page: Page;

async function open(name: FixtureName): Promise<void> {
  await page.goto(fixtureUrl(name));
  await page.evaluate(HARNESS);
}

const call = <T>(method: string, ...args: unknown[]) =>
  page.evaluate<T>(
    (m: string, a: unknown[]) => (globalThis as unknown as { __folioHarness: Record<string, (...x: unknown[]) => unknown> }).__folioHarness[m]!(...a),
    method,
    args,
  );

before(async () => {
  browser = await Browser.launch();
  page = await browser.newPage();
  await page.serveFixtures(fixtureHtmlForPath);
});

after(async () => {
  await browser?.close();
});

describe('claude.ai adapter on a fully loaded conversation (synthetic)', () => {
  it('finds every prompt and reply in order with semantic attributes', async () => {
    await open('loaded');
    const messages = await call<Discovered[]>('discover');
    assert.equal(messages.length, 12);
    assert.deepEqual(
      messages.map((m) => m.role),
      Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? 'human' : 'assistant')),
    );
    assert.equal(messages[0]!.text, 'I want to plan drip irrigation for a 6 by 3 metre vegetable bed.\nWhere should I start?');
    assert.deepEqual(messages[1]!.headings, [
      { level: 2, text: 'Water needs' },
      { level: 3, text: 'Emitter spacing' },
      { level: 2, text: 'Layout' },
    ]);
    assert.match(messages[5]!.text, /Spring\s+20/);
    const snapshot = await call<Snapshot>('snapshot');
    assert.equal(snapshot.state, 'ready');
    assert.equal(snapshot.strategy.id, 'semantic-attributes');
    assert.equal(snapshot.coverage.level, 'loaded-only');
    assert.deepEqual(snapshot.coverage.signals, []);
    assert.deepEqual(snapshot.conversation, {
      provider: 'claude.ai',
      id: fixtureId('loaded'),
      url: fixtureUrl('loaded'),
      title: 'Synthetic fixture: Planning drip irrigation',
    });
  });

  it('never reads the composer, password fields, buttons, the sidebar or page chrome', async () => {
    const texts = (await call<Discovered[]>('discover')).map((m) => m.text).join('\n');
    for (const forbidden of ['DRAFT-COMPOSER-TEXT', 'fixture-password', 'Sourdough timing', 'Synthetic test fixture', 'Copy', 'Retry', 'Send']) {
      assert.ok(!texts.includes(forbidden), forbidden);
    }
  });

  it('resolves anchors by content after reload and after earlier messages are inserted', async () => {
    const snapshot = await call<Snapshot>('snapshot');
    const target = snapshot.messages[5]!;
    const anchor = await call<MessageAnchor>('anchorFor', target.key);
    await open('loaded');
    assert.equal((await call<{ resolution: Resolution }>('locate', anchor)).resolution.status, 'exact');
    await page.evaluate(() => {
      const turn = document.querySelector('[data-test-render-count]')!;
      const extra = turn.cloneNode(true) as Element;
      extra.querySelector('[data-testid="user-message"]')!.textContent = 'A newly loaded earlier prompt';
      turn.before(extra);
    });
    const located = await call<{ resolution: Resolution; text: string }>('locate', anchor);
    assert.equal(located.resolution.status, 'exact');
    assert.match(located.text, /^With 40 emitters/);
  });

  it('jumps to a message and to a heading, scrolling it into view and highlighting it', async () => {
    await open('loaded');
    const snapshot = await call<Snapshot>('snapshot');
    const last = snapshot.messages[11]!;
    // The latest message, reached as an outline click does (by live identity): as a
    // bookmark it would not be confirmed, because nothing was known after it.
    assert.equal((await call<{ resolution: Resolution }>('locate', await call<MessageAnchor>('anchorFor', last.key))).resolution.status, 'probable');
    await call('go', last.key, snapshot.revision, {});
    const visible = await page.evaluate<{ attr: string | null; top: number; height: number }>(() => {
      const el = document.querySelectorAll('[data-is-streaming]')[5]!;
      return { attr: el.getAttribute('data-folio-highlight'), top: el.getBoundingClientRect().top, height: innerHeight };
    });
    assert.equal(visible.attr, 'message');
    assert.ok(visible.top >= 0 && visible.top < visible.height, `top ${visible.top}`);

    const first = snapshot.messages[1]!;
    const outcome = await call<{ headingFallback: boolean }>('jump', await call<MessageAnchor>('anchorFor', first.key, 1), {
      headingIndex: 1,
      headingText: 'Emitter spacing',
    });
    assert.equal(outcome.headingFallback, false);
    assert.equal(await page.evaluate(() => document.querySelector('h3')!.getAttribute('data-folio-highlight')), 'heading');
    assert.equal(await page.evaluate(() => document.querySelectorAll('[data-folio-highlight]').length), 2);
  });

  it('falls back to the message start when a saved heading no longer matches', async () => {
    const snapshot = await call<Snapshot>('snapshot');
    const outcome = await call<{ headingFallback: boolean }>('jump', await call<MessageAnchor>('anchorFor', snapshot.messages[1]!.key), {
      headingIndex: 1,
      headingText: 'A heading that was renamed',
    });
    assert.equal(outcome.headingFallback, true);
  });

  it('highlights search terms without modifying page markup', async () => {
    const result = await call<SearchResult>('search', '"backflow preventer"');
    assert.equal(result.total, 2);
    assert.deepEqual(result.hits.map((h) => h.exchange), [2, 6]);
    const before = await page.evaluate(() => document.querySelector('main')!.innerHTML.replace(/ data-folio-highlight="[a-z]+"/g, '').length);
    const snapshot = await call<Snapshot>('snapshot');
    const outcome = await call<{ termFound: boolean }>('jump', await call<MessageAnchor>('anchorFor', snapshot.messages[3]!.key), {
      highlightTerm: 'backflow preventer',
    });
    assert.equal(outcome.termFound, true);
    assert.equal(await page.evaluate(() => CSS.highlights.has('folio-match')), true);
    const afterLength = await page.evaluate(() => document.querySelector('main')!.innerHTML.replace(/ data-folio-highlight="[a-z]+"/g, '').length);
    assert.equal(afterLength, before);
  });
});

describe('partially loaded conversation (synthetic)', () => {
  it('reports partial coverage when the first loaded message is a reply and a loader is shown', async () => {
    await open('partial');
    const snapshot = await call<Snapshot>('snapshot');
    assert.equal(snapshot.messages.length, 5);
    assert.equal(snapshot.messages[0]!.role, 'assistant');
    assert.equal(snapshot.coverage.level, 'partial');
    const codes = snapshot.coverage.signals.map((s) => s.code).sort();
    assert.deepEqual(codes, ['first-not-human', 'loading-indicator']);
    const exchanges = await call<{ labelSource: string }[]>('exchanges');
    assert.equal(exchanges[0]!.labelSource, 'reply-excerpt');
  });

  it('updates when claude.ai loads the earlier messages', async () => {
    await page.evaluate(() => {
      document.getElementById('loading')!.remove();
      const conversation = document.getElementById('conversation')!;
      conversation.insertAdjacentHTML(
        'afterbegin',
        '<div data-test-render-count="1"><div data-testid="user-message"><p>How long should my levain take?</p></div></div>',
      );
    });
    const snapshot = await call<Snapshot>('snapshot');
    assert.equal(snapshot.messages.length, 6);
    assert.equal(snapshot.messages[0]!.role, 'human');
    assert.equal(snapshot.coverage.level, 'loaded-only');
  });
});

describe('branched conversation (synthetic)', () => {
  it('reports versions at edited prompts and retried replies, ignoring look-alike text inside messages', async () => {
    await open('branched');
    const messages = await call<Discovered[]>('discover');
    assert.equal(messages.length, 6);
    assert.deepEqual(messages.map((m) => m.branch), [null, null, { current: 2, total: 3 }, { current: 1, total: 2 }, null, null]);
    const snapshot = await call<Snapshot>('snapshot');
    assert.equal(snapshot.coverage.branchPoints, 2);
    assert.equal(snapshot.coverage.level, 'loaded-only');
    assert.match(snapshot.coverage.statement, /Only the version shown at 2 branch points is indexed/);
    assert.ok(snapshot.coverage.signals.some((s) => s.code === 'branches' && s.count === 2));
  });

  it('starts fresh when the user switches versions instead of keeping messages from the other branch', async () => {
    await call<Snapshot>('snapshot');
    await page.evaluate(() => {
      document.getElementById('prompt-version-label')!.textContent = '3 / 3';
      document.querySelector('#edited-prompt p')!.textContent = 'How do we backfill without locking the table?';
      const turns = Array.from(document.querySelectorAll('[data-test-render-count]'));
      for (const turn of turns.slice(4)) turn.remove();
    });
    const snapshot = await call<Snapshot>('snapshot');
    assert.equal(snapshot.messages.length, 4);
    assert.equal(snapshot.coverage.notRenderedCount, 0);
  });
});

describe('edge cases (synthetic)', () => {
  it('handles duplicates, markup-like text, RTL, image-only prompts, streaming replies and prompts being edited', async () => {
    await open('edge');
    const snapshot = await call<Snapshot>('snapshot');
    assert.deepEqual(snapshot.messages.map((m) => m.role), ['human', 'assistant', 'human', 'assistant', 'human', 'assistant']);
    const [first, , second] = snapshot.messages;
    assert.equal(first!.digest, second!.digest);
    assert.deepEqual([first!.occurrence, second!.occurrence], [0, 1]);
    assert.notEqual(first!.key, second!.key);
    assert.equal(snapshot.messages[4]!.chars, 0);
    assert.equal(snapshot.messages[5]!.streaming, true);
    assert.deepEqual(snapshot.messages[1]!.headings.map((h) => h.text), [`Results ${String.fromCodePoint(0x1f680)} & next steps`]);
    const codes = snapshot.coverage.signals.map((s) => s.code).sort();
    assert.deepEqual(codes, ['no-text', 'streaming']);

    const texts = (await call<Discovered[]>('discover')).map((m) => m.text);
    assert.ok(texts[1]!.includes('<img src=x onerror="window.__folioPwned=1">'));
    assert.ok(texts[3]!.includes('שלום עולם'));
    assert.ok(!texts.join('\n').includes('EDITING-PROMPT-TEXT'));
    assert.equal(await page.evaluate(() => (window as unknown as { __folioPwned?: number }).__folioPwned ?? null), null);
  });

  it('resolves the second of two identical prompts to the second one', async () => {
    const snapshot = await call<Snapshot>('snapshot');
    const anchor = await call<MessageAnchor>('anchorFor', snapshot.messages[2]!.key);
    await call('jump', anchor, {});
    const highlighted = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="user-message"]')).findIndex((el) => el.hasAttribute('data-folio-highlight')),
    );
    assert.equal(highlighted, 1);
  });

  it('follows a streaming reply without leaving a stale copy behind', async () => {
    await page.evaluate(() => {
      const reply = document.getElementById('streaming-reply')!;
      reply.querySelector('p')!.textContent += ' a maple leaf with early autumn colour.';
    });
    let snapshot = await call<Snapshot>('snapshot');
    assert.equal(snapshot.messages.length, 6);
    assert.equal(snapshot.coverage.notRenderedCount, 0);
    await page.evaluate(() => document.getElementById('streaming-reply')!.setAttribute('data-is-streaming', 'false'));
    snapshot = await call<Snapshot>('snapshot');
    assert.equal(snapshot.messages[5]!.streaming, false);
    assert.ok(!snapshot.coverage.signals.some((s) => s.code === 'streaming'));
  });
});

describe('duplicate messages on partially loaded pages (synthetic, review finding 1)', () => {
  const removeTurns = (from: number, to: number) =>
    page.evaluate(
      (a: number, b: number) => {
        for (const turn of Array.from(document.querySelectorAll('[data-test-render-count]')).slice(a, b)) turn.remove();
      },
      from,
      to,
    );
  const highlightedPrompts = () =>
    page.evaluate<number[]>(() =>
      Array.from(document.querySelectorAll('[data-testid="user-message"]')).flatMap((el, i) => (el.hasAttribute('data-folio-highlight') ? [i] : [])),
    );

  it('keeps both copies of a duplicate prompt, with stable keys, when virtualization removes the first', async () => {
    await open('edge');
    const before = await call<Snapshot>('snapshot');
    const secondKey = before.messages[2]!.key;
    const anchor = await call<MessageAnchor>('anchorFor', secondKey);
    await removeTurns(0, 2);
    const after = await call<Snapshot>('snapshot');
    assert.equal(after.coverage.knownCount, 6);
    assert.equal(after.coverage.notRenderedCount, 2);
    assert.deepEqual(after.messages.map((m) => m.rendered), [false, false, true, true, true, true]);
    assert.equal(after.messages[2]!.key, secondKey, 'occurrence numbering must not restart on the loaded subset');
    const hit = (await call<SearchResult>('search', 'onerror')).hits[0];
    assert.equal(hit?.rendered, false, 'the virtualized reply stays searchable');
    assert.equal((await call<{ resolution: Resolution }>('locate', anchor)).resolution.status, 'exact');
    await call('jump', anchor, {});
    assert.deepEqual(await highlightedPrompts(), [0], 'the remaining (second) copy is highlighted');
  });

  it('never resolves a saved duplicate to the other copy when the saved one is not loaded', async () => {
    await open('edge');
    const snapshot = await call<Snapshot>('snapshot');
    const anchor = await call<MessageAnchor>('anchorFor', snapshot.messages[2]!.key);
    await removeTurns(2, 6);
    const located = await call<{ resolution: Resolution; text: string | null }>('locate', anchor);
    assert.notEqual(located.resolution.status, 'exact');
    assert.equal(located.text, null);
    assert.equal(await call('jump', anchor, {}), null);
    assert.deepEqual(await highlightedPrompts(), [], 'nothing is highlighted');
  });
});

describe('outline and search clicks follow live identity, not anchors (synthetic, review finding 3)', () => {
  interface Went {
    stale: boolean;
    resolution: Resolution;
    jumped: boolean;
  }
  const highlighted = (selector: string) =>
    page.evaluate<number[]>(
      (s: string) => Array.from(document.querySelectorAll(s)).flatMap((el, i) => (el.hasAttribute('data-folio-highlight') ? [i] : [])),
      selector,
    );
  const PROMPTS = '[data-testid="user-message"]';
  const REPLIES = '[data-is-streaming]';

  it('goes to the second of two fully identical exchanges, which no anchor can tell apart', async () => {
    await open('repeated');
    const snapshot = await call<Snapshot>('snapshot');
    assert.deepEqual(snapshot.messages.map((m) => m.excerpt), ['Continue', 'Done.', 'Continue', 'Done.']);
    const [, , prompt, reply] = snapshot.messages;
    const anchored = await call<{ resolution: Resolution }>('locate', await call<MessageAnchor>('anchorFor', prompt!.key));
    assert.equal(anchored.resolution.status, 'ambiguous', 'as a bookmark it stays ambiguous');

    const went = await call<Went>('go', prompt!.key, snapshot.revision, {});
    assert.deepEqual([went.stale, went.jumped, went.resolution.status], [false, true, 'exact']);
    assert.deepEqual(await highlighted(PROMPTS), [1]);
    const view = await page.evaluate<{ top: number; height: number }>(() => ({
      top: document.querySelectorAll('[data-testid="user-message"]')[1]!.getBoundingClientRect().top,
      height: innerHeight,
    }));
    assert.ok(view.top > -1 && view.top < view.height, `second prompt scrolled into view (top ${view.top})`);
    await call('go', reply!.key, snapshot.revision, {});
    assert.deepEqual(await highlighted(REPLIES), [1]);
    await call('go', snapshot.messages[0]!.key, snapshot.revision, {});
    assert.deepEqual(await highlighted(PROMPTS), [0]);
  });

  it('goes to a single loaded message, which no neighbour can confirm', async () => {
    await open('repeated');
    await page.evaluate(() => {
      for (const turn of Array.from(document.querySelectorAll('[data-test-render-count]')).slice(1)) turn.remove();
    });
    const snapshot = await call<Snapshot>('snapshot');
    assert.equal(snapshot.messages.length, 1);
    const anchored = await call<{ resolution: Resolution }>('locate', await call<MessageAnchor>('anchorFor', snapshot.messages[0]!.key));
    assert.equal(anchored.resolution.status, 'probable', 'as a bookmark it is not confirmed');
    const went = await call<Went>('go', snapshot.messages[0]!.key, snapshot.revision, {});
    assert.deepEqual([went.stale, went.jumped], [false, true]);
    assert.deepEqual(await highlighted(PROMPTS), [0]);
  });

  it('does not follow an entry drawn before earlier messages loaded and renumbered the keys; the updated list reaches it (correction 3)', async () => {
    await open('repeated');
    await page.evaluate(() => {
      const turns = Array.from(document.querySelectorAll('[data-test-render-count]'));
      (window as unknown as { __earlier: Element[] }).__earlier = turns.slice(0, 2);
      for (const turn of turns.slice(0, 2)) turn.remove();
    });
    const shownList = await call<Snapshot>('snapshot');
    const shown = shownList.messages[0]!;
    assert.equal(shownList.messages.length, 2, 'only the second exchange is loaded');
    await page.evaluate(() => document.getElementById('conversation')!.prepend(...(window as unknown as { __earlier: Element[] }).__earlier));
    const now = await call<Snapshot>('snapshot');
    assert.equal(now.messages.length, 4);
    assert.equal(now.messages[0]!.key, shown.key, 'the same key now names the first copy');

    // Nothing was known before it in the list that was shown, so its anchor cannot tell the two copies apart.
    const went = await call<Went>('go', shown.key, shownList.revision, {});
    assert.deepEqual([went.stale, went.jumped, went.resolution.status], [true, false, 'ambiguous']);
    assert.deepEqual(await highlighted(PROMPTS), []);
    const fresh = await call<Went>('go', now.messages[2]!.key, now.revision, {});
    assert.deepEqual([fresh.stale, fresh.jumped], [false, true]);
    assert.deepEqual(await highlighted(PROMPTS), [1]);
  });

  it('does not follow an element whose text changed before Folio refreshed (review finding 2)', async () => {
    await open('loaded');
    const shown = await call<Snapshot>('snapshot');
    await page.evaluate(() => {
      document.querySelectorAll('[data-is-streaming]')[1]!.querySelector('.standard-markdown')!.textContent = 'This reply was regenerated and now says something else entirely.';
    });
    // No refresh in between: the click names the current generation, whose element now holds other text.
    const went = await call<Went>('go', shown.messages[3]!.key, shown.revision, {});
    assert.deepEqual([went.stale, went.jumped, went.resolution.status], [true, false, 'unresolved'], 'ff66a57: not stale, exact, jumped');
    assert.deepEqual(await highlighted(REPLIES), []);
  });

  it('does not follow a reused element to an identical earlier reply after the page changed (review finding 3)', async () => {
    await open('repeated');
    await page.evaluate(() => {
      const prompt = (text: string) => {
        const turn = document.createElement('div');
        turn.setAttribute('data-test-render-count', '1');
        const el = document.createElement('div');
        el.setAttribute('data-testid', 'user-message');
        el.textContent = text;
        turn.append(el);
        return turn;
      };
      document.querySelectorAll('[data-test-render-count]')[1]!.after(prompt('Who approved the deploy?'));
      document.getElementById('conversation')!.append(prompt('Write the follow-up email.'));
    });
    const shown = await call<Snapshot>('snapshot');
    assert.deepEqual(shown.messages.map((m) => m.excerpt), ['Continue', 'Done.', 'Who approved the deploy?', 'Continue', 'Done.', 'Write the follow-up email.']);
    await page.evaluate(() => {
      // The later reply's element now shows the earlier reply; the rest is virtualized away.
      const turns = Array.from(document.querySelectorAll('[data-test-render-count]'));
      turns[0]!.after(turns[4]!);
      for (const i of [1, 3, 5]) turns[i]!.remove();
    });
    const now = await call<Snapshot>('snapshot');
    assert.deepEqual(now.messages.map((m) => m.rendered), [true, true, true, false, false, false]);

    const went = await call<Went>('go', shown.messages[4]!.key, shown.revision, {});
    assert.deepEqual([went.stale, went.jumped, went.resolution.status], [true, false, 'unresolved'], 'ff66a57: exact index 1, jumped');
    assert.equal(went.resolution.status === 'unresolved' && went.resolution.reason, 'not-loaded');
    assert.deepEqual(await highlighted(REPLIES), []);
  });

  it('refuses when the page changed and the entry can no longer be confirmed', async () => {
    await open('repeated');
    const snapshot = await call<Snapshot>('snapshot');
    await page.evaluate(() => {
      // claude.ai re-renders the second prompt (a new element) and a new prompt arrives.
      const turns = Array.from(document.querySelectorAll('[data-test-render-count]'));
      turns[2]!.replaceWith(turns[2]!.cloneNode(true));
      const turn = turns[3]!.cloneNode(false) as Element;
      turn.append(Object.assign(document.createElement('div'), { textContent: 'Summarize everything so far.' }));
      turn.firstElementChild!.setAttribute('data-testid', 'user-message');
      document.getElementById('conversation')!.append(turn);
    });
    const went = await call<Went>('go', snapshot.messages[2]!.key, snapshot.revision, {});
    assert.deepEqual([went.stale, went.jumped, went.resolution.status], [true, false, 'ambiguous']);
    assert.deepEqual(await highlighted(PROMPTS), []);
  });

  it('keeps no earlier generations once the index is cleared', async () => {
    await open('repeated');
    const snapshot = await call<Snapshot>('snapshot');
    await call('clear');
    assert.equal(await call('go', snapshot.messages[2]!.key, snapshot.revision, {}), null);
  });
});

describe('layout drift and unsupported pages (synthetic)', () => {
  it('falls back to CSS class names and reports that as partial', async () => {
    await open('drifted');
    const snapshot = await call<Snapshot>('snapshot');
    assert.equal(snapshot.messages.length, 4);
    assert.equal(snapshot.strategy.id, 'class-fallback');
    assert.equal(snapshot.strategy.stable, false);
    assert.equal(snapshot.coverage.level, 'partial');
    assert.ok(snapshot.coverage.signals.some((s) => s.code === 'fallback-selectors'));
  });

  it('reports that nothing was recognized instead of guessing', async () => {
    await open('unrecognized');
    const snapshot = await call<Snapshot>('snapshot');
    assert.equal(snapshot.state, 'no-messages');
    assert.equal(snapshot.messages.length, 0);
    assert.equal(snapshot.coverage.level, 'none');
  });

  it('reports no conversation on claude.ai pages without one', async () => {
    await open('home');
    const snapshot = await call<Snapshot>('snapshot');
    assert.equal(snapshot.state, 'no-conversation');
    assert.equal(snapshot.conversation, null);
    assert.equal(FIXTURES.home.path, '/new');
  });
});

describe('long conversation (synthetic, 500 messages)', () => {
  it('indexes all 500 messages quickly and finds a specific answer', async () => {
    await open('long');
    const snapshot = await call<Snapshot>('snapshot');
    assert.equal(snapshot.messages.length, 500);
    assert.equal(snapshot.messages.reduce((n, m) => n + m.headings.length, 0), 25);
    const ms = await call<number>('timeRefresh');
    console.log(`# full index of 500 synthetic messages: ${ms.toFixed(1)} ms`);
    assert.ok(ms < 2000, `indexing took ${ms} ms`);
    const result = await call<SearchResult>('search', `"${NEEDLE_PHRASE}"`);
    assert.equal(result.total, 1);
    assert.equal(result.hits[0]!.exchange, NEEDLE_EXCHANGE);
  });

  it('keeps virtualized-away messages as "not loaded", refuses to jump to them, and restores them', async () => {
    const snapshot = await call<Snapshot>('snapshot');
    const early = await call<MessageAnchor>('anchorFor', snapshot.messages[10]!.key);
    await page.evaluate(() => {
      const turns = Array.from(document.querySelectorAll('[data-test-render-count]'));
      (window as unknown as { __removed: Element[] }).__removed = turns.slice(0, 200);
      for (const turn of turns.slice(0, 200)) turn.remove();
    });
    let after = await call<Snapshot>('snapshot');
    assert.equal(after.coverage.knownCount, 500);
    assert.equal(after.coverage.renderedCount, 300);
    assert.equal(after.coverage.notRenderedCount, 200);
    assert.equal(after.coverage.level, 'partial');
    const located = await call<{ resolution: Resolution }>('locate', early);
    assert.equal(located.resolution.status, 'unresolved');
    assert.equal(located.resolution.status === 'unresolved' && located.resolution.reason, 'not-loaded');
    const result = await call<SearchResult>('search', '"Step 6:"');
    assert.equal(result.hits[0]?.rendered, false);

    await page.evaluate(() => {
      const removed = (window as unknown as { __removed: Element[] }).__removed;
      document.getElementById('conversation')!.prepend(...removed);
    });
    after = await call<Snapshot>('snapshot');
    assert.equal(after.coverage.renderedCount, 500);
    assert.equal(after.coverage.notRenderedCount, 0);
    assert.equal((await call<{ resolution: Resolution }>('locate', early)).resolution.status, 'exact');
  });

  it('made no network requests other than the synthetic documents', () => {
    const unexpected = page.requests.filter((r) => r.outcome === 'blocked');
    assert.deepEqual(unexpected, []);
  });
});
