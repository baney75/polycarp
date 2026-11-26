# Tiling

macOS today; the decisions are `TilingEngine`, `TilingRead` and `TilingDrag` in BaneySpacesCore. Linux and Windows have none.

Off until a person turns it on, for all workspaces or one at a time (docs/surfaces.md, `tiling`).

### R-T1 Off costs nothing
While no workspace in sight tiles and no window waits to go back where it was, nothing is read, watched, asked or moved for
tiling. Looks come from what Spaces already sees (a scan applied, a switch ended, a display or the bar changed): there is
no timer at rest and no second window list. Windows that are where they belong are not written.

### R-T2 What is tiled
Standard windows on a workspace in sight that tiles, when their app can resize them. These float and are never moved: a
window that can't be resized, one of an app in `tiling.float`, one a person floated, a full-screen window, one Polycarp
filled the screen with, sheets, dialogs, panels, popovers, Polycarp's own windows and every window on the agent
workspace, whatever the settings say. A minimized or hidden window leaves the layout and comes back to its place.
Native tabs of one window have one tile.

### R-T3 One writer
A window has one writer at a time. Tiling writes nothing while a workspace switch runs, while displays change or while the
left mouse button is down, and a pass of writes under way stops at its next message when either starts. A parked window
is not touched.

### R-T4 An app's answer stands
A window that stays larger than its tile has its minimum learned and the layout is solved again, at most 3 times a window.
A target is written at most 3 times. A window whose app puts it elsewhere stays there until the target changes. An app
that doesn't answer is asked again after a while, and holds up no other app.

### R-T5 Nothing is lost
A window's frame from before tiling comes back when its workspace stops tiling or it starts to float. A frame comes back
in reach of a display there is now.

### R-T6 The area
A display's usable area, less the Dock, the menu bar and the part of Polycarp's bar that reaches into it. When any of
those changes the layouts are solved again. A layout is kept for each workspace and display.

### R-T8 Layouts
Each workspace has one of five on each display, kept across restarts: `dwindle`, `columns`, `main`, `scrolling` and
`floating`. A `scrolling` column is as wide as it was left, whatever the others are; the one in use is always wholly in
view, and the strip scrolls no further than that takes. A window out of view waits in the parking corner, never on another
display, and comes back in reach when Polycarp quits or stops placing windows. `floating` writes no frame after the one
that puts a window back where it was.

### R-T9 Groups
A group's windows share one tile and one frame, under a strip of tabs that is inside the tile and that no tiled window
lies over. A window is in one group at most and a group has one window in front. A group lasts until its last window goes
or a person takes it apart; a window back from the Dock or from hiding is in its group again.

### R-T10 Scratchpad
A scratchpad window is on no workspace. All of them come out over the workspace in use at one key and go away at the next,
at a switch of that workspace, or with its display; each workspace then has the window in focus it had. They float and are
never tiled, keep their frame, and a minimized one stays in the Dock. There is none over the agent workspace. A window is
taken out by the key that sent it there or by sending it to a workspace, and the two keys stay while one is left. It is
kept across restarts.

### R-T11 Pinned
A pinned window is on whichever workspace its display shows and floats there. It is not what a workspace gives the focus to
while it has a window of its own, is never on the agent workspace, and is let go by sending it to a workspace or to the
scratchpad. Let go, or floated and tiled again, a window takes its old place when the rest of that layout is as it was, with
its frame from before tiling. Another native tab of a pinned or scratchpad window is pinned or on the scratchpad as it was.

### R-T12 Full size
A window in tiled full screen has all its workspace may tile, with no gaps; one in full width has the layout's width and
its tile's height. The layout is not changed by either and neither makes a macOS desktop. A window stays so until it is
asked back, dragged or floated, through other windows' focus, other workspaces, the Dock and restarts. A group is zoomed as
one, and no strip of tabs is drawn under a zoomed window.

### R-T13 Widths
A workspace's only window is as wide as the setting says until the person gives it a width of its own, which stays with the
workspace, in the middle, never past the area and never under the window's minimum; evening out or another setting ends it.
A kept width is by app and workspace, the app's latest elsewhere. It changes the layout only as a pulled edge does.

### R-T19 Window rules
`tiling.rules` lines read `<bundle id> <float|tile|pin|1-9> [title words]`; a line that doesn't read turns the file away.
Bundle ids match in any case and title words as a case-insensitive part of the title. The first float or tile rule that
matches decides, then `tiling.float`, then the built-in utilities; a person's ⌃⌥F wins over all of them. The decision is
made once a window has a title when its app has a rule with title words, at once otherwise, and kept until the rules
change. Pin and workspace rules apply once, to a new window no agent claimed, after claims; never to or from the agent
workspace, nor to a window of an app with a window there or one that waits on you. Titles are read only while a rule has
title words, and never reach a trace line or a saved file.

### R-T7 Fast
From a look to the last frame sent, Polycarp's own time is under 50 ms with 8 windows (`open tile=` in timing.log, budget
in speed.json), apps are written side by side off the main thread, and a workspace switch takes no longer than without
tiling.
