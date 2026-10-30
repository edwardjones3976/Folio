// Shared builders for unit tests (synthetic data only).
import { digest, excerpt } from '../../src/shared/text.ts';
import type { MessageSummary, Role } from '../../src/shared/types.ts';

export function message(role: Role, text: string, overrides: Partial<MessageSummary> = {}): MessageSummary {
  const d = digest(text);
  return {
    key: `${role}:${d}:0`,
    role,
    digest: d,
    occurrence: 0,
    seq: 0,
    ordinal: 0,
    excerpt: excerpt(text),
    headings: [],
    branch: null,
    streaming: false,
    rendered: true,
    chars: text.length,
    ...overrides,
  };
}

/** Assigns seq/ordinal in order, like the live index does. */
export function sequence(messages: MessageSummary[]): MessageSummary[] {
  return messages.map((m, i) => ({ ...m, seq: i, ordinal: m.rendered ? i : -1 }));
}

export class MemoryStorage {
  data: Record<string, unknown> = {};
  failNextSet = false;

  async get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
    const copy = structuredClone(this.data);
    if (keys === null || keys === undefined) return copy;
    const wanted = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(wanted.filter((k) => k in copy).map((k) => [k, copy[k]]));
  }

  async set(items: Record<string, unknown>): Promise<void> {
    if (this.failNextSet) {
      this.failNextSet = false;
      throw new Error('QUOTA_BYTES quota exceeded');
    }
    Object.assign(this.data, structuredClone(items));
  }

  async remove(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) delete this.data[key];
  }

  async getBytesInUse(): Promise<number> {
    return JSON.stringify(this.data).length;
  }
}
