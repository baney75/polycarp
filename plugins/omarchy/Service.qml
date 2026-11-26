import QtQuick
import Quickshell
import Quickshell.Hyprland
import Quickshell.Io
import qs.Commons
import "lib/Agents.js" as Agents
import "lib/Strings.js" as Strings
import "lib/Workspaces.js" as Workspaces
import "ui"

// What every Polycarp widget shares, once per shell: the words, whether motion is reduced, and the compositor facts that
// one widget per monitor should not each fetch. Nothing runs on a timer while the desktop is at rest.
Item {
  id: root

  property var shell: null
  property var manifest: null
  property string omarchyPath: ""

  readonly property string pluginId: "baney75.polycarp"
  readonly property var strings: Strings.table(Qt.locale().name)

  // Omarchy 4.0.4 has no reduced-motion token, so read Hyprland's own setting there. A newer shell's wins.
  property bool animationsOff: false
  readonly property bool still: "reduceMotion" in Style ? Style["reduceMotion"] === true : animationsOff

  function ms(duration) {
    return still ? 0 : duration
  }

  // Layouts live in the workspaces' IPC objects, which Quickshell only refreshes when asked.
  function refreshWorkspaces() {
    settle.restart()
  }

  // A layout change says nothing on the event socket; look again once the command has had time to run.
  function refreshSoon() {
    later.restart()
  }

  // How many marks are on the bars: the panel opens from one of them, if there is one.
  property int marks: 0

  readonly property Looks looks: Looks { strings: root.strings }
  readonly property Apps apps: Apps {}

  // The agents that are open, the ones that want you first, and how many of each.
  property var agents: []
  readonly property var agentCounts: Agents.counts(agents)
  // The windows that want you, by address.
  property var attention: ({})
  function wants(address) {
    return attention[address] === true
  }

  property var scan: Agents.parse("")
  property var terminals: ({})
  property var titles: ({})
  property var known: ({})

  function lookForAgents() {
    look.restart()
  }

  function focusAgent(agent) {
    if (agent.pane) Quickshell.execDetached(["tmux", "select-window", "-t", agent.pane, ";", "select-pane", "-t", agent.pane])
    if (agent.herdr) Quickshell.execDetached(["herdr", "agent", "focus", agent.herdr])
    if (agent.address) Quickshell.execDetached(["hyprctl", "dispatch", Workspaces.windowCommand(agent.address)])
  }

  function workspaceOf(address) {
    var tops = Hyprland.toplevels.values
    for (var i = 0; i < tops.length; i++) if (tops[i].address === address) return tops[i].workspace ? tops[i].workspace.name : ""
    return ""
  }

  function pidOf(address) {
    var tops = Hyprland.toplevels.values
    for (var i = 0; i < tops.length; i++) if (tops[i].address === address) return tops[i].lastIpcObject ? tops[i].lastIpcObject.pid || 0 : 0
    return 0
  }

  // A title moves on every frame of a spinner. Only a new state or new words are worth a look.
  function titleChanged(address, title) {
    var old = titles[address] || ""
    titles[address] = title
    if (Agents.titleState(old) === Agents.titleState(title) && Agents.plainTitle(old) === Agents.plainTitle(title)) return
    if (!terminals[pidOf(address)]) return
    count.restart()
    lookForAgents()
  }

  function countAgents() {
    var windows = []
    var urgent = {}
    var tops = Hyprland.toplevels.values
    var now = {}
    for (var i = 0; i < tops.length; i++) {
      var t = tops[i]
      now[t.address] = titles[t.address] !== undefined ? titles[t.address] : t.title
      urgent[t.address] = t.urgent
      windows.push({ address: t.address, pid: t.lastIpcObject ? t.lastIpcObject.pid || 0 : 0, app: t.wayland ? t.wayland.appId : "", title: now[t.address] })
    }
    titles = now
    var active = Hyprland.activeToplevel ? Hyprland.activeToplevel.address : ""
    var rows = Agents.find(scan, windows)
    var next = {}
    var wanted = {}
    var list = rows.map(function(row, at) {
      var seen = Agents.read(row, now, Quickshell.env("HOME"))
      var was = root.known[row.id] || null
      next[row.id] = Agents.next(was, { raw: seen.raw, focused: row.address !== "" && row.address === active, urgent: urgent[row.address] === true })
      if (next[row.id].wants) wanted[row.address] = true
      return {
        id: row.id, at: at, agent: row.agent, heading: seen.heading, detail: seen.detail, address: row.address, pane: row.pane, herdr: row.herdr,
        kind: Agents.kind(next[row.id])
      }
    })
    known = next
    attention = wanted
    list = Agents.sorted(list)
    if (JSON.stringify(list) !== JSON.stringify(agents)) agents = list
  }

  Process {
    id: scanner
    // A look asked for while a scan runs is kept, and made once the scan is over.
    property bool again: false
    onRunningChanged: if (!running && again) { again = false; look.restart() }
    command: ["bash", decodeURIComponent(String(Qt.resolvedUrl("scripts/agents-scan")).replace("file://", ""))]
    stdout: StdioCollector {
      onStreamFinished: {
        root.scan = Agents.parse(text)
        root.terminals = Agents.terminals(root.scan)
        root.countAgents()
      }
    }
  }

  // Long enough for a new window to have a pid and a new agent to have a process, and for a burst to cost one look.
  Timer {
    id: look
    interval: 1200
    onTriggered: {
      if (scanner.running) { scanner.again = true; return }
      Hyprland.refreshToplevels()
      scanner.running = true
    }
  }

  Timer {
    id: count
    interval: 40
    onTriggered: root.countAgents()
  }

  // One shot after a burst of events, so ten windows closing cost one request.
  Timer {
    id: settle
    interval: 60
    onTriggered: Hyprland.refreshWorkspaces()
  }

  Timer {
    id: later
    interval: 400
    onTriggered: Hyprland.refreshWorkspaces()
  }

  Connections {
    target: Hyprland
    function onRawEvent(event) {
      switch (event.name) {
      case "configreloaded":
        motion.running = true
        root.refreshWorkspaces()
        break
      case "windowtitlev2":
        var comma = event.data.indexOf(",")
        root.titleChanged(event.data.slice(0, comma), event.data.slice(comma + 1))
        break
      case "activewindowv2":
        count.restart()
        if (root.terminals[root.pidOf(event.data)]) root.lookForAgents()
        break
      case "urgent":
        count.restart()
        break
      case "openwindow":
      case "closewindow":
        root.lookForAgents()
        root.refreshWorkspaces()
        break
      case "workspacev2":
      case "movewindowv2":
        root.refreshWorkspaces()
        break
      }
    }
  }

  Process {
    id: motion
    command: ["hyprctl", "getoption", "animations:enabled", "-j"]
    stdout: StdioCollector {
      onStreamFinished: {
        try {
          // Hyprland 0.56 prints a bool; a Hyprland whose options are all numbers prints an int.
          var o = JSON.parse(text)
          root.animationsOff = o.bool === false || o.int === 0
        } catch (e) {
        }
      }
    }
  }

  Component.onCompleted: {
    motion.running = true
    refreshWorkspaces()
    lookForAgents()
  }

  IpcHandler {
    target: root.pluginId

    function open(): void { if (root.shell) root.shell.summon(root.pluginId, "{}") }
    function close(): void { if (root.shell) root.shell.hide(root.pluginId) }
    function toggle(): void { if (root.shell) root.shell.toggle(root.pluginId, "{}") }
  }
}
