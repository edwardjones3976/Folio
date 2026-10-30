// Tiny DOM helpers. All text is inserted as text nodes; Folio never assigns
// untrusted strings to innerHTML.

type AttrValue = string | number | boolean | null | undefined;
type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, AttrValue> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (name === 'class') el.className = String(value);
    else if (name === 'text') el.textContent = String(value);
    else el.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return el;
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Folio panel: missing #${id}`);
  return el as T;
}

export function clear(el: Element): void {
  el.replaceChildren();
}

let announceTimer: ReturnType<typeof setTimeout> | undefined;

/** Speaks a short message through the polite live region. */
export function announce(text: string): void {
  const region = byId('announcer');
  region.textContent = '';
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => {
    region.textContent = text;
  }, 50);
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Up/Down/Home/End move focus between elements matching `selector` inside
 * `container`, so long lists do not need hundreds of Tab presses.
 */
export function arrowNavigation(container: HTMLElement, selector: string): void {
  container.addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = Array.from(container.querySelectorAll<HTMLElement>(selector));
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (current < 0) return;
    let next = current;
    if (event.key === 'ArrowDown') next = Math.min(items.length - 1, current + 1);
    if (event.key === 'ArrowUp') next = Math.max(0, current - 1);
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = items.length - 1;
    event.preventDefault();
    items[next]?.focus();
  });
}
