// claude.ai site adapter.
//
// The selectors below model claude.ai markup as described by public open-source
// tools and observation; they were NOT verified against live claude.ai for this
// build (no logged-in session was available). Discovery prefers semantic data
// attributes and falls back to CSS class names only when those are absent,
// reporting the fallback as less stable. Folio never guesses messages: when
// nothing matches, it reports that nothing was recognized.
import { extractText, inPrivateRegion, outermostInOrder } from '../content/extract.ts';
import { conversationUrl } from '../shared/storage.ts';
import { normalizeText } from '../shared/text.ts';
import type { BranchInfo, ConversationRef, CoverageSignal, DiscoveryStrategy, Role } from '../shared/types.ts';
import type { DiscoveredHeading, DiscoveredMessage, Discovery, SiteAdapter } from './types.ts';

export const CLAUDE_SELECTORS = {
  human: '[data-testid="user-message"]',
  assistant: '[data-is-streaming]',
  turn: '[data-test-render-count]',
  humanFallback: '.font-user-message',
  assistantFallback: '.font-claude-response, .font-claude-message',
  loading: '[aria-busy="true"], [role="progressbar"]',
} as const;

const CHAT_PATH = /^\/chat\/([A-Za-z0-9_-]{6,80})\/?$/;
const BRANCH_TEXT = /^\s*(\d{1,3})\s*\/\s*(\d{1,3})\s*$/;

function cleanTitle(raw: string): string {
  const title = normalizeText(raw).replace(/\s*[-|–—]\s*Claude\s*$/i, '').trim();
  return title && title.toLowerCase() !== 'claude' ? title : 'Untitled conversation';
}

function query(doc: Document, selector: string): Element[] {
  return Array.from(doc.querySelectorAll(selector)).filter((el) => !inPrivateRegion(el));
}

function headingsOf(el: Element): DiscoveredHeading[] {
  return Array.from(el.querySelectorAll('h1, h2, h3, h4, h5, h6'))
    .filter((h) => !inPrivateRegion(h))
    .map((h) => ({ level: Number(h.tagName.slice(1)), text: extractText(h), element: h }))
    .filter((h) => h.text.length > 0);
}

/**
 * Finds a "2 / 3" style version switcher in the message's turn container. Text
 * inside any message is ignored, so a message that merely contains "1 / 2" is
 * not mistaken for a switcher. Without a turn container, no branch is reported.
 */
function branchOf(el: Element, messageEls: readonly Element[]): BranchInfo | null {
  const turn = el.closest(CLAUDE_SELECTORS.turn);
  if (!turn) return null;
  for (const candidate of Array.from(turn.querySelectorAll('span, div'))) {
    if (candidate.children.length > 0) continue;
    const match = BRANCH_TEXT.exec(candidate.textContent ?? '');
    if (!match) continue;
    if (messageEls.some((m) => m.contains(candidate))) continue;
    if (!candidate.parentElement?.querySelector('button')) continue;
    const current = Number(match[1]);
    const total = Number(match[2]);
    if (current >= 1 && total >= 2 && current <= total) return { current, total };
  }
  return null;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export const claudeAdapter: SiteAdapter = {
  id: 'claude.ai',
  label: 'claude.ai',

  conversation(location, doc): ConversationRef | null {
    let host = '';
    try {
      host = new URL(location.href).hostname;
    } catch {
      return null;
    }
    if (host !== 'claude.ai') return null;
    const match = CHAT_PATH.exec(location.pathname);
    const id = match?.[1];
    const url = id ? conversationUrl(id) : null;
    if (!id || !url) return null;
    return { provider: 'claude.ai', id, url, title: cleanTitle(doc.title) };
  },

  discover(doc): Discovery {
    let humans = query(doc, CLAUDE_SELECTORS.human);
    let assistants = query(doc, CLAUDE_SELECTORS.assistant);
    let fallback = false;
    if (humans.length === 0) {
      humans = query(doc, CLAUDE_SELECTORS.humanFallback);
      fallback ||= humans.length > 0;
    }
    if (assistants.length === 0) {
      assistants = query(doc, CLAUDE_SELECTORS.assistantFallback);
      fallback ||= assistants.length > 0;
    }

    const roles = new Map<Element, Role>();
    for (const el of outermostInOrder(humans)) roles.set(el, 'human');
    for (const el of outermostInOrder(assistants)) if (!roles.has(el)) roles.set(el, 'assistant');
    // A message nested inside another message is a duplicate match, not a message.
    const ordered = outermostInOrder(roles.keys());

    const messages: DiscoveredMessage[] = ordered.map((element) => {
      const role = roles.get(element)!;
      const streamingHost = element.closest(CLAUDE_SELECTORS.assistant);
      return {
        element,
        role,
        text: extractText(element),
        headings: headingsOf(element),
        branch: branchOf(element, ordered),
        streaming: role === 'assistant' && streamingHost?.getAttribute('data-is-streaming') === 'true',
      };
    });

    const strategy: DiscoveryStrategy =
      messages.length === 0
        ? { id: 'none', label: 'No claude.ai messages recognized', stable: true }
        : fallback
          ? { id: 'class-fallback', label: 'claude.ai CSS class names (fallback, less stable)', stable: false }
          : { id: 'semantic-attributes', label: 'claude.ai data attributes', stable: true };

    const signals: CoverageSignal[] = [];
    if (fallback) {
      signals.push({
        code: 'fallback-selectors',
        severity: 'warning',
        message: 'Messages were recognized by CSS class names because the usual data attributes were missing. Some messages may be missed.',
      });
    }
    if (messages[0]?.role === 'assistant') {
      signals.push({
        code: 'first-not-human',
        severity: 'warning',
        message: 'The first loaded message is a Claude reply, so earlier messages are probably not loaded. Scroll up in the chat to load them.',
      });
    }
    const loading = query(doc, CLAUDE_SELECTORS.loading).filter((el) => !ordered.some((m) => m.contains(el)));
    if (loading.length > 0) {
      signals.push({
        code: 'loading-indicator',
        severity: 'warning',
        message: 'claude.ai is showing a loading indicator, so some messages may not be loaded yet.',
      });
    }
    const branched = messages.filter((m) => m.branch && m.branch.total > 1).length;
    if (branched > 0) {
      signals.push({
        code: 'branches',
        severity: 'info',
        count: branched,
        message: `${plural(branched, 'message has', 'messages have')} other versions (edits or retries). Only the version claude.ai is showing is indexed.`,
      });
    }
    const streaming = messages.filter((m) => m.streaming).length;
    if (streaming > 0) {
      signals.push({ code: 'streaming', severity: 'info', count: streaming, message: 'A reply is still being written; its text will change.' });
    }
    const noText = messages.filter((m) => m.text.length === 0).length;
    if (noText > 0) {
      signals.push({
        code: 'no-text',
        severity: 'info',
        count: noText,
        message: `${plural(noText, 'message has', 'messages have')} no readable text (for example only images or files). Images, files and artifacts are not indexed.`,
      });
    }
    return { messages, strategy, signals };
  },

  branchSignature(messages): string {
    return messages
      .filter((m) => m.branch)
      .map((m) => `${m.role}:${m.branch!.current}/${m.branch!.total}`)
      .join('|');
  },
};
