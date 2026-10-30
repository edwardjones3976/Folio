// Minimal ambient declarations for the chrome.* APIs Folio uses. Folio has no npm
// dependencies, so @types/chrome is not installed; this file covers only what the
// code calls. It is used by editors and `tsc --noEmit`, never bundled.

declare namespace chrome {
  namespace runtime {
    interface MessageSender {
      id?: string;
      tab?: { id?: number };
      url?: string;
    }
    interface LastError {
      message?: string;
    }
    interface Port {
      name: string;
      sender?: MessageSender;
      postMessage(message: unknown): void;
      disconnect(): void;
      onMessage: Event<(message: unknown, port: Port) => void>;
      onDisconnect: Event<(port: Port) => void>;
    }
    interface Event<T extends (...args: never[]) => unknown> {
      addListener(callback: T): void;
      removeListener(callback: T): void;
    }
    const id: string;
    const lastError: LastError | undefined;
    function getURL(path: string): string;
    const onInstalled: Event<() => void>;
    const onStartup: Event<() => void>;
    const onConnect: Event<(port: Port) => void>;
    const onMessage: Event<(message: unknown, sender: MessageSender, sendResponse: (response?: unknown) => void) => boolean | undefined>;
  }

  namespace tabs {
    interface Tab {
      id?: number;
      windowId: number;
      active: boolean;
      status?: string;
    }
    interface TabActiveInfo {
      tabId: number;
      windowId: number;
    }
    interface TabChangeInfo {
      status?: string;
    }
    function query(queryInfo: { active?: boolean; currentWindow?: boolean; lastFocusedWindow?: boolean }): Promise<Tab[]>;
    function connect(tabId: number, connectInfo: { name: string }): runtime.Port;
    function sendMessage(tabId: number, message: unknown): Promise<unknown>;
    function update(tabId: number, props: { url?: string; active?: boolean }): Promise<Tab | undefined>;
    function create(props: { url: string; active?: boolean }): Promise<Tab>;
    const onActivated: runtime.Event<(info: TabActiveInfo) => void>;
    const onUpdated: runtime.Event<(tabId: number, info: TabChangeInfo, tab: Tab) => void>;
  }

  namespace windows {
    function getCurrent(): Promise<{ id?: number }>;
  }

  namespace storage {
    interface StorageChange {
      oldValue?: unknown;
      newValue?: unknown;
    }
    interface StorageArea {
      get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
      clear(): Promise<void>;
      getBytesInUse(keys?: string | string[] | null): Promise<number>;
    }
    const local: StorageArea;
    const onChanged: runtime.Event<(changes: Record<string, StorageChange>, areaName: string) => void>;
  }

  namespace sidePanel {
    function setPanelBehavior(behavior: { openPanelOnActionClick?: boolean }): Promise<void>;
  }
}
