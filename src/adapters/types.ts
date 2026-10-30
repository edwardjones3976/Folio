// Site adapter interface: everything provider-specific (DOM discovery, source
// identity, coverage evidence) lives behind this boundary.
import type { BranchInfo, ConversationRef, CoverageSignal, DiscoveryStrategy, Role } from '../shared/types.ts';

export interface DiscoveredHeading {
  level: number;
  text: string;
  element: Element;
}

export interface DiscoveredMessage {
  element: Element;
  role: Role;
  /** Normalized readable text of the message. */
  text: string;
  headings: DiscoveredHeading[];
  branch: BranchInfo | null;
  streaming: boolean;
}

export interface Discovery {
  messages: DiscoveredMessage[];
  strategy: DiscoveryStrategy;
  /** Provider-specific coverage evidence (loading indicators, branches, ...). */
  signals: CoverageSignal[];
}

export interface SiteAdapter {
  readonly id: 'claude.ai';
  readonly label: string;
  /** Conversation identity from the page location, or null when no conversation is open. */
  conversation(location: { href: string; pathname: string }, doc: Document): ConversationRef | null;
  discover(doc: Document): Discovery;
  /**
   * A string that changes when the user switches branches (edits or retries),
   * so previously seen messages from another branch are not kept.
   */
  branchSignature(messages: readonly DiscoveredMessage[]): string;
}
