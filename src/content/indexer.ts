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

  /** `role:digest` of the known message at `index`, or null outside the known list. */
  private neighbour(index: number): string | null {
    return this.known[index]?.id ?? null;
  }

  anchorFor(key: string, headingIndex?: number): MessageAnchor | null {
    const position = this.known.findIndex((m) => m.key === key);
    const message = this.known[position];
    if (!message || !this.conversation) return null;
    const anchor: MessageAnchor = {
      provider: 'claude.ai',
      conversationId: this.conversation.id,
      role: message.role,
      digest: message.digest,
      occurrence: message.occurrence,
      ordinal: message.ordinal,
      prefix: anchorPrefix(message.text),
      context: { before: this.neighbour(position - 1), after: this.neighbour(position + 1) },
    };
    const heading = headingIndex === undefined ? undefined : message.headings[headingIndex];
    if (heading) {
      anchor.headingIndex = heading.index;
      anchor.headingText = heading.text;
    }
    return anchor;
  }

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
    if (resolution.status === 'unresolved' || resolution.status === 'ambiguous') return { resolution, message: null };
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
