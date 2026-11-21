# Tabkyra "Agents" video: storyboard

A 57.6-second cut for X about what changed for agents: several at once, resume, hand-off,
ask_user, the side panel's `/` and `@` menus, the terminal, and reload safety. The hero
(`HERO-STORYBOARD.md`) stays the general pitch; this one is for people who already run agents.

**Spec.** `Agents` 1920×1080 and `AgentsVertical` 1080×1920, 30 fps, H.264 + AAC, 57.6 s
(1728 frames), the same edit in both. Poster `AgentsPoster` 1280×720. Outputs:
`media/agents.mp4`, `media/agents-vertical.mp4`, `media/agents-poster.jpg`.

**Music.** The hero's track (`public/hero/music.m4a`, ACE-Step 1.5, seed 302; license and
provenance in `public/hero/NOTICE.md`) and its beat map (`src/hero/music.json`). Same file, same
terms. 126.05 BPM, 0.476 s a beat. Landmarks the edit uses: impact at B0, near-silence 13.4 to
14.0 s (B28 to B29), the drop at B32 (15.30 s), the band back at B64 (30.55 s) and B96
(45.78 s), the last hit at B120.

**Captions.** No voice. Each shot carries one caption line, the shot's claim, in Instrument
Sans semibold on an ink plate at the bottom third (wide) or below the picture (vertical), at
least 64 px on the 1080 px short side, held for the whole shot. Every caption stays still while
it must be read. Captions are claims; each is checked against `public/capture/agents.json`
before render (`src/agents/claims.ts`).

**What is recorded and what is drawn.** Recorded by `scripts/demo/capture-agents.mjs`, in
`public/capture/agents/` and `agents.json`: page screenshots (each agent's own `screenshot`
call), side panel screenshots, group titles and colors (read from `chrome.tabGroups` in the
browser), tab ids, titles and URLs, every tool call's arguments and result text, the CLI output,
and the shop's order counter. Drawn: the browser chrome and tab strip around the screenshots
(headless Chromium has no visible tab strip; the strip shows the recorded group titles, colors
and tab titles), the panels holding call text and terminal output, the drag animation of the
hand-off (the run did it with `chrome.tabs.ungroup`, the same event a drag out of the group
fires), and the type.

**Treatment.** Kinetic type in the brand: Instrument Sans semibold for captions and slams,
JetBrains Mono for calls and terminal output, ink background with a slow brass bloom, grain and
vignette on top. Signature motif: the **group pill**, the colored tab group chip. It opens the
video as three pills, and every chapter returns to a pill: the pill that comes back after a
restart, the tab that leaves a pill, the pill named in `tabkyra sessions`. Through-line: one
small web shop project, `shop`, with three Claude Code agents testing it.

The story the run tells: a developer is building a shop (`shop`, a git project served on
127.0.0.1). Agent 1 tests the product page, agent 2 the cart, agent 3 checkout. Agent 3 is the
one that asks the user and the one whose click a reload cuts off.

---

## Chapter 1: Hook (0 to 4.8 s, B0 to B10)

### Shot 1. Three agents land (B0 to B5, 0 to 2.4 s)
- **What happens**: On the impact (frame 2), B1 and B2, the three agents' recorded pages slam in,
  each under its recorded group pill in its recorded color: "Tabkyra · claude · shop", "… shop 2",
  "… shop 3". Wide: side by side. Vertical: a cascade, each card lower and in front.
- **Camera**: slow push in (1.00 to 1.04) across the hook; cards drift (Ken Burns).
- **Text**: caption "Three agents. One browser." on B1. The hook is on screen by 0.6 s.
- **Transition out**: the caption changes on B5 (shot 2).

### Shot 2. Own groups (B5 to B10, 2.4 to 4.8 s)
- **What happens**: the three pills ring in turn, 4 frames apart.
- **Text**: caption "Each one gets its own tab group."
- **Transition out**: whip right into shot 3.

## Chapter 2: Separate (4.8 to 13.4 s, B10 to B28)

### Shot 3. No cross-talk (B10 to B20, 4.8 to 9.6 s)
- **What happens**: Agent 1's card beside agent 2's call panel, which types its recorded
  `tabs_select` on agent 1's tab id. On B14 the recorded refusal lands under it in alarm red, and
  a "NOT YOURS" stamp slams on the agent 1 card. On B16 a line in tide: agent 1 keeps its tab.
- **Camera**: shake on the stamp (B14).
- **Text**: caption "None of them can touch another's tabs."
- **Transition out**: whip left.

### Shot 4. Each one sees only its own (B20 to B28, 9.6 to 13.4 s)
- **What happens**: Three recorded `tabs_context` replies, one per agent, side by side (vertical:
  stacked), each first line highlighting its own session name. Each lists one tab.
- **Camera**: slow drift up.
- **Text**: caption "Each one sees only its own."
- **Transition out**: from B26.5 agents 2 and 3 dim; agent 1's stays lit into the quiet.

## Chapter 3: Resume (13.4 to 21.0 s, B28 to B44)

### Shot 5. Quit (B28 to B32, 13.4 to 15.3 s)
- **What happens**: Near silence. Agent 1's pill and its two tabs (the group as recorded while
  the client was closed) fade to grey; a label reads "agent 1 quit · its 2 tabs stay in the group".
- **Text**: caption "Quit an agent. Its tabs stay put."
- **Transition out**: on the drop, the pill relights (shot 6).

### Shot 6. Back (B32 to B44, 15.3 to 21.0 s)
- **What happens**: Drop. The pill slams back to its color; the recorded `tabs_context` reply of
  the restarted client lands, its two tab lines (the same ids as before) marked in tide green.
- **Camera**: slam zoom on the drop, settle.
- **Text**: caption "Start it again. Its tabs come back." 4 frames after the drop.
- **Transition out**: the strip pulls back to show agent 1's group with two tabs (shot 7).

## Chapter 4: Hand-off (21.0 to 26.7 s, B44 to B56)

### Shot 7. Drag it out (B44 to B56)
- **What happens**: Agent 1's group, two tabs, on a light tab strip. On B46 a cursor lifts the
  second tab and drags it out and down (drawn motion; the run called `chrome.tabs.ungroup`). It
  loses the group's color line; "your tab now" appears under it. On B49 the agent's recorded
  next `tabs_context` news lands, marked on B50.
- **Text**: caption "Drag a tab out. Now it's yours." The agent's sentence is shown as recorded.
- **Transition out**: whip into shot 8.

## Chapter 5: It asks (26.7 to 34.3 s, B56 to B72)

### Shot 8. The question (B56 to B64)
- **What happens**: Agent 3's recorded `ask_user` call (header, question, options), then the side
  panel crop of the card as it rendered ("Claude Code asks"). From B59.5 a ring on the option the
  run chose; on B60 the crop switches to the recorded frame with it checked.
- **Text**: caption "Your agent asks. You answer in the side panel."
- **Transition out**: the band comes back on B64: the panel whips left, the answer flies right.

### Shot 9. It goes on (B64 to B72)
- **What happens**: The recorded tool result (the answer the agent got), then its two recorded
  fills, then agent 3's recorded page with the form filled.
- **Text**: caption "It gets your answer and keeps going."
- **Transition out**: zoom into the side panel composer.

## Chapter 6: `/` and `@` (34.3 to 41.9 s, B72 to B88)

### Shot 10. Skills and tabs in the composer (B72 to B88)
- **What happens**: Recorded panel screenshots, cropped by recorded boxes: `/` menu open (B72),
  filtered to `writing` (B75), `@` menu listing the tabs with the agents' tabs "used by agent …"
  (B78), the message with the skill and tab chips (B81.5), the side panel agent's reply (B84).
- **Camera**: each crop slides in from the right with a short blur.
- **Text**: caption "/ runs a skill. @ points it at a tab." (the vertical cut breaks the line after "skill.") then on B84 "It runs right in the side
  panel."
- **Transition out**: the panel shrinks into a terminal window.

## Chapter 7: The terminal (41.9 to 48.2 s, B88 to B101)

### Shot 11. sessions, tabs, threads (B88 to B101)
- **What happens**: Three real commands type and print their recorded output in one terminal:
  `tabkyra sessions` (B88), `tabkyra tabs` (B92), `tabkyra threads search teapot` (B96.5). Group
  names in the output take their pill colors. Vertical: lines too long for the width are cut
  with an ellipsis, never shrunk.
- **Text**: caption "Every session, from your terminal."
- **Transition out**: wipe up to the checkout page.

## Chapter 8: Reload safety (48.2 to 52.4 s, B101 to B110)

### Shot 12. Reload mid-click (B101 to B110)
- **What happens**: The recorded `actions` call (click "Place order", wait 3 s), "the extension
  reloads" with a red flash and shake on B103, the recorded `interrupted` result marked on
  B104.5, then the shop's recorded order count counting up to 1 and the page's order line.
- **Text**: caption "Reload mid-click. The click runs once."
- **Transition out**: flash to the end card.

## Chapter 9: End card (52.4 to 57.6 s, B110 to end) [untouchable]

### Shot 13
- **What happens**: the hero's end card as is (`EndCard` in `src/hero/Outro.tsx`): the helm and
  "Tabkyra", "You steer. Your agents work the tabs.", `tabkyra setup`, and the links
  `dbaney.com/tabkyra` and `github.com/baney75/tabkyra`. Holds still from B114 so the links can
  be read.
- **Transition out**: the music's own fade.

---

## Risks
- **Small text at phone size.** The vertical cut is watched at about 390 pt wide. Terminal and
  call text must be at least 30 px at 1080 wide; captions at least 64 px. The contact sheets at
  2 s check it.
- **Long recorded strings** (URLs, `tabs_context` lines) can overflow; scenes clamp width and
  wrap, never shrink below the floor.
- **Live data.** The side panel agent's reply comes from a local model; its text differs per run,
  so it is shown as recorded and no caption quotes it.
- **The hand-off drag** is drawn; the run used the tabGroups API. Said in the README.
- **Render time**: ~1728 frames twice; grain is SVG per frame, as in the hero.
