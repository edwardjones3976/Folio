// Bundled in memory by tests/browser/adapter.test.ts and evaluated in a fixture
// page, so the real adapter and index code run against a real browser DOM.
import { claudeAdapter } from '../../src/adapters/claude.ts';
import { LiveIndex } from '../../src/content/indexer.ts';
import { jumpTo } from '../../src/content/navigate.ts';
import type { JumpOptions } from '../../src/content/navigate.ts';
import { buildExchanges } from '../../src/shared/outline.ts';
import { search } from '../../src/shared/search.ts';
import type { MessageAnchor } from '../../src/shared/types.ts';

const index = new LiveIndex(claudeAdapter, document, location);

(globalThis as unknown as { __folioHarness: unknown }).__folioHarness = {
  refresh: () => index.refresh(),
  snapshot: () => {
    index.refresh();
    return index.snapshot();
  },
  discover: () =>
    claudeAdapter.discover(document).messages.map((m) => ({
      role: m.role,
      text: m.text,
      headings: m.headings.map((h) => ({ level: h.level, text: h.text })),
      branch: m.branch,
      streaming: m.streaming,
    })),
  exchanges: () => {
    index.refresh();
    return buildExchanges(index.snapshot().messages).map((e) => ({ number: e.number, label: e.label, labelSource: e.labelSource, loaded: e.loaded }));
  },
  anchorFor: (key: string, headingIndex?: number) => index.anchorFor(key, headingIndex),
  locate: (anchor: MessageAnchor) => {
    index.refresh();
    const located = index.locate(anchor);
    return { resolution: located.resolution, text: located.message?.text ?? null };
  },
  jump: (anchor: MessageAnchor, options: JumpOptions) => {
    index.refresh();
    const located = index.locate(anchor);
    return located.message ? jumpTo(document, located.message, options) : null;
  },
  search: (query: string) => {
    index.refresh();
    return search(index.searchDocs(), query);
  },
  timeRefresh: () => {
    const fresh = new LiveIndex(claudeAdapter, document, location);
    const start = performance.now();
    fresh.refresh();
    return performance.now() - start;
  },
};
