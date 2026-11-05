---
name: polycarp-theme
description: Use when the user wants Polycarp (Spaces, Voice, Browser or the website) to look different, such as colors, corners, fonts, spacing or motion, or wants a theme previewed or undone.
---

# Customizing Polycarp for the user

One theme file drives every Polycarp product. Change it with the `polycarp theme` command, or with the
`theme_*` tools if `polycarp mcp` is connected. Both give the same JSON result (`--json` on the command).

## Steps

1. **Ask or infer.** What should change, and where: everywhere, or one product (spaces, voice, browser, site)?
   "Warmer" or "rounder" is enough. Do not ask about hex values.
2. **Read.** `polycarp theme schema` lists every field with what it controls, its range and the contrast
   rules. `polycarp theme current` says what is in force. `polycarp theme get dark.accent` reads one value.
3. **Make the smallest change.**
   - One value: `polycarp theme change <path> <value>`. On a built-in theme it makes `<name>-custom`
     that extends it and switches to it; it says so. The built-ins are never edited.
   - A whole look: `polycarp theme apply <file|->` with TOML or JSON. Set `extends` and list only what changes.
   - One product only: use `surface.<product>.<section>.<key>` paths, or a `[surface.<product>]` table.
   - Only the brand color: `polycarp theme accent '#rrggbb'` (it picks a readable `on_accent`).
4. **Read refusals, then adjust.** A refusal changes nothing. With `--json`, `error.data.errors` lists each
   `path`, and for contrast the `actual` and `needs` ratios. Pick other colors. Never loosen the rules or
   edit the files in `current/` by hand.
5. **Preview.** `polycarp theme preview` writes an HTML file (light and dark side by side) and prints its
   path. Open it and take a screenshot. Show the user.
6. **Undo.** If they dislike it, `polycarp theme undo` steps back one change, including the theme file.
   `polycarp theme reset` always works. Set `POLYCARP_CALLER=agent:<your name>` so history says it was you.

Use a temporary `XDG_CONFIG_HOME` when you test. Never edit the user's real config to experiment.

## Example: "warmer"

Warm paper in light mode, warm brown in dark mode, a terracotta accent. Read from stdin:

```sh
polycarp theme apply - <<'EOF'
name = "warmer"
title = "Warmer"
extends = "polycarp"
[light]
background = "#fbf0e0"
surface = "#fff7ea"
sunken = "#f0e1cb"
border = "#e0cbaa"
selection = "#f1d8bc"
accent = "#a4502a"
on_accent = "#fff7ea"
[dark]
background = "#2f2822"
surface = "#3a322b"
sunken = "#252019"
border = "#54493d"
selection = "#4d3c2c"
accent = "#e3a57a"
on_accent = "#2a1a0e"
EOF
```

## Example: "square corners and a monospace font"

```sh
polycarp theme change shape.radius_small 0
polycarp theme change shape.radius 0
polycarp theme change shape.radius_large 0
polycarp theme change type.ui 'ui-monospace, "SF Mono", Menlo, Consolas, monospace'
polycarp theme change type.display 'ui-monospace, "SF Mono", Menlo, Consolas, monospace'
```

## Example: "only the browser panel greener"

Only Tabkyra changes; Spaces, Voice and the site keep their accent.

```sh
polycarp theme change surface.browser.light.accent '#2f6b3a'
polycarp theme change surface.browser.dark.accent '#8fcf9a'
polycarp theme preview --surface browser
```

## Paths and values

`light.*` and `dark.*` take `"#rrggbb"`. `shape.radius*` and `shape.border_width` take px; `shape.shadow` 0
to 1; `shape.density` is compact, regular or spacious; `shape.indicator` is dot, bar or number-block.
`type.*` fonts take a font stack; `motion.*` takes ms, an easing, or `reduced` true. Exact ranges are in
the schema. The full guide is `themes/README.md`.
