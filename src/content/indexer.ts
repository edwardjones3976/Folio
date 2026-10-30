// Live, in-memory index of the open conversation. Nothing here is persisted:
// message text stays in the content script's memory for the life of the page.
import type { DiscoveredMessage, SiteAdapter } from '../adapters/types.ts';
import { resolveAnchor } from '../shared/anchors.ts';
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
  text: string;
}

export interface Located {
  resolution: Resolution;
  message: DiscoveredMessage | null;
}

const NO_STRATEGY: DiscoveryStrategy = { id: 'none', label: 'Not running', stable: true };

export class LiveIndex {
  private known: IndexedMessage[] = [];
  private elements = new Map<string, DiscoveredMessage>();
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
      const seen = new Map<string, number>();
      const current: IndexedMessage[] = discovery.messages.map((m, ordinal) => {
        const d = digest(m.text);
        const occurrence = seen.get(`${m.role}:${d}`) ?? 0;
        seen.set(`${m.role}:${d}`, occurrence + 1);
        return {
          key: `${m.role}:${d}:${occurrence}`,
          role: m.role,
          digest: d,
          occurrence,
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
      this.known = mergeLoaded(this.known, current).map((m, seq) => ({ ...m, seq, ordinal: m.rendered ? m.ordinal : -1 }));
      this.elements = new Map(current.map((m, i) => [m.key, discovery.messages[i]!]));
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
    if (fingerprint === this.fingerprint) return false;
    this.fingerprint = fingerprint;
    this.revision += 1;
    return true;
  }

  reset(): void {
    this.known = [];
    this.elements = new Map();
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
      messages: this.known.map(({ text: _text, ...summary }) => summary),
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

  anchorFor(key: string, headingIndex?: number): MessageAnchor | null {
    const message = this.known.find((m) => m.key === key);
    if (!message || !this.conversation) return null;
    const anchor: MessageAnchor = {
      provider: 'claude.ai',
      conversationId: this.conversation.id,
      role: message.role,
      digest: message.digest,
      occurrence: message.occurrence,
      ordinal: message.ordinal,
      prefix: anchorPrefix(message.text),
    };
    const heading = headingIndex === undefined ? undefined : message.headings[headingIndex];
    if (heading) {
      anchor.headingIndex = heading.index;
      anchor.headingText = heading.text;
    }
    return anchor;
  }

  locate(anchor: MessageAnchor): Located {
    const resolution = resolveAnchor(anchor, this.conversation?.id ?? null, this.known);
    if (resolution.status === 'unresolved') return { resolution, message: null };
    const target = this.known[resolution.index]!;
    const message = this.elements.get(target.key) ?? null;
    if (!message || !message.element.isConnected) {
      return {
        resolution: { status: 'unresolved', reason: 'not-loaded', note: 'The message is not loaded in the page right now. Scroll the chat to load it, then try again.' },
        message: null,
      };
    }
    return { resolution, message };
  }
}
