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

  readonly property string source: {
    var entry = DesktopEntries.heuristicLookup(app)
    return Quickshell.iconPath(entry && entry.icon ? entry.icon : app, true)
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
    // org.example.Thing reads T.
    text: root.app.split(".").pop().charAt(0).toUpperCase()
    color: root.ink
    font.family: root.family
    font.pixelSize: Math.round(root.size * 0.8)
    font.weight: Font.DemiBold
  }
}
