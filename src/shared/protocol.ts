// Messages between the side panel and the content script. The panel opens a
// long-lived port to the content script of one tab; the content script only ever
// posts on an open port, so it never messages a closed panel.
import type { SearchResult } from './search.ts';
import type { JumpResult, MessageAnchor, Resolution, Snapshot } from './types.ts';

export const PORT_NAME = 'folio-panel';
export const PING = 'folio:ping';

export type PanelRequest =
  | { type: 'jump'; requestId: number; anchor: MessageAnchor; highlightTerm?: string }
  | { type: 'search'; requestId: number; query: string }
  | { type: 'anchor-for'; requestId: number; key: string; headingIndex?: number }
  | { type: 'resolve'; requestId: number; anchors: MessageAnchor[] };

export type ContentReply =
  | { type: 'jump'; requestId: number; result: JumpResult }
  | { type: 'search'; requestId: number; result: SearchResult; coverage: string }
  | { type: 'anchor-for'; requestId: number; anchor: MessageAnchor | null }
  | { type: 'resolve'; requestId: number; results: Resolution[] }
  | { type: 'error'; requestId: number; message: string };

export type ContentPush = { type: 'snapshot'; snapshot: Snapshot };

export interface PingReply {
  ok: true;
  provider: 'claude.ai';
  url: string;
  state: Snapshot['state'] | 'starting';
}

const REQUEST_TYPES = new Set(['jump', 'search', 'anchor-for', 'resolve']);

/** Structural check on messages arriving at the content script. */
export function isPanelRequest(value: unknown): value is PanelRequest {
  if (typeof value !== 'object' || value === null) return false;
  const msg = value as Record<string, unknown>;
  return typeof msg.type === 'string' && REQUEST_TYPES.has(msg.type) && Number.isInteger(msg.requestId);
}
