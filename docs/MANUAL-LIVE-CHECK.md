# Manual live check on claude.ai (not yet performed)

Status: **UNKNOWN.** Folio P0 has been tested only against synthetic fixtures. The
steps below are the reproducible manual check for a person with a claude.ai
account. Record raw observations (date, Chrome version, Folio commit, what was
seen) instead of a pass/fail summary, and keep screenshots with any private
content removed.

Use a throwaway conversation. Do not record conversation content you would not
publish.

## Setup

1. `npm run build`, then load `dist/` unpacked in `chrome://extensions` (Developer
   mode).
2. Note the Chrome version (`chrome://version`) and the Folio commit
   (`git rev-parse HEAD`).
3. Open DevTools on the claude.ai tab, Network panel, "Preserve log" on, so you can
   confirm that Folio adds no requests.

## Checks

| # | Action | Record |
| --- | --- | --- |
| 1 | Open an existing conversation with at least 10 exchanges, then click the Folio toolbar button. | Does the side panel open? What does the status line say? Which discovery method is listed under Coverage details ("claude.ai data attributes" or the class-name fallback)? |
| 2 | Compare the outline with the chat. | Are all loaded prompts and replies present, in order, with the right speaker? Are reply headings listed? Is anything from the sidebar, composer or page chrome included? |
| 3 | Click five outline entries and two headings, spread through the chat. | Does each scroll to and outline the correct original message or heading? |
| 4 | Search for a word you know appears once, then for a `"phrase"`. | Correct count, snippet, exchange number and coverage sentence? Does clicking the result highlight the term? |
| 5 | Bookmark a reply. Reload the tab, open the Bookmarks view. | Status "Found in this page"? |
| 6 | Open a different conversation, then Open the bookmark. | Does it navigate back and jump to the reply? |
| 7 | Edit an earlier prompt in the chat (creating a version switcher). | Does Coverage details report other versions? Does the outline follow the version shown? |
| 8 | Retry (regenerate) a reply that was bookmarked. | Is the bookmark reported as changed or unresolved rather than jumping to the wrong message? |
| 9 | In a very long conversation, scroll to the top quickly. | Does claude.ai load messages progressively or remove them? What does the coverage statement say before and after? |
| 10 | Send a new prompt and watch the panel while the reply streams. | Does the outline update without duplicates? |
| 11 | Settings, then turn Folio off. | Does the panel say Folio is off, with outline and search blocked? Turn it back on. |
| 12 | Settings, then Show stored data. | Is it only `folio.settings` and `folio.bookmarks`, as documented? |
| 13 | Network panel. | Any request initiated by the extension (initiator `chrome-extension://...` or content script)? There should be none. |

If claude.ai's markup does not match the adapter, step 1 shows "No messages were
recognized" (blocked) or the class-name fallback (partial). Note which elements
carry the prompts and replies (attribute names only, no content) so the adapter
can be updated and a new synthetic fixture added.
