// Connects the side panel to Folio's content script in one browser tab.
// The panel opens the port; the content script only answers on it. When the tab
// navigates or reloads the port closes and the panel reconnects.
import { PORT_NAME } from '../shared/protocol.ts';
import type { ContentPush, ContentReply, PanelRequest } from '../shared/protocol.ts';
import type { Snapshot } from '../shared/types.ts';

export type ConnectionState =
  | { kind: 'connecting' }
  | { kind: 'unavailable'; detail: string }
  | { kind: 'connected'; snapshot: Snapshot };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type RequestBody = DistributiveOmit<PanelRequest, 'requestId'>;

export const UNAVAILABLE_DETAIL =
  'Folio is not running in this tab. It works only on https://claude.ai/ pages. ' +
  'If this claude.ai tab was open before Folio was installed or updated, reload the tab.';

const RETRY_DELAYS_MS = [200, 400, 800, 1600, 3200];
const REQUEST_TIMEOUT_MS = 8000;

interface Pending {
  resolve(reply: ContentReply): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class TabConnection {
  tabId: number | null = null;
  private port: chrome.runtime.Port | null = null;
  private hasSnapshot = false;
  private retries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private nextRequestId = 1;
  private pending = new Map<number, Pending>();
  private readonly pinnedTabId: number | null;
  private readonly onState: (state: ConnectionState) => void;

  constructor(pinnedTabId: number | null, onState: (state: ConnectionState) => void) {
    this.pinnedTabId = pinnedTabId;
    this.onState = onState;
  }

  async start(): Promise<void> {
    chrome.tabs.onUpdated.addListener((tabId, info) => {
      if (tabId === this.tabId && info.status === 'complete' && !this.hasSnapshot) this.connect();
    });
    if (this.pinnedTabId !== null) {
      this.target(this.pinnedTabId);
      return;
    }
    const windowId = (await chrome.windows.getCurrent()).id;
    chrome.tabs.onActivated.addListener((info) => {
      if (info.windowId === windowId) this.target(info.tabId);
    });
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id !== undefined) this.target(tab.id);
    else this.onState({ kind: 'unavailable', detail: 'No browser tab is active in this window.' });
  }

  /** True when the panel follows a fixed tab (opened with ?tabId=). */
  get pinned(): boolean {
    return this.pinnedTabId !== null;
  }

  target(tabId: number): void {
    this.disconnect();
    this.tabId = tabId;
    this.retries = 0;
    this.connect();
  }

  private disconnect(): void {
    clearTimeout(this.retryTimer);
    if (this.port) {
      const port = this.port;
      this.port = null;
      try {
        port.disconnect();
      } catch {
        // already closed
      }
    }
    this.hasSnapshot = false;
    this.retries = 0;
    this.failPending('The tab changed before Folio answered.');
  }

  private failPending(message: string): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }

  private connect(): void {
    if (this.tabId === null) return;
    clearTimeout(this.retryTimer);
    if (this.port) return;
    this.onState({ kind: 'connecting' });
    const port = chrome.tabs.connect(this.tabId, { name: PORT_NAME });
    this.port = port;
    port.onMessage.addListener((message: unknown) => this.receive(message as ContentReply | ContentPush));
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError; // reading it marks "Receiving end does not exist" as handled
      if (this.port !== port) return;
      this.port = null;
      this.hasSnapshot = false;
      this.failPending('The page closed the connection (it may have navigated or reloaded).');
      this.onState({ kind: 'unavailable', detail: UNAVAILABLE_DETAIL });
      this.scheduleRetry();
    });
  }

  private scheduleRetry(): void {
    const delay = RETRY_DELAYS_MS[this.retries];
    if (delay === undefined) return; // further attempts happen when the tab finishes loading
    this.retries += 1;
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  private receive(message: ContentReply | ContentPush): void {
    if (message.type === 'snapshot') {
      this.hasSnapshot = true;
      this.retries = 0;
      this.onState({ kind: 'connected', snapshot: message.snapshot });
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    clearTimeout(pending.timer);
    if (message.type === 'error') pending.reject(new Error(message.message));
    else pending.resolve(message);
  }

  request(body: RequestBody): Promise<ContentReply> {
    const port = this.port;
    if (!port || !this.hasSnapshot) return Promise.reject(new Error('Folio is not connected to a claude.ai conversation in this tab.'));
    const requestId = this.nextRequestId++;
    return new Promise<ContentReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('The page did not answer in time.'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
      port.postMessage({ ...body, requestId });
    });
  }

  /** Navigates the connected tab, or opens a new tab when the panel has no claude.ai tab. */
  async open(url: string, sameTab: boolean): Promise<void> {
    if (sameTab && this.tabId !== null) {
      this.disconnect();
      await chrome.tabs.update(this.tabId, { url });
      this.onState({ kind: 'connecting' });
      return;
    }
    await chrome.tabs.create({ url, active: true });
  }
}
