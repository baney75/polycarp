import QtQuick
import qs.Commons

// A line of small words in a panel.
Text {
  property var page
  textFormat: Text.PlainText
  wrapMode: Text.WordWrap
  color: Geometry.words
  font.family: page ? page.family : Style.font.family
  font.pixelSize: Style.font.bodySmall
  lineHeight: 1.15
}
