// Live, in-memory index of the open conversation. Nothing here is persisted:
// message text stays in the content script's memory for the life of the page.
import type { DiscoveredMessage, SiteAdapter } from '../adapters/types.ts';
import { messageId, resolveAnchor } from '../shared/anchors.ts';
import type { AnchorCandidate } from '../shared/anchors.ts';
import { computeCoverage } from '../shared/coverage.ts';
import { mergeLoaded } from '../shared/merge.ts';
import { buildExchanges, exchangeNumbers } from '../shared/outline.ts';
import type { SearchDoc } from '../shared/search.ts';
import { anchorPrefix, digest, excerpt } from '../shared/text.ts';
import type {
  ConversationRef,
  Coverage,
  CoverageSignal,
  DiscoveryStrategy,
  MessageAnchor,
  MessageSummary,
  PageState,
  Resolution,
  Snapshot,
} from '../shared/types.ts';

interface IndexedMessage extends MessageSummary {
  /** Content identity, `role:digest`; identical messages share it. */
  id: string;
  text: string;
}

export interface Located {
  resolution: Resolution;
  message: DiscoveredMessage | null;
}

export interface Targeted extends Located {
  /** The entry as the panel showed it. */
  shown: MessageSummary;
  /** True when the page changed after the panel showed the entry, so it had to be found again. */
  stale: boolean;
}

/**
 * One state of the index. Outline entries and search results name messages by
 * key, and a key is only meaningful within the generation (snapshot revision)
 * it came from: when earlier messages load, occurrence numbers can shift.
 */
interface Generation {
  known: IndexedMessage[];
  elements: Map<string, DiscoveredMessage>;
}

/** Recent generations, so a click on a list drawn just before the page changed can still be followed. */
const RECENT_GENERATIONS = 8;
/** Search results stay on screen while the page changes, so the generations they came from are kept as well. */
const SEARCHED_GENERATIONS = 2;

const NO_STRATEGY: DiscoveryStrategy = { id: 'none', label: 'Not running', stable: true };

const NOT_LOADED_NOW: Resolution = {
  status: 'unresolved',
  reason: 'not-loaded',
  note: 'The message is not loaded in the page right now. Scroll the chat to load it, then try again.',
};

/** The anchor for `known[position]`: its text, the messages around it and how many share its text. */
function anchorIn(known: readonly IndexedMessage[], position: number, conversationId: string): MessageAnchor {
  const message = known[position]!;
  return {
    provider: 'claude.ai',
    conversationId,
    role: message.role,
    digest: message.digest,
    occurrence: message.occurrence,
    ordinal: message.ordinal,
    prefix: anchorPrefix(message.text),
    context: { before: known[position - 1]?.id ?? null, after: known[position + 1]?.id ?? null },
    copies: known.filter((m) => m.id === message.id).length,
  };
}

function keep(generations: Map<number, Generation>, revision: number, generation: Generation, limit: number): void {
  generations.delete(revision);
  generations.set(revision, generation);
  for (const old of generations.keys()) {
    if (generations.size <= limit) break;
    generations.delete(old);
  }
}

export class LiveIndex {
  private known: IndexedMessage[] = [];
  private elements = new Map<string, DiscoveredMessage>();
  private generations = new Map<number, Generation>();
  private searched = new Map<number, Generation>();
  private conversation: ConversationRef | null = null;
  private signature = '';
  private signals: CoverageSignal[] = [];
  private strategy: DiscoveryStrategy = NO_STRATEGY;
  private coverage: Coverage = computeCoverage([], []);
  private state: PageState = 'no-conversation';
  private fingerprint = '';
  private revision = 0;
  private readonly adapter: SiteAdapter;
  private readonly doc: Document;
  private readonly location: { href: string; pathname: string };

  constructor(adapter: SiteAdapter, doc: Document, location: { href: string; pathname: string }) {
    this.adapter = adapter;
    this.doc = doc;
    this.location = location;
  }

  /** Re-reads the page. Returns true when the snapshot changed. */
  refresh(): boolean {
    const conversation = this.adapter.conversation(this.location, this.doc);
    if (conversation?.id !== this.conversation?.id) this.reset();
    this.conversation = conversation;

    if (!conversation) {
      this.state = 'no-conversation';
      this.strategy = NO_STRATEGY;
      this.signals = [];
    } else {
      const discovery = this.adapter.discover(this.doc);
      const signature = this.adapter.branchSignature(discovery.messages);
      if (signature !== this.signature) {
        this.known = [];
        this.signature = signature;
      }
      const current: IndexedMessage[] = discovery.messages.map((m, ordinal) => {
        const d = digest(m.text);
        return {
          id: messageId(m.role, d),
          key: '',
          role: m.role,
          digest: d,
          occurrence: 0,
          seq: 0,
          ordinal,
          excerpt: excerpt(m.text),
          headings: m.headings.map((h, index) => ({ level: h.level, text: h.text, index })),
          branch: m.branch,
          streaming: m.streaming,
          rendered: true,
          chars: m.text.length,
          text: m.text,
        };
      });
      // Occurrences are counted over everything known (including messages that
      // virtualization removed), not over the loaded subset, so a duplicate keeps
      // its number when the window slides.
      const seen = new Map<string, number>();
      this.known = mergeLoaded(this.known, current).map((m, seq) => {
        const occurrence = seen.get(m.id) ?? 0;
        seen.set(m.id, occurrence + 1);
        return { ...m, key: `${m.id}:${occurrence}`, occurrence, seq, ordinal: m.rendered ? m.ordinal : -1 };
      });
      this.elements = new Map(this.known.filter((m) => m.rendered).map((m) => [m.key, discovery.messages[m.ordinal]!]));
      this.strategy = discovery.strategy;
      this.signals = discovery.signals;
      this.state = current.length > 0 || this.known.length > 0 ? 'ready' : 'no-messages';
    }
    this.coverage = computeCoverage(this.known, this.signals);

    const fingerprint = JSON.stringify([
      this.state,
      this.conversation,
      this.strategy.id,
      this.coverage.statement,
      this.coverage.signals.map((s) => `${s.code}:${s.count ?? ''}`),
      this.known.map((m) => `${m.key}|${m.rendered ? 1 : 0}|${m.streaming ? 1 : 0}|${m.headings.length}|${m.branch?.current ?? ''}`),
    ]);
    const changed = fingerprint !== this.fingerprint;
    if (changed) {
      this.fingerprint = fingerprint;
      this.revision += 1;
    }
    // Same keys when unchanged; the elements may still have been re-rendered.
    keep(this.generations, this.revision, { known: this.known, elements: this.elements }, RECENT_GENERATIONS);
    return changed;
  }

  reset(): void {
    this.known = [];
    this.elements = new Map();
    this.generations = new Map();
    this.searched = new Map();
    this.signature = '';
  }

  /** Drops everything, e.g. when the user disables Folio. */
  clear(): void {
    this.reset();
    this.conversation = null;
    this.signals = [];
    this.strategy = NO_STRATEGY;
    this.coverage = computeCoverage([], []);
    this.state = 'no-conversation';
    this.fingerprint = '';
  }

  snapshot(): Snapshot {
    return {
      provider: 'claude.ai',
      state: this.state,
      conversation: this.conversation,
      messages: this.known.map(({ text: _text, id: _id, ...summary }) => summary),
      coverage: this.coverage,
      strategy: this.strategy,
      revision: this.revision,
    };
  }

  coverageStatement(): string {
    return this.coverage.statement;
  }

  searchDocs(): SearchDoc[] {
    const numbers = exchangeNumbers(buildExchanges(this.known));
    return this.known.map((m) => ({
      key: m.key,
      role: m.role,
      seq: m.seq,
      exchange: numbers.get(m.key) ?? 0,
      text: m.text,
      rendered: m.rendered,
    }));
  }

  /** Keeps the current generation while search results from it are on screen; returns its revision. */
  keepForSearch(): number {
    keep(this.searched, this.revision, { known: this.known, elements: this.elements }, SEARCHED_GENERATIONS);
    return this.revision;
  }

  /** `role:digest` of the known message at `index`, or null outside the known list. */
  private neighbour(index: number): string | null {
    return this.known[index]?.id ?? null;
  }

  /** The anchor to save for a bookmark; null unless `revision` is the current generation (keys may have shifted since). */
  anchorFor(key: string, headingIndex?: number, revision: number = this.revision): MessageAnchor | null {
    const position = this.known.findIndex((m) => m.key === key);
    const message = this.known[position];
    if (revision !== this.revision || !message || !this.conversation) return null;
    const anchor = anchorIn(this.known, position, this.conversation.id);
    const heading = headingIndex === undefined ? undefined : message.headings[headingIndex];
    if (heading) {
      anchor.headingIndex = heading.index;
      anchor.headingText = heading.text;
    }
    return anchor;
  }

  /** Persistent resolution, for stored bookmarks: by text and neighbours, never by position. */
  locate(anchor: MessageAnchor): Located {
    const candidates: AnchorCandidate[] = this.known.map((m, i) => ({
      role: m.role,
      digest: m.digest,
      text: m.text,
      rendered: m.rendered,
      before: this.neighbour(i - 1),
      after: this.neighbour(i + 1),
    }));
    const resolution = resolveAnchor(anchor, this.conversation?.id ?? null, candidates);
    if (resolution.status !== 'exact' && resolution.status !== 'changed') return { resolution, message: null };
    const target = this.known[resolution.index]!;
    const message = this.elements.get(target.key) ?? null;
    if (!message || !message.element.isConnected) return { resolution: NOT_LOADED_NOW, message: null };
    return { resolution, message };
  }

  /**
   * Direct navigation from the outline or search: the entry the panel showed as
   * `key` in generation `revision`. In the current generation that is the
   * indexed message's own element; no anchor is resolved. If the page changed
   * since, the entry is found again: by its element when that is still in the
   * page holding the same message after the same previous message, otherwise by
   * its anchor in that generation, resolved as strictly as a bookmark. Null when
   * that generation is no longer kept.
   */
  target(key: string, revision: number): Targeted | null {
    const generation = this.generations.get(revision) ?? this.searched.get(revision);
    const position = generation ? generation.known.findIndex((m) => m.key === key) : -1;
    if (!generation || position < 0) return null;
    const shown = generation.known[position]!;
    if (revision === this.revision) {
      const message = this.elements.get(key);
      if (!shown.rendered || !message?.element.isConnected) return { shown, stale: false, resolution: NOT_LOADED_NOW, message: null };
      return { shown, stale: false, resolution: { status: 'exact', index: position }, message };
    }
    return { shown, stale: true, ...this.relocate(generation, position) };
  }

  private relocate(generation: Generation, position: number): Located {
    const shown = generation.known[position]!;
    const element = generation.elements.get(shown.key)?.element;
    const now = element?.isConnected ? this.known.findIndex((m) => m.rendered && this.elements.get(m.key)?.element === element) : -1;
    const current = this.known[now];
    if (current && current.id === shown.id) {
      const before = { then: generation.known[position - 1]?.id, now: this.known[now - 1]?.id };
      if (!before.then || !before.now || before.then === before.now) {
        return { resolution: { status: 'exact', index: now }, message: this.elements.get(current.key)! };
      }
    }
    if (!this.conversation) return { resolution: NOT_LOADED_NOW, message: null };
    return this.locate(anchorIn(generation.known, position, this.conversation.id));
  }
}
