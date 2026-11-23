# Keys

Every Polycarp shortcut on a Mac, by group. The list comes from one table in the code (`Keymap.all` in
`spaces/Sources/BaneySpacesCore/Keymap.swift`), and a test fails when this page or the code says something else.

⌘ in the workspace and window rows, and in "hold ⌘", is your Polycarp modifier: ⌘ unless you picked ⌃, ⌥ or ⌃⌥ in
Settings > Keys. Rows that say "when Settings has it on" work only while that switch is on.

- `polycarp-spaces keys` prints this list with your modifier, grouped like a cheat sheet.
- `polycarp-spaces keys --json` prints it as an array of `{id, keys, display, title, group, scope}`. In `keys`, the
  token `mod` stands for your modifier; `display` has it filled in.
- Agents read the same list with the `keys_list` MCP tool (`polycarp mcp` or `polycarp agent`).
- `polycarp-spaces keys --markdown` prints the tables below.

<!-- keys:begin -->
## Launcher

| Keys | What it does | Where it works |
| --- | --- | --- |
| ⌘Space | Open the launcher, when Settings puts it on ⌘Space | Anywhere |
| ⌃⌘K | Open the launcher | Anywhere |
| hold ⌘ | Show every shortcut | Anywhere |
| ⌘K | Show every shortcut | In the launcher |
| ? | Show every shortcut | In the launcher |
| ↓ | Select the next result | In the launcher |
| ↑ | Select the previous result | In the launcher |
| Return | Open the selected result | In the launcher |
| ⌘Return | The selected result's other action, or show where it lives | In the launcher |
| Tab | Open the selected menu, or finish an Install or a bang | In the launcher |
| Esc | Clear the search, then go back a menu, then close | In the launcher |
| Delete | Go back a menu when the search is empty | In the launcher |
| Return | Search, or go to the address typed | On the browser's new tab page |

## Workspaces

| Keys | What it does | Where it works |
| --- | --- | --- |
| ⌘1...9 | Go to workspace 1 to 9 | Anywhere |
| F3 | Show every workspace (the Mission Control key), when Settings has it on | Anywhere |
| ⌃↑ | Show every workspace, while macOS has ⌃↑ for Mission Control | Anywhere |

## Windows

| Keys | What it does | Where it works |
| --- | --- | --- |
| ⌘⇧1...9 | Move the window in front to workspace 1 to 9 | Anywhere |
| ⌘Tab | Switch apps or workspaces, when Settings has ⌘Tab on | Anywhere |
| ⌘⇧Tab | Step back in the ⌘Tab switcher | Anywhere |

## Terminal

| Keys | What it does | Where it works |
| --- | --- | --- |
| ⌃` | Drop down the quick terminal, when Settings has it on | Anywhere |

## Agents

| Keys | What it does | Where it works |
| --- | --- | --- |
| ⌃⌘U | Go to the agent that finished | Anywhere |
| ⌘⇧U | Go to the agent that finished | While a terminal app is in front |
<!-- keys:end -->
