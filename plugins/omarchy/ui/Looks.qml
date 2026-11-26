import QtQuick
import Quickshell.Io
import "../lib/Builtin.js" as Builtin
import "../lib/Looks.js" as Model
import "../lib/Strings.js" as Strings

// The looks on disk and the one thing at a time that changes them. It lives in the service, so a look that is being set
// does not stop when its panel closes. Nothing is read until a panel asks.
Item {
  id: root

  required property var strings

  property var list: Model.parseList("")
  readonly property var looks: Model.offer(Builtin.themes, list.user, list.taken)
  // The Omarchy theme in use as a Polycarp theme, unless it came from Polycarp.
  readonly property var here: list.theme === "" || list.theme.indexOf("polycarp") === 0 ? null : Model.fromOmarchy(list.theme, list.colors, list.font)
  readonly property bool saved: here !== null && list.user[here.id] !== undefined
  property string busy: ""
  // What the last action came to.
  property string said: ""
  // A read asked for while one runs: that one may have started before a change finished, so another follows it.
  property bool again: false

  readonly property string script: decodeURIComponent(String(Qt.resolvedUrl("../scripts/looks")).replace("file://", ""))

  function look() {
    if (reader.running) again = true
    else reader.running = true
  }

  function apply(look) {
    run("apply", look.id, Model.base64(Model.backgroundBytes(look)) + "\n" + Model.colorsToml(look))
  }

  function undo() {
    if (list.undo) run("undo", "", "")
    else said = strings.undoFailed
  }

  function save() {
    if (here) run("import", here.id, Model.themeToml(here))
  }

  function forget() {
    if (saved) run("forget", here.id, "")
  }

  function run(what, id, text) {
    if (busy !== "") return
    busy = what + " " + id
    said = ""
    writer.what = what
    writer.target = id
    writer.payload = text
    writer.command = ["bash", script, what, id]
    writer.stdinEnabled = true
    writer.running = true
  }

  function say(what, id, code) {
    var s = strings
    if (what === "apply") return code === 0 ? "" : code === 3 ? s.looksLeft : s.looksFailed
    if (what === "undo") return code === 0 ? Strings.fill(s.undone, Model.titled(list.theme)) : s.undoFailed
    if (what === "import") return code === 0 ? Strings.fill(s.saved, id) : code === 3 ? s.saveLeft : s.saveFailed
    return code === 0 ? s.removed : s.saveLeft
  }

  Process {
    id: reader
    command: ["bash", root.script, "list"]
    stdout: StdioCollector { id: out }
    onExited: function(exitCode) {
      // A list that could not be read keeps the last one, rather than showing no looks.
      if (exitCode === 0) root.list = Model.parseList(out.text)
      if (root.again) {
        root.again = false
        Qt.callLater(root.look)
        return
      }
      if (writer.done) {
        root.said = root.say(writer.what, writer.target, writer.code)
        writer.done = false
        root.busy = ""
      }
    }
  }

  Process {
    id: writer
    property string what: ""
    property string target: ""
    property string payload: ""
    property int code: 0
    property bool done: false
    onStarted: {
      write(payload)
      stdinEnabled = false
    }
    onExited: function(exitCode) {
      code = exitCode
      done = true
      root.look()
    }
  }
}
