import QtQuick
import Quickshell.Io
import "../lib/Apps.js" as Model

// The default apps, read when a panel asks and set through Omarchy's own commands.
Item {
  id: root

  property var rows: []
  property string busy: ""
  property bool failed: false

  readonly property string script: decodeURIComponent(String(Qt.resolvedUrl("../scripts/apps")).replace("file://", ""))

  function look() {
    reader.running = true
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
    onExited: {
      root.rows = Model.parse(out.text)
      root.busy = ""
    }
  }

  Process {
    id: writer
    onExited: function(exitCode) {
      root.failed = exitCode !== 0
      root.look()
    }
  }
}
