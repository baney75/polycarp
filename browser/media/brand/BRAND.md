# Tabkyra brand

**Tabkyra** is *tab* + *kyra*, from Greek *kybernētēs*, "helmsman", the root of
"cybernetics". You steer and it works the tabs. The brand should feel calm and capable,
with the human in command. It is not an "autonomous AI agent".

Line: **You steer. Your agents work the tabs.** Inside the extension, where Tabkyra itself
is the agent, the line is **You steer. Tabkyra works the tabs.**

## Mark

A ship's helm with eight turned pegs, and a pointer on the hub, standing for the user's
hand on the wheel. The app icon sets it in ink on a brass tile.

| File | Use |
| --- | --- |
| `icon.svg` | App icon: brass tile, ink helm. Use at 32 px and up. |
| `icon-16.svg` | 16 px icon on its own grid, with six pegs and a solid hub, because the pointer doesn't read at that size. |
| `mark.svg` | Bare helm in ink, for light backgrounds. |
| `mark-brass.svg` | Bare helm in brass, for dark backgrounds. |
| `hero.png` | README hero on ink, for dark themes and the default (1280×400 @2x). |
| `hero-light.png` | README hero on paper, for light themes. The line is set in brass deep (1280×400 @2x). |
| `social.png` | GitHub social preview (1280×640). Upload it in the repository's Settings > General > Social preview. |

Everything is generated from the geometry in `build.mjs`. To change the mark, edit that
file and run `node media/brand/build.mjs`. It rewrites the SVGs, `static/icon-{16,32,48,128}.png`,
`src/components/helm-svg.ts`, both heroes, the GitHub social preview and the site's
social card (`site/src/frontend/public/img/og.png`, same layout at 1200×630). Don't edit
the outputs by hand.

Rules:

- Keep the tile corner radius at 15/64 of the side (3.75 px at 16 px). Don't add outlines, gradients or shadows
  to the mark itself (a soft brass glow under the tile in the UI is fine).
- Give the mark clear space of at least one peg length on every side.
- Don't rotate the mark. The pointer always points up and to the left. The one exception
  is the background watermark on the heroes and social cards: the bare brass helm turned
  11° and cropped off the edge, at 7% opacity on ink and 14% on paper (where 7% disappears).
- Never pair it with the Sitegeist orb or badlogic's marks. Tabkyra credits them in words,
  not in pictures.

## Palette

| Name | Hex | Use |
| --- | --- | --- |
| Brass | `#E3A93B` | The tile, emphasis and the one accent color. Use it on ink, never as text on white. |
| Brass deep | `#A8761C` | Brass for text and focus rings on light backgrounds. |
| Ink | `#0F1B24` | The helm, dark surfaces and body text on paper. |
| Tide | `#43B3A0` | Success and "connected" states. |
| Paper | `#F6F2EA` | Light surfaces and text on ink. |
| Slate | `#6B7A86` | Secondary text. |

The side panel's dark theme tints the neutral grays toward ink (hue 240, chroma ~0.017).
Brass appears sparingly: the mark, the tutorial pills and the user's own messages.

## Type

| Role | Face | Where |
| --- | --- | --- |
| Display | Instrument Serif, italic | The line, site headings and accents |
| Text and wordmark | Instrument Sans, semibold for the wordmark | Site and hero |
| Code | JetBrains Mono | Commands, the CLI in screenshots |
| Extension UI | System UI stack | The side panel bundles no fonts |

All three fonts are OFL-licensed and come from `@fontsource` packages in `site/`.

The wordmark is "Tabkyra" with a capital T, set in Instrument Sans semibold at -0.035em
tracking. Write the name as Tabkyra in prose and as `tabkyra` for the command.

## Voice

Plain, direct American English. Say what the tool does and what the user controls. Avoid
hype, "AI-powered", "autonomous" and "seamless". Safety statements are concrete: name
what is blocked and who approves.
