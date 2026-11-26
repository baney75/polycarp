import QtQuick
import QtQuick.Shapes

// A ring of dots: work under way. It does not turn, so a working agent costs the bar nothing.
Shape {
  id: root
  property real size: 11
  property color ink

  implicitWidth: size
  implicitHeight: size
  preferredRendererType: Shape.CurveRenderer

  ShapePath {
    strokeColor: root.ink
    strokeWidth: Math.max(1.4, root.size / 7)
    fillColor: "transparent"
    capStyle: ShapePath.RoundCap
    strokeStyle: ShapePath.DashLine
    // Eight dots, whatever the size.
    dashPattern: [0.01, Math.PI * (root.size - strokeWidth) / 8 / strokeWidth - 0.01]
    PathAngleArc {
      centerX: root.size / 2
      centerY: root.size / 2
      radiusX: (root.size - Math.max(1.4, root.size / 7)) / 2
      radiusY: radiusX
      startAngle: -90
      sweepAngle: 360
    }
  }
}
