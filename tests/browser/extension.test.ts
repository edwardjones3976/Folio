// End-to-end: the built, unpacked extension in real Chrome, driven through its
// side panel (opened as a tab pinned to the fixture tab) against synthetic
// claude.ai fixtures served at https://claude.ai/... with no network access.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { fixtureHtmlForPath, fixtureId, fixtureUrl } from '../../fixtures/claude/index.ts';
import type { FixtureName } from '../../fixtures/claude/index.ts';
import { NEEDLE_EXCHANGE, NEEDLE_PHRASE } from '../../fixtures/claude/long.ts';
import type { JumpResult, Snapshot } from '../../src/shared/types.ts';
import { build } from '../../src/tools/build.mjs';
import { Browser, sleep } from './cdp.ts';
import type { Page, Session } from './cdp.ts';

let browser: Browser;
let extensionId: string;
let worker: Session;
let page: Page;
let panel: Page;
let tabId: number;
const extensionRequests: string[] = [];

const TITLES: Partial<Record<FixtureName, string>> = {
  loaded: 'Synthetic fixture: Planning drip irrigation',
  partial: 'Synthetic fixture: Sourdough timing',
  long: 'Synthetic fixture: Long project log',
  edge: 'Synthetic fixture: Edge cases',
  repeated: 'Synthetic fixture: Repeated exchanges',
};

async function recordNetwork(session: Session): Promise<void> {
  browser.on((message) => {
    if (message.sessionId !== session.sessionId || message.method !== 'Network.requestWillBeSent') return;
    const url = String((message.params as { request: { url: string } }).request.url);
    if (!url.startsWith('chrome-extension://') && !url.startsWith('data:') && !url.startsWith('blob:')) extensionRequests.push(url);
  });
  await session.send('Network.enable');
}

async function findTab(url: string): Promise<number> {
  return worker.waitFor<number>(
    async (target: string) => {
      for (const tab of await chrome.tabs.query({})) {
        try {
          const reply = (await chrome.tabs.sendMessage(tab.id!, { type: 'folio:ping' })) as { url: string; state: string } | undefined;
          if (reply?.url === target && reply.state !== 'starting') return tab.id;
        } catch {
          // no Folio content script in this tab
        }
      }
      return null;
    },
    [url],
    15_000,
    `content script in ${url}`,
  );
}

const text = (selector: string) => panel.evaluate<string | null>((s: string) => document.querySelector(s)?.textContent ?? null, selector);
const click = (selector: string) =>
  panel.evaluate((s: string) => {
    const el = document.querySelector<HTMLElement>(s);
    if (!el) throw new Error(`missing ${s}`);
    el.click();
    return true;
  }, selector);
const stored = () => panel.evaluate<Record<string, unknown>>(() => chrome.storage.local.get(null));
const waitPanel = <T>(fn: (...args: never[]) => unknown, args: unknown[], label: string, timeout = 10_000) => panel.waitFor<T>(fn, args, timeout, label);
const waitPage = <T>(fn: (...args: never[]) => unknown, args: unknown[], label: string, timeout = 10_000) => page.waitFor<T>(fn, args, timeout, label);

async function showFixture(name: FixtureName): Promise<void> {
  await page.goto(fixtureUrl(name));
  const title = TITLES[name];
  if (title) await waitPanel((t: string) => document.getElementById('conversation-title')?.textContent === t && document.querySelector('#outline-list li'), [title], `panel for ${name}`);
}

async function selectTab(name: string): Promise<void> {
  await click(`#tab-${name}`);
}

before(async () => {
  const dist = build({ quiet: true });
  browser = await Browser.launch();
  console.log(`# browser: ${await browser.version()}`);
  extensionId = await browser.loadExtension(dist);
  worker = await browser.serviceWorker(extensionId);
  await recordNetwork(worker);
  page = await browser.newPage();
  await page.serveFixtures(fixtureHtmlForPath);
  await page.goto(fixtureUrl('loaded'));
  tabId = await findTab(fixtureUrl('loaded'));
  panel = await browser.newPage();
  await recordNetwork(panel);
  await panel.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html?tabId=${tabId}`);
});

after(async () => {
  await browser?.close();
});

describe('installation', () => {
  it('loads with only storage and sidePanel, and opens the side panel from the toolbar button', async () => {
    const manifest = await worker.evaluate<{ permissions: string[]; host_permissions?: string[] }>(() => chrome.runtime.getManifest());
    assert.deepEqual([...manifest.permissions].sort(), ['sidePanel', 'storage']);
    assert.equal(manifest.host_permissions, undefined);
    const behavior = await worker.waitFor<{ openPanelOnActionClick: boolean }>(
      async () => {
        const b = await chrome.sidePanel.getPanelBehavior();
        return b.openPanelOnActionClick ? b : null;
      },
      [],
      5000,
      'panel behavior',
    );
    assert.equal(behavior.openPanelOnActionClick, true);
  });
});

describe('P0 stories on a loaded conversation (synthetic)', () => {
  it('Open: shows a compact outline of exchanges with reply headings and an honest coverage statement', async () => {
    const summary = await waitPanel<string>(() => document.querySelector('#outline-list .exchange') && document.getElementById('outline-summary')!.textContent, [], 'outline');
    assert.equal(summary, '6 exchanges, 12 messages, 6 reply headings.');
    assert.equal(await text('#conversation-title'), TITLES.loaded);
    assert.match((await text('#status-text'))!, /^Indexed 12 messages loaded in this claude\.ai page\. Folio cannot confirm/);
    assert.equal(await panel.evaluate(() => document.getElementById('status')!.dataset.state), 'ok');
    const chips = await panel.evaluate<string[]>(() => Array.from(document.querySelectorAll('#feature-chips li')).map((li) => li.textContent!));
    assert.deepEqual(chips, ['Outline: working', 'Jump and highlight: working', 'Search: working', 'Bookmarks: working']);
    const labels = await panel.evaluate<string[]>(() => Array.from(document.querySelectorAll('.exchange-jump .label')).map((l) => l.textContent!));
    assert.equal(labels[0], 'I want to plan drip irrigation for a 6 by 3 metre vegetable bed.');
    assert.equal(labels.length, 6);
  });

  it('Jump: clicking an exchange scrolls to and highlights the original prompt in the page', async () => {
    await click('#outline-list .exchange:nth-child(5) .exchange-jump');
    const state = await waitPage<{ top: number; height: number }>(
      () => {
        const prompt = document.querySelectorAll('[data-testid="user-message"]')[4]!;
        return prompt.getAttribute('data-folio-highlight') === 'message' ? { top: prompt.getBoundingClientRect().top, height: innerHeight } : null;
      },
      [],
      'highlighted prompt 5',
    );
    assert.ok(state.top >= 0 && state.top < state.height);
    assert.equal(await text('#action-status'), 'Jumped to exchange 5.');
  });

  it('Jump: clicking a reply heading highlights that heading', async () => {
    const button = await panel.evaluate<string>(() => {
      const target = Array.from(document.querySelectorAll<HTMLElement>('.heading-jump')).find((b) => b.textContent!.endsWith('Winterizing'))!;
      target.click();
      return target.textContent!;
    });
    assert.equal(button, 'Heading level 2: Winterizing');
    await waitPage(
      () => Array.from(document.querySelectorAll('h2')).find((h) => h.textContent === 'Winterizing')?.getAttribute('data-folio-highlight') === 'heading',
      [],
      'highlighted heading',
    );
  });

  it('Keyboard: arrows move through the outline, Enter jumps, tabs and "/" are keyboard operable', async () => {
    await panel.send('Page.bringToFront');
    await panel.evaluate(() => document.querySelector<HTMLElement>('.exchange-jump')!.focus());
    await panel.press('ArrowDown');
    assert.equal(await panel.evaluate(() => document.activeElement!.textContent), 'Heading level 2: Water needs');
    await panel.press('Enter');
    await waitPage(
      () => Array.from(document.querySelectorAll('h2')).find((h) => h.textContent === 'Water needs')?.getAttribute('data-folio-highlight') === 'heading',
      [],
      'keyboard jump',
    );
    await panel.press('End');
    assert.equal(await panel.evaluate(() => document.activeElement!.textContent), '6. Thanks, summarize the plan in three bullets.');

    await panel.evaluate(() => document.getElementById('tab-outline')!.focus());
    await panel.press('ArrowRight');
    assert.equal(await panel.evaluate(() => document.activeElement!.id), 'tab-search');
    assert.equal(await panel.evaluate(() => document.getElementById('panel-search')!.hidden), false);
    assert.equal(await panel.evaluate(() => document.getElementById('panel-outline')!.hidden), true);
    await panel.press('ArrowLeft');
    assert.equal(await panel.evaluate(() => document.activeElement!.id), 'tab-outline');
    await panel.press('/');
    assert.equal(await panel.evaluate(() => document.activeElement!.id), 'search-input');
    assert.equal(await panel.evaluate(() => document.getElementById('tab-search')!.getAttribute('aria-selected')), 'true');
  });

  it('Find: search shows snippets, the source location and a coverage statement, and jumps to the match', async () => {
    await panel.evaluate(() => {
      (document.getElementById('search-input') as HTMLInputElement).value = '"backflow preventer"';
      (document.getElementById('search-form') as HTMLFormElement).requestSubmit();
    });
    await waitPanel(() => document.querySelectorAll('#search-results li').length === 2, [], 'two results');
    assert.equal(await text('#search-summary'), '2 messages match.');
    assert.equal(
      await text('#search-coverage'),
      'Searched 12 messages loaded in this page. Not searched: messages claude.ai has not loaded, other branch versions, images, files and artifacts.',
    );
    assert.equal(await text('#search-results li:first-child .result-meta'), 'Exchange 2 · Claude · 2 matches');
    assert.equal(await text('#search-results li:first-child mark'), 'backflow preventer');
    await click('#search-results li:first-child button');
    await waitPage(() => document.querySelectorAll('[data-is-streaming]')[1]!.getAttribute('data-folio-highlight') === 'message', [], 'search jump');
    assert.equal(await text('#action-status'), 'Jumped to the match in exchange 2.');
    // The term highlight is registered from the content script's isolated world;
    // the document-level registry is visible from the page.
    assert.equal(await page.evaluate(() => CSS.highlights.has('folio-match')), true);
  });

  it('Bookmark: saves a stable source reference with title and timestamp, and finds it in the page', async () => {
    await selectTab('outline');
    await click('#outline-list .exchange:nth-child(2) .bookmark-add');
    const data = await waitPanel<Record<string, { items: Record<string, unknown>[] }>>(
      async () => {
        const all = await chrome.storage.local.get('folio.bookmarks');
        return (all['folio.bookmarks'] as { items: unknown[] } | undefined)?.items.length === 1 ? all : null;
      },
      [],
      'stored bookmark',
    );
    const bookmark = data['folio.bookmarks']!.items[0] as {
      title: string;
      createdAt: string;
      exchange: number;
      conversation: { id: string; provider: string };
      anchor: { role: string; prefix: string; digest: string; conversationId: string };
    };
    assert.equal(bookmark.title, 'What parts do I need from the tap to the bed?');
    assert.equal(bookmark.exchange, 2);
    assert.deepEqual([bookmark.conversation.provider, bookmark.conversation.id], ['claude.ai', fixtureId('loaded')]);
    assert.equal(bookmark.anchor.role, 'assistant');
    assert.equal(bookmark.anchor.conversationId, fixtureId('loaded'));
    assert.match(bookmark.anchor.digest, /^[0-9a-f]{16}$/);
    assert.ok(bookmark.anchor.prefix.startsWith('Parts list'));
    assert.ok(Math.abs(Date.parse(bookmark.createdAt) - Date.now()) < 60_000);

    await selectTab('bookmarks');
    const status = await waitPanel<string>(() => document.querySelector('.bookmark [data-status="exact"]')?.textContent, [], 'bookmark check');
    assert.equal(status, 'Found in this page');
  });

  it('Bookmark: title and note can be edited', async () => {
    await click('.bookmark [data-action="edit"]');
    await panel.evaluate(() => {
      const form = document.querySelector<HTMLFormElement>('.bookmark-editor')!;
      form.querySelector<HTMLInputElement>('input')!.value = 'Parts list for the drip system';
      form.querySelector<HTMLTextAreaElement>('textarea')!.value = 'Order the backflow preventer first.';
      form.requestSubmit();
    });
    await waitPanel(() => document.querySelector('.bookmark-title')?.textContent === 'Parts list for the drip system', [], 'edited title');
    assert.equal(await text('.bookmark-note'), 'Order the backflow preventer first.');
    const item = ((await stored())['folio.bookmarks'] as { items: { note: string; updatedAt: string; createdAt: string }[] }).items[0]!;
    assert.equal(item.note, 'Order the backflow preventer first.');
    assert.ok(item.updatedAt >= item.createdAt);
  });

  it('Bookmark: a snapshot arriving during an edit keeps the draft and focus (review finding 4)', async () => {
    await click('.bookmark [data-action="edit"]');
    await panel.evaluate(() => {
      const form = document.querySelector<HTMLFormElement>('.bookmark-editor')!;
      const note = form.querySelector('textarea')!;
      form.querySelector('input')!.value = 'Draft title, not saved yet';
      note.value = 'Draft note typed while Claude was replying';
      note.focus();
      note.setSelectionRange(5, 5);
      for (const el of [note, document.querySelector('.bookmark-status')!]) (el as unknown as { folioMark: boolean }).folioMark = true;
    });
    // A new message in the page makes the content script push a new snapshot,
    // which re-renders the panel and re-checks the bookmarks.
    await page.evaluate(() => {
      const turn = document.createElement('div');
      turn.setAttribute('data-test-render-count', '1');
      const prompt = document.createElement('div');
      prompt.setAttribute('data-testid', 'user-message');
      prompt.textContent = 'A prompt sent while a bookmark was being edited';
      turn.append(prompt);
      document.querySelector('.conversation')!.append(turn);
    });
    await waitPanel(() => document.getElementById('outline-summary')!.textContent!.includes('13 messages'), [], 'snapshot with the new message');
    await waitPanel(
      () => !(document.querySelector('.bookmark-status') as unknown as { folioMark?: boolean } | null)?.folioMark,
      [],
      'bookmark list re-rendered by the snapshot and check',
    );
    const editor = await panel.evaluate<{ title: string; note: string; sameNode: boolean; focused: boolean; caret: number }>(() => {
      const form = document.querySelector<HTMLFormElement>('.bookmark-editor')!;
      const note = form.querySelector('textarea')!;
      return {
        title: form.querySelector('input')!.value,
        note: note.value,
        sameNode: (note as unknown as { folioMark?: boolean }).folioMark === true,
        focused: document.activeElement === note,
        caret: note.selectionStart,
      };
    });
    assert.deepEqual(editor, { title: 'Draft title, not saved yet', note: 'Draft note typed while Claude was replying', sameNode: true, focused: true, caret: 5 });
    assert.equal(await text('.bookmark-status'), 'Found in this page', 'the saved details around the editor are still refreshed');

    await click('.bookmark-editor .cancel');
    await waitPanel(
      () => document.querySelector('.bookmark-title')?.textContent === 'Parts list for the drip system' && !document.querySelector('.bookmark-editor'),
      [],
      'editor closed, saved title kept',
    );
  });

  it('Bookmark: reopens its conversation from another chat and jumps to the saved reply', async () => {
    await showFixture('partial');
    assert.equal(await panel.evaluate(() => document.getElementById('status')!.dataset.state), 'partial');
    assert.ok((await panel.evaluate<string[]>(() => Array.from(document.querySelectorAll('#feature-chips li')).map((li) => li.textContent!))).includes('Outline: partial'));
    assert.match((await text('#bookmarks-summary'))!, /No bookmarks for this conversation/);
    await click('input[name="bookmark-scope"][value="all"]');
    await waitPanel(() => document.querySelector('.bookmark-status')?.textContent?.startsWith('In another conversation'), [], 'other-conversation label');

    await click('.bookmark [data-action="open"]');
    await waitPage((url: string) => location.href === url, [fixtureUrl('loaded')], 'navigation back to the bookmarked chat', 15_000);
    await waitPage(() => document.querySelectorAll('[data-is-streaming]')[1]?.getAttribute('data-folio-highlight') === 'message', [], 'bookmark jump', 15_000);
    await waitPanel(() => document.getElementById('action-status')!.textContent!.startsWith('Jumped to bookmark'), [], 'jump report');
  });

  it('Bookmark: reports an unresolved anchor instead of jumping when the message is gone', async () => {
    await waitPage(() => document.querySelectorAll('[data-folio-highlight]').length === 0, [], 'highlight to clear', 8000);
    await page.evaluate(() => {
      document.querySelectorAll('[data-is-streaming]')[1]!.querySelector('.standard-markdown')!.textContent = 'This reply was regenerated and now says something else entirely.';
    });
    const status = await waitPanel<string>(() => document.querySelector('.bookmark [data-status="unresolved"]')?.textContent, [], 'unresolved label');
    assert.match(status, /^Unresolved: No loaded message matches/);
    await click('.bookmark [data-action="open"]');
    await waitPanel(() => document.getElementById('action-status')!.textContent!.startsWith('Could not jump to bookmark'), [], 'unresolved report');
    assert.equal(await page.evaluate(() => document.querySelectorAll('[data-folio-highlight]').length), 0);
  });
});

describe('long conversation (synthetic, 500 messages)', () => {
  it('finds a specific original answer by search and jumps to it', async () => {
    await showFixture('long');
    assert.equal(await text('#outline-summary'), '250 exchanges, 500 messages, 25 reply headings.');
    await selectTab('search');
    const started = Date.now();
    await panel.evaluate((query: string) => {
      (document.getElementById('search-input') as HTMLInputElement).value = query;
      (document.getElementById('search-form') as HTMLFormElement).requestSubmit();
    }, `"${NEEDLE_PHRASE}"`);
    await waitPanel(() => document.querySelectorAll('#search-results li').length === 1, [], 'needle result');
    await click('#search-results li:first-child button');
    await waitPage(
      (n: number) => document.querySelector(`[data-fixture-exchange="${n}"] [data-is-streaming]`)?.getAttribute('data-folio-highlight') === 'message',
      [NEEDLE_EXCHANGE],
      'needle highlighted',
    );
    const elapsed = Date.now() - started;
    console.log(`# automated search-and-jump to exchange ${NEEDLE_EXCHANGE} of 250: ${elapsed} ms (not a user benchmark)`);
    assert.equal(await text('#search-results li:first-child .result-meta'), `Exchange ${NEEDLE_EXCHANGE} · Claude · 1 match`);
  });

  it('labels virtualized-away outline entries and refuses to jump to them', async () => {
    await page.evaluate(() => {
      for (const turn of Array.from(document.querySelectorAll('[data-test-render-count]')).slice(0, 200)) turn.remove();
    });
    await selectTab('outline');
    await waitPanel(() => document.querySelector('#outline-list .exchange:first-child .badge.warn')?.textContent === 'Not loaded in page', [], 'not-loaded badge');
    assert.equal(await panel.evaluate(() => document.getElementById('status')!.dataset.state), 'partial');
    assert.match((await text('#status-text'))!, /plus 200 seen earlier/);
    await click('#outline-list .exchange:first-child .exchange-jump');
    await waitPanel(() => document.getElementById('action-status')!.textContent!.startsWith('Could not jump to exchange 1.'), [], 'not-loaded report');
    assert.match((await text('#action-status'))!, /not loaded in the page/);
  });
});

describe('untrusted content (synthetic)', () => {
  it('renders markup-like message text as inert text in the panel', async () => {
    await showFixture('edge');
    const headings = await panel.evaluate<string[]>(() => Array.from(document.querySelectorAll('.heading-jump')).map((b) => b.textContent!));
    assert.deepEqual(headings, [`Heading level 2: Results ${String.fromCodePoint(0x1f680)} & next steps`]);
    await selectTab('search');
    await panel.evaluate(() => {
      (document.getElementById('search-input') as HTMLInputElement).value = 'onerror';
      (document.getElementById('search-form') as HTMLFormElement).requestSubmit();
    });
    await waitPanel(() => document.querySelectorAll('#search-results li').length === 1, [], 'markup result');
    assert.ok((await text('#search-results li .snippet'))!.includes('<img src=x onerror="window.__folioPwned=1">'));
    assert.equal(await panel.evaluate(() => document.querySelectorAll('#search-results img, #outline-list img, script:not([src])').length), 0);
    assert.equal(await panel.evaluate(() => (window as unknown as { __folioPwned?: number }).__folioPwned ?? null), null);
    assert.equal(await page.evaluate(() => (window as unknown as { __folioPwned?: number }).__folioPwned ?? null), null);
  });
});

describe('outline clicks follow live identity (synthetic, review finding 3)', () => {
  const highlightedPrompts = () =>
    page.evaluate<number[]>(() =>
      Array.from(document.querySelectorAll('[data-testid="user-message"]')).flatMap((el, i) => (el.hasAttribute('data-folio-highlight') ? [i] : [])),
    );
  const clearPageHighlights = () =>
    page.evaluate(() => {
      for (const el of Array.from(document.querySelectorAll('[data-folio-highlight]'))) el.removeAttribute('data-folio-highlight');
    });
  const outlineSummary = (expected: string) => waitPanel((s: string) => document.getElementById('outline-summary')!.textContent === s, [expected], expected);

  /** Talks to the content script over its own panel port, bypassing the panel UI: the snapshot it pushes first, and the reply to `body`. */
  const askContent = <T>(body: Record<string, unknown> | null) =>
    panel.evaluate<{ snapshot: Snapshot; reply: T | null }>(
      (id: number, b: Record<string, unknown> | null) =>
        new Promise((resolve, reject) => {
          const port = chrome.tabs.connect(id, { name: 'folio-panel' });
          let snapshot: unknown = null;
          const timer = setTimeout(() => reject(new Error('no reply from the content script')), 5000);
          const finish = (reply: unknown) => {
            clearTimeout(timer);
            port.disconnect();
            resolve({ snapshot, reply });
          };
          port.onMessage.addListener((message: { type: string; snapshot?: unknown }) => {
            if (message.type !== 'snapshot') finish(message);
            else if ((snapshot ??= message.snapshot) && !b) finish(null);
          });
          if (b) port.postMessage({ ...b, requestId: 1 });
        }),
      tabId,
      body,
    );

  it('clicking the second of two fully identical exchanges jumps to the second', async () => {
    await showFixture('repeated');
    await selectTab('outline');
    await outlineSummary('2 exchanges, 4 messages, 0 reply headings.');
    await click('#outline-list .exchange:nth-child(2) .exchange-jump');
    await waitPage(
      () => {
        const prompts = document.querySelectorAll('[data-testid="user-message"]');
        return prompts[1]!.getAttribute('data-folio-highlight') === 'message' && !prompts[0]!.hasAttribute('data-folio-highlight');
      },
      [],
      'second prompt highlighted',
    );
    await waitPanel(() => document.getElementById('action-status')!.textContent === 'Jumped to exchange 2.', [], 'jump report');
    await click('#outline-list .exchange:nth-child(1) .exchange-jump');
    await waitPage(() => document.querySelectorAll('[data-testid="user-message"]')[0]!.getAttribute('data-folio-highlight') === 'message', [], 'first prompt');
    assert.deepEqual(await highlightedPrompts(), [0]);
  });

  it('a click on an entry drawn before the page changed is followed to the same message, and says so', async () => {
    const { snapshot } = await askContent(null);
    const second = snapshot.messages[2]!;
    await page.evaluate(() => {
      const turn = document.createElement('div');
      turn.setAttribute('data-test-render-count', '1');
      const prompt = document.createElement('div');
      prompt.setAttribute('data-testid', 'user-message');
      prompt.textContent = 'Summarize everything so far.';
      turn.append(prompt);
      document.getElementById('conversation')!.append(turn);
    });
    await outlineSummary('3 exchanges, 5 messages, 0 reply headings.');
    await clearPageHighlights();
    const went = await askContent<{ result: JumpResult }>({ type: 'go', key: second.key, revision: snapshot.revision });
    assert.deepEqual(went.reply?.result, { status: 'jumped', note: 'The page changed after this list was shown; Folio found the same message again.' });
    assert.deepEqual(await highlightedPrompts(), [1]);
    const expired = await askContent<{ result: JumpResult }>({ type: 'go', key: second.key, revision: -2 });
    assert.equal(expired.reply?.result.status, 'unresolved');
    assert.match(expired.reply!.result.note, /^The page changed after this list was shown, and Folio no longer has that version of it\./);
  });

  it('a single loaded message is navigable from the outline', async () => {
    await page.evaluate(() => {
      for (const turn of Array.from(document.querySelectorAll('[data-test-render-count]')).slice(1)) turn.remove();
    });
    await outlineSummary('1 exchanges, 1 messages, 0 reply headings.');
    await clearPageHighlights();
    await panel.evaluate(() => {
      document.getElementById('action-status')!.textContent = '';
    });
    await click('#outline-list .exchange:nth-child(1) .exchange-jump');
    await waitPanel(() => document.getElementById('action-status')!.textContent === 'Jumped to exchange 1.', [], 'jump report');
    assert.deepEqual(await highlightedPrompts(), [0]);
  });

  it('a bookmark that its neighbours cannot confirm is labelled "Not confirmed", and Open does not jump (review finding 1)', async () => {
    await click('#outline-list .exchange:nth-child(1) .bookmark-add');
    await selectTab('bookmarks');
    const status = await waitPanel<string>(() => document.querySelector('.bookmark [data-status="probable"]')?.textContent, [], 'probable label');
    assert.match(status, /^Not confirmed: One message has the saved text, but no message next to it was known when this was saved/);
    await clearPageHighlights();
    await click('.bookmark:has([data-status="probable"]) [data-action="open"]');
    await waitPanel(() => document.getElementById('action-status')!.textContent!.startsWith('Could not jump to bookmark "Continue". One message has the saved text'), [], 'probable report');
    assert.equal(await page.evaluate(() => document.querySelectorAll('[data-folio-highlight]').length), 0);
    await selectTab('outline');
  });
});

describe('settings', () => {
  it('applies theme and text size and stores them', async () => {
    await selectTab('settings');
    await click('input[name="theme"][value="dark"]');
    await click('input[name="text-size"][value="large"]');
    await waitPanel(() => document.documentElement.dataset.theme === 'dark' && document.documentElement.dataset.textSize === 'large', [], 'appearance');
    const settings = (await stored())['folio.settings'] as { theme: string; textSize: string };
    assert.deepEqual([settings.theme, settings.textSize], ['dark', 'large']);
    await click('input[name="theme"][value="contrast"]');
    await waitPanel(() => document.documentElement.dataset.theme === 'contrast', [], 'high contrast');
  });

  it('turning Folio off for claude.ai stops page reading; turning it on restores it', async () => {
    await showFixture('loaded');
    await selectTab('settings');
    await click('#setting-enabled');
    await waitPanel(() => document.getElementById('status-text')!.textContent === 'Folio is turned off for claude.ai. Turn it on in Settings.', [], 'disabled status');
    assert.equal(await panel.evaluate(() => document.querySelectorAll('#outline-list li').length), 0);
    const chip = await panel.evaluate<string>(() => document.querySelector('#feature-chips li[data-feature="outline"]')!.textContent!);
    assert.equal(chip, 'Outline: blocked');
    const ping = await panel.evaluate<{ state: string }>((id: number) => chrome.tabs.sendMessage(id, { type: 'folio:ping' }), tabId);
    assert.equal(ping.state, 'disabled');

    await click('#setting-enabled');
    await waitPanel(() => document.querySelectorAll('#outline-list .exchange').length === 6, [], 'outline restored');
  });

  it('shows exactly what is stored and prepares a JSON download', async () => {
    await click('#inspect-refresh');
    const json = await waitPanel<string>(() => !document.getElementById('storage-view')!.hidden && document.getElementById('storage-view')!.textContent, [], 'stored data');
    const parsed = JSON.parse(json) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed).sort(), ['folio.bookmarks', 'folio.settings']);
    assert.match((await text('#storage-usage'))!, /^2 keys stored, \d+ bytes in chrome\.storage\.local\.$/);
    await click('#export-data');
    await waitPanel(() => /^Prepared folio-stored-data\.json \(\d+ bytes\) for download\.$/.test(document.getElementById('storage-usage')!.textContent!), [], 'export');
  });

  it('erases bookmarks, then everything, after confirmation', async () => {
    await click('#erase-bookmarks');
    assert.equal(await panel.evaluate(() => document.getElementById('erase-confirm')!.hidden), false);
    assert.equal(await panel.evaluate(() => document.activeElement!.id), 'erase-confirm-no');
    await click('#erase-confirm-yes');
    await waitPanel(async () => !('folio.bookmarks' in (await chrome.storage.local.get(null))), [], 'bookmarks erased');
    await selectTab('bookmarks');
    await waitPanel(() => document.querySelectorAll('#bookmark-list li').length === 0, [], 'empty bookmark list');

    await selectTab('settings');
    await click('#erase-all');
    await click('#erase-confirm-yes');
    await waitPanel(async () => Object.keys(await chrome.storage.local.get(null)).length === 0, [], 'all erased');
    await waitPanel(
      () => document.documentElement.dataset.theme === 'system' && (document.getElementById('setting-enabled') as HTMLInputElement).checked,
      [],
      'defaults restored',
    );
  });
});

describe('erase all forgets the live index (review finding 3)', () => {
  interface PortSearch {
    total: number;
    hits: { rendered: boolean }[];
    searchedLoaded: number;
    searchedNotLoaded: number;
    coverage: string;
  }

  /** Searches the content script's index directly over a panel port, bypassing the panel UI. */
  const searchIndex = (query: string) =>
    panel.evaluate<PortSearch>(
      (id: number, q: string) =>
        new Promise((resolve, reject) => {
          const port = chrome.tabs.connect(id, { name: 'folio-panel' });
          const timer = setTimeout(() => reject(new Error('no search reply')), 5000);
          port.onMessage.addListener((message: { type: string; result?: { total: number; hits: { rendered: boolean }[]; searchedLoaded: number; searchedNotLoaded: number }; coverage?: string; message?: string }) => {
            if (message.type === 'snapshot') return;
            clearTimeout(timer);
            port.disconnect();
            if (message.type !== 'search') reject(new Error(message.message ?? message.type));
            else resolve({ ...message.result!, coverage: message.coverage! });
          });
          port.postMessage({ type: 'search', requestId: 1, query: q });
        }),
      tabId,
      query,
    );

  it('previously seen text, including virtualized-away messages, is no longer searchable after Erase all', async () => {
    await showFixture('long');
    await page.evaluate(() => {
      for (const turn of Array.from(document.querySelectorAll('[data-test-render-count]')).slice(0, 200)) turn.remove();
    });
    await waitPanel(() => /plus 200 seen earlier/.test(document.getElementById('status-text')!.textContent!), [], 'virtualized messages');
    const virtualized = await searchIndex('"Step 6:"');
    assert.deepEqual([virtualized.total, virtualized.hits[0]?.rendered], [1, false], 'seen earlier, no longer loaded, still searchable before erase');
    assert.equal((await searchIndex(`"${NEEDLE_PHRASE}"`)).total, 1);

    await selectTab('settings');
    await click('#erase-all');
    await click('#erase-confirm-yes');
    await waitPanel(async () => Object.keys(await chrome.storage.local.get(null)).length === 0, [], 'storage erased');
    const announced = await waitPanel<string>(
      () => /^All Folio data erased/.test(document.getElementById('announcer')!.textContent!) && document.getElementById('announcer')!.textContent,
      [],
      'erase announcement',
    );
    for (const query of ['"Step 6:"', `"${NEEDLE_PHRASE}"`, 'step']) {
      const after = await searchIndex(query);
      assert.deepEqual([after.total, after.searchedLoaded, after.searchedNotLoaded], [0, 0, 0], query);
      assert.match(after.coverage, /^Nothing was searched\. Folio's index of this page was erased\./);
    }
    assert.equal(announced, 'All Folio data erased: bookmarks, settings, and the index in 1 open claude.ai tab.');
    await waitPanel(() => /index of this page was erased/.test(document.getElementById('status-text')!.textContent!), [], 'erased status');
    assert.equal(await panel.evaluate(() => document.getElementById('reindex')!.hidden), false);
    assert.equal(await text('#feature-chips li[data-feature="search"]'), 'Search: blocked');
    assert.equal(await panel.evaluate(() => document.querySelectorAll('#outline-list li, #search-results li').length), 0);
    // Page changes do not quietly rebuild the index.
    await page.evaluate(() => document.querySelector('[data-test-render-count]')!.remove());
    await sleep(1500);
    assert.equal((await searchIndex('step')).total, 0);
    const ping = await panel.evaluate<{ state: string }>((id: number) => chrome.tabs.sendMessage(id, { type: 'folio:ping' }), tabId);
    assert.equal(ping.state, 'erased');

    await click('#reindex');
    await waitPanel(() => document.querySelector('#outline-list .exchange') && document.getElementById('reindex')!.hidden, [], 're-indexed');
    const reindexed = await searchIndex('"Step 6:"');
    assert.equal(reindexed.total, 0, 'virtualized-away text is gone for good');
    assert.equal(reindexed.searchedNotLoaded, 0);
    assert.equal(reindexed.searchedLoaded, 299);
    assert.equal((await searchIndex(`"${NEEDLE_PHRASE}"`)).hits[0]?.rendered, true, 'loaded messages are searchable again');
  });
});

describe('pages Folio cannot use', () => {
  it('says when no conversation is open', async () => {
    await page.goto(fixtureUrl('home'));
    await waitPanel(() => document.getElementById('status-text')!.textContent!.startsWith('No conversation is open'), [], 'no conversation');
    assert.equal(await panel.evaluate(() => document.querySelectorAll('#outline-list li').length), 0);
  });

  it('says when the tab is not a claude.ai page', async () => {
    const blank = await browser.newPage();
    const panelTab = await panel.evaluate<number>(async () => (await chrome.tabs.getCurrent())!.id!);
    const others = await panel.evaluate<number[]>(async (exclude: number[]) => {
      const tabs = await chrome.tabs.query({});
      return tabs.map((t) => t.id!).filter((id) => !exclude.includes(id));
    }, [tabId, panelTab]);
    assert.ok(others.length > 0);
    const second = await browser.newPage();
    await second.goto(`chrome-extension://${extensionId}/sidepanel.html?tabId=${others[0]}`);
    await second.waitFor(() => document.getElementById('status')!.dataset.state === 'unavailable', [], 10_000, 'unavailable state');
    assert.match((await second.evaluate<string>(() => document.getElementById('status-text')!.textContent!))!, /^Folio is not running in this tab\./);
    assert.equal(await second.evaluate(() => document.querySelector('#feature-chips li[data-feature="search"]')!.textContent), 'Search: blocked');
    await second.close();
    await blank.close();
  });
});

describe('unpinned panel (the real side panel mode)', () => {
  it('follows the active tab of its window', async () => {
    await page.goto(fixtureUrl('loaded'));
    const follower = await browser.newPage();
    await follower.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    // The panel page is itself the active tab, which is not a claude.ai page.
    await follower.waitFor(() => document.getElementById('status')!.dataset.state === 'unavailable', [], 10_000, 'unavailable while active');
    await browser.send('Target.activateTarget', { targetId: page.targetId });
    const title = await follower.waitFor<string>(
      () => document.querySelector('#outline-list .exchange') && document.getElementById('conversation-title')!.textContent,
      [],
      10_000,
      'follows the claude.ai tab',
    );
    assert.equal(title, TITLES.loaded);
    await follower.close();
  });
});

describe('privacy', () => {
  it('made no network requests: only synthetic documents were served and nothing else left the browser', () => {
    const blocked = page.requests.filter((r) => r.outcome === 'blocked');
    assert.deepEqual(blocked, []);
    assert.ok(page.requests.every((r) => r.url.startsWith('https://claude.ai/')));
    assert.deepEqual(extensionRequests, []);
  });
});
