# Style sheet: restyle the top bar and the tiling outline with CSS

`style.css` restyles Polycarp's top bar, the launcher and the outline of where a dragged tiled window would go
(surfaces.json's `tiling`) with a small, strict subset of CSS. The theme (`polycarp theme`) sets colors,
shape, type and motion everywhere; a rule in the sheet changes them for the bar or one part of it, and anything the sheet leaves out is drawn as before. What each surface shows (which modules, which
labels) stays in [surfaces.json](surfaces.md). `polycarp look` keeps the sheet with the theme, the surfaces and the paper
as one look ([looks.md](../../docs/looks.md)); applying one replaces the sheet, and `polycarp look undo` brings it back.

- File: `<config>/style.css`, in the folder `polycarp theme current` prints: `$POLYCARP_CONFIG_DIR`, else
  `$XDG_CONFIG_HOME/polycarp`, else `~/.config/polycarp`.
- At most 64 KB, a regular file, UTF-8. A file that breaks these is ignored, with one line in `trace.log`.
- No file means no sheet, and nothing is logged.
- Edits apply live: a running Polycarp picks up a change within 200 ms, logs `style.css: applied, N rules, M problems`
  (or `style.css: removed`) and redraws the bar; the outline reads it at the next drag. A new bar `height` moves the bar's panels. Nothing restarts.
- `polycarp-spaces style example` prints a starter sheet that names every selector and property, all commented out.
- `polycarp-spaces style preset omarchy` writes a whole look in one command (see [Presets](#presets)).
- Every selector and property below changes something on screen; nothing in the table is parsed and then ignored.
- The Workspace Dock was removed on 2026-11-23, and its `dock` selectors with it. An older sheet that still has `dock`
  rules loads: each such selector is a warning and is ignored, and the rest of the sheet applies.

## Precedence

The theme comes first, then the sheet. A property the sheet sets wins over the theme for the part it selects; a property
it doesn't set keeps the theme's value. Inside the sheet, the usual CSS order holds: the more specific selector wins, and
on a tie the later rule wins.

## Reading the sheet is forgiving

The sheet never stops Polycarp from drawing. A declaration that can't be used is dropped and the rest of its rule
applies; a rule with a bad selector is dropped and the rest of the sheet applies. Each one is a problem with a line, a
column and a reason, which `polycarp-spaces style check` lists:

```text
style.css:3:3: error: unknown property `colr`; did you mean `color`?
style.css:5:1: error: `bar` has no part `.clok`; its parts are `.left` `.center` `.right` `.mark` ... `.network`; the rule is dropped
style.css:7:21: warning: `bar .clock`: text #222222 on #111111 is 1.1:1 in dark mode; text needs at least 3:1
```

A warning (low contrast) still applies; `check` passes when there are only warnings.

## Grammar

- Comments: `/* ... */`.
- Rules: `selector, selector { property: value; property: value }`. Nested rules and `!important` aren't supported.
- Custom properties go in `:root`: `:root { --gold: #d4af37; }`, used as `var(--gold)` or `var(--gold, fallback)`. A
  value can use `var()` anywhere in it; a reference that comes back to itself is a problem and sets nothing.
- The theme's roles are predefined custom properties, in the mode in force: `--background` `--surface` `--sunken`
  `--foreground` `--strong` `--muted` `--border` `--accent` `--on-accent` `--selection` `--urgent` `--working` `--done`.
  A sheet that defines one in `:root` overrides the theme's for the sheet.
- The only at-rule is `@media (prefers-color-scheme: dark)` (or `light`), holding rules and `:root` blocks for that mode.
- Lengths are `px` or `pt`; both mean points. `0` needs no unit.
- Colors: `#rgb` `#rgba` `#rrggbb` `#rrggbbaa`, `rgb()` and `rgba()` (commas or spaces, `/ alpha`, numbers or
  percentages), `hsl()` and `hsla()`, `transparent`, `currentColor`, the 16 basic named colors (`black` `silver` `gray`
  `white` `maroon` `red` `purple` `fuchsia` `green` `lime` `olive` `yellow` `navy` `blue` `teal` `aqua`) and `var(--role)`.
- Specificity: the surface counts as a type; each part, `.current` and `:hover` counts as a class.
- Inheritance: `color`, `font-*`, `letter-spacing` and `text-transform` pass from a surface to its region and from a
  region to its modules. Nothing else inherits.
- `*`, ids, attribute selectors, combinators other than the space, and pseudo-elements aren't supported. A selector with
  any of them is a problem that says why and names the selectors that work.
- Low contrast: text whose color is under 3:1 against what it's drawn on is a warning.

## Selectors

| Selector | States | What it is |
| --- | --- | --- |
| `bar` | none | The top bar itself. |
| `bar .left` `bar .center` `bar .right` | none | The bar's three regions; modules inherit text properties from their region. |
| `bar .island` | none | One island of modules when bar.style is islands: its background, corners, line, shadow, padding and gap. Text inside takes its region's and module's styles. |
| `bar .mark` `bar .workspaces` `bar .app-menus` `bar .status` `bar .hour` `bar .clock` `bar .date` `bar .verse` `bar .battery` `bar .network` `bar .agents` `bar .page` `bar .notifications` | `:hover` | One class for each bar module (surfaces.json bar.modules); :hover while the pointer is on it. |
| `bar .workspace` | `.current` `:hover` | One number in the workspaces module; .current is the workspace you're on, :hover the one under the pointer. |
| `launcher` | none | The launcher's panel. gap is the space between rows. |
| `launcher .field` | none | The search field across the top, with the magnifying glass beside it. border-bottom takes the place of the line under it. |
| `launcher .section` | none | A heading over a group of results. |
| `launcher .row` | `.selected` `:hover` | One result; .selected is the one Return opens, :hover the one under the pointer. A border on .row.selected takes the place of the accent mark beside it. |
| `launcher .title` | `.selected` | A result's name; .selected while its row is. |
| `launcher .subtitle` | `.selected` | The line under a result's name; .selected while its row is. |
| `launcher .badge` | `.selected` | A result's word at the right (Install, Installed); .selected while its row is. |
| `launcher .icon` | `.selected` | A result's picture, and the color of a symbol; .selected while its row is. |
| `launcher .footer` | none | The key hints along the bottom. border takes the place of the line over it. |
| `tiling` | none | The outline of where a dragged tiled window would go. |
| `switcher` | none | The ⌘Tab panel. gap is the space between tiles. |
| `switcher .item` | `.selected` | One app, window or workspace in it; .selected is the one letting go lands on. |
| `switcher .number` | `.selected` | A workspace's number, when ⌘Tab steps through workspaces; .selected while its tile is. |
| `switcher .label` | `.selected` | The name under an app, a window's title or a workspace's window count; .selected while its tile is. |
| `switcher .icon` | `.selected` | An app's icon; .selected while its tile is. |
| `switcher .hint` | none | The line under the apps, and the words beside a window bar's heading. |

States join with no space: `bar .workspace.current`, `bar .workspace:hover`, `bar .workspace.current:hover`. A
`custom:<name>` bar module has no class yet.

## Properties

| Property | Takes | Applies to | Inherited | What it does |
| --- | --- | --- | --- | --- |
| `color` | a color | bar, bar region, bar module, bar workspace; all of launcher; switcher, switcher item, switcher number, switcher label, switcher hint | yes | Text and symbol color. |
| `background` | a color, `none`, `glass` (the platform's blur) or `linear-gradient(<color>, <color>)`, optionally starting `to bottom,` or `to right,` | all of bar; launcher, launcher field, launcher section, launcher row, launcher badge, launcher footer; all of tiling; switcher, switcher item | no | What is drawn behind it. |
| `opacity` | a number from 0 to 1, or a percentage | everything | no | How opaque the whole thing is. |
| `font-family` | a font stack, as the theme's `type.ui`: names separated by commas, quoted when they hold other characters | bar, bar region, bar module, bar workspace; launcher, launcher field, launcher section, launcher row, launcher title, launcher subtitle, launcher badge, launcher footer; switcher, switcher item, switcher number, switcher label, switcher hint | yes | The font, first installed name wins; `monospace` and `serif` are the system's. |
| `font-size` | a length from 6 to 40 (`px` or `pt`) | bar, bar region, bar module, bar workspace; launcher, launcher field, launcher section, launcher row, launcher title, launcher subtitle, launcher badge, launcher footer; switcher, switcher item, switcher number, switcher label, switcher hint | yes | Text size in points. |
| `font-weight` | 100 to 900, `normal` (400) or `bold` (700) | bar, bar region, bar module, bar workspace; launcher, launcher field, launcher section, launcher row, launcher title, launcher subtitle, launcher badge, launcher footer; switcher, switcher item, switcher number, switcher label, switcher hint | yes | Text weight. |
| `font-style` | `normal` or `italic` | bar, bar region, bar module, bar workspace; launcher, launcher field, launcher section, launcher row, launcher title, launcher subtitle, launcher badge, launcher footer; switcher, switcher item, switcher number, switcher label, switcher hint | yes | Upright or italic text. |
| `letter-spacing` | `normal` or a length from -2 to 10 (`px` or `pt`) | bar, bar region, bar module, bar workspace; launcher, launcher section, launcher row, launcher title, launcher subtitle, launcher badge, launcher footer; switcher, switcher item, switcher number, switcher label, switcher hint | yes | Extra space between letters. |
| `text-transform` | `none`, `uppercase`, `lowercase` or `capitalize` | bar, bar region, bar module, bar workspace; launcher, launcher section, launcher row, launcher title, launcher subtitle, launcher badge, launcher footer; switcher, switcher item, switcher label, switcher hint | yes | Letter case, whatever the text says. |
| `font-variant-numeric` | `normal` or `tabular-nums` | bar, bar region, bar module, bar workspace; launcher, launcher section, launcher row, launcher title, launcher subtitle, launcher badge, launcher footer; switcher, switcher item, switcher number, switcher label, switcher hint | yes | `tabular-nums` gives every digit the same width, so a clock doesn't jiggle. |
| `width` | a length from 480 to 1200 (`px` or `pt`) | launcher | no | The panel's width (never wider than the screen). |
| `height` | a length from 18 to 64 (`px` or `pt`) | bar; launcher row | no | The bar's height (on a screen with a notch the bar fills the strip beside it), or a row's: its icon shrinks to fit, and a subtitle with no room goes. |
| `padding` | 1 to 4 lengths from 0 to 40, in CSS order (top, right, bottom, left) | all of bar; launcher, launcher field, launcher section, launcher row, launcher badge, launcher footer; switcher | no | Space inside the edge. |
| `gap` | a length from 0 to 40 (`px` or `pt`) | bar, bar region, bar island, bar module; launcher, launcher row; switcher | no | Space between modules (bar, a region, an island), between a module's items (workspace numbers, menus, status items), between rows or tiles (a panel) or between an icon and its text (a row). |
| `border-radius` | a length from 0 to 40 (`px` or `pt`) | all of bar; launcher, launcher field, launcher section, launcher row, launcher badge, launcher icon, launcher footer; all of tiling; switcher, switcher item, switcher icon | no | Corner radius. |
| `border` | `none` or `<width 0 to 8> solid <color>` | all of bar; launcher, launcher field, launcher section, launcher row, launcher badge, launcher footer; all of tiling; switcher, switcher item | no | A line all around. |
| `border-bottom` | `none` or `<width 0 to 8> solid <color>` | bar, bar region, bar module, bar workspace; launcher, launcher field, launcher section, launcher row; switcher, switcher item | no | A line along the bottom edge only. |
| `box-shadow` | `none` or `<x> <y> <blur> <color>` (x and y -40 to 40, blur 0 to 64) | bar island | no | A drop shadow. |
| `display` | `flex` or `none` | bar region, bar island, bar module, bar workspace; launcher section, launcher subtitle, launcher badge, launcher icon, launcher footer; switcher label, switcher icon, switcher hint | no | `none` hides it; `flex` (the default) shows it. |
| `transition-duration` | 0 to 2000 `ms`, or the same in `s` | bar module, bar workspace; launcher row; switcher item | no | How long a change of state (hover, current, selected) fades its colors and lines. |

A property used on a selector it doesn't apply to is a problem, not silently ignored. To turn the whole bar off, use
`bar.enabled` in surfaces.json.

## Examples

A glass bar with a gold clock. The gold is darker in light mode so it reads on a light bar:

```css
:root { --gold: #8a6d1f; }
@media (prefers-color-scheme: dark) {
  :root { --gold: #d4af37; }
}

bar { background: glass; }
bar .clock { color: var(--gold); font-weight: 600; font-variant-numeric: tabular-nums; }
```

A hairline bar with uppercase, spaced labels:

```css
bar {
  background: var(--background);
  border-bottom: 0.5px solid var(--border);
  height: 26px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 1.5px;
  text-transform: uppercase;
}
bar .verse { text-transform: none; letter-spacing: normal; font-style: italic; }
```

Quiet workspace numbers with an accent line under the one you're on:

```css
bar .workspace { color: var(--muted); padding: 0 5px 3px; }
bar .workspace:hover { color: var(--foreground); }
bar .workspace.current { color: var(--foreground); border-bottom: 2px solid var(--accent); }
```

## Presets

`polycarp-spaces style preset <name>` writes a whole sheet in one command, and `polycarp-spaces style restore` undoes it.
With no name it lists them. The sheet that was there is kept as a backup, as `reset` keeps it, and `polycarp-spaces
style reset` puts the theme's own look back.

Backups sit beside the sheet: `style.css.bak`, then `style.css.bak.1`, `.bak.2` and on. A new one always takes the next
number, so none is ever written over. Three cases make no backup, since nothing would be lost: a preset already in force
is left as it is, `reset` of an unedited preset only removes it (`preset` writes it again), and `reset` of text the newest
backup already holds only removes the sheet. `restore` puts the newest backup back and keeps the sheet it replaces as the
next backup, so a second `restore` undoes the first; with no backup it is refused with the code `no_backup`. A preset
written where there was no sheet keeps an empty sheet as its backup, so `restore` goes back to no rules (the theme's
own look) and never to an older backup a `reset` put away.

- `omarchy`: the top bar as Omarchy's Waybar draws it. A solid dark strip (`#1a1b26`) in both modes, one monospace face
  (JetBrains Mono when it is installed, else the system's), the workspace numbers muted with a 2 pt accent line under
  the one you're on, the clock brighter, and the right side in a quiet gray. It checks clean, contrast included.

The preset is an ordinary sheet: `polycarp-spaces style show` prints it and `style set` edits it like any other.

## Commands

```sh
polycarp-spaces style path [--json]                     # where the sheet is, and whether it exists
polycarp-spaces style show [--json]                     # the sheet's text and its rules
polycarp-spaces style check [file] [--json]             # every problem with its line and column (default: the sheet in use)
polycarp-spaces style example [--json]                  # a starter sheet naming every selector and property
polycarp-spaces style preset [name] [--json]            # write a whole sheet (omarchy); no name lists them
polycarp-spaces style set '<selector>' <property> <value> [--media dark|light] [--json]
polycarp-spaces style unset '<selector>' [property] [--media dark|light] [--json]
polycarp-spaces style reset [--json]                    # moves the sheet to the next backup
polycarp-spaces style restore [--json]                  # puts the newest backup back (the sheet there becomes one)
```

`set` edits the file in place: it changes the declaration if the rule has it, adds it to the rule if not, and adds the
rule at the end if there is none. Comments and everything else stay as they were. It checks the sheet with the change in
it and writes nothing when the change would add an error. `--media dark` puts the rule in the dark-mode block. `unset`
removes one property, or the whole rule with no property; a rule or `@media` block left empty goes too. The value is
the rest of the arguments, so `style set 'bar .clock' font-family '"SF Pro Text", system-ui'` works.

Exit codes: 0 done, 1 refused (an error in the sheet, an invalid selector, property or value, no backup to restore, a
file that can't be read), 2 the command was used wrong. With `--json`, every subcommand prints the envelope
`polycarp-spaces surfaces` uses; a refusal's `error.data.errors` lists each problem with `line`, `column`, `severity`
and `message`.

## MCP

`polycarp mcp` serves these tools, each running the command above:

| Tool | Runs |
| --- | --- |
| `style_example` | `polycarp-spaces style example --json` |
| `style_get` | `polycarp-spaces style show --json` |
| `style_check` | `polycarp-spaces style check --json` (the sheet in use only: the tool takes no file) |
| `style_set` | `polycarp-spaces style set <selector> <property> <value> [--media] --json` |
| `style_unset` | `polycarp-spaces style unset <selector> [property] [--media] --json` |
| `style_preset` | `polycarp-spaces style preset [name] --json` |
| `style_restore` | `polycarp-spaces style restore --json` (undoes `style_preset`) |

The usual loop for an agent: `style_example` to learn the names, `style_set` for each change, then `style_check`.
To undo a `style_preset`, `style_restore`.
