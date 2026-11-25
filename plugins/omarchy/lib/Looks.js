.pragma library

// Polycarp themes and Omarchy themes, each turned into the other, with every pair of colors measured. Plain data in and
// out: files are read and written by scripts/look.

var MODES = ["dark", "light"]
var ROLES = ["background", "surface", "sunken", "foreground", "strong", "muted", "border", "accent", "on_accent", "selection", "urgent", "working", "done"]
// Text this small needs 4.5 to 1; a dot or a bar needs 3.
var TEXT = 4.5
var MARK = 3

// ---- TOML, as much of it as a theme file uses: [tables], strings, numbers, true and false.

function parseToml(text) {
  var out = {}
  var table = out
  var lines = String(text || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim()
    if (line === "" || line.charAt(0) === "#") continue
    var m = line.match(/^\[\s*([A-Za-z0-9_.-]+)\s*\]\s*(#.*)?$/)
    // A table this reader does not know ("x", [[x]]): its keys go nowhere rather than into the table before it.
    if (!m && line.charAt(0) === "[") { table = {}; continue }
    if (m) {
      table = out
      var path = m[1].split(".")
      for (var j = 0; j < path.length; j++) {
        if (unsafe(path[j])) { table = {}; break }
        if (typeof table[path[j]] !== "object") table[path[j]] = {}
        table = table[path[j]]
      }
      continue
    }
    m = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/)
    if (!m || unsafe(m[1])) continue
    var value = scalar(m[2])
    if (value !== undefined) table[m[1]] = value
  }
  return out
}

function unsafe(key) {
  return key === "__proto__" || key === "constructor" || key === "prototype"
}

function scalar(text) {
  var m = text.match(/^"((?:[^"\\]|\\.)*)"/)
  if (m) return m[1].replace(/\\(["\\])/g, "$1")
  m = text.match(/^'([^']*)'/)
  if (m) return m[1]
  m = text.match(/^([^\s#]+)/)
  if (!m) return undefined
  if (m[1] === "true") return true
  if (m[1] === "false") return false
  return m[1] !== "" && !isNaN(Number(m[1])) ? Number(m[1]) : undefined
}

// ---- Color

function isHex(v) {
  return typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v)
}

function rgb(hex) {
  return [1, 3, 5].map(function(i) { return parseInt(hex.slice(i, i + 2), 16) / 255 })
}

function hex(c) {
  return "#" + c.map(function(v) {
    var s = Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16)
    return s.length < 2 ? "0" + s : s
  }).join("")
}

function mix(a, b, t) {
  var x = rgb(a)
  var y = rgb(b)
  return hex([0, 1, 2].map(function(i) { return x[i] + (y[i] - x[i]) * t }))
}

function luminance(color) {
  var c = rgb(color).map(function(v) { return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) })
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

function contrast(a, b) {
  var x = luminance(a)
  var y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

function worst(color, grounds) {
  var out = 99
  for (var i = 0; i < grounds.length; i++) out = Math.min(out, contrast(color, grounds[i]))
  return out
}

// The nearest color to this one that reads on every ground, going toward `to` only as far as it must.
function fit(color, grounds, least, to) {
  if (worst(color, grounds) >= least) return color
  for (var t = 0.02; t < 1; t += 0.02) {
    var c = mix(color, to, t)
    if (worst(c, grounds) >= least) return c
  }
  return to
}

function fromHsl(h, s, l) {
  var f = function(n) {
    var k = (n + h / 30) % 12
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  }
  return hex([f(0), f(8), f(4)])
}

// ---- Polycarp themes

// A theme with everything it extends folded in, or null when it cannot be whole.
function resolve(name, themes) {
  var chain = []
  for (var at = name; at; at = themes[at].extends) {
    if (!themes.hasOwnProperty(at) || chain.length > 8) return null
    for (var i = 0; i < chain.length; i++) if (chain[i] === themes[at]) return null
    chain.push(themes[at])
  }
  var out = { name: name, title: "", description: "", light: {}, dark: {}, type: {} }
  for (i = chain.length - 1; i >= 0; i--) {
    var t = chain[i]
    // Its own title and description, not the theme's it extends.
    if (i === 0 && t.title) out.title = String(t.title)
    if (i === 0 && t.description) out.description = String(t.description)
    var tables = ["light", "dark", "type"]
    for (var j = 0; j < tables.length; j++) for (var key in t[tables[j]] || {}) out[tables[j]][key] = t[tables[j]][key]
  }
  if (!out.title) out.title = name
  for (j = 0; j < MODES.length; j++) for (i = 0; i < ROLES.length; i++) if (!isHex(out[MODES[j]][ROLES[i]])) return null
  return out
}

// The pairs Polycarp holds a theme to: [role, ground, least]
var PAIRS = (function() {
  var out = []
  var text = ["foreground", "strong", "muted"]
  var status = ["urgent", "working", "done", "accent"]
  var i
  for (i = 0; i < text.length; i++) out.push([text[i], "background", TEXT], [text[i], "surface", TEXT], [text[i], "sunken", TEXT])
  out.push(["foreground", "selection", TEXT], ["strong", "selection", TEXT])
  for (i = 0; i < status.length; i++) out.push([status[i], "background", TEXT], [status[i], "surface", TEXT], [status[i], "sunken", MARK])
  out.push(["on_accent", "accent", TEXT])
  return out
})()

// The pairs that miss: [{ role, ground, ratio, least }]
function misses(colors, pairs) {
  var out = []
  for (var i = 0; i < pairs.length; i++) {
    var a = colors[pairs[i][0]]
    var b = colors[pairs[i][1]]
    if (!isHex(a) || !isHex(b)) continue
    var ratio = contrast(a, b)
    if (ratio < pairs[i][2]) out.push({ role: pairs[i][0], ground: pairs[i][1], ratio: Math.floor(ratio * 10) / 10, least: pairs[i][2] })
  }
  return out
}

// ---- To Omarchy

// What a shell, a terminal or an editor draws as text.
var OMARCHY_PAIRS = ["foreground", "bright_foreground", "light_foreground", "muted", "accent", "red", "orange", "yellow", "green", "cyan", "blue", "magenta"].map(function(role) {
  return [role, "background", TEXT]
})

function omarchyId(name, mode) {
  return (name === "polycarp" ? "polycarp" : "polycarp-" + name) + (mode === "light" ? "-light" : "")
}

function toOmarchy(theme, mode) {
  var r = theme[mode]
  var dark = mode === "dark"
  var ground = [r.background]
  // Further from the page in the direction the mode already goes.
  var deep = dark ? "#000000" : r.foreground
  var hue = function(h) { return fit(fromHsl(h, dark ? 0.42 : 0.5, dark ? 0.72 : 0.36), ground, TEXT, r.strong) }
  var c = {
    accent: r.accent,
    selection: r.selection,
    muted: r.muted,
    background: r.background,
    dark_background: r.sunken,
    darker_background: mix(r.sunken, deep, dark ? 0.3 : 0.08),
    lighter_background: r.surface,
    foreground: r.foreground,
    dark_foreground: mix(r.foreground, r.background, 0.45),
    light_foreground: fit(mix(r.foreground, r.muted, 0.6), ground, TEXT, r.strong),
    bright_foreground: r.strong,
    red: r.urgent,
    yellow: r.working,
    orange: fit(mix(r.urgent, r.working, 0.5), ground, TEXT, r.strong),
    green: r.done,
    cyan: hue(186),
    blue: hue(214),
    magenta: hue(304),
    brown: mix(mix(r.urgent, r.working, 0.6), r.background, 0.45)
  }
  var bright = ["red", "yellow", "green", "cyan", "blue", "magenta"]
  for (var i = 0; i < bright.length; i++) c["bright_" + bright[i]] = mix(c[bright[i]], r.strong, 0.18)
  for (var key in c) c[key] = c[key].toLowerCase()
  return { id: omarchyId(theme.name, mode), title: theme.title, mode: mode, colors: c, misses: misses(c, OMARCHY_PAIRS) }
}

var GROUPS = [
  ["accent", "selection", "muted"],
  ["background", "dark_background", "darker_background", "lighter_background"],
  ["foreground", "dark_foreground", "light_foreground", "bright_foreground"],
  ["red", "yellow", "orange", "green", "cyan", "blue", "magenta", "brown"],
  ["bright_red", "bright_yellow", "bright_green", "bright_cyan", "bright_blue", "bright_magenta"]
]

function colorsToml(look) {
  return "# " + look.title + ", a Polycarp theme. Polycarp wrote this file.\nmode = \"" + look.mode + "\"\n\n" +
    GROUPS.map(function(group) {
      return group.map(function(key) { return key + " = \"" + look.colors[key] + "\"" }).join("\n")
    }).join("\n\n") + "\n"
}

// A quiet picture in the theme's own colors, as the bytes of a BMP: the page, a little lighter high up, a breath of the
// accent in one corner. Omarchy scales it to the screen, so it is small.
function backgroundBytes(look) {
  var w = 96
  var h = 54
  var row = w * 3
  var out = []
  var put = function(n, bytes) { for (var i = 0; i < bytes; i++) out.push((n >> (8 * i)) & 255) }
  out.push(66, 77)
  put(54 + row * h, 4); put(0, 4); put(54, 4)
  put(40, 4); put(w, 4); put(h, 4); put(1, 2); put(24, 2); put(0, 4); put(row * h, 4); put(2835, 4); put(2835, 4); put(0, 4); put(0, 4)
  var page = rgb(look.colors.background)
  var low = rgb(look.colors.dark_background)
  var accent = rgb(look.colors.accent)
  for (var y = h - 1; y >= 0; y--) {
    for (var x = 0; x < w; x++) {
      var down = y / (h - 1)
      var dx = (x / (w - 1) - 0.82)
      var dy = (down - 0.16) * 0.7
      var glow = 0.16 * Math.exp(-(dx * dx + dy * dy) / 0.11)
      for (var k = 2; k >= 0; k--) {
        var v = page[k] + (low[k] - page[k]) * down
        out.push(Math.round((v + (accent[k] - v) * glow) * 255))
      }
    }
  }
  return out
}

function base64(bytes) {
  var abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  var out = ""
  for (var i = 0; i < bytes.length; i += 3) {
    var n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0)
    out += abc[n >> 18] + abc[(n >> 12) & 63] + (i + 1 < bytes.length ? abc[(n >> 6) & 63] : "=") + (i + 2 < bytes.length ? abc[n & 63] : "=")
  }
  return out
}
