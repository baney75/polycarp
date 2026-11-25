# The ⌘Tab switcher

macOS today. Windows keeps its own Alt+Tab.

One setting, **⌘Tab switches**: `windows` (the default when nothing was chosen), `apps`, `workspaces`, or `off`
(macOS's own). A choice already stored stays. Tab and the right arrow step on, ⌘⇧Tab and the left arrow step back,
both ends wrap, letting go of ⌘ goes there, Esc goes nowhere.

### R-W1 Windows, most recently used first
Each window on every workspace is one card. The window in front is first, read from the window server's stacking order
even when no focus event named it. Then windows in the order they were last focused, then the ones never focused: the
current workspace's front to back, the others by most recently visited workspace, then by window id. Minimized windows
are last. No window is listed twice, a closed one is dropped, and the same input gives the same list. A window just
picked counts as in front for 0.5 s while its app comes forward.

### R-W2 One tap is the window used last
The selection starts on the second card, or on the last for ⌘⇧Tab. With no window in front (an empty workspace) the
first card is the window used last, so it starts there. One card alone is selected.

### R-W3 A tap shows nothing
The panel comes up once the gesture has lasted 120 ms, counted from the key press, or at its second step (Tab or an
arrow), whichever is first. A quicker tap commits with no panel. Every key, and the check for a ⌘ let go unseen, acts
on the gesture whether its panel is up or not.

### R-W4 The cards always fit
A card has the app's icon, the window's title and its workspace's badge. Cards are in even rows: the biggest card whose
rows fit the display, at most six to a row unless only longer rows fit. Nothing is cut off at the screen's edge.

### R-W5 Up and down go by row
Among windows the up and down arrows keep the column and wrap; a short last row gives its last card. With one row, and
among apps and workspaces, they step like left and right.

### R-W6 Holding Tab
Among apps, holding Tab on an app with more than one window opens its window bar; holding it again goes back. Among
windows and workspaces a held Tab does nothing more.

### R-W7 A pick never waits on an app
The window is looked up in a fresh window list without holding the main thread. Closed meanwhile, its app is gone to.
