# Keys

Every Polycarp shortcut on a Mac, by group. The list comes from one table in the code (`Keymap.all` in
`spaces/Sources/BaneySpacesCore/Keymap.swift`), and a test fails when this page or the code says something else.

⌘ in "go to workspace" and "move to workspace" (in the menu too) and in "hold ⌘" is your Polycarp modifier: ⌘
unless you picked ⌃, ⌥ or ⌃⌥ in Settings > Keys. The When column says when a shortcut works beyond its place, such as
only while a Settings switch is on; Always means it always works there.

- `polycarp-spaces keys` prints this list with your modifier, grouped like a cheat sheet.
- `polycarp-spaces keys --json` prints it as an array of `{id, keys, display, title, group, scope, note}`. In `keys`,
  the token `mod` stands for your modifier; `display` has it filled in. `note` is the When column, or null for Always.
- Agents read the same list with the `keys_list` MCP tool (`polycarp mcp` or `polycarp agent`).
- `polycarp-spaces keys --markdown` prints the tables below.

<!-- keys:begin -->
## Launcher

| Keys | What it does | Where it works | When |
| --- | --- | --- | --- |
| ⌘Space | Open the launcher | Anywhere | When Settings puts the launcher on ⌘Space and Spotlight doesn't hold it |
| ⌃⌘K | Open the launcher | Anywhere | Always |
| hold ⌘ | Show every shortcut | Anywhere | Always |
| ⌘K | Show every shortcut | In the launcher | Always |
| keys | Type keys to show every shortcut | In the launcher | Always |
| ↓ | Select the next result | In the launcher | Always |
| ↑ | Select the previous result | In the launcher | Always |
| Return | Open the selected result | In the launcher | Always |
| ⌘Return | The selected result's other action, or show where it lives | In the launcher | Always |
| Tab | Open the selected menu, or finish an Install or a bang | In the launcher | Always |
| Esc | Clear the search, then go back a menu, then close | In the launcher | Always |
| Delete | Go back a menu | In the launcher | When the search is empty |
| Return | Search, or go to the address typed | On the browser's new tab page | Always |
| ↓ | Select the next result | On the browser's new tab page | Always |
| ⌃N | Select the next result | On the browser's new tab page | Always |
| ↑ | Select the previous result | On the browser's new tab page | Always |
| ⌃P | Select the previous result | On the browser's new tab page | Always |
| Tab | Finish a bang | On the browser's new tab page | Always |
| Esc | Clear the search | On the browser's new tab page | When the search has text |

## Workspaces

| Keys | What it does | Where it works | When |
| --- | --- | --- | --- |
| ⌘1...9 | Go to workspace 1 to 9 | Anywhere | Always |
| F3 | Show every workspace (the Mission Control key) | Anywhere | When Settings uses Polycarp's overview instead of Mission Control |
| ⌃↑ | Show every workspace | Anywhere | When Settings uses Polycarp's overview and macOS has ⌃↑ for Mission Control |
| 1...9 | Go to that workspace | In the overview | Always |
| ←→↑↓ | Move the highlight from workspace to workspace | In the overview | Always |
| Return | Go to the highlighted workspace | In the overview | Always |
| Esc | Close the overview | In the overview | Always |
| ⌘1...9 | Go to that workspace | In the Polycarp menu | Always |

## Windows

| Keys | What it does | Where it works | When |
| --- | --- | --- | --- |
| ⌘⇧1...9 | Move the window in front to workspace 1 to 9 | Anywhere | Always |
| ⌘Tab | Switch windows, apps or workspaces | Anywhere | Unless Settings leaves ⌘Tab to macOS |
| ⌘⇧Tab | Step back in the ⌘Tab switcher | Anywhere | Unless Settings leaves ⌘Tab to macOS |
| ←→↑↓ | Step through the switcher (among windows ↑ ↓ go by row) | While the ⌘Tab switcher is up | Always |
| Esc | Close the switcher without switching | While the ⌘Tab switcher is up | Always |
| ⌃⌥T | Tile this workspace, or stop | Anywhere | Always |
| ⌃⌥←→↑↓ | Focus the window that way | Anywhere | While this workspace tiles |
| ⌃⌥] | Focus the next tiled window | Anywhere | While this workspace tiles |
| ⌃⌥[ | Focus the previous tiled window | Anywhere | While this workspace tiles |
| ⌃⌥⇧←→↑↓ | Move the tiled window that way | Anywhere | While this workspace tiles |
| ⌃⌥⌘←→↑↓ | Move the tiled window's edge that way | Anywhere | While this workspace tiles |
| ⌃⌥B | Even out every split | Anywhere | While this workspace tiles |
| ⌃⌥R | Turn the window's split | Anywhere | While this workspace tiles |
| ⌃⌥S | Next layout: dwindle, columns, main, scrolling, floating | Anywhere | While this workspace tiles |
| ⌃⌥Return | Make the window the main one | Anywhere | While this workspace tiles |
| ⌃⌥F | Float the window, or tile it again | Anywhere | While this workspace tiles |
| ⌃⌥M | Give the window the whole area, or put it back | Anywhere | While this workspace tiles |
| ⌃⌥G | Make the tile a group of tabs, or take it apart | Anywhere | While this workspace tiles |
| ⌃⌥⇧⌘←→↑↓ | Move the window into the tile that way, or out of its group | Anywhere | While this workspace tiles |
| ⌃⌥Tab | Focus the next window of the group | Anywhere | While this workspace tiles |
| ⌃⌥⇧Tab | Focus the previous window of the group | Anywhere | While this workspace tiles |
| ⌃⌥N | Send the window to the next display | Anywhere | While this workspace tiles |

## Terminal

| Keys | What it does | Where it works | When |
| --- | --- | --- | --- |
| ⌃` | Drop down the quick terminal | Anywhere | When Settings has it on, in builds with the terminal |

## Agents

| Keys | What it does | Where it works | When |
| --- | --- | --- | --- |
| ⌃⌘U | Go to the agent that finished | Anywhere | Always |
| ⌘⇧U | Go to the agent that finished | While a terminal app is in front | Always |

## Player

| Keys | What it does | Where it works | When |
| --- | --- | --- | --- |
| Space | Play or pause | In the player | Songs and videos |
| ←→ | Back or forward 5 seconds | In the player | Songs and videos; on a photo, the previous or next file |
| ⇧←→ | Back or forward 30 seconds | In the player | Songs and videos |
| ↑↓ | Volume up or down | In the player | Songs and videos |
| ⌘←→ | The previous or next file in the folder | In the player | Always |
| F | Fill the screen, or come back | In the player | Always |
| ⌘I | Show or hide the file's details | In the player | Always |
| Esc | Close the player | In the player | Always |
| ⌘W | Close the player | In the player | Always |

## Bar

| Keys | What it does | Where it works | When |
| --- | --- | --- | --- |
| ⌘, | Open Settings | In the Polycarp menu | Always |
| ⌘Q | Quit Polycarp | In the Polycarp menu | Always |
<!-- keys:end -->
