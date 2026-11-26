.pragma library

// Which coding agents are open, which are working and which want you, from plain data: one scan of processes (with tmux
// and herdr, where they run) and the titles of the windows. No Quickshell in here: the tests run it in node.

// The commands that are a coding agent, and what to call each one.
var NAMES = {
  claude: "Claude Code", codex: "Codex", gemini: "Gemini", grok: "Grok", opencode: "OpenCode", pi: "Pi", omp: "Oh My Pi",
  hermes: "Hermes", copilot: "GitHub Copilot", crush: "Crush", "cursor-agent": "Cursor CLI", muse: "Muse Code",
  openclaw: "OpenClaw", qwen: "Qwen Code", kimi: "Kimi", amp: "Amp", droid: "Droid", aider: "Aider", goose: "Goose",
  devin: "Devin", kilo: "Kilo", agy: "Antigravity"
}
var RUNTIMES = /^(node|bun|deno|python3?(\.\d+)?|uv|uvx|npx|bunx)$/
// Runs with nobody at the keyboard: one question in a script, or a server or other errand instead of a session.
var HEADLESS_FLAGS = /^(-p|--print|--prompt|--version|--help)$/
var HEADLESS_COMMANDS = /^(exec|e|run|mcp|mcp-server|app-server|serve|server|acp|update|login|logout)$/

function name(agent) {
  return NAMES[agent] || agent
}

function base(path) {
  return String(path).split("/").pop()
}

// The agent a command line runs, or "". Only with a terminal: an agent somebody is at has one.
function agentOf(args, tty) {
  if (!tty || tty === "?") return ""
  var words = String(args).trim().split(/\s+/)
  var at = 0
  var runs = base(words[0])
  if (RUNTIMES.test(runs)) {
    at = 1
    while (at < words.length && words[at].charAt(0) === "-") at++
    if (runs === "uv" && words[at] === "run") for (at++; at < words.length && words[at].charAt(0) === "-"; at++) {}
    runs = scriptName(words[at] || "")
  }
  if (!NAMES.hasOwnProperty(runs)) return ""
  return headless(words.slice(at + 1)) ? "" : runs
}

// The options, and the first word that is not one: what was asked comes after it and may hold any of these words.
// A word after a long option is taken as its value, unless it is a command such as exec.
function headless(words) {
  for (var i = 0; i < words.length; i++) {
    var word = words[i]
    if (HEADLESS_FLAGS.test(word) || HEADLESS_COMMANDS.test(word)) return true
    if (word.charAt(0) === "-") continue
    if (i > 0 && /^--[^=]+$/.test(words[i - 1])) continue
    return false
  }
  return false
}

// .../@openai/codex/bin/codex.js is codex, .../@anthropic-ai/claude-code/cli.js is claude.
function scriptName(path) {
  var file = base(path).replace(/\.(m?js|cjs|ts|py)$/, "")
  if (NAMES.hasOwnProperty(file)) return file
  if (/claude-code\//.test(path)) return "claude"
  if (/gemini-cli\//.test(path)) return "gemini"
  // Otherwise the installed package the script is in: only the name right after the last node_modules or
  // site-packages, never a folder of somebody's own above it, and never .bin, which holds every package's commands.
  var m = String(path).match(/.*\/(?:node_modules|site-packages)\/((?:@[^\/]+\/)?[^\/]+)\//)
  var pkg = m ? base(m[1]) : ""
  return NAMES.hasOwnProperty(pkg) ? pkg : ""
}

// The scan script's output: sections that start with a line of "#name".
function parse(text) {
  var out = { processes: [], cwds: {}, panes: [], clients: [], herdr: [] }
  var section = ""
  var rest = ""
  var lines = String(text || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    if (/^#(ps|cwd|panes|clients|herdr)$/.test(line)) { section = line.slice(1); continue }
    if (line === "") continue
    var m
    if (section === "ps") {
      m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)
      if (m) out.processes.push({ pid: Number(m[1]), ppid: Number(m[2]), tty: m[3], args: m[4] })
    } else if (section === "cwd") {
      m = line.match(/^(\d+)\t(.*)$/)
      if (m) out.cwds[m[1]] = m[2]
    } else if (section === "panes") {
      m = line.split("\t")
      if (m.length >= 4) out.panes.push({ pid: Number(m[0]), pane: m[1], session: m[2], title: m.slice(3).join(" ") })
    } else if (section === "clients") {
      m = line.split("\t")
      if (m.length >= 2) out.clients.push({ pid: Number(m[0]), session: m[1] })
    } else if (section === "herdr") rest += line + "\n"
  }
  if (rest) {
    try {
      var answer = JSON.parse(rest)
      var list = answer.result && answer.result.agents ? answer.result.agents : answer.agents
      if (list instanceof Array) out.herdr = list.filter(function(h) { return h !== null && typeof h === "object" })
    } catch (e) {
      out.herdr = []
    }
  }
  return out
}

// What an agent's title says it is doing: "working", "blocked", "ready", or "" when it says nothing.
function titleState(title) {
  var t = String(title || "")
  if (/^\s*(✋|⚠|\[ ?!|Action Required)/i.test(t)) return "blocked"
  // A braille spinner, or one of the marks Gemini and Claude Code spin through.
  if (/^\s*[\u2800-\u28ff◐◓◑◒]/.test(t) || /^\s*✦\s/.test(t)) return "working"
  if (/^\s*(✳|◇)\s/.test(t)) return "ready"
  return ""
}

// A title without its mark: what the agent is on.
function plainTitle(title) {
  return String(title || "").replace(/^\s*[\u2800-\u28ff◐◓◑◒✋⚠✦✳◇✻✽✶✢·]+\s*/, "").trim()
}

// A title no plain shell has: an agent on another computer, over ssh, has no process here to find.
function titleAgent(title) {
  var t = String(title || "")
  if (/^\s*✳\s/.test(t)) return "claude"
  if (/^\s*(◇|✦|✋)\s.*(Ready|Working|Action Required)/i.test(t)) return "gemini"
  return ""
}

// Every agent found, each with the window it is in. windows: [{ address, pid, app, title }]
function find(scan, windows) {
  var byPid = {}
  var i
  for (i = 0; i < scan.processes.length; i++) byPid[scan.processes[i].pid] = scan.processes[i]
  var paneOf = {}
  for (i = 0; i < scan.panes.length; i++) paneOf[scan.panes[i].pid] = scan.panes[i]

  var rows = []
  for (i = 0; i < scan.processes.length; i++) {
    var p = scan.processes[i]
    var agent = agentOf(p.args, p.tty)
    if (!agent || underAgent(p, byPid)) continue
    // herdr lists its own agents below, with their state.
    if (scan.herdr.length > 0 && under(p, byPid, /^herdr$/)) continue
    var pane = null
    var pids = []
    for (var q = p, n = 0; q && n < 40; q = byPid[q.ppid], n++) {
      if (!pane && paneOf[q.pid]) pane = paneOf[q.pid]
      pids.push(q.pid)
    }
    // In tmux the pane hangs off the server, so the window is the one its client is in.
    if (pane) {
      pids = []
      for (var c = 0; c < scan.clients.length; c++) {
        if (scan.clients[c].session !== pane.session) continue
        for (q = byPid[scan.clients[c].pid], n = 0; q && n < 40; q = byPid[q.ppid], n++) pids.push(q.pid)
      }
    }
    rows.push({
      id: "p" + p.pid, agent: agent, cwd: scan.cwds[p.pid] || "", pane: pane ? pane.pane : "", herdr: "", titled: false,
      // As fresh as the last scan: with tmux's set-titles off, a pane's new title raises no window event.
      paneTitle: pane ? pane.title : "", pids: pids, address: "", raw: ""
    })
  }
  place(rows, windows)

  for (i = 0; i < scan.herdr.length; i++) {
    var h = scan.herdr[i]
    rows.push({
      id: "h" + h.pane_id, agent: String(h.agent || h.display_agent || "agent"), cwd: h.foreground_cwd || h.cwd || "", pane: "", herdr: h.pane_id, titled: false,
      paneTitle: h.title || h.name || h.terminal_title_stripped || "", pids: [], address: herdrWindow(windows),
      raw: h.agent_status === "working" ? "working" : h.agent_status === "blocked" ? "blocked" : h.agent_status === "done" || h.agent_status === "idle" ? "ready" : ""
    })
  }

  var taken = {}
  for (i = 0; i < rows.length; i++) taken[rows[i].address] = true
  for (i = 0; i < windows.length; i++) {
    var w = windows[i]
    var far = taken[w.address] ? "" : titleAgent(w.title)
    if (far) rows.push({ id: "w" + w.address, agent: far, cwd: "", pane: "", herdr: "", titled: true, paneTitle: "", pids: [], address: w.address, raw: "" })
  }
  return rows
}

// Started by another agent (a subagent, a reviewer): its own agent speaks for it.
function underAgent(p, byPid) {
  for (var q = byPid[p.ppid], n = 0; q && n < 40; q = byPid[q.ppid], n++) if (agentOf(q.args, q.tty)) return true
  return false
}

// Has an ancestor whose command is the program named.
function under(p, byPid, program) {
  for (var q = byPid[p.ppid], n = 0; q && n < 40; q = byPid[q.ppid], n++) if (program.test(base(String(q.args).split(/\s+/)[0]))) return true
  return false
}

// The folder's name as a whole word of the title: "app" is not in "Mapping", and "u" is not in "u@box".
function names(title, cwd) {
  var folder = base(cwd)
  if (!folder) return false
  var at = title.indexOf(folder)
  for (; at >= 0; at = title.indexOf(folder, at + 1)) {
    var before = at === 0 ? " " : title.charAt(at - 1)
    var after = title.charAt(at + folder.length) || " "
    if (/[\s\/:~]/.test(before) && /[\s\/]/.test(after)) return true
  }
  return false
}

function herdrWindow(windows) {
  for (var i = 0; i < windows.length; i++) if (/herdr/i.test(windows[i].app)) return windows[i].address
  return ""
}

// The window for each row. One terminal process can hold many windows, so the ones with a mark in the title or the
// folder's name go first, and a window with nothing else to say for it holds at most one agent.
function place(rows, windows) {
  var pairs = []
  for (var i = 0; i < rows.length; i++) {
    for (var j = 0; j < windows.length; j++) {
      var up = rows[i].pids.indexOf(windows[j].pid)
      if (up < 0) continue
      var score = -up
      // A mark counts for the agent it belongs to: a remote Claude's window is not a local Codex's.
      var marked = titleAgent(windows[j].title)
      if (titleState(windows[j].title) && (marked === "" || marked === rows[i].agent)) score += 200
      if (names(windows[j].title, rows[i].cwd)) score += 100
      pairs.push({ row: rows[i], window: windows[j], score: score, at: pairs.length })
    }
  }
  pairs.sort(function(a, b) { return b.score - a.score || a.at - b.at })
  var used = {}
  for (i = 0; i < pairs.length; i++) {
    if (pairs[i].row.address || used[pairs[i].window.address]) continue
    pairs[i].row.address = pairs[i].window.address
    // A window's title is the title of one of its splits, so it speaks for one agent.
    pairs[i].row.titled = true
    used[pairs[i].window.address] = true
  }
  // Splits in one window: the rest share the nearest.
  for (i = 0; i < pairs.length; i++) if (!pairs[i].row.address) pairs[i].row.address = pairs[i].window.address
}

// One agent's next state. An agent that stops while you look elsewhere wants you until you look.
//   was: { raw, wants } or null
//   now: { raw, focused, urgent }
function next(was, now) {
  if (now.raw === "blocked") return { raw: now.raw, wants: true }
  if (now.focused) return { raw: now.raw, wants: false }
  var stopped = was && was.raw === "working" && now.raw !== "working"
  return { raw: now.raw, wants: now.raw !== "working" && (now.urgent || stopped || (was !== null && was.wants)) }
}

// The programs a terminal runs in: only their titles can change what an agent is doing.
function terminals(scan) {
  var byPid = {}
  var out = {}
  for (var i = 0; i < scan.processes.length; i++) byPid[scan.processes[i].pid] = scan.processes[i]
  for (i = 0; i < scan.processes.length; i++) {
    if (scan.processes[i].tty === "?") continue
    for (var q = byPid[scan.processes[i].ppid], n = 0; q && n < 40; q = byPid[q.ppid], n++) out[q.pid] = true
  }
  return out
}

// What there is to see about one agent, from its place and the titles now.
//   titles: { address: title }
function read(row, titles, home) {
  // A tmux pane speaks only for itself: the window's title may be another pane's.
  var title = row.pane ? row.paneTitle : row.paneTitle || (row.titled ? titles[row.address] || "" : "")
  var plain = plainTitle(title)
  var folder = shortPath(row.cwd, home)
  var quiet = plain === "" || plain === row.agent || plain === name(row.agent) || plain === folder || plain === row.cwd || /^([~\/…]|[\w.-]+@[\w.-]+:)/.test(plain)
  return {
    raw: row.raw || titleState(title),
    heading: quiet ? name(row.agent) : plain,
    detail: quiet ? folder : folder ? name(row.agent) + "  " + folder : name(row.agent)
  }
}

function kind(state) {
  return state.wants ? "needs" : state.raw === "working" ? "working" : "open"
}

function counts(rows) {
  var out = { needs: 0, working: 0, open: 0 }
  for (var i = 0; i < rows.length; i++) out[rows[i].kind]++
  return out
}

// Needing you first, then working, then the rest, each in the order found.
function sorted(rows) {
  var order = { needs: 0, working: 1, open: 2 }
  return rows.slice().sort(function(a, b) { return order[a.kind] - order[b.kind] || a.at - b.at })
}

// ~/code/app, with only the last two folders of a deep path.
function shortPath(cwd, home) {
  if (!cwd) return ""
  var path = home && (cwd === home || cwd.indexOf(home + "/") === 0) ? "~" + cwd.slice(home.length) : cwd
  var parts = path.split("/")
  return parts.length > 4 ? "…/" + parts.slice(-2).join("/") : path
}
