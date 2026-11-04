# Changes in the 0xSero fork

What 0xSero/sitegeist added on top of badlogic/sitegeist, kept for reference. Paths and
names are from before the Tabkyra rename (`sitegeist` CLI, `ai.sitegeist.bridge`).

Extension:

- `src/browser/` is new and is the only code that touches tabs: `session.ts` (tab group
  per session, current tab, persistence in `chrome.storage.session`), `cdp.ts`
  (`chrome.debugger` screenshots, real input events, focus emulation so hidden tabs keep
  running `requestAnimationFrame` and lazy loading), `page.ts` (navigation with load
  wait, in-page scripts with `userScripts` → `scripting` → CDP fallbacks, snapshot with
  element refs), `foreground-guard.ts` (popups opened by agent tabs no longer steal
  focus).
- Every tool now acts on the session's current tab instead of the active tab:
  `navigate` (new `showTab`, `closeTab`, `back`/`forward`; `switchToTab` no longer
  focuses), `browserjs()`, native input events, debugger, skills, element picker,
  `extract_image` (CDP screenshot instead of `captureVisibleTab`).
- Opening the side panel puts the tab you opened it on into the session's tab group
  right away, so the group exists from the start. The side panel only reacts to URL
  changes on its own tabs. A link icon in the header shares further tabs with the agent.
- `src/models/`: runtime model discovery for Anthropic, OpenAI, Gemini,
  OpenRouter, Mistral, Groq, xAI, Cerebras, Hugging Face; metadata from
  the generated table and models.dev; cached in IndexedDB (`discovered-models` store).
  Providers without a list endpoint keep the static table. `registerModels` was added to
  `pi-ai` (`../pi-mono/packages/ai/src/models.ts`).
- `src/bridge/`: native messaging port, one browser session per connected harness,
  request routing, site permissions, diagnostics (`bridge.debug`, `bridge.bench`,
  `bridge.reload`). Settings gained a Bridge tab.
- Manifest: fixed `key` (stable id `kjnkealaldnlmhpooihmomfkbllgmdkk`), new permissions
  `tabGroups`, `nativeMessaging`, `alarms`.
- Fixed the type errors in the custom provider dialogs.

CLI (`cli/`, package `sitegeist`): native host, socket client, MCP server with 22 tools,
installer for all Chromium browser directories (macOS, Linux, Windows registry), pi
extension generator.

Design and evidence (reference implementations, experiments, protocol): see
`docs/agent-bridge-design.md`. Live task results and bridge latencies: `docs/benchmarks.md`.
Full list of changes: `CHANGELOG.md`.
