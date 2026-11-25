.pragma library

// What the workspaces part shows, from plain data. No Quickshell in here: the tests run it in node.
//
// workspaces: [{ id, name, monitor, windows: [{ app, title }], urgent, layout }]

// Hyprland gives a named workspace an id of -1337 or lower. Anything from 0 down to there is special (a scratchpad).
var NAMED_FROM = -1337

function real(id) {
  return id > 0 || id <= NAMED_FROM
}

// The marks for one monitor, in order: numbered ones by number, then named ones by name. A workspace shows when it has
// windows, when it is the one on this monitor, or when it wants you. With `empty` > 0 the first `empty` numbers of the
// monitor's block show as well, except the ones another monitor holds.
function shown(workspaces, monitor, activeId, empty) {
  var first = blockStart(workspaces, monitor, activeId)
  empty = Math.min(empty, 10)
  var out = []
  var seen = {}
  var i, w
  for (i = 0; i < workspaces.length; i++) {
    w = workspaces[i]
    if (!real(w.id)) continue
    seen[w.id] = w.monitor
    if (w.monitor !== monitor) continue
    if (w.windows.length > 0 || w.id === activeId || w.urgent || (w.id >= first && w.id < first + empty)) out.push(w)
  }
  for (i = 0; i < empty && first > 0; i++) {
    var id = first + i
    if (seen[id] !== undefined) continue
    out.push({ id: id, name: String(id), monitor: monitor, windows: [], urgent: false, layout: "" })
  }
  out.sort(order)
  return out
}

function order(a, b) {
  var an = a.id > 0, bn = b.id > 0
  if (an !== bn) return an ? -1 : 1
  if (an) return a.id - b.id
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

// Omarchy gives each monitor ten numbers: 1 to 10, 11 to 20 and so on. The monitor's ten are the ones it is on now; on a
// named workspace, the ones its lowest number is in. On a named workspace with no number at all it has none (0): any ten
// guessed could be another monitor's.
function blockStart(workspaces, monitor, activeId) {
  var id = activeId
  for (var i = 0; i < workspaces.length && activeId <= 0; i++) {
    var w = workspaces[i]
    if (w.monitor === monitor && w.id > 0 && (id <= 0 || w.id < id)) id = w.id
  }
  return id > 0 ? Math.floor((id - 1) / 10) * 10 + 1 : 0
}

// What the mark says. A number in the monitor's ten (from `first`) is its place there, as the number keys are: 12 is "2",
// 10 is "0" on a key but reads 10 here. One that came from another monitor's ten keeps its whole number. `names` uses the
// workspace's own name where it has one.
function label(workspace, style, first) {
  var named = workspace.name !== "" && workspace.name !== String(workspace.id)
  if (workspace.id <= 0) return workspace.name
  if (style === "names" && named) return workspace.name
  return String(first > 0 && workspace.id >= first && workspace.id < first + 10 ? workspace.id - first + 1 : workspace.id)
}

// The apps on a workspace as icons: each app once, in the order its first window came, up to `max`, then how many apps
// are left out.
function icons(windows, max) {
  var apps = []
  var seen = Object.create(null)
  for (var i = 0; i < windows.length; i++) {
    var app = windows[i].app
    if (!app || seen[app]) continue
    seen[app] = true
    apps.push(app)
  }
  var room = Math.max(0, max)
  return { apps: apps.slice(0, room), more: Math.max(0, apps.length - room) }
}

// The workspace one step of the wheel goes to. Stops at the ends: a wheel that wraps loses your place.
function step(marks, activeId, way) {
  var at = indexOf(marks, activeId)
  if (at < 0 || way === 0) return null
  var to = Math.max(0, Math.min(marks.length - 1, at + (way > 0 ? 1 : -1)))
  return to === at ? null : marks[to]
}

function indexOf(marks, id) {
  for (var i = 0; i < marks.length; i++) if (marks[i].id === id) return i
  return -1
}

// A mouse wheel sends 120 a notch and a touchpad sends crumbs. Steps once per notch's worth and keeps the rest; a turn
// the other way starts over.
function wheel(rest, delta) {
  var sum = rest * delta < 0 ? delta : rest + delta
  var steps = sum > 0 ? Math.floor(sum / 120) : Math.ceil(sum / 120)
  return { steps: steps, rest: sum - steps * 120 }
}

// What Hyprland calls the workspace when you ask to go there.
function target(workspace) {
  return workspace.id > 0 ? String(workspace.id) : "name:" + workspace.name
}

// The dispatch that focuses it. A name is the person's own text, so it is quoted for Lua.
function focusCommand(workspace) {
  return "hl.dsp.focus({ workspace = " + luaString(target(workspace)) + " })"
}

function windowCommand(address) {
  return /^(0x)?[0-9a-f]+$/i.test(address)
    ? "hl.dsp.focus({ window = " + luaString("address:0x" + address.replace(/^0x/i, "")) + " })"
    : ""
}

function luaString(text) {
  return "\"" + String(text).replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/[\r\n]+/g, " ") + "\""
}

// What the layout's glyph is: tiled side by side, a scrolling row, or one window at a time.
function layoutKind(name) {
  if (name === "scrolling") return "scrolling"
  if (name === "dwindle" || name === "master") return "tiled"
  if (name === "monocle") return "single"
  return name ? "tiled" : ""
}

function describe(workspace, strings) {
  var parts = [strings.workspace.replace("%1", function() { return workspace.name || workspace.id })]
  var titles = []
  for (var i = 0; i < workspace.windows.length && titles.length < 3; i++) if (workspace.windows[i].title) titles.push(workspace.windows[i].title)
  if (titles.length) parts.push(titles.join(", "))
  if (workspace.urgent) parts.push(strings.wantsYou)
  return parts.join("  ")
}
