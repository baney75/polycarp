# Tabkyra demo video: storyboard

This file matches the composed source in `src/` (scene lengths in `src/Demo.tsx`, captions in
each scene). Times are seconds into `media/demo.mp4`; scenes overlap by a 0.5 s crossfade.

**Spec.** 1920×1080, 30 fps, H.264, 84.7 s (2540 frames), silent, captions burned in. Poster:
1280×720 JPEG (`Poster` still). Shown on dbaney.com/tabkyra, in the README and in the portfolio.

**Treatment.** A coding agent works a real browser while the user stays in charge. Every
browser frame, side panel frame and line of command output comes from a real run recorded by
`scripts/demo/capture-video.mjs` (the built extension in headless Chromium, its native host,
`tabkyra mcp` driven by a scripted MCP client, and the real CLI against doi.org, OpenAlex and
Crossref). Visual language is the brand: ink background (#0F1B24), paper text (#F6F2EA), one
brass accent (#E3A93B), tide (#43B3A0) for success; a muted red (#E46B5D) only for errors and
retractions, as the CLI prints them. Type: Instrument Serif italic for the line, Instrument
Sans for captions and titles, JetBrains Mono for tool calls and terminals. The bare brass helm
sits behind every scene as the hero's 7% watermark, turned 11° and cropped off the edge.
**Signature motif:** the brass tab-group pill, "Tabkyra · claude", the agent's own group, on
every browser window.
**Through-line:** the user's hand stays on the wheel. Each chapter adds one control (asks
first, own tabs, reads back, checked sources, linted skills), and the last chapter hands the
wheel to the viewer: one prompt to get started.

Every scene has one chapter label (top left: the app icon and the name in brass, 30 px
semibold, uppercase) and a caption (bottom center, 46 px Instrument Sans, paper on an ink
plate, one line). Commands in captions are set in JetBrains Mono, brass.

---

## Chapter 1: Title (0.0–5.0 s)

- **What happens:** On ink, the brass app tile rises 40 px and fades in (0.0–0.8 s). The
  wordmark "Tabkyra" fades in under it (0.5–1.2 s). "You steer." fades in at 1.3 s and "Your
  agents work the tabs." (brass) at 1.9 s. The slate subline fades in at 2.8 s.
- **Camera:** static; a 2% push over the shot.
- **Text:** "Tabkyra" / "You steer. Your agents work the tabs." / "A Chromium extension and
  CLI for Claude Code, Codex and any MCP agent."
- **Transition out:** crossfade.

## Chapter 2: Asks first (4.5–18.5 s)

- **What happens:** Left, the agent pane ("claude · tool calls") shows `# a new site, not
  allowed yet`, types `navigate { url: "https://www.gutenberg.org/ebooks/2701" }`, then `# the
  call waits for your answer`. Under it, the inline prompt with the real elicitation message
  and choices fades in ("tabkyra: the browser agent wants to open www.gutenberg.org. Allow?";
  "Allow www.gutenberg.org from now on" / "Allow once" / "Deny"). Right, the real side panel
  (Settings › Bridge), cropped from "Site access" to the first allowed site, shows "claude
  wants to open www.gutenberg.org" with Allow site / Allow once / Deny; a brass ring pulses on
  the request card from 6.8 s. At 10.8 s the first choice highlights, and at 11.7 s it is
  confirmed. The panel crossfades to the real after-state (www.gutenberg.org under Allowed
  sites, tide ring on that row), and the pane prints the navigate result title.
- **Camera:** static; the panel scales from 0.97 to 1.0 as it enters.
- **Captions:** 5.3 s "A new site? The agent asks first. You answer inline or in the side
  panel." 12.0 s "Allow it once, for good, or deny it. `tabkyra allow <host>` works too."
- **Crops and rings** come from element boxes recorded in `capture.json` (`browser.boxes`),
  so a re-capture with a changed panel layout still frames the right rows.
- **Transition out:** crossfade.

## Chapter 3: Its own tabs (18.0–29.0 s)

- **What happens:** A browser window holds the real Gutenberg screenshot. Its tab strip shows
  the brass pill "Tabkyra · claude" (glow ring from 18.5 s) and the real tab title. The agent
  pane carries the navigate call from chapter 2, then runs `get_page_text {}` and prints the
  page heading and the first sentence of the summary it got back.
- **Camera:** static.
- **Caption:** 18.5 s "It works in its own background tab group, and it can't see your other
  tabs."
- **Transition out:** none; the same window carries into chapter 4 and its page changes. The
  run itself did the catalog work first and opened Gutenberg after; the video shows the
  permission beat first because it's the point of the piece. Each call and result is the run's
  own, but the order across chapters 2 to 4 is edited.

## Chapter 4: Fills forms, reads back (29.0–47.2 s)

- **What happens:** The label changes to "Fills forms, reads back". The pane notes `# allowed
  beforehand: tabkyra allow 127.0.0.1` and runs the real calls, each synced to the screenshot
  it produced: `navigate` (catalog home), `read_page { filter: "interactive" }` with `e1
  textbox "Search the catalog"` and `e2 button "Search"`, `type { ref: "e1", text:
  "Moby-Dick", submit: true }` → `{"typed":9}` (results), `read_page { filter: "interactive" }`
  with `e1 button "Place hold"` and `e2 button "Place hold"` (the refs renumbered),
  `click { ref: "e1" } // Place hold`
  (hold form), `read_page` with the card, branch and confirm refs, two `fill` calls (filled
  form, 40.0 s), `click { ref: "e3" } // Confirm hold` (confirmation, 42.2 s), and
  `get_page_text {}` → "Hold placed for Ada Lovelace: Moby-Dick. Pick it up at Main Street
  after Thursday." in tide.
- **Camera:** static; each screenshot crossfades in over 8 frames.
- **Captions:** 29.7 s "It reads the page as element refs, then clicks and types by ref."
  40.2 s "Then it reads the result back to check its own work."
- **Transition out:** crossfade.

## Chapter 5: Checked sources (46.7–60.7 s)

- **What happens:** A full-width terminal. `tabkyra library add 10.1037/0033-2909.132.3.354`
  types on and the real output appears ("Added cepeda2006distributed ...", "verified by
  doi.org, openalex, crossref-updates; cited by ..." in tide). Then
  `tabkyra library add '10.1016/S0140-6736(97)11096-0'` (quoted as a shell needs it) and its
  real output: the RETRACTED title, the verification line, the correction notice, the
  retraction notice and "RETRACTED: don't cite this as support." in red, then `# exit 3:
  saved, but flagged`. Then the made-up DOI and its real refusal ("is not registered
  (doi.org returned 404)") with `# exit 1: nothing saved`.
- **Camera:** static; the terminal fills from the top and scrolls once it is full.
- **Captions:** 47.1 s "`tabkyra library` checks every DOI with doi.org, OpenAlex and
  Crossref." 53.5 s "Retracted papers get flagged. Made-up DOIs are refused."
- **Transition out:** crossfade.

## Chapter 6: Linted skills (60.2–71.2 s)

- **What happens:** Left, the bad skill's SKILL.md (the real file the capture linted), with
  line numbers. Right, a terminal runs `tabkyra skill lint page-helper`; at 62.4 s the four
  real errors print one by one (remote-code, safety-bypass, conceal-from-user,
  secret-exfiltration) and each flagged file line (14, 15, 16) gets a red bar as its error
  appears. Then "✗ 4 problems.", `# exit 1`, and `tabkyra skill lint skills/` → "✓ Clean."
- **Camera:** static.
- **Captions:** 60.6 s "Skill lint refuses piped installers, safety bypasses and secret
  grabs." 66.9 s "Every bundled skill passes it, and CI runs it on every pull request."
- **Transition out:** crossfade.

## Chapter 7: Get started (70.7–79.2 s)

- **What happens:** The real welcome dialog. A pointer glides to "Copy setup prompt for your
  agent" (the button box recorded in the capture), with a brass ring from 72.0 s, and clicks
  at 73.0 s. The real "Setup prompt copied. Paste it into your agent." toast drops in above
  the dialog. Right, the first lines of the real copied prompt appear in an agent pane ("your
  agent · pasted prompt").
- **Camera:** static.
- **Caption:** 71.1 s "Copy one prompt into your agent. It installs the CLI and connects
  itself."
- **Transition out:** crossfade to the end card.

## Chapter 8: End card (78.7–84.7 s). Closing lines are untouchable.

- **What happens:** The brass tile and "Tabkyra" (0.0–0.6 s into the shot), the line (from
  0.5 s), then the two URLs in JetBrains Mono and "Free and open source. AGPL-3.0." (from
  1.0 s). Hold to the end.
- **Text (untouchable):** "You steer. Your agents work the tabs." /
  "github.com/baney75/tabkyra" / "dbaney.com/tabkyra".

---

## Risks

- **Text size on phones.** Captions (46 px) and chapter labels read at 640 px wide. Tool-call
  and terminal text (19 to 28 px) is detail at that size; the captions carry each beat.
- **Reading time.** Each caption stays up at least 4 s.
- **Live data drifts.** Citation counts, page text and the Gutenberg page change over time. The
  video shows the run dated in `public/capture/capture.json`.
- **File size.** Mostly flat colour and text; CRF 20 lands near 5 MB.
- **Licensing.** Fonts are OFL (licenses in `public/fonts/`). No music. Remotion itself is source-available, free for individuals and companies of up to three people; larger companies need a Remotion company license.
