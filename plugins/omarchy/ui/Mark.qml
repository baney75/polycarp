import QtQuick
import QtQuick.Shapes

// The olive branch, as brand/browser/icon-16.svg draws it, in one color.
Item {
  id: root
  property real size: 16
  property color ink
  readonly property real unit: size / 64

  implicitWidth: size
  implicitHeight: size

  Shape {
    width: 64
    height: 64
    preferredRendererType: Shape.CurveRenderer
    transform: Scale { xScale: root.unit; yScale: root.unit }

    ShapePath {
      strokeColor: root.ink
      strokeWidth: 6.2
      fillColor: "transparent"
      capStyle: ShapePath.RoundCap
      PathSvg { path: "M6 60C19 50 33 37 42 23" }
    }
    ShapePath {
      strokeColor: "transparent"
      strokeWidth: 0
      fillColor: root.ink
      PathSvg { path: "M42.0 23.0C52.4 21.9 55.8 12.1 54.2 3.5C45.8 5.8 38.5 13.2 42.0 23.0Z M35.0 31.5C40.6 23.5 36.2 14.1 29.4 9.2C25.8 16.7 26.3 27.0 35.0 31.5Z M39.0 27.0C45.8 33.1 54.7 29.9 59.8 24.1C53.3 19.9 43.8 19.2 39.0 27.0Z" }
    }
    ShapePath {
      strokeColor: "transparent"
      strokeWidth: 0
      fillColor: root.ink
      PathAngleArc { centerX: 38; centerY: 49; radiusX: 10; radiusY: 11; startAngle: 0; sweepAngle: 360 }
    }
  }
}
