.pragma library

// The default apps, as scripts/apps lists them, with names a person knows them by.

var TITLES = {
  chromium: "Chromium", chrome: "Chrome", brave: "Brave", "brave-origin": "Brave Origin", edge: "Edge", firefox: "Firefox", zen: "Zen",
  alacritty: "Alacritty", foot: "Foot", ghostty: "Ghostty", kitty: "Kitty",
  code: "VS Code", cursor: "Cursor", zed: "Zed", sublime_text: "Sublime Text", helix: "Helix", vim: "Vim", emacs: "Emacs", nvim: "Neovim", plain: "Plain",
  claude: "Claude Code", codex: "Codex", opencode: "OpenCode", pi: "Pi", omp: "Oh My Pi", grok: "Grok", gemini: "Gemini", openclaw: "OpenClaw",
  hermes: "Hermes", copilot: "Copilot", crush: "Crush", "cursor-agent": "Cursor CLI", muse: "Muse", kimi: "Kimi", qwen: "Qwen", amp: "Amp"
}

// What Omarchy stores for a choice, where that is not the choice's own name.
var STORED = { zeditor: "zed", subl: "sublime_text" }

function title(id) {
  var name = String(id).replace(/\.desktop$/, "")
  if (TITLES.hasOwnProperty(name)) return TITLES[name]
  return name.charAt(0).toUpperCase() + name.slice(1)
}

// [{ kind, now, choices: [{ id, title, now, set }] }]. The one in use is shown even when Omarchy does not offer it; that
// one cannot be set.
function parse(text) {
  return String(text || "").split("\n").filter(function(line) { return line.indexOf("\t") > 0 }).map(function(line) {
    var f = line.split("\t")
    var now = STORED.hasOwnProperty(f[1]) ? STORED[f[1]] : f[1]
    var choices = f.slice(2).map(function(id) { return { id: id, title: title(id), now: id === now, set: true } })
    if (now !== "" && !choices.some(function(c) { return c.now })) choices.unshift({ id: now, title: title(now), now: true, set: false })
    return { kind: f[0], now: now, choices: choices }
  })
}

// Where the keys go: left and right within a kind, up and down to the next kind that has a choice.
function step(rows, at, dx, dy) {
  var row = at.row
  var col = at.col
  if (dy !== 0) {
    for (var r = row + dy; r >= 0 && r < rows.length; r += dy) {
      if (rows[r].choices.length === 0) continue
      return { row: r, col: Math.min(col, rows[r].choices.length - 1) }
    }
    return at
  }
  var n = rows[row] ? rows[row].choices.length : 0
  return n === 0 ? at : { row: row, col: Math.max(0, Math.min(n - 1, col + dx)) }
}
