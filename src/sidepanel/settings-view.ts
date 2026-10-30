// Settings view: enable/disable, theme, text size, stored-data inspection,
// download and erase, and the feature status table.
import type { FeatureReport } from '../shared/features.ts';
import { eraseAll, eraseBookmarks, inspectStorage, saveSettings } from '../shared/storage.ts';
import type { Settings, StorageAreaLike, TextSize, Theme } from '../shared/storage.ts';
import { announce, byId, clear, h } from './dom.ts';

export function applyAppearance(settings: Settings): void {
  document.documentElement.dataset.theme = settings.theme;
  document.documentElement.dataset.textSize = settings.textSize;
}

export function showSettings(settings: Settings): void {
  byId<HTMLInputElement>('setting-enabled').checked = settings.enabled;
  byId<HTMLInputElement>('show-headings').checked = settings.showHeadings;
  for (const input of Array.from(document.querySelectorAll<HTMLInputElement>('input[name="theme"]'))) {
    input.checked = input.value === settings.theme;
  }
  for (const input of Array.from(document.querySelectorAll<HTMLInputElement>('input[name="text-size"]'))) {
    input.checked = input.value === settings.textSize;
  }
}

export function renderFeatureTable(reports: readonly FeatureReport[]): void {
  const body = byId('feature-table');
  clear(body);
  for (const report of reports) {
    body.append(
      h(
        'tr',
        { 'data-feature': report.id },
        h('th', { scope: 'row', text: report.name }),
        h('td', { 'data-status': report.status, text: report.status }),
        h('td', { text: report.detail }),
      ),
    );
  }
}

async function storedJson(area: StorageAreaLike): Promise<{ json: string; bytes: number | null; keys: number }> {
  const report = await inspectStorage(area);
  return { json: JSON.stringify(report.data, null, 2), bytes: report.bytesInUse, keys: Object.keys(report.data).length };
}

export async function refreshStoredData(area: StorageAreaLike): Promise<void> {
  const view = byId('storage-view');
  const { json, bytes, keys } = await storedJson(area);
  view.textContent = json;
  view.hidden = false;
  byId('storage-usage').textContent =
    `${keys} ${keys === 1 ? 'key' : 'keys'} stored` + (bytes === null ? '.' : `, ${bytes} bytes in chrome.storage.local.`);
}

/**
 * `forgetIndexes` runs after "Erase all" has cleared storage: it empties the
 * live index in open claude.ai tabs and the panel's own caches, and returns how
 * many tabs confirmed.
 */
export function initSettings(area: StorageAreaLike, forgetIndexes: () => Promise<number>): void {
  const save = (patch: Partial<Omit<Settings, 'version'>>, message: string) => {
    saveSettings(area, patch).then(
      () => announce(message),
      (error: unknown) => announce(`Could not save the setting: ${String(error)}`),
    );
  };

  byId<HTMLInputElement>('setting-enabled').addEventListener('change', (event) => {
    const enabled = (event.target as HTMLInputElement).checked;
    save({ enabled }, enabled ? 'Folio turned on for claude.ai.' : 'Folio turned off for claude.ai. It will read nothing from claude.ai pages.');
  });
  byId<HTMLInputElement>('show-headings').addEventListener('change', (event) => {
    save({ showHeadings: (event.target as HTMLInputElement).checked }, 'Outline updated.');
  });
  for (const input of Array.from(document.querySelectorAll<HTMLInputElement>('input[name="theme"]'))) {
    input.addEventListener('change', () => save({ theme: input.value as Theme }, `Theme: ${input.parentElement?.textContent?.trim()}.`));
  }
  for (const input of Array.from(document.querySelectorAll<HTMLInputElement>('input[name="text-size"]'))) {
    input.addEventListener('change', () => save({ textSize: input.value as TextSize }, `Text size: ${input.parentElement?.textContent?.trim()}.`));
  }

  byId('inspect-refresh').addEventListener('click', () => {
    refreshStoredData(area).catch((error: unknown) => announce(`Could not read stored data: ${String(error)}`));
  });

  byId('export-data').addEventListener('click', () => {
    storedJson(area).then(
      ({ json }) => {
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = h('a', { href: url, download: 'folio-stored-data.json' });
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        byId('storage-usage').textContent = `Prepared folio-stored-data.json (${blob.size} bytes) for download.`;
        announce('Stored data download started.');
      },
      (error: unknown) => announce(`Could not export stored data: ${String(error)}`),
    );
  });

  let pendingErase: 'bookmarks' | 'all' | null = null;
  const confirm = byId('erase-confirm');
  const ask = (kind: 'bookmarks' | 'all') => {
    pendingErase = kind;
    byId('erase-question').textContent =
      kind === 'all'
        ? 'Erase all Folio data (bookmarks, settings, and what Folio has indexed in open claude.ai tabs) from this browser? This cannot be undone.'
        : 'Erase all bookmarks from this browser? This cannot be undone.';
    confirm.hidden = false;
    byId('erase-confirm-no').focus();
  };
  const close = (focusId: string) => {
    pendingErase = null;
    confirm.hidden = true;
    byId(focusId).focus();
  };
  byId('erase-bookmarks').addEventListener('click', () => ask('bookmarks'));
  byId('erase-all').addEventListener('click', () => ask('all'));
  byId('erase-confirm-no').addEventListener('click', () => close(pendingErase === 'all' ? 'erase-all' : 'erase-bookmarks'));
  confirm.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close(pendingErase === 'all' ? 'erase-all' : 'erase-bookmarks');
  });
  byId('erase-confirm-yes').addEventListener('click', () => {
    const kind = pendingErase;
    if (!kind) return;
    const work =
      kind === 'all'
        ? eraseAll(area).then(async () => {
            const tabs = await forgetIndexes();
            return `All Folio data erased: bookmarks, settings, and the index in ${tabs} open claude.ai ${tabs === 1 ? 'tab' : 'tabs'}.`;
          })
        : eraseBookmarks(area).then(() => 'All bookmarks erased.');
    work
      .then(async (message) => {
        await refreshStoredData(area);
        return message;
      })
      .then(
        (message) => {
          close(kind === 'all' ? 'erase-all' : 'erase-bookmarks');
          announce(message);
        },
        (error: unknown) => announce(`Erase failed: ${String(error)}`),
      );
  });
}
