// Registry of synthetic claude.ai fixtures, keyed by the URL path tests serve them at.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { longConversationHtml } from './long.ts';

export const FIXTURE_ORIGIN = 'https://claude.ai';

export const FIXTURES = {
  loaded: { path: '/chat/11111111-1111-4111-8111-111111111111', file: 'loaded.html' },
  partial: { path: '/chat/22222222-2222-4222-8222-222222222222', file: 'partial.html' },
  branched: { path: '/chat/33333333-3333-4333-8333-333333333333', file: 'branched.html' },
  edge: { path: '/chat/44444444-4444-4444-8444-444444444444', file: 'edge.html' },
  drifted: { path: '/chat/55555555-5555-4555-8555-555555555555', file: 'drifted.html' },
  unrecognized: { path: '/chat/66666666-6666-4666-8666-666666666666', file: 'unrecognized.html' },
  long: { path: '/chat/77777777-7777-4777-8777-777777777777', file: null },
  repeated: { path: '/chat/88888888-8888-4888-8888-888888888888', file: 'repeated.html' },
  home: { path: '/new', file: 'home.html' },
} as const;

export type FixtureName = keyof typeof FIXTURES;

export function fixtureUrl(name: FixtureName): string {
  return `${FIXTURE_ORIGIN}${FIXTURES[name].path}`;
}

export function fixtureId(name: FixtureName): string {
  return FIXTURES[name].path.split('/').pop()!;
}

/** HTML for a served URL path, or null when no fixture exists for it. */
export function fixtureHtmlForPath(pathname: string): string | null {
  const entry = Object.values(FIXTURES).find((f) => f.path === pathname.replace(/\/$/, ''));
  if (!entry) return null;
  if (entry.file === null) return longConversationHtml();
  return readFileSync(join(import.meta.dirname, entry.file), 'utf8');
}
