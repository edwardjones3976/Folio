// Explicit feature statuses (spec section 4). Static entries describe what is
// built; page-dependent features are re-evaluated from the live snapshot.
import type { FeatureStatus, Snapshot } from './types.ts';

export interface FeatureReport {
  id: string;
  name: string;
  status: FeatureStatus;
  detail: string;
}

/** Features whose status does not depend on the open page. */
export const STATIC_FEATURES: readonly FeatureReport[] = [
  {
    id: 'chapters',
    name: 'Chapters',
    status: 'partial',
    detail: 'The outline groups messages into exchanges and lists headings found in replies. Topic detection and user-edited chapters are not built.',
  },
  {
    id: 'settings',
    name: 'Settings and stored-data controls',
    status: 'working',
    detail: 'Enable/disable on claude.ai, theme, text size, inspect, download and erase stored data.',
  },
  {
    id: 'archive',
    name: 'Conversation archive, book view and export',
    status: 'not_implemented',
    detail: 'Planned for a later release (P1). Folio does not save conversation text, except the short excerpt kept with each bookmark.',
  },
  {
    id: 'other-sites',
    name: 'Other chat sites',
    status: 'not_implemented',
    detail: 'Only https://claude.ai/ is supported.',
  },
];

/** Status of page-dependent features for the current snapshot (null: no Folio page connected). */
export function pageFeatures(snapshot: Snapshot | null, unavailableReason: string): FeatureReport[] {
  const make = (id: string, name: string, status: FeatureReport['status'], detail: string): FeatureReport => ({ id, name, status, detail });
  if (!snapshot || snapshot.state !== 'ready') {
    const reason =
      snapshot?.state === 'disabled'
        ? 'Folio is turned off for claude.ai.'
        : snapshot?.state === 'no-conversation'
          ? 'No claude.ai conversation is open in this tab.'
          : snapshot?.state === 'no-messages'
            ? 'No messages were recognized on this page; claude.ai may have changed its layout.'
            : unavailableReason;
    return [
      make('outline', 'Outline', 'blocked', reason),
      make('jump', 'Jump and highlight', 'blocked', reason),
      make('search', 'Search', 'blocked', reason),
      make('bookmarks', 'Bookmarks', 'partial', `Saved bookmarks can be viewed, edited and opened. New bookmarks need an open conversation. ${reason}`),
    ];
  }
  const partialReasons: string[] = [];
  if (!snapshot.strategy.stable) partialReasons.push('messages were found with fallback CSS class names, which are less reliable');
  if (snapshot.coverage.level === 'partial') partialReasons.push('coverage is partial');
  const status: FeatureStatus = partialReasons.length > 0 ? 'partial' : 'working';
  const detail = partialReasons.length > 0 ? `Partial because ${partialReasons.join(' and ')}.` : 'Working on the messages loaded in this page.';
  return [
    make('outline', 'Outline', status, detail),
    make('jump', 'Jump and highlight', status, detail),
    make('search', 'Search', status, detail),
    make('bookmarks', 'Bookmarks', 'working', 'Saved locally; anchors resolve by message content, and unresolved anchors are reported.'),
  ];
}
