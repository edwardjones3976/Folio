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
  /** How many earlier loaded messages share role and digest (duplicate disambiguation). */
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

export type PageState = 'ready' | 'disabled' | 'no-conversation' | 'no-messages';

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

/** Stable, source-specific reference to one message (used by outline jumps and bookmarks). */
export interface MessageAnchor {
  provider: 'claude.ai';
  conversationId: string;
  role: Role;
  digest: string;
  occurrence: number;
  /** Ordinal when the anchor was made; only a tie-breaker, never trusted alone. */
  ordinal: number;
  /** Start of the normalized message text, for detecting changed messages. */
  prefix: string;
  headingIndex?: number;
  headingText?: string;
}

export type Resolution =
  | { status: 'exact'; index: number; note?: string }
  | { status: 'changed'; index: number; note: string }
  | { status: 'unresolved'; reason: 'not-loaded' | 'not-found' | 'ambiguous' | 'other-conversation'; note: string };

export interface JumpResult {
  status: 'jumped' | 'jumped-changed' | 'unresolved';
  note: string;
  /** Present when the target heading could not be matched and the message itself was used. */
  headingFallback?: boolean;
}
