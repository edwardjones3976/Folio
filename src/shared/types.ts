// Shared, provider-agnostic data model for Folio P0.

export type Role = 'human' | 'assistant';

/** Explicit feature status vocabulary from the product contract (spec section 4). */
export type FeatureStatus = 'working' | 'partial' | 'blocked' | 'not_implemented';

export interface ConversationRef {
  provider: 'claude.ai';
  /** Conversation identifier taken from the page URL (e.g. /chat/<id>). */
  id: string;
  /** Canonical URL rebuilt from the id; never a stored arbitrary URL. */
  url: string;
  title: string;
}

export interface BranchInfo {
  /** 1-based version currently shown by claude.ai at this message. */
  current: number;
  total: number;
}

export interface HeadingRef {
  level: number;
  text: string;
  /** Position among the headings of the same message. */
  index: number;
}

/** Index entry describing one message as seen by the content script. */
export interface MessageSummary {
  /** Stable within a page session: `${role}:${digest}:${occurrence}`. */
  key: string;
  role: Role;
  /** Content digest of the normalized message text. */
  digest: string;
  /** How many earlier known messages (loaded or seen earlier) share role and digest; keeps keys unique. */
  occurrence: number;
  /** Position in the merged list (loaded + seen-earlier messages). */
  seq: number;
  /** Position among messages currently loaded in the page, or -1 when not loaded. */
  ordinal: number;
  /** First line of the message, truncated, for display. */
  excerpt: string;
  headings: HeadingRef[];
  branch: BranchInfo | null;
  streaming: boolean;
  /** True when the message element is currently present in the page. */
  rendered: boolean;
  /** Length of the normalized text; 0 means Folio found no readable text. */
  chars: number;
}

export type CoverageCode =
  | 'loading-indicator'
  | 'first-not-human'
  | 'branches'
  | 'streaming'
  | 'no-text'
  | 'fallback-selectors'
  | 'not-rendered';

export interface CoverageSignal {
  code: CoverageCode;
  severity: 'info' | 'warning';
  message: string;
  count?: number;
}

export interface Coverage {
  /** 'none': nothing indexed. 'partial': evidence of missing content. 'loaded-only': no such evidence, completeness still unverified. */
  level: 'none' | 'partial' | 'loaded-only';
  statement: string;
  renderedCount: number;
  knownCount: number;
  notRenderedCount: number;
  humanCount: number;
  assistantCount: number;
  branchPoints: number;
  signals: CoverageSignal[];
}

export interface DiscoveryStrategy {
  id: 'semantic-attributes' | 'class-fallback' | 'none';
  label: string;
  /** False when discovery relied on transient CSS class names. */
  stable: boolean;
}

/** 'erased': "Erase all Folio data" emptied the index; it stays empty until the user re-indexes or the page changes. */
export type PageState = 'ready' | 'disabled' | 'no-conversation' | 'no-messages' | 'erased';

export interface Snapshot {
  provider: 'claude.ai';
  state: PageState;
  conversation: ConversationRef | null;
  messages: MessageSummary[];
  coverage: Coverage;
  strategy: DiscoveryStrategy;
  /** Monotonic counter so the panel can ignore stale snapshots. */
  revision: number;
}

/**
 * The messages around an anchored message, as `${role}:${digest}` of the
 * previous and next message Folio knew when the anchor was made (null: none
 * known). Like the prefix and suffix of a W3C TextQuoteSelector, this tells
 * identical messages apart.
 */
export interface AnchorContext {
  before: string | null;
  after: string | null;
}

/** Stable, source-specific reference to one message (used by outline jumps and bookmarks). */
export interface MessageAnchor {
  provider: 'claude.ai';
  conversationId: string;
  role: Role;
  digest: string;
  /** Earlier known messages with the same role and digest when saved (informational; not used to resolve). */
  occurrence: number;
  /** Ordinal when the anchor was made (informational; never used to resolve). */
  ordinal: number;
  /** Start of the normalized message text, for detecting changed messages. */
  prefix: string;
  /** Missing on anchors saved by Folio 0.1.0 before context was recorded. */
  context?: AnchorContext;
  /**
   * Known messages (loaded or seen earlier) with the same role and text when the
   * anchor was made, itself included (informational; never used to resolve: it
   * counts only messages Folio had seen, so it cannot prove a text was unique).
   * Missing on anchors saved before it was recorded.
   */
  copies?: number;
  headingIndex?: number;
  headingText?: string;
}

/**
 * 'exact' and 'changed' identify one message. 'probable': one message fits but
 * its neighbours cannot confirm it. 'ambiguous': several messages fit, and Folio
 * cannot tell which one was saved. Jumps to anchors navigate only on 'exact'
 * and 'changed'.
 */
export type Resolution =
  | { status: 'exact'; index: number; note?: string }
  | { status: 'changed'; index: number; note: string }
  | { status: 'probable'; index: number; note: string }
  | { status: 'ambiguous'; note: string }
  | { status: 'unresolved'; reason: 'not-loaded' | 'not-found' | 'other-conversation'; note: string };

export interface JumpResult {
  status: 'jumped' | 'jumped-changed' | 'probable' | 'ambiguous' | 'unresolved';
  note: string;
  /** Present when the target heading could not be matched and the message itself was used. */
  headingFallback?: boolean;
}
