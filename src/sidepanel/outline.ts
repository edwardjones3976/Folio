// Outline view: one entry per exchange, with source headings from replies.
import { buildExchanges } from '../shared/outline.ts';
import type { Exchange } from '../shared/outline.ts';
import type { MessageSummary, Snapshot } from '../shared/types.ts';
import { clear, h } from './dom.ts';

export interface OutlineActions {
  jump(message: MessageSummary, description: string, headingIndex?: number): void;
  bookmark(exchange: Exchange, message: MessageSummary): void;
}

/** The reply a bookmark should point at: the answer if there is one, else the prompt. */
export function bookmarkTarget(exchange: Exchange): MessageSummary | null {
  return exchange.replies.find((r) => r.chars > 0) ?? exchange.replies[0] ?? exchange.prompt;
}

function loadedBadge(loaded: Exchange['loaded']): HTMLElement | null {
  if (loaded === 'all') return null;
  return h('span', { class: 'badge warn', text: loaded === 'none' ? 'Not loaded in page' : 'Partly loaded' });
}

function exchangeItem(exchange: Exchange, showHeadings: boolean, actions: OutlineActions): HTMLLIElement {
  const first = exchange.prompt ?? exchange.replies[0]!;
  const description = `exchange ${exchange.number}`;
  const jump = h(
    'button',
    { type: 'button', class: 'jump exchange-jump', 'data-nav': 'outline', 'data-nav-id': `x${exchange.number}` },
    h('span', { class: 'num', text: `${exchange.number}.` }),
    ' ',
    exchange.labelSource === 'reply-excerpt' ? h('span', { class: 'badge', text: 'Reply' }) : null,
    exchange.labelSource === 'reply-excerpt' ? ' ' : null,
    h('span', { class: exchange.labelSource === 'no-text' ? 'label muted' : 'label', text: exchange.label }),
    loadedBadge(exchange.loaded),
  );
  jump.addEventListener('click', () => actions.jump(first, description));

  const target = bookmarkTarget(exchange);
  const bookmark = target
    ? h('button', {
        type: 'button',
        class: 'icon-button bookmark-add',
        'aria-label': `Bookmark ${target.role === 'assistant' ? "Claude's reply" : 'the prompt'} in exchange ${exchange.number}`,
        title: 'Bookmark',
        text: '☆',
        'data-nav-id': `b${exchange.number}`,
      })
    : null;
  bookmark?.addEventListener('click', () => actions.bookmark(exchange, target!));

  const item = h('li', { class: 'exchange', 'data-loaded': exchange.loaded }, h('div', { class: 'exchange-row' }, jump, bookmark));

  if (showHeadings) {
    const headings = exchange.replies.flatMap((reply) => reply.headings.map((heading) => ({ reply, heading })));
    if (headings.length > 0) {
      const list = h('ol', { class: 'headings', 'aria-label': `Headings in exchange ${exchange.number}` });
      for (const { reply, heading } of headings) {
        const button = h(
          'button',
          {
            type: 'button',
            class: `jump heading-jump level-${Math.min(heading.level, 4)}`,
            'data-nav': 'outline',
            'data-nav-id': `x${exchange.number}-${reply.key}-${heading.index}`,
          },
          h('span', { class: 'visually-hidden', text: `Heading level ${heading.level}: ` }),
          heading.text,
        );
        button.addEventListener('click', () => actions.jump(reply, `heading "${heading.text}"`, heading.index));
        list.append(h('li', {}, button));
      }
      item.append(list);
    }
  }
  return item;
}

export function renderOutline(
  list: HTMLElement,
  summary: HTMLElement,
  snapshot: Snapshot | null,
  showHeadings: boolean,
  actions: OutlineActions,
): void {
  const focusedId = (document.activeElement as HTMLElement | null)?.dataset?.navId;
  clear(list);
  if (!snapshot || snapshot.state !== 'ready') {
    summary.textContent = 'No outline: open a claude.ai conversation with Folio turned on.';
    return;
  }
  const exchanges = buildExchanges(snapshot.messages);
  const headingCount = snapshot.messages.reduce((n, m) => n + m.headings.length, 0);
  summary.textContent = `${exchanges.length} exchanges, ${snapshot.messages.length} messages, ${headingCount} reply headings.`;
  const fragment = document.createDocumentFragment();
  for (const exchange of exchanges) fragment.append(exchangeItem(exchange, showHeadings, actions));
  list.append(fragment);
  if (focusedId) list.querySelector<HTMLElement>(`[data-nav-id="${CSS.escape(focusedId)}"]`)?.focus();
}
