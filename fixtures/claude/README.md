# Synthetic claude.ai fixtures

**Every file in this directory is synthetic.** They were hand-written for Folio's
tests. None was captured from claude.ai and none contains real user data.

They model only the markup Folio's claude.ai adapter depends on, as described by
public open-source tools and general observation (not verified against a live,
logged-in claude.ai session for this build):

| Model attribute | Meaning in the fixture |
| --- | --- |
| `data-testid="user-message"` | a human prompt |
| `data-is-streaming="true\|false"` | a Claude reply container (true while being written) |
| `data-test-render-count` | a conversation turn container |
| `.font-user-message`, `.font-claude-response` | CSS classes used only as a fallback |
| a leaf `<span>` reading `2 / 3` next to buttons in a turn | edit/retry version switcher |

Real claude.ai markup is different, larger, and changes over time. Passing tests
on these fixtures does **not** prove Folio works on live claude.ai.

| Fixture | URL served in tests | Purpose |
| --- | --- | --- |
| `loaded.html` | `/chat/11111111-1111-4111-8111-111111111111` | fully loaded conversation, headings, code, composer and password field that must never be read |
| `partial.html` | `/chat/22222222-2222-4222-8222-222222222222` | starts mid-conversation with a loading indicator |
| `branched.html` | `/chat/33333333-3333-4333-8333-333333333333` | edited prompt (2 / 3) and retried reply (1 / 2); a message containing the text "1 / 2" |
| `edge.html` | `/chat/44444444-4444-4444-8444-444444444444` | duplicate prompts, markup-like text, RTL and accents, image-only prompt, streaming reply, prompt being edited in a form |
| `drifted.html` | `/chat/55555555-5555-4555-8555-555555555555` | data attributes missing; only CSS classes remain |
| `unrecognized.html` | `/chat/66666666-6666-4666-8666-666666666666` | a chat URL whose markup Folio does not recognize |
| `long.ts` (generated) | `/chat/77777777-7777-4777-8777-777777777777` | 250 exchanges / 500 messages, deterministic |
| `home.html` | `/new` | claude.ai page with no conversation open |

Tests serve these documents at `https://claude.ai/...` by intercepting the
browser's requests (Chrome DevTools Protocol `Fetch` domain); no request reaches
the network and DNS is disabled for the test browser.
