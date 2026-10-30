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
| Exact jump and highlight | working | Scrolls the original message (or heading) into view and outlines it for 4 seconds. Outline and search entries go to the exact message that was clicked, even among identical messages, as long as the page still shows what the list was drawn from. Bookmarks are matched by their text and both messages around them, never by position; unloaded, unconfirmed, ambiguous or changed targets are reported, not guessed. |
| Local search | working | Case-insensitive; every word must appear; `"quotes"` for a phrase. Results show the exchange number, the speaker, a snippet and a statement of what was searched. Clicking a result jumps to it and highlights the term. |
| Bookmarks | working | Saved locally with title, note and timestamps. Open re-opens the same chat and jumps to the message. Anchors that no longer resolve are labelled "Unresolved"; a single match that the messages around it cannot confirm is labelled "Not confirmed"; identical messages Folio cannot tell apart are labelled "Ambiguous". Open jumps to none of these. Live updates never discard an open edit. |
| Coverage indicators | working | Reports loading indicators, a conversation that starts mid-way, edited/retried versions (only the shown version is indexed), messages without readable text, messages removed from the page by virtualization, and fallback detection. |
| Settings | working | Enable/disable on claude.ai, theme (system, light, dark, high contrast), text size, inspect stored data, download it as JSON, erase bookmarks or everything (including what Folio has indexed in open claude.ai tabs). |
| Keyboard access | working | See [Keyboard](#keyboard). All controls are native buttons, inputs and ARIA tabs with labels; results are announced in a live region. |
| Chapters | partial | Deterministic structure only (exchanges and reply headings). No topic detection and no user-edited chapters. |
| Archive, book view, export of conversations | not_implemented | Planned for P1. |
| Other chat sites | not_implemented | claude.ai only. |

When the page cannot be used, the panel marks outline, jump and search as
`blocked` and says why: Folio is turned off, no conversation is open, no messages
were recognized, the page's index was erased, or the tab is not a claude.ai page. When detection fell back to
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
    content digest, occurrence, position, the content digests (not the text) of
    the messages just before and after it, how many known messages had the same
    text (informational; not used to match), and **up to 160 characters from
    the start of the bookmarked message** (used to recognize the message again).
    Stored records that fail validation (including a second record with the id
    of an existing bookmark) are ignored but kept exactly as found; adding or
    editing bookmarks never removes them. Deleting a bookmark removes every
    stored record with that bookmark's id, so an ignored duplicate cannot take
    its place; records with other ids stay until an erase.
  - Nothing else. Conversation text otherwise stays in memory while the page is
    open and is gone when the tab closes.
- **Inspect, export and delete.** Settings, then Stored data shows exactly what is
  stored, unfiltered, and can download it as JSON. Erase bookmarks removes the
  bookmarks. Erase all Folio data removes everything stored and also empties the
  in-memory index in every open claude.ai tab, including messages seen earlier
  and no longer loaded. That index stays empty until you choose **Re-index this
  page** or the tab moves to another page. Removing the extension also removes
  its storage.

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
- Outline entries and search results jump by **live identity**: the message
  element Folio indexed for the entry that was clicked, in the version of the
  index the list was drawn from. No anchor is resolved, so the second of two
  identical exchanges is reached as reliably as any other. Before following
  the element, Folio reads the page again and checks that it still shows
  exactly what that version indexed: the same message elements in the same
  order, each with the same speaker and text (a reply that is still being
  written may grow, unless it is the one clicked). If anything differs, for
  example the element now holds other text or the page reused or moved it,
  Folio rebuilds its index from the page and treats the click as coming from
  an older list.
- A click on an older list (the page changed after the list was drawn, and
  earlier messages loading can renumber entries) is never followed by its
  element. Folio resolves the entry's anchor, saved as of that list, as
  strictly as a bookmark's, and the status line says that the page changed.
- Each message gets a content digest. A bookmark's anchor is the digest plus
  the digests of the messages just before and after it, in the manner of a W3C
  Web Annotation text quote selector (exact text plus prefix and suffix). A
  neighbour that is known both in the anchor and in the page, and differs, rules
  a message out. A target is **exact** only when exactly one message is left and
  **both** neighbours match. There are no exceptions: when no message was known
  on one side when the bookmark was saved (the first or latest message), that
  side can never be confirmed, because Folio cannot tell that claude.ai has
  loaded the whole conversation, and a copy of the same text that Folio never
  saw could fit as well. A single match without that confirmation, for example
  because a neighbour is not loaded or was not known, is **not confirmed**;
  several are **ambiguous**. If the text changed, at least 24 identical opening
  characters plus the same confirmation by both neighbours count as
  **changed**; shorter messages only ever match exactly. Otherwise the target
  is **unresolved**. Position is never used. Folio jumps to a bookmark only when
  it is exact or changed.
- Messages that disappear from the page at the top or bottom (virtualization) are
  kept as "not loaded". They stay searchable but cannot be jumped to until
  claude.ai shows them again. The loaded window is placed among the known
  messages by its longest run of identical messages, and occurrence numbers are
  counted over all known messages, so identical messages keep their identity as
  the window slides. When two placements are equally good, Folio keeps only the
  loaded messages rather than guess.

These selectors follow how public open-source tools describe claude.ai. They
have **not** been verified on live claude.ai for this build.

## Tests

```sh
npm test               # node src/tools/build.mjs && node --test --test-concurrency=1 "tests/**/*.test.ts"
npm run test:unit      # logic only, no browser
npm run test:browser   # real Chrome
```

- `tests/unit/`: text and digest handling, search, outline grouping, coverage,
  virtualization merge (including windows of identical messages), anchor
  resolution (identical messages, partial pages, conflicting neighbours, the
  strict two-sided rule for first and latest messages, short messages, anchors
  without context), the live index driven by an in-memory page (outline clicks
  on elements whose text changed or that the page reused, and clicks on older
  lists), storage validation (including corrupted
  records kept through add and edit, duplicates removed with the bookmark they
  copy, and write failures), feature statuses, the bundler, and a static
  privacy and permission audit of the manifest, sources, bundles, README, docs
  and fixtures.
- `tests/browser/adapter.test.ts`: runs the real adapter and index in Chrome on
  every synthetic fixture: loaded, partially loaded, branched, edge cases
  (including identical prompts with part of the page removed), fully identical
  exchanges reached by live identity, clicks after the page changed (a reply
  whose text changed, an element reused for an identical earlier reply, keys
  renumbered by earlier messages loading), layout drift, unrecognized, no
  conversation, and a 500-message conversation with virtualization.
- `tests/browser/extension.test.ts`: loads the built `dist/` extension into Chrome
  and drives the real side panel (opened as a tab pinned with `?tabId=`) through
  the P0 stories: open, jump (including identical exchanges, a single message,
  and a list drawn before the page changed), keyboard use, find, bookmark
  (including a live update during an edit, and a bookmark that cannot be
  confirmed), settings, erase (including a direct check that the content
  script's index is empty afterwards), unusable pages and network silence.

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
  markup, not checked on a live account. [`docs/MANUAL-LIVE-CHECK.html`](docs/MANUAL-LIVE-CHECK.html)
  describes the manual check that is still to do. The latest completion report
  is [`docs/P0-COMPLETION-REPORT.html`](docs/P0-COMPLETION-REPORT.html).
- A bookmark of the first message Folio knew, or of the latest message, is
  never exact: it shows "Not confirmed" and Open does not jump, even after the
  conversation continues, because nothing was known on one side when it was
  saved. This includes ☆ on the latest exchange, which bookmarks the latest
  reply. Folio cannot tell whether the first loaded message is the start of
  the conversation, so "nothing before it" is never evidence. Outline and
  search clicks still reach these messages. To get a bookmark that can be
  confirmed, bookmark the reply again after the next prompt has been sent.
- A bookmarked message at the top or bottom of what is loaded, whose neighbour
  on that side was known when it was saved, is reported as not confirmed until
  that neighbour is loaded. If the message after a bookmarked message changed
  (for example the next prompt was edited, or a later reply regenerated), the
  bookmark is unresolved, because Folio cannot tell that from another copy of
  the same text.
- Bookmarks saved by Folio 0.1.0 have no neighbour context. They are never
  exact or changed: when a message with the same text, or with at least 24
  identical opening characters, is in the page or was seen earlier, they are
  reported as ambiguous; otherwise unresolved. Bookmark the message again.
  Bookmarks saved since commit `d1fba89` have context and follow the same
  rule as new ones. A bookmark of the first or latest message saved by commit
  `ff66a57`, which could show "Found in this page", now shows "Not confirmed".
- Outline and search clicks follow the index version their list was drawn from.
  Folio keeps the last 8 versions, plus the versions behind the last 2 searches;
  an older click is refused with a request to choose again or search again.
- A click on a list drawn before the page changed is followed only when the
  entry's anchor, as of that list, is exact or changed. The first or latest
  entry of that list, and entries among identical exchanges, are then refused
  with "The page changed after this list was shown"; choose them again from
  the updated list.
- While a reply is being written, a click on that reply (or a heading in it)
  can be refused: its text changed after the list was drawn, and as the latest
  message its anchor cannot be confirmed. Clicks on other messages are not
  affected. A list drawn before a page change that Folio has not yet indexed
  (it re-reads the page within about a second of a change) also sends the
  click through the anchor rules.
- Live identity assumes that when every loaded message element still holds the
  same speaker and text in the same order, the page still shows the same
  messages. A page that re-bound all of its loaded elements at once to another
  run of identical messages would not be detected. Whether claude.ai reuses
  message elements at all is UNKNOWN.
- Erase all reaches the claude.ai tabs where Folio's content script is running.
  Tabs that were open before Folio was installed have no Folio index to erase.
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
- If the stored bookmark value is unreadable as a whole (not a list of records),
  Folio refuses to add or change bookmarks rather than overwrite it, and says
  so. Download stored data to keep a copy, then use Erase bookmarks.
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
docs/                    product contract, completion report, manual check (HTML)
```

## License

Copyright (c) 2026 Edward Jones. All rights reserved.
