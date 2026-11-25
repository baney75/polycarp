import QtQuick
import qs.Commons

// Says what is true: there is nothing to sync with yet.
Item {
  id: root

  property var page
  implicitHeight: column.implicitHeight

  Column {
    id: column
    width: root.width
    spacing: Style.space(4)
    topPadding: Style.space(4)
    bottomPadding: Style.space(4)

    Text {
      leftPadding: Style.space(2)
      textFormat: Text.PlainText
      text: root.page ? root.page.strings.syncOff : ""
      color: Color.popups.text
      font.family: root.page ? root.page.family : Style.font.family
      font.pixelSize: Style.font.title
      font.weight: Font.DemiBold
    }

    Note {
      page: root.page
      width: parent.width
      leftPadding: Style.space(2)
      text: root.page ? root.page.strings.syncText : ""
    }
  }
}
