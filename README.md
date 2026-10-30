# Folio for claude.ai (P0)

Folio is a Chrome (Manifest V3) extension that adds a side panel to an open
claude.ai conversation. It shows an outline of the conversation, jumps to and
highlights an original message, searches the loaded messages, and keeps local
bookmarks to specific messages. Everything stays in your browser.

This is the P0 release defined in [`docs/PRODUCT-SPEC.html`](docs/PRODUCT-SPEC.html):
one platform (claude.ai), navigation basics only. Outline, jump, bookmark and
search features for claude.ai already exist in other extensions (for example
Ophel Atlas, Claude Navigator, Threadline and the AI Toolbox Claude module).
Folio makes no claim that these features are new or better. The P0 goal is
basics that are honest about what they cover.

> **Verification status.** Every automated test runs against **synthetic**
> pages modelled on claude.ai (see [`fixtures/claude/`](fixtures/claude/README.md)).
> Folio has **not** been checked on live claude.ai: the live-browser state is
> **UNKNOWN**. If claude.ai's real markup differs from the model, Folio says
> "No messages were recognized" instead of guessing.

## Features and status

Statuses use the contract's vocabulary: `working`, `partial`, `blocked`,
`not_implemented`. The panel shows the live status for the current page; the
table below describes what is built.

| Feature | Status | Notes |
| --- | --- | --- |
| Outline of exchanges | working | One entry per prompt and its replies. Labels are the first line of the prompt, as written. Headings from Claude's replies are listed under each entry. Entries that are not loaded in the page are labelled. |
| Exact jump and highlight | working | Scrolls the original message (or heading) into view and outlines it for 4 seconds. Targets are matched by content, not position; unloaded or changed targets are reported, not guessed. |
| Local search | working | Case-insensitive; every word must appear; `"quotes"` for a phrase. Results show the exchange number, the speaker, a snippet and a statement of what was searched. Clicking a result jumps to it and highlights the term. |
| Bookmarks | working | Saved locally with title, note and timestamps. Open re-opens the same chat and jumps to the message. Anchors that no longer resolve are labelled "Unresolved". |
| Coverage indicators | working | Reports loading indicators, a conversation that starts mid-way, edited/retried versions (only the shown version is indexed), messages without readable text, messages removed from the page by virtualization, and fallback detection. |
| Settings | working | Enable/disable on claude.ai, theme (system, light, dark, high contrast), text size, inspect stored data, download it as JSON, erase bookmarks or everything. |
| Keyboard access | working | See [Keyboard](#keyboard). All controls are native buttons, inputs and ARIA tabs with labels; results are announced in a live region. |
| Chapters | partial | Deterministic structure only (exchanges and reply headings). No topic detection and no user-edited chapters. |
| Archive, book view, export of conversations | not_implemented | Planned for P1. |
| Other chat sites | not_implemented | claude.ai only. |

When the page cannot be used, the panel marks outline, jump and search as
`blocked` and says why: Folio is turned off, no conversation is open, no messages
were recognized, or the tab is not a claude.ai page. When detection fell back to
CSS class names or coverage is partial, they show as `partial`.

## Permissions

| Permission | Why it is needed |
| --- | --- |
| `storage` | Saves settings and bookmarks in `chrome.storage.local`, on this computer only. |
| `sidePanel` | Shows Folio in Chrome's side panel and opens it from the toolbar button. Requires Chrome 114+; Folio declares `minimum_chrome_version` 116 for `sidePanel.setPanelBehavior`. |
| Content script on `https://claude.ai/*` | Reads the visible messages of the open conversation to build the outline and search, and scrolls/highlights them. It runs in the top frame only, in Chrome's isolated world. |

Not requested: `host_permissions`, `tabs`, `activeTab`, `scripting`,
`cookies`, `webRequest`, `history`, `downloads`, access to other sites,
`web_accessible_resources` or `externally_connectable`.

Extension pages use a strict Content Security Policy:
`default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`.
All code ships in the package; nothing is loaded remotely.

## Privacy

- **No network.** Folio makes no network requests and sends no telemetry.
  `connect-src 'none'` enforces this for the panel; the content script and
  service worker contain no network APIs (checked by `tests/unit/audit.test.ts`
  and by recording requests in the browser tests).
- **What is read.** Only on `https://claude.ai/*`, only while Folio is enabled,
  and only the elements recognized as messages. Folio never reads cookies, page
  storage, form fields, password fields, the message composer, or a prompt being
  edited. When disabled, the content script reads nothing from the page.
- **What is stored** (`chrome.storage.local`):
  - `folio.settings`: enabled, theme, text size, show headings.
  - `folio.bookmarks`: for each bookmark, its title, note, created/updated times,
    the conversation id and title, the exchange number, and an anchor: role,
    content digest, occurrence, position, and **up to 160 characters from the
    start of the bookmarked message** (used to recognize the message again).
  - Nothing else. Conversation text otherwise stays in memory while the page is
    open and is gone when the tab closes.
- **Inspect, export and delete.** Settings, then Stored data shows exactly what is
  stored, unfiltered, and can download it as JSON. Erase bookmarks or Erase all
  Folio data removes it. Removing the extension also removes its storage.

## Install from source

Requirements: Node.js 22.18 or newer (developed with Node 26.13) and Google
Chrome 116 or newer. Folio has **no npm dependencies**: there is nothing to
install, and `package-lock.json` lists no packages.

```sh
npm run build          # same as: node src/tools/build.mjs  ->  dist/
```

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**
   and choose the `dist/` folder.
2. Open a conversation on claude.ai. Tabs that were already open before installing
   must be reloaded.
3. Click the Folio toolbar button to open the side panel.

**Update:** rebuild, then click the reload icon on Folio's card in
`chrome://extensions` and reload claude.ai tabs.
**Rollback:** check out the previous commit, rebuild, and reload the extension.
**Uninstall:** remove Folio in `chrome://extensions`. This deletes its stored
data. To keep a copy first, use Settings, then Download stored data (JSON).

## Using Folio

- **Outline:** click an entry to jump to the prompt, or a heading to jump to that
  heading in Claude's reply. ☆ bookmarks Claude's reply in that exchange (or the
  prompt if there is no reply).
- **Search:** type words or a `"quoted phrase"` and press Enter.
- **Bookmarks:** Open, Edit (title and note) or Delete. "This conversation" or
  "All conversations".
- **Settings:** turn Folio off for claude.ai, change appearance, inspect, download
  or erase stored data, and read the feature status table.

### Keyboard

| Key | Where | Action |
| --- | --- | --- |
| Left / Right, Home / End | view tabs | switch between Outline, Search, Bookmarks and Settings |
| Up / Down, Home / End | outline, search results | move between entries |
| Enter or Space | any entry | jump |
| `/` | anywhere outside a text field | go to Search |
| Escape | bookmark editor, erase confirmation | cancel |

## How Folio finds messages on claude.ai

The claude.ai adapter (`src/adapters/claude.ts`) sits behind a provider-neutral
interface (`src/adapters/types.ts`):

- Prompts: `[data-testid="user-message"]`. Replies: elements with a
  `data-is-streaming` attribute. Turns: `[data-test-render-count]`.
- If those attributes are missing, it falls back to the class names
  `.font-user-message`, `.font-claude-response` and `.font-claude-message`. It
  reports the fallback, and the features show as `partial`.
- Each message gets a content digest and an occurrence count. Jumps and
  bookmarks resolve by digest. If the text changed, a long unique matching
  opening counts as "changed". Otherwise the target is unresolved. Position is
  only a tie-breaker and is never trusted alone.
- Messages that disappear from the page at the top or bottom (virtualization) are
  kept as "not loaded". They stay searchable but cannot be jumped to until
  claude.ai shows them again.

These selectors follow how public open-source tools describe claude.ai. They
have **not** been verified on live claude.ai for this build.

## Tests

```sh
npm test               # node src/tools/build.mjs && node --test --test-concurrency=1 "tests/**/*.test.ts"
npm run test:unit      # logic only, no browser
npm run test:browser   # real Chrome
```

- `tests/unit/`: text and digest handling, search, outline grouping, coverage,
  virtualization merge, anchor resolution, storage validation (including
  corrupted records and write failures), feature statuses, the bundler, and a
  static privacy and permission audit of the manifest, sources, bundles, README
  and fixtures.
- `tests/browser/adapter.test.ts`: runs the real adapter and index in Chrome on
  every synthetic fixture: loaded, partially loaded, branched, edge cases, layout
  drift, unrecognized, no conversation, and a 500-message conversation with
  virtualization.
- `tests/browser/extension.test.ts`: loads the built `dist/` extension into Chrome
  and drives the real side panel (opened as a tab pinned with `?tabId=`) through
  the P0 stories: open, jump, keyboard use, find, bookmark, settings, erase,
  unusable pages and network silence.

The browser tests use a small built-in Chrome DevTools Protocol driver
(`tests/browser/cdp.ts`) instead of Playwright, so the project needs no
dependencies. Chrome starts headless with a temporary profile, a random loopback
debugging port and DNS disabled. The extension is installed with
`Extensions.loadUnpacked`, because branded Chrome ignores `--load-extension`
since version 137. Requests to `https://claude.ai/...` are answered from the
synthetic fixtures. Set `FOLIO_CHROME` to use a different Chrome or Chromium
executable.

## Known gaps

- **Live claude.ai is unverified (UNKNOWN).** The adapter is modelled on described
  markup, not checked on a live account. [`docs/MANUAL-LIVE-CHECK.md`](docs/MANUAL-LIVE-CHECK.md)
  describes the manual check that is still to do.
- Folio indexes only what claude.ai has loaded in the page. It does not scroll,
  fetch or call claude.ai APIs to load more. Other edit/retry versions, images,
  files, artifacts and attachments are not indexed. Search text collapses
  whitespace, so code indentation is not preserved in snippets.
- Version switchers are recognized only as a leaf `N / M` text next to a button
  inside a turn container.
- No conversation archive: search covers the current page session only.
- Chapters are `partial` (exchanges and headings only).
- The panel follows the active tab of its window. Opening a bookmark from a page
  that is not claude.ai opens a new tab.
- Two panels in different windows editing bookmarks at the same moment could
  overwrite each other's change (last write wins).
- Not covered by automation: the real side-panel container and toolbar click (the
  tests check the panel behavior setting and drive `sidepanel.html` in a tab),
  screen-reader output, visual appearance of themes, whether the JSON download
  reaches disk, and Chrome versions other than 156.
- No TypeScript type-check was run for this build. Sources use only erasable
  syntax and run through Node's type stripping; `tsconfig.json` is provided for
  `tsc --noEmit` once TypeScript is available.
- The timed comparison against claude.ai's own navigation and competing
  extensions (spec section 10, step 6) has not been run: UNKNOWN.

## Project layout

```
manifest.json            MV3 manifest (copied into dist/)
src/adapters/            site adapter interface and the claude.ai adapter
src/content/             content script: extraction, live index, jump/highlight
src/sidepanel/           side panel UI
src/background/          service worker (opens the panel from the toolbar)
src/shared/              provider-neutral logic: search, anchors, coverage, storage
src/tools/               zero-dependency bundler, build and icon scripts
fixtures/claude/         synthetic claude.ai fixtures (clearly labelled)
tests/                   unit and real-browser tests
docs/                    product contract, completion report, manual check
```

## License

Copyright (c) 2026 Edward Jones. All rights reserved.
