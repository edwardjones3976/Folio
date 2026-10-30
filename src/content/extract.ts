// DOM text extraction shared by site adapters. Reads only text a user can see in
// a message; never reads form fields, editable regions or hidden controls.
import { normalizeText } from '../shared/text.ts';

const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'SVG', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED',
]);
const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BR', 'DD', 'DETAILS', 'DIV', 'DL', 'DT', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'H1', 'H2', 'H3',
  'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TR', 'UL',
]);
const CELL_TAGS = new Set(['TD', 'TH']);

/** Elements whose content Folio must never read (user input and editors). */
export const PRIVATE_REGION = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]';

function skipElement(el: Element): boolean {
  if (SKIP_TAGS.has(el.tagName.toUpperCase())) return true;
  if (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('hidden')) return true;
  return el.matches(PRIVATE_REGION);
}

/** Returns normalized text with block boundaries turned into line breaks. */
export function extractText(root: Element): string {
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      parts.push(node.nodeValue ?? '');
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    if (skipElement(el)) return;
    const tag = el.tagName.toUpperCase();
    const block = BLOCK_TAGS.has(tag);
    if (block) parts.push('\n');
    if (tag === 'BR') return;
    for (let child = el.firstChild; child; child = child.nextSibling) walk(child);
    if (block) parts.push('\n');
    else if (CELL_TAGS.has(tag)) parts.push(' \t ');
  };
  for (let child = root.firstChild; child; child = child.nextSibling) walk(child);
  return normalizeText(parts.join(''));
}

/** True when the element is inside (or is) a region Folio must not read. */
export function inPrivateRegion(el: Element): boolean {
  return el.closest(PRIVATE_REGION) !== null || el.closest('form') !== null;
}

/** Keeps only outermost elements, in document order, removing nested duplicates. */
export function outermostInOrder(elements: Iterable<Element>): Element[] {
  const sorted = [...new Set(elements)].sort((a, b) => (a === b ? 0 : a.compareDocumentPosition(b) & 4 ? -1 : 1));
  const outer: Element[] = [];
  for (const el of sorted) {
    // In document order an ancestor precedes its descendants, so checking the
    // last kept element is enough.
    const last = outer[outer.length - 1];
    if (!last || !last.contains(el)) outer.push(el);
  }
  return outer;
}
