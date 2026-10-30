// Groups messages into exchanges (a prompt plus the replies that follow it).
// Labels are source excerpts or source headings only; nothing is inferred.
import type { MessageSummary } from './types.ts';

export interface Exchange {
  /** 1-based position among exchanges Folio knows about (not claude.ai's numbering). */
  number: number;
  label: string;
  /** 'prompt-excerpt': first line of the human prompt. 'reply-excerpt': no prompt is loaded for this exchange. */
  labelSource: 'prompt-excerpt' | 'reply-excerpt' | 'no-text';
  prompt: MessageSummary | null;
  replies: MessageSummary[];
  /** 'all', 'some' or 'none' of this exchange's messages are loaded in the page. */
  loaded: 'all' | 'some' | 'none';
}

function loadedState(messages: MessageSummary[]): Exchange['loaded'] {
  const count = messages.filter((m) => m.rendered).length;
  if (count === messages.length) return 'all';
  return count === 0 ? 'none' : 'some';
}

function labelFor(prompt: MessageSummary | null, replies: MessageSummary[]): Pick<Exchange, 'label' | 'labelSource'> {
  if (prompt && prompt.excerpt) return { label: prompt.excerpt, labelSource: 'prompt-excerpt' };
  const reply = replies.find((r) => r.excerpt);
  if (!prompt && reply) return { label: reply.excerpt, labelSource: 'reply-excerpt' };
  return { label: prompt ? 'Prompt without readable text' : 'Reply without readable text', labelSource: 'no-text' };
}

export function buildExchanges(messages: MessageSummary[]): Exchange[] {
  const groups: { prompt: MessageSummary | null; replies: MessageSummary[] }[] = [];
  for (const message of messages) {
    const current = groups[groups.length - 1];
    if (message.role === 'human' || !current) {
      groups.push(message.role === 'human' ? { prompt: message, replies: [] } : { prompt: null, replies: [message] });
    } else {
      current.replies.push(message);
    }
  }
  return groups.map((group, i) => ({
    number: i + 1,
    ...labelFor(group.prompt, group.replies),
    prompt: group.prompt,
    replies: group.replies,
    loaded: loadedState(group.prompt ? [group.prompt, ...group.replies] : group.replies),
  }));
}

/** Exchange number for each message key, for search results and bookmarks. */
export function exchangeNumbers(exchanges: Exchange[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const exchange of exchanges) {
    if (exchange.prompt) map.set(exchange.prompt.key, exchange.number);
    for (const reply of exchange.replies) map.set(reply.key, exchange.number);
  }
  return map;
}
