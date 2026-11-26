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

  // As in Looks.qml: a read is over when the script has exited and its output has ended.
  function read() {
    if (reader.code < 0 || !reader.ended) return
    var ok = reader.code === 0
    reader.code = -1
    reader.ended = false
    if (ok) rows = Model.parse(out.text)
    if (again) {
      again = false
      Qt.callLater(look)
      return
    }
    if (writer.done) {
      writer.done = false
      busy = ""
    }
  }

  Process {
    id: reader
    property int code: -1
    property bool ended: false
    command: ["bash", root.script, "list"]
    stdout: StdioCollector {
      id: out
      onStreamFinished: {
        reader.ended = true
        root.read()
      }
    }
    onExited: function(exitCode) {
      code = exitCode
      root.read()
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
