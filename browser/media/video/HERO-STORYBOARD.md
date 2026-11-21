# Tabkyra hero video: storyboard

The short, music-driven cut. The 85-second captioned walkthrough (`Demo`, `media/demo.mp4`)
stays the full demo; this is the one people share. This file matches the source in
`src/hero/`; beat numbers below are the ones the code uses.

**Spec.** `Hero` 1920×1080 and `HeroVertical` 1080×1920, 30 fps, H.264 + AAC, 57.6 s
(1728 frames), the same edit in both, ending with the music. Poster `HeroPoster` 1280×720.
Outputs: `media/hero.mp4`, `media/hero-vertical.mp4`, `media/hero-poster.jpg`.

**Music.** `public/hero/music.m4a`, an instrumental generated with ACE-Step 1.5 (see
`public/hero/NOTICE.md` and the README). 126.05 BPM, 0.476 s a beat. The beat map is
`src/hero/music.json` from `scripts/analyze_music.py`; every cut and slam below is a beat index
`B` into it. What the map records: 121 beats; downbeats on B0, B4, B8, … (the drop starts a
bar, so it sets the phase); entries where the full band comes back at **B32 (15.30 s, the
drop, +16.2 dB)**, **B64 (30.55 s)** and **B96 (45.78 s)**; the final hit B120 (57.21 s). The
master is trimmed to 57.6 s and fades out over its last 0.2 s. Measured while choosing the take
(10 Hz energy): the opening impact at 0.06 s, and near-silence from 13.4 to 14.0 s (0.6 s)
before the drop. Sections: 8 + 8 + 8 + 6 bars.

**What is recorded and what is drawn.** Recorded (in `public/capture/`): every page
screenshot, every side panel crop, the elicitation prompt's message and choices, the tab group
name, tab titles and URLs, every tool call's arguments and result, all CLI output, and the
router's matches and timing. Drawn: the browser frame around the page screenshots (its group
name, title and URL are the recorded values), the box around the inline prompt (its text is
the recorded elicitation), the panels that hold calls and terminal output (their text is
recorded), and the motion graphics: the helm, the stamps (REFUSED, FLAGGED, BLOCKED), the
count-ups and the type.

**Treatment.** Kinetic type in the brand (Instrument Sans semibold for slams, Instrument Serif
italic for the line, JetBrains Mono for commands and output), on ink with one brass accent, tide
for "allowed" and "clean", the CLI's red for refusals. Push-ins, pans, parallax and whip
transitions with motion blur into the captures. **Signature motif:** the helm assembling peg by
peg. The brand forbids rotating the mark, so instead of spinning, its eight pegs light up in a
clockwise sweep around the hub. **Through-line:** you steer. Each beat shows one thing the user
controls or the tool checks, ending on the command that sets it up.

Both cuts share the timeline. The vertical cut stacks what the wide cut places side by side.

---

## 1. Cold open (B0–B3, 0.06–1.97 s)

- The helm's ring draws itself over B0–B2 while the eight pegs light clockwise, evenly over B0–B3 (one every 3/8 beat);
  the pointer pops at B3. Brass flash on the impact; a push from 1.4× to 1.0×.
- **Out:** hard cut on B4.

## 2. The line (B4–B11, 1.97–5.71 s)

- **"You steer."** slams in on B4, a downbeat, with a shake and a brass flash. The helm shrinks
  above it. B8–B11: **"Your agents work the tabs."** lands one word per beat in brass serif.
- **Out:** whip on B12.

## 3. Build (B12–B27, 5.71–13.42 s)

- Three phrases, one every four beats, each over a capture with drift: **"Your real browser."**
  (B12, the catalog home page), **"Your agent drives it."** (B16, the Gutenberg page), **"In
  tabs of its own."** (B20, the hold form). Then one cut per beat, B24–B27: results, Gutenberg,
  the filled form, the confirmation. Each shot whips in on its own clock.
- **Out:** the music drops out.

## 4. The gap (B28–B31, 13.42–14.86 s)

- A near-still push into the real request card ("claude wants to open www.gutenberg.org") under
  a slate label, "a new site".
- **Out:** the drop.

## 5. The moment: it asks first (B32–B43, 15.30–20.98 s)

- B32: **"It asks first."** slams over the request card, centered, with a brass ring, flash and
  shake. B36: the card moves aside and, under the caption "in your agent", the drawn prompt box
  shows the recorded elicitation ("tabkyra: the browser agent wants to open
  www.gutenberg.org. Allow?"); its three recorded choices land B37–B38 and the one the run answered (recorded as
  `permissionAnswer`, "Allow www.gutenberg.org from now on") is checked on B39. B40: whip to the real after-state, Allowed sites with 127.0.0.1 and
  www.gutenberg.org, under **"You decide."** with a tide flash.
- **Out:** whip on B44.

## 6. Its own tab group (B44–B51, 20.98–24.80 s)

- The drawn browser frame (recorded group name "Tabkyra · claude", recorded title and URL)
  around the real Gutenberg screenshot flies in. **"Its own tab group."**; B48: push in 1.6×
  toward the group pill, **"Your tabs stay yours."**
- **Out:** cut on B52.

## 7. Fills it, reads it back (B52–B60, 24.80–29.15 s)

- One cut per beat, each with the recorded call that produced its screenshot: B52 the home page
  (`navigate`), B53 results (`type`), B54 the hold form (`click`), B55 the filled form (both
  `fill` calls), B56 the confirmation (`click`). B57: the recorded `get_page_text {}` call and
  its result, "Hold placed for Ada Lovelace...", punch in; **"Filled."** (B58) **"Read back."**
  (B59). The calls are found by content in the recorded order (`catalogRunFrom` in `src/hero/claims.ts`);
  the `//` labels on the two clicks ("Place hold", "Confirm hold") are the button names in the
  recorded `read_page` the agent acted on, where the filled refs must be its textbox and
  combobox. The read-back sentence is the recorded `get_page_text` result itself and must name the book
  searched, the card name and the branch filled, in their places; each action's own result must
  show it succeeded. The render fails if a step is missing.
- **Out:** cut on B61.

## 8. Refused (B61–B71, 29.15–34.36 s)

- B61, in the drum break: the real command types on, `tabkyra library add
  10.1037/0000-0000.000.0.000`. B64, when the drums come back: the real refusal prints ("DOI
  ... is not registered (doi.org returned 404)") and a red **REFUSED** stamp slams over it.
  B66: **"Made-up DOIs are refused."**
- **Out:** whip on B72.

## 9. Flagged (B72–B79, 34.36–38.16 s)

- The real Wakefield 1998 command and its title line. The citation count from the recorded
  output, 3,011, counts up to B74: **"citations."** B76: a red **FLAGGED** stamp slams over the
  recorded line "RETRACTED: don't cite this as support." (picked by its content); B77: **"Still
  retracted."**
- **Out:** whip on B80.

## 10. Blocked (B80–B91, 38.16–43.89 s)

- The bad SKILL.md, shown from two lines above the first flagged line to one below the last.
  The four recorded lint errors land on B80–B83, each lighting the line it names red (line 16
  carries two, so it lights on B82 and pulses again on B83), while a **4**
  counts up: **"problems."** B84: a red **BLOCKED** stamp. B88: `tabkyra skill lint skills/` and
  its recorded **"✓ Clean."**; B89: **"Every bundled skill passes."**
- **Out:** whip on B92.

## 11. The skill router (B92–B103, 43.89–49.59 s)

- In the drum break, **"The right skill,"** (B92) and **"in under a millisecond at p95."**
  (B93). B94: the figures from one `tabkyra skill eval --json` run, in tide: p95 per match,
  the number of timed matches and the bundled skill count (13). B96, when the drums come back,
  the header shrinks up and four recorded `tabkyra skill match` runs land, one every two beats:
  a research question → **academic-research** (B96), a landlord background check → **osint**
  (B98), "Don't use the osint skill, just search the news" → **none** (B100), `/rsi` → **rsi**
  (B102). From B96 a caption under the rows gives each whole command's recorded wall time
  (114–117 ms, starting Node), so the rows aren't read as the p95. Recorded by `scripts/demo/capture-router.mjs` into `public/capture/router.json`.
- **Out:** cut on B104.

## 12. Works with (B104–B109, 49.59–52.43 s)

- **"Works with"** on B104; **Claude Code**, **Codex**, **pi**, **OMP**, **Cursor** on half beats
  from B104.5; then "and any MCP agent". All five are named in the README's setup section.

## 13. End card (B110 to 57.6 s)

- The helm assembles within one beat, B110–B111 (its eight pegs one every 1/8 beat); the wordmark **Tabkyra** (B111); the
  line **"You steer. Your agents work the tabs."** (B111.5–B112.5); `tabkyra setup` types on
  (B113) with "builds the extension, registers your browser, offers to add your agents"
  (B113.5); **dbaney.com/tabkyra** and github.com/baney75/tabkyra (B114). B120: the final hit
  and a brass flash. The video ends with the music at 57.6 s.
- **Text (untouchable):** "You steer. Your agents work the tabs." / `tabkyra setup` /
  "dbaney.com/tabkyra".

---

## Risks

- **Beat sync drift.** Frames are 33 ms; each beat rounds to the nearest frame (±17 ms).
  Checked after render by finding cuts in the video and beats in its audio.
- **Readability at speed.** Output that must be read (the refusal, the retraction line, the
  confirmation) holds at least 1.5 s; one-beat cuts carry one short call each.
- **The mark.** The helm in the video never rotates and gets no outline or gradient. The one
  rotated helm is the poster's background watermark, which BRAND.md allows: "the bare brass helm
  turned 11° and cropped off the edge, at 7% opacity on ink".
- **Vertical layout.** Side-by-side shots stack; every beat is checked in the 9:16 cut.
- **Loudness.** About -14 LUFS with a -1 dBTP ceiling, re-measured on the final MP4s.
- **Re-captures.** Every stamped or highlighted claim is checked against the recording before
  render: each typed command against its recorded args (the shipped lint on `skills/`), the search
  text against the recorded results, the refusal line and a non-zero exit, the retraction lines and exit 3, four lint
  errors, each naming a line of the shown file, and a non-zero exit, the shipped skills'
  "✓ Clean." with no errors and exit 0, the catalog calls in order and the read-back sentence,
  the prompt's answered choice, the tab group with the recorded tab's title and URL, the lint
  summary's count, and the router's p95 under 1 ms and each row's routed skill. The
  render of Hero, HeroVertical or HeroPoster fails if one doesn't hold; the Demo still renders.
