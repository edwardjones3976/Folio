// Search view: renders lexical search results with snippets and coverage.
import type { SearchHit, SearchResult } from '../shared/search.ts';
import { clear, h } from './dom.ts';

export function renderSearchResults(
  list: HTMLElement,
  summary: HTMLElement,
  coverageNote: HTMLElement,
  result: SearchResult,
  coverage: string,
  onSelect: (hit: SearchHit) => void,
): void {
  clear(list);
  coverageNote.textContent = coverage;
  if (result.terms.length === 0) {
    summary.textContent = 'Type a word or a "quoted phrase" to search.';
    return;
  }
  const shown = result.truncated ? ` Showing the first ${result.hits.length}.` : '';
  summary.textContent =
    result.total === 0
      ? `No loaded message contains ${result.terms.map((t) => `"${t}"`).join(' and ')}.`
      : `${result.total} ${result.total === 1 ? 'message matches' : 'messages match'}.${shown}`;

  const fragment = document.createDocumentFragment();
  for (const hit of result.hits) {
    const who = hit.role === 'human' ? 'Prompt' : 'Claude';
    const snippet = h('span', { class: 'snippet' });
    for (const part of hit.snippet) snippet.append(part.match ? h('mark', { text: part.text }) : part.text);
    const button = h(
      'button',
      { type: 'button', class: 'jump result', 'data-nav': 'results', 'data-nav-id': `r${hit.key}` },
      h(
        'span',
        { class: 'result-meta' },
        `Exchange ${hit.exchange} · ${who} · ${hit.matches} ${hit.matches === 1 ? 'match' : 'matches'}`,
        hit.rendered ? null : h('span', { class: 'badge warn', text: 'Not loaded in page' }),
      ),
      snippet,
    );
    button.addEventListener('click', () => onSelect(hit));
    fragment.append(h('li', {}, button));
  }
  list.append(fragment);
}
