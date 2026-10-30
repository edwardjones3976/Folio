// Scrolls to and highlights a message (or one of its headings) in the page.
// Highlighting uses one data attribute (styled by content.css) and, for search
// terms, the CSS Custom Highlight API, which does not modify page markup.
import type { DiscoveredMessage } from '../adapters/types.ts';
import { foldCase } from '../shared/text.ts';

export const HIGHLIGHT_ATTR = 'data-folio-highlight';
export const TERM_HIGHLIGHT = 'folio-match';
const HIGHLIGHT_MS = 4000;
const TERM_HIGHLIGHT_MS = 8000;

let clearTimer: ReturnType<typeof setTimeout> | undefined;
let termTimer: ReturnType<typeof setTimeout> | undefined;

export function clearHighlights(doc: Document): void {
  for (const el of Array.from(doc.querySelectorAll(`[${HIGHLIGHT_ATTR}]`))) el.removeAttribute(HIGHLIGHT_ATTR);
  const registry = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
  registry?.delete(TERM_HIGHLIGHT);
}

function termRanges(doc: Document, root: Element, term: string, limit = 50): Range[] {
  const needle = foldCase(term);
  if (!needle) return [];
  const ranges: Range[] = [];
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  for (let node = walker.nextNode(); node && ranges.length < limit; node = walker.nextNode()) {
    const text = foldCase(node.nodeValue ?? '');
    let at = text.indexOf(needle);
    while (at >= 0 && ranges.length < limit) {
      const range = doc.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      ranges.push(range);
      at = text.indexOf(needle, at + needle.length);
    }
  }
  return ranges;
}

export interface JumpOptions {
  headingIndex?: number;
  headingText?: string;
  highlightTerm?: string;
}

export interface JumpOutcome {
  headingFallback: boolean;
  termFound: boolean;
}

export function jumpTo(doc: Document, message: DiscoveredMessage, options: JumpOptions = {}): JumpOutcome {
  clearHighlights(doc);
  clearTimeout(clearTimer);
  clearTimeout(termTimer);

  let target: Element = message.element;
  let headingFallback = false;
  if (options.headingIndex !== undefined) {
    const heading = message.headings[options.headingIndex];
    if (heading && heading.text === options.headingText) target = heading.element;
    else headingFallback = true;
  }

  message.element.setAttribute(HIGHLIGHT_ATTR, 'message');
  if (target !== message.element) target.setAttribute(HIGHLIGHT_ATTR, 'heading');

  let termFound = false;
  const HighlightCtor = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  const registry = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
  if (options.highlightTerm) {
    const ranges = termRanges(doc, message.element, options.highlightTerm);
    termFound = ranges.length > 0;
    const first = ranges[0]?.startContainer.parentElement;
    if (first && message.element.contains(first)) target = first;
    if (termFound && HighlightCtor && registry) registry.set(TERM_HIGHLIGHT, new HighlightCtor(...ranges));
  }

  target.scrollIntoView({ block: target === message.element ? 'start' : 'center', behavior: 'instant' });

  clearTimer = setTimeout(() => {
    for (const el of Array.from(doc.querySelectorAll(`[${HIGHLIGHT_ATTR}]`))) el.removeAttribute(HIGHLIGHT_ATTR);
  }, HIGHLIGHT_MS);
  if (termFound) termTimer = setTimeout(() => registry?.delete(TERM_HIGHLIGHT), TERM_HIGHLIGHT_MS);
  return { headingFallback, termFound };
}
