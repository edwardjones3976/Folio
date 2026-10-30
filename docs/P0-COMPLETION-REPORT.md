# Folio P0 completion report: WO-20261030-002 (claude.ai)

Spec section 10 report. It keeps four things separate: code written, tests
passing, live-browser confirmation, and public release.

| Item | State |
| --- | --- |
| Base | `main` at `113dabdd78f8bf12d6dc6a9700cfe805762a241f` (tree `b4f00e7be489dad254e4a91c1f78ce5fb869823b`) |
| Commit / branch / PR | none. The writer was not authorized to commit or push; all changes are uncommitted in the working tree. |
| Supported provider | claude.ai only (`https://claude.ai/*`) |
| Browser used for tests | Google Chrome 156.0.8078.74, headless, Windows 11 |
| Code written | yes (see the file list in the hand-off message and `git status`) |
| Tests passing | yes: 111 of 111, 0 failed, 0 skipped, 0 cancelled, 0 todo (three consecutive full runs) |
| Live claude.ai confirmation | **UNKNOWN**: not performed (no logged-in session). See `docs/MANUAL-LIVE-CHECK.md`. |
| Public release | none |
| Timed comparison against native UI and competitors (step 6) | **UNKNOWN**: not performed |

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | settings and bookmarks in `chrome.storage.local` |
| `sidePanel` | the side panel UI, opened from the toolbar button |
| content script `https://claude.ai/*` (top frame, isolated world) | read the loaded messages; scroll and highlight them |

No `host_permissions`, `tabs`, `activeTab`, `scripting`, `cookies`, network or
other-site access. Extension-page CSP:
`default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`.

## Features (P0 stories)

| Story | Status | Evidence |
| --- | --- | --- |
| Open: outline of exchanges, usable on narrow screens and long chats | working | `extension.test.ts` "Open", long-chat outline (250 exchanges, 500 messages) |
| Jump: exact jump and highlight; unloaded targets labelled | working | "Jump" tests; virtualized entries refused with a label |
| Find: lexical search, snippet, source location, coverage statement | working | "Find" test; 500-message needle test |
| Bookmark: stable source reference, title, note, timestamp; reopen; unresolved anchors | working | bookmark save, edit, reopen and unresolved tests |
| Chapters | partial | exchanges and reply headings only, all source-backed; no topic detection or user chapters |
| Settings: enable/disable, theme, readability, erase, inspect | working | settings tests |
| Keyboard access and labels | working (automated keyboard paths); screen-reader output not tested | "Keyboard" test |
| Explicit statuses | working | `features.ts`, status chips, feature table, unit tests |

## Test commands and results

```
npm test   ==  node src/tools/build.mjs && node --test --test-concurrency=1 "tests/**/*.test.ts"
```

Because `npm` was blocked in the writer's session, the two underlying commands
were run directly, in the foreground:

```
node src/tools/build.mjs
  -> Folio 0.1.0 built into ...\dist
node --test --test-concurrency=1 "tests/**/*.test.ts"
  -> tests 111, suites 33, pass 111, fail 0, cancelled 0, skipped 0, todo 0
```

| File group | Tests |
| --- | --- |
| `tests/unit/*.test.ts` (Node, no browser) | 71 |
| `tests/browser/adapter.test.ts` (Chrome, adapter and index on fixtures) | 19 |
| `tests/browser/extension.test.ts` (Chrome, built extension and panel) | 21 |

Measurements printed by the tests, on synthetic data. These are automated
timings, not user benchmarks:

- Full index of 500 messages: 9.1 to 9.4 ms.
- Automated search-and-jump to exchange 137 of 250: 133 to 138 ms.

## Deviations from the work order

1. **Playwright not used.** `npm` commands were denied in the writer session (no
   approval surface), so no devDependencies could be installed. The project is
   dependency-free instead:
   - a small bundler (`src/tools/bundle.mjs`) that uses Node's built-in
     `module.stripTypeScriptTypes`;
   - `node --test` for all tests;
   - a minimal DevTools Protocol driver (`tests/browser/cdp.ts`) that loads the
     unpacked extension with `Extensions.loadUnpacked`, because branded Chrome
     ignores `--load-extension` since version 137.

   `package-lock.json` is a hand-written lockfile for a package with no
   dependencies. `playwright.config.*` was not created.
2. **Pipe transport replaced by a loopback port.** On this machine, Chrome 156
   relaunches itself, so the PID that Node spawns exits after about 100 ms and
   `--remote-debugging-pipe` handles are lost. The driver uses
   `--remote-debugging-port=0` instead; the browser reports the port in
   `DevToolsActivePort`. DNS is disabled and all non-fixture requests are failed
   and recorded.
3. **No type-check.** No TypeScript compiler was available. Sources use erasable
   syntax only; `tsconfig.json` and a minimal `src/types/chrome.d.ts` are provided.
4. **Research files missing.** `research/research-WO-20261030-002-rev2-20261029.html`
   and `research/research-WO-20261030-002-20261029.html` are not in the worktree.
   The work was based on the spec and the research summary inside the work order.
   The open-source references were not consulted, and no third-party code was
   copied.

## Known gaps

See README "Known gaps". In short:

- Live claude.ai behaviour is UNKNOWN.
- Only loaded messages are indexed; other branch versions, images, files and
  artifacts are not.
- Chapters are partial.
- No archive or export of conversations (P1).
- The real side-panel container, toolbar click, screen readers, theme visuals and
  JSON download to disk are not covered by automation.
- No type-check was run.

## Install and rollback

See README "Install from source". Short version:

- **Install:** `npm run build`, then Load unpacked `dist/`.
- **Rollback:** check out the previous commit, rebuild, and reload the extension.
- **Uninstall:** remove the extension; this deletes its storage.

## Repository hygiene notes for the Foreman

- `dist/` (build output) is not in `.gitignore`, and `.gitignore` is outside the
  writer's file scope. The writer removed `dist/` after the final run. Suggest
  adding `dist/` to `.gitignore` before committing.
- The tests create Chrome profiles under the OS temp directory and delete them on
  exit.
- **Delete before committing:** an untracked folder named literally
  `%SystemDrive%/` (four Windows cache files under
  `ProgramData/Microsoft/Windows/Caches/*.db`) is in the repository root. It was
  created by accident, most likely by a one-off PowerShell process check the
  writer ran to clean up test browsers in a session environment without the
  `SystemDrive` variable. The writer's delete attempt was refused by the
  session's permission policy. It is not part of Folio. Do not use
  `git add -A` until it is removed.
