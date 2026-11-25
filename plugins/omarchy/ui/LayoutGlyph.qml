import QtQuick
import qs.Commons

// The workspace's layout, drawn: two panes side by side, a row that runs on past the edge, or one pane.
Item {
  id: root
  property string kind: ""
  property color ink

  readonly property int line: Math.max(1, Style.space(1))
  implicitWidth: Style.space(13)
  implicitHeight: Style.space(10)

  Repeater {
    model: root.kind === "scrolling" ? [0, 0.4, 0.8] : root.kind === "single" ? [0] : [0, 0.54]

    Rectangle {
      required property real modelData
      required property int index
      readonly property real share: root.kind === "scrolling" ? (index === 2 ? 0.2 : 0.32) : root.kind === "single" ? 1 : 0.46
      x: Math.round(root.width * modelData)
      width: Math.round(root.width * share)
      height: root.height
      radius: Math.min(Geometry.radius, Style.space(2))
      color: index === 0 && root.kind !== "single" ? root.ink : "transparent"
      border.width: root.line
      border.color: root.ink
    }
  }
}
