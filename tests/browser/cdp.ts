// Minimal Chrome DevTools Protocol driver for Folio's browser tests.
//
// Folio has no npm dependencies, so instead of Playwright these tests drive
// Chrome directly over the DevTools Protocol. The browser listens on a random
// loopback port (--remote-debugging-port=0, read back from DevToolsActivePort);
// the pipe transport is not used because Chrome on Windows can relaunch itself,
// which drops the inherited pipe handles. The unpacked extension is installed
// with Extensions.loadUnpacked (needs --enable-unsafe-extension-debugging),
// because branded Chrome ignores --load-extension since version 137.
// Pages at https://claude.ai/ are answered from local synthetic fixtures through
// the Fetch domain; every other request is failed and recorded, and DNS is
// disabled with --host-resolver-rules, so nothing reaches the network.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Json = Record<string, unknown>;
interface Message {
  id?: number;
  method?: string;
  params?: Json;
  result?: Json;
  error?: { message: string };
  sessionId?: string;
}

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

export function findChrome(): string {
  const found = [process.env.FOLIO_CHROME, ...CHROME_CANDIDATES].find((p) => p && existsSync(p));
  if (!found) throw new Error('Google Chrome or Chromium not found. Set FOLIO_CHROME to the browser executable.');
  return found;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Escape: { code: 'Escape', keyCode: 27 },
  Tab: { code: 'Tab', keyCode: 9 },
  '/': { code: 'Slash', keyCode: 191, text: '/' },
};

export class Browser {
  readonly profileDir: string;
  private readonly socket: WebSocket;
  private nextId = 1;
  private readonly callbacks = new Map<number, { resolve(v: Json): void; reject(e: Error): void; method: string }>();
  private readonly listeners = new Set<(m: Message) => void>();
  private closed = false;
  private readonly closedPromise: Promise<void>;

  private constructor(socket: WebSocket, profileDir: string) {
    this.socket = socket;
    this.profileDir = profileDir;
    socket.onmessage = (event) => this.dispatch(JSON.parse(String(event.data)) as Message);
    this.closedPromise = new Promise<void>((resolve) => {
      socket.onclose = () => {
        this.closed = true;
        for (const [, cb] of this.callbacks) cb.reject(new Error(`Chrome connection closed during ${cb.method}`));
        this.callbacks.clear();
        resolve();
      };
    });
  }

  static async launch(): Promise<Browser> {
    const profileDir = mkdtempSync(join(tmpdir(), 'folio-chrome-'));
    const args = [
      '--headless',
      '--remote-debugging-port=0',
      '--enable-unsafe-extension-debugging',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-default-apps',
      '--disable-client-side-phishing-detection',
      '--disable-domain-reliability',
      '--metrics-recording-only',
      '--no-pings',
      '--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider,AutofillServerCommunication',
      '--host-resolver-rules=MAP * ~NOTFOUND',
      '--window-size=1280,900',
      'about:blank',
    ];
    const launcher = spawn(findChrome(), args, { stdio: 'ignore', windowsHide: true });
    launcher.on('error', () => undefined); // reported below as a missing DevToolsActivePort
    const portFile = join(profileDir, 'DevToolsActivePort');
    const deadline = Date.now() + 20_000;
    while (!existsSync(portFile) || readFileSync(portFile, 'utf8').trim().split('\n').length < 2) {
      if (Date.now() > deadline) throw new Error('Chrome did not start (no DevToolsActivePort file)');
      await sleep(100);
    }
    const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n');
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error('Could not connect to Chrome DevTools'));
    });
    const browser = new Browser(socket, profileDir);
    await browser.send('Browser.getVersion');
    return browser;
  }

  private dispatch(message: Message): void {
    if (message.id !== undefined) {
      const cb = this.callbacks.get(message.id);
      if (!cb) return;
      this.callbacks.delete(message.id);
      if (message.error) cb.reject(new Error(`${cb.method}: ${message.error.message}`));
      else cb.resolve(message.result ?? {});
      return;
    }
    for (const listener of this.listeners) listener(message);
  }

  send(method: string, params: Json = {}, sessionId?: string): Promise<Json> {
    if (this.closed) return Promise.reject(new Error('Chrome is closed'));
    const id = this.nextId++;
    const message: Message = { id, method, params, ...(sessionId ? { sessionId } : {}) };
    return new Promise<Json>((resolve, reject) => {
      this.callbacks.set(id, { resolve, reject, method });
      this.socket.send(JSON.stringify(message));
    });
  }

  on(listener: (m: Message) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async version(): Promise<string> {
    return String((await this.send('Browser.getVersion')).product);
  }

  async loadExtension(path: string): Promise<string> {
    return String((await this.send('Extensions.loadUnpacked', { path })).id);
  }

  async newPage(): Promise<Page> {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, String(targetId), String(sessionId));
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    return page;
  }

  /** Attaches to the extension's service worker (waits for it to start). */
  async serviceWorker(extensionId: string, timeoutMs = 10_000): Promise<Session> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { targetInfos } = (await this.send('Target.getTargets')) as { targetInfos: { targetId: string; type: string; url: string }[] };
      const worker = targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extensionId}/`));
      if (worker) {
        const { sessionId } = await this.send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
        return new Session(this, String(sessionId));
      }
      await sleep(100);
    }
    throw new Error('Extension service worker did not start');
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.send('Browser.close').catch(() => undefined);
      await Promise.race([this.closedPromise, sleep(5000)]);
      if (!this.closed) this.socket.close();
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        rmSync(this.profileDir, { recursive: true, force: true });
        return;
      } catch {
        await sleep(300); // Chrome may still hold profile files briefly on Windows
      }
    }
  }
}

export class Session {
  readonly browser: Browser;
  readonly sessionId: string;

  constructor(browser: Browser, sessionId: string) {
    this.browser = browser;
    this.sessionId = sessionId;
  }

  send(method: string, params: Json = {}): Promise<Json> {
    return this.browser.send(method, params, this.sessionId);
  }

  /** Runs `fn(...args)` in the target and returns its (awaited, JSON) result. */
  async evaluate<T>(fn: string | ((...args: never[]) => unknown), ...args: unknown[]): Promise<T> {
    const expression = typeof fn === 'string' ? fn : `(${fn.toString()})(...${JSON.stringify(args)})`;
    const response = (await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })) as {
      result: { value?: T };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    };
    if (response.exceptionDetails) {
      throw new Error(`Evaluation failed: ${response.exceptionDetails.exception?.description ?? response.exceptionDetails.text}`);
    }
    return response.result.value as T;
  }

  /** Polls `fn(...args)` until it returns a truthy value. */
  async waitFor<T>(fn: (...args: never[]) => unknown, args: unknown[] = [], timeoutMs = 10_000, label = 'condition'): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last: unknown;
    while (Date.now() < deadline) {
      try {
        last = await this.evaluate<T>(fn, ...args);
        if (last) return last as T;
      } catch (error) {
        last = error;
      }
      await sleep(50);
    }
    throw new Error(`Timed out waiting for ${label}. Last value: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
  }
}

export interface RecordedRequest {
  url: string;
  outcome: 'fixture' | 'favicon' | 'blocked';
}

export class Page extends Session {
  readonly targetId: string;
  readonly requests: RecordedRequest[] = [];

  constructor(browser: Browser, targetId: string, sessionId: string) {
    super(browser, sessionId);
    this.targetId = targetId;
  }

  /** Answers https://claude.ai/ document requests from `resolve`; fails and records everything else. */
  async serveFixtures(resolve: (pathname: string) => string | null): Promise<void> {
    this.browser.on((message) => {
      if (message.sessionId !== this.sessionId || message.method !== 'Fetch.requestPaused') return;
      const params = message.params as { requestId: string; request: { url: string } };
      const url = new URL(params.request.url);
      const html = url.origin === 'https://claude.ai' ? resolve(url.pathname) : null;
      if (html !== null) {
        this.requests.push({ url: url.href, outcome: 'fixture' });
        void this.send('Fetch.fulfillRequest', {
          requestId: params.requestId,
          responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
          body: Buffer.from(html, 'utf8').toString('base64'),
        }).catch(() => undefined);
      } else if (url.origin === 'https://claude.ai' && url.pathname === '/favicon.ico') {
        this.requests.push({ url: url.href, outcome: 'favicon' });
        void this.send('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: 404 }).catch(() => undefined);
      } else {
        this.requests.push({ url: url.href, outcome: 'blocked' });
        void this.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' }).catch(() => undefined);
      }
    });
    await this.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  }

  async goto(url: string, timeoutMs = 15_000): Promise<void> {
    const loaded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`Timed out loading ${url}`));
      }, timeoutMs);
      const off = this.browser.on((message) => {
        if (message.sessionId === this.sessionId && message.method === 'Page.loadEventFired') {
          clearTimeout(timer);
          off();
          resolve();
        }
      });
    });
    const result = (await this.send('Page.navigate', { url })) as { errorText?: string };
    if (result.errorText) throw new Error(`Navigation to ${url} failed: ${result.errorText}`);
    await loaded;
  }

  async press(key: string): Promise<void> {
    const def = KEYS[key];
    if (!def) throw new Error(`Unknown key ${key}`);
    const base = { key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode };
    await this.send('Input.dispatchKeyEvent', { type: def.text ? 'keyDown' : 'rawKeyDown', ...base, ...(def.text ? { text: def.text } : {}) });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  async close(): Promise<void> {
    await this.browser.send('Target.closeTarget', { targetId: this.targetId }).catch(() => undefined);
  }
}
