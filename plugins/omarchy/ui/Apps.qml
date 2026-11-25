import QtQuick
import Quickshell.Io
import "../lib/Apps.js" as Model

// The default apps, read when a panel asks and set through Omarchy's own commands.
Item {
  id: root

  property var rows: []
  property string busy: ""
  property bool failed: false
  // As in Looks.qml: a read asked for while one runs is followed by another, and only a read after a change ends it.
  property bool again: false

  readonly property string script: decodeURIComponent(String(Qt.resolvedUrl("../scripts/apps")).replace("file://", ""))

  function look() {
    if (reader.running) again = true
    else reader.running = true
  }

  function set(kind, id) {
    if (busy !== "") return
    busy = kind + " " + id
    failed = false
    writer.command = ["bash", script, "set", kind, id]
    writer.running = true
  }

  Process {
    id: reader
    command: ["bash", root.script, "list"]
    stdout: StdioCollector { id: out }
    onExited: function(exitCode) {
      if (exitCode === 0) root.rows = Model.parse(out.text)
      if (root.again) {
        root.again = false
        Qt.callLater(root.look)
        return
      }
      if (writer.done) {
        writer.done = false
        root.busy = ""
      }
    }
  }

  Process {
    id: writer
    property bool done: false
    onExited: function(exitCode) {
      root.failed = exitCode !== 0
      done = true
      root.look()
    }
  }
}
