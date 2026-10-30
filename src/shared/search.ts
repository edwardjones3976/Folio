// Local lexical search over message text the content script can read.
// Case-insensitive; every word must occur; "double quotes" match an exact phrase.
import { foldCase } from './text.ts';
import type { Role } from './types.ts';

export interface SearchDoc {
  key: string;
  role: Role;
  seq: number;
  exchange: number;
  text: string;
  rendered: boolean;
}

export interface SnippetPart {
  text: string;
  match: boolean;
}

export interface SearchHit {
  key: string;
  role: Role;
  seq: number;
  exchange: number;
  rendered: boolean;
  /** Number of term occurrences in the message. */
  matches: number;
  snippet: SnippetPart[];
  /** First matched term (as typed), used to highlight it after a jump. */
  firstTerm: string;
}

export interface SearchResult {
  query: string;
  terms: string[];
  hits: SearchHit[];
  total: number;
  truncated: boolean;
  searchedLoaded: number;
  searchedNotLoaded: number;
}

export const MAX_HITS = 200;
export const MAX_QUERY_LENGTH = 200;

/** Splits a query into terms; quoted sections become single phrase terms. */
export function parseQuery(query: string): string[] {
  const terms: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  for (const match of query.slice(0, MAX_QUERY_LENGTH).matchAll(re)) {
    const term = (match[1] ?? match[2] ?? '').replace(/\s+/g, ' ').trim();
    if (term && !terms.some((t) => foldCase(t) === foldCase(term))) terms.push(term);
  }
  return terms;
}

interface Range {
  start: number;
  end: number;
}

function findAll(folded: string, needle: string): Range[] {
  const ranges: Range[] = [];
  if (!needle) return ranges;
  let from = 0;
  for (;;) {
    const at = folded.indexOf(needle, from);
    if (at < 0) return ranges;
    ranges.push({ start: at, end: at + needle.length });
    from = at + Math.max(1, needle.length);
  }
}

function buildSnippet(text: string, ranges: Range[], first: Range, before = 60, after = 110): SnippetPart[] {
  let start = Math.max(0, first.start - before);
  let end = Math.min(text.length, first.end + after);
  const space = text.lastIndexOf(' ', start);
  if (start > 0 && space >= 0 && start - space < 15) start = space + 1;
  const nextSpace = text.indexOf(' ', end);
  if (end < text.length && nextSpace >= 0 && nextSpace - end < 15) end = nextSpace;

  const parts: SnippetPart[] = [];
  const push = (s: string, match: boolean) => {
    const clean = s.replace(/\s*\n\s*/g, ' ⏎ ');
    if (clean) parts.push({ text: clean, match });
  };
  if (start > 0) parts.push({ text: '…', match: false });
  let cursor = start;
  const visible = ranges
    .filter((r) => r.end > start && r.start < end)
    .sort((a, b) => a.start - b.start);
  for (const r of visible) {
    const s = Math.max(r.start, cursor);
    const e = Math.min(r.end, end);
    if (s >= e) continue;
    push(text.slice(cursor, s), false);
    push(text.slice(s, e), true);
    cursor = e;
  }
  push(text.slice(cursor, end), false);
  if (end < text.length) parts.push({ text: '…', match: false });
  return parts;
}

export function search(docs: readonly SearchDoc[], query: string, limit = MAX_HITS): SearchResult {
  const terms = parseQuery(query);
  const searchedLoaded = docs.filter((d) => d.rendered).length;
  const empty = { query, terms, hits: [], total: 0, truncated: false, searchedLoaded, searchedNotLoaded: docs.length - searchedLoaded };
  if (terms.length === 0) return empty;

  const foldedTerms = terms.map(foldCase);
  const hits: SearchHit[] = [];
  let total = 0;
  for (const doc of [...docs].sort((a, b) => a.seq - b.seq)) {
    const folded = foldCase(doc.text);
    const perTerm = foldedTerms.map((t) => findAll(folded, t));
    if (perTerm.some((r) => r.length === 0)) continue;
    total += 1;
    if (hits.length >= limit) continue;
    const ranges = perTerm.flat();
    const first = perTerm[0]![0]!;
    hits.push({
      key: doc.key,
      role: doc.role,
      seq: doc.seq,
      exchange: doc.exchange,
      rendered: doc.rendered,
      matches: ranges.length,
      snippet: buildSnippet(doc.text, ranges, first),
      firstTerm: terms[0]!,
    });
  }
  return { ...empty, hits, total, truncated: total > hits.length };
}
