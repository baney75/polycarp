import QtQuick
import Quickshell
import Quickshell.Widgets

// An app's icon from its window's app id, or its first letter where the icon theme has none.
Item {
  id: root
  property string app: ""
  property real size: 14
  property color ink
  property string family: ""

  // Reading the list first looks the app up again when apps are installed or removed.
  readonly property var entry: {
    DesktopEntries.applications.values
    return DesktopEntries.heuristicLookup(app)
  }
  readonly property string source: {
    var own = entry && entry.icon ? Quickshell.iconPath(entry.icon, true) : ""
    return own !== "" ? own : Quickshell.iconPath(app, true)
  }
  // With no icon, the first letter of the app's name. Without a name: org.example.Thing reads T, and a web app
  // (chrome-<host>__<path>-<profile>) reads the first letter of its host.
  readonly property string letter: {
    if (entry && entry.name) return entry.name.charAt(0).toUpperCase()
    var web = /^chrome-(.+?)__/.exec(app)
    var word = web ? web[1].replace(/^www\./, "").split(".")[0] : app.split(".").pop()
    return word.charAt(0).toUpperCase()
  }

  implicitWidth: size
  implicitHeight: size

  IconImage {
    anchors.fill: parent
    visible: root.source !== ""
    source: root.source
    asynchronous: true
  }

  Text {
    anchors.centerIn: parent
    visible: root.source === ""
    textFormat: Text.PlainText
    text: root.letter
    color: root.ink
    font.family: root.family
    font.pixelSize: Math.round(root.size * 0.8)
    font.weight: Font.DemiBold
  }
}
