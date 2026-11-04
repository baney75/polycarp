# Bridge benchmarks, 2026-09-16

Four real tasks run through the bridge by an external harness, with ground truth
fetched independently (Hacker News API and front page HTML, Wikipedia wikitext, the
httpbin echo, the GitHub API). Frames of the agent's hidden tab were captured every
1.5 s through the same bridge while the task ran; the demo video is assembled from them.

Harness: Claude Code (`claude -p`) with `--mcp-config` pointing at `sitegeist mcp`,
hosts pre-allowed with `sitegeist allow <host>`. Browser: Brave 152 on macOS, 25 to 34
user tabs open, the user working in other Spaces the whole time.

| Task | Result | Wall time | Tool calls | Verdict |
| --- | --- | --- | --- | --- |
| Hacker News: top 5 titles with points | 5 stories | 28.1 s | 5 | Correct. Titles and order matched the live front page; points matched at read time (top story moved by 4 before the check). |
| Wikipedia: Copenhagen municipality population from the infobox | 671,714 as of 1 January 2026 | 27.7 s | 5 | Correct (matches page wikitext). |
| httpbin form: fill 7 fields, submit, read the echoed JSON | all fields echoed | 40.6 s | 14 | Correct, including the three fields not asked about. |
| GitHub: repository description and star count | description + 825 stars | 31.9 s | 7 | Correct (matches the API). |

Accuracy: 4 of 4. Nothing was brought to the foreground; each task ran in its own
"Sitegeist · claude" tab group and closed nothing the user owned.

## Bridge latency during the runs

From `sitegeist debug` (per-call timing inside the extension, excluding model time):

| Method | Calls | Median | Max |
| --- | --- | --- | --- |
| tabs.context | 77 | 2 ms | 38 ms |
| screenshot (1280 px JPEG, hidden tab) | 44 | 376 ms | 988 ms |
| navigate (incl. page load wait) | 4 | 592 ms | 1414 ms |
| snapshot / text / find / fill / click | 15 | 7 to 16 ms | 16 ms |

Chrome API benchmark with the machine idle (`bridge.bench`): storage, windows, tab group
and debugger target queries all 0 to 6 ms; session open 3 ms.

Model time dominates: each task's 28 to 41 s is almost entirely Claude thinking and
tool-round-trips; the browser side contributes well under two seconds per task.

## What went wrong before this run

- Under heavy machine load (15-minute load average above 150, two local omp agents at
  100% CPU, a screen recording in progress) the same Chrome API calls took 10 to 60 s
  each and one navigation took four minutes. That is the browser being starved, not the
  bridge; the fix was to add per-call timeouts so a slow browser cannot wedge a client.
- The first live run deadlocked: permission answers were queued behind the request that
  was waiting for them. Fixed by handling answers outside the per-client queue.
- pi runs failed for reasons unrelated to the bridge: the local homelab model was
  saturated (no reply in 20 s) and the ChatGPT subscription hit its usage limit
  (`Codex error: The usage limit has been reached`). The pi extension itself connected,
  registered its tools and made calls (`browser_navigate`, `browser_read_page`,
  `browser_fill` ...), so the pi path is exercised; the tasks were completed on Claude
  Code instead.
- Two clients on one session (the agent and the frame recorder) overwrote each other's
  tab list until session instances were shared per id.

## Reproducing

```bash
sitegeist status
sitegeist allow news.ycombinator.com
SITEGEIST_SESSION=demo claude -p "Open https://news.ycombinator.com and list the top 5 stories with points" \
  --mcp-config '{"mcpServers":{"sitegeist":{"command":"sitegeist","args":["mcp"]}}}' \
  --allowedTools "mcp__sitegeist__*"
sitegeist debug     # timings for what just happened
```

# Sessions, resilience and tab groups, 2026-10-27

Two scripts measure what an agent goes through when it works in sessions, so every change to
the MCP server, the bridge or the session model is compared with the same numbers.

- `cli/eval/skill-eval.mjs --suite sessions` runs scripted tasks through `claude -p` with
  Haiku (a small model, so tool ergonomics show) against a local fixture site in a headless
  throwaway Chromium. Scores come from the fixture server and the browser's own tabs and
  groups. Tasks: **multitab** (compare two price lists open at once, close the tabs),
  **resume** (one harness process types a draft, the extension reloads, a second process in
  the same project must finish it in the same tab), **parallel** (two agents in one project at
  once, no cross-talk), **handover** (give the cart tab to the user, out of the agent's group),
  **reload** (the extension reloads right after the first item lands in the cart).
- `cli/eval/bridge-metrics.mjs` needs no model: the tools/list and instructions payload
  (bytes, and with `--claude` the real input-token cost of a turn with the server attached),
  cold start to the first tool result, calls sent while the extension reloads or the native
  host is killed (with a click in flight, which must never run twice), three clients at once,
  and thirteen tab group behaviors (identity, colors, and what closing, dragging out,
  dragging in, collapsing and ungrouping do, reloads, a tab cap, a closed window).

Both use `cli/eval/fixture-browser.mjs`, which turns on developer mode in the throwaway
profile: without it this Chromium disables an unpacked extension the moment it reloads, so a
forced reload would unload Tabkyra for good.

```bash
npm run build && (cd cli && npm run build)
node cli/eval/bridge-metrics.mjs --cycles 3 --claude
node cli/eval/skill-eval.mjs --suite sessions --reps 2
node cli/eval/skill-eval.mjs --suite skill --reps 2
```

## Baseline (main at b81629d: v1.1.9 plus ask_user and the panel UI work)

| Measure | Baseline |
| --- | --- |
| Tools listed | 31 |
| tools/list + instructions | 26,460 + 2,709 bytes |
| Input tokens the server adds to every turn (`claude -p`, Haiku) | 11,471 |
| Cold start: initialize / first tool result (median of 5) | 119 ms / 131 ms (115 to 150 ms across idle runs) |
| Calls across forced reloads and host kills (3 cycles, 15 calls) | 15 answered, 0 hangs, slowest 4.8 s |
| Cycles where a click in flight during a reload ran twice | **3 of 3** |
| Three clients at once: separate groups / cross-talk / labels naming the project | yes / 0 / 0 of 3 |
| Tab group behaviors as specified | 5 of 13 |

Session tasks, Haiku, 2 reps, MCP server only, each row in a fresh project folder:

| Task | Success | Mean tool calls | Mean tool errors | Mean seconds |
| --- | --- | --- | --- | --- |
| multitab | 2/2 | 7.5 | 0.0 | 8.0 |
| resume | 0/2 | 12.5 | 0.0 | 13.0 |
| parallel | 2/2 | 28.0 | 3.0 | 18.5 |
| handover | 0/2 | 12.5 | 0.0 | 14.0 |
| reload | 2/2 | 14.5 | 0.5 | 16.5 |
| all | 6/10 | 15.0 | 0.7 | 14.0 |

Skill suite (shop, contact, forum), Haiku, 2 reps: 6/6 without the skill (11.2 calls, 16.0 s
mean) and 6/6 with it (11.0 calls, 15.8 s).

multitab is scored from the model's closing `ANSWER: Store <letter> $<price>` line, and
parallel counts cross-talk only when one agent's tool results show the other's fixture pages.
## After each change

| Measure | Baseline (b81629d) | CLI polish and evals (#40) |
| --- | --- | --- |
| Tools / tools/list + instructions bytes | 31 / 26,460 + 2,709 | 31 / 26,460 + 2,709 (no MCP change) |
| Input tokens per turn (Haiku) | 11,471 | 11,471 |
| `tabkyra mcp` start through the launcher, interleaved medians | 140 / 131 ms (both arms identical on main) | 119 ms without the compile cache, 108 ms with it |
| Duplicate clicks across reloads | 3 of 3 cycles | 3 of 3 |
| Tab group behaviors | 5 of 13 | 5 of 13 |
| Session tasks | 6/10 | 6/10 |
| Skill suite, without / with the skill | 6/6 / 6/6 | 6/6 / 6/6 |
| `tabkyra --version` | 0.1.0 | 1.1.9 |

An earlier baseline on 9e37df3 (before ask_user) measured 30 tools and 10,473 tokens, with
the same task and group results.

What failed: a new harness process gets a new session, so **resume** can't find the tab it
left; there is no way to give a tab to the user, so **handover** leaves it in the agent's
group; the client replays a request whose reply a reload cut off, so a click runs twice.
Group titles say "claude 2", "claude 3" and never the project; closing a group leaves its
session behind; a tab the user drags out or ungroups is pulled back into the group; and
nothing caps the tabs in a group.

## Seeing pages: perception eval

`node cli/eval/perception.mjs --extension <build> [--out file.json]` drives the MCP tools against
local fixture pages (no model) and scores 20 probes:
- open shadow roots: see, click, fill a nested field, and read their text with `read_page`,
  `get_page_text`, and `get_page_text` on the host; a `display: contents` component
- same-origin and cross-origin frames, including a scaled, padded frame
- control states, including a disabled fieldset
- a page's own `fetch()` and its response body
- embedded JSON and forms
- the size of a small interactive read
- the review cases from #73:
  - hidden web-component text stays out
  - opaque cross-site responses are refused, with and without `Access-Control-Allow-Origin: *`
  - login passwords in multipart and form bodies are masked
  - `fill` reaches a listener outside the shadow root
  - a newline in a frame URL or a `role` can't fake an element line

Measured 2026-10-28 in headless Chromium, each build with the current CLI. Each review
column is the head that review saw; its high findings show as that column's failures.

| Probe | main | review 1 (328e9f6) | review 2 (8a21dfc) | review 3 (c2f4df9) | now |
| --- | --- | --- | --- | --- | --- |
| `shadow-see` | fail | pass | pass | pass | pass |
| `shadow-click` | fail | pass | pass | pass | pass |
| `nested-fill` | fail | pass | pass | pass | pass |
| `shadow-text` | fail | fail | pass | pass | pass |
| `frame-see` | fail | pass | pass | pass | pass |
| `frame-click` | fail | pass | pass | pass | pass |
| `xorigin-flag` | fail | pass | pass | pass | pass |
| `states` | fail | pass | pass | pass | pass |
| `api-request` | pass | pass | pass | pass | pass |
| `api-body` | fail | pass | pass | pass | pass |
| `embedded-map` | fail | pass | pass | pass | pass |
| `cost` | pass | pass | pass | pass | pass |
| `scaled-click` | fail | fail | pass | pass | pass |
| `hidden-text` | fail | fail | fail | fail | pass |
| `xorigin-body` | pass | fail | fail | pass | pass |
| `login-masked` | fail | fail | fail | fail | pass |
| `composed-fill` | fail | fail | pass | pass | pass |
| `fieldset-disabled` | fail | fail | pass | pass | pass |
| `hostile-src` | pass | pass | pass | pass | pass |
| `contents-host` | fail | fail | fail | fail | pass |

Score: main 4/20, review 1 (328e9f6) 12/20, review 2 (8a21dfc) 16/20, review 3 (c2f4df9) 17/20, now 20/20. The cross-site fixture serves text/plain:
Chromium aborts an opaque JSON or HTML response before a body exists, which would make that
probe pass on any build.

# Dictation, 2026-10-29

`cli/eval/dictation.mjs` on the built extension in Playwright's Chromium on an M-series Mac
(WebGPU with shader-f16, 32 GB, 10 cores). Two clips spoken by macOS `say` (Samantha, 16 kHz),
6.5 and 6 seconds, with reference transcripts. No language is given, as with the product's default
("Detect it"), so Whisper detects it. Word error rate (WER) is word edit distance over
the reference, punctuation and case ignored. Real-time factor (RTF) is transcription time over
audio length: under 1 is faster than speech.

| Model | Runs on | Download | WER | RTF |
| --- | --- | --- | --- | --- |
| Whisper large-v3 turbo | GPU | 1470 MB | 3.3% | 0.42 |
| Whisper small | GPU | 590 MB | 3.3% | 0.22 |
| Whisper base | processor | 77 MB | 3.3% | 0.69 |
| Moonshine base (English) | processor | 63 MB | 6.7% | 0.16 |
| Moonshine tiny (English) | processor | 28 MB | 10.0% | 0.08 |
| Whisper tiny | processor | 41 MB | 14.8% | 0.32 |

The strong models missed one word, the name "Tabkyra" ("TabKara", "Tabgira"). Clean synthetic
speech doesn't separate them; turbo's lead (large-v3 accuracy) shows on accents, noise and other
languages, which these clips don't test. Turbo's first load took 177 s, almost all of it the
download.

The button, end to end: Chromium's fake microphone played clip 1, the eval pressed Dictate and
then Stop as the clip ended. In four runs the automatic model on this device (turbo) put the
reference sentence in the composer word for word (WER 0%); once it came back without capitals or
punctuation.

A third clip, 27 seconds (a spoken request for a report summary), checks long dictation after
#75: Whisper windows it itself, and Moonshine, which reads a clip in one pass, gets pieces of 20
seconds or less cut at quiet points. Every model returned the whole passage; with it, WER is
turbo 4.1%, small 4.1%, base 4.1%, Moonshine base 6.3%, Moonshine tiny 8.5%, Whisper tiny 12.0%.
Most of the added errors are numbers written as digits ("10", "8%") against a reference that
spells them out.

Reproduce: `TABKYRA_NO_BUMP=1 node scripts/build.mjs` (a plain production build bumps the version),
then `node cli/eval/dictation.mjs --extension dist-chrome --clips <dir of name.wav + name.txt> [--models a,b|none]`.
