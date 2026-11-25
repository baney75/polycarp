import QtQuick
import QtQuick.Shapes

// Points right; turn it with `rotation`.
Item {
  id: root
  property real size: 9
  property color ink

  implicitWidth: size
  implicitHeight: size

  Shape {
    anchors.fill: parent
    preferredRendererType: Shape.CurveRenderer
    ShapePath {
      strokeColor: root.ink
      strokeWidth: Math.max(1.5, root.size / 6)
      fillColor: "transparent"
      capStyle: ShapePath.RoundCap
      joinStyle: ShapePath.RoundJoin
      startX: root.size * 0.34
      startY: root.size * 0.12
      PathLine { x: root.size * 0.72; y: root.size * 0.5 }
      PathLine { x: root.size * 0.34; y: root.size * 0.88 }
    }
  }
}
