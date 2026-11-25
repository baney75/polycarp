import QtQuick
import Quickshell
import qs.Commons
import "../lib/Calendar.js" as Calendar
import "../lib/Workspaces.js" as Workspaces

// Today, and a month at a time. Left and right go a month, up and down a year, T back to today.
Item {
  id: root

  required property var host

  readonly property var strings: host.service ? host.service.strings : ({})
  readonly property color ink: Color.popups.text
  readonly property color quiet: Geometry.words
  readonly property color faint: Geometry.quiet(ink, Color.popups.background, 0.4, 3)
  readonly property string family: host.bar ? host.bar.fontFamily : Style.font.family
  readonly property var locale: Qt.locale()
  readonly property var today: ({ year: clock.date.getFullYear(), month: clock.date.getMonth(), day: clock.date.getDate() })
  property var shown: ({ year: clock.date.getFullYear(), month: clock.date.getMonth() })
  readonly property bool here: shown.year === today.year && shown.month === today.month
  readonly property int cell: Style.space(36)
  property real rest: 0

  function go(months) {
    shown = Calendar.step(shown.year, shown.month, months)
  }

  function back() {
    if (here) return false
    home()
    return true
  }

  function home() {
    shown = { year: today.year, month: today.month }
  }

  function move(dx, dy) {
    go(dx + dy * 12)
  }

  function activate() {
    home()
  }

  function key(text) {
    if (text === "t" || text === "T") home()
  }

  implicitWidth: cell * 7
  implicitHeight: list.implicitHeight

  SystemClock {
    id: clock
    precision: SystemClock.Hours
  }

  Column {
    id: list
    width: root.width
    spacing: Style.space(10)

    Column {
      leftPadding: Style.space(6)
      spacing: Style.space(1)

      Text {
        textFormat: Text.PlainText
        text: root.locale.toString(clock.date, "dddd")
        color: root.quiet
        font.family: root.family
        font.pixelSize: Style.font.body
      }

      Text {
        textFormat: Text.PlainText
        text: root.locale.toString(clock.date, "MMMM d")
        color: root.ink
        font.family: root.family
        font.pixelSize: Style.font.heading
        font.weight: Font.DemiBold
      }
    }

    Rectangle {
      width: parent.width
      height: 1
      color: Util.alpha(root.ink, 0.14)
    }

    Item {
      width: parent.width
      height: Math.max(title.implicitHeight, Style.space(26))

      Text {
        id: title
        x: Style.space(6)
        anchors.verticalCenter: parent.verticalCenter
        textFormat: Text.PlainText
        text: root.locale.toString(new Date(root.shown.year, root.shown.month, 1), "MMMM yyyy")
        color: root.ink
        font.family: root.family
        font.pixelSize: Style.font.body
        font.weight: Font.DemiBold
      }

      Row {
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter

        PageButton {
          visible: !root.here
          ink: root.ink
          family: root.family
          text: root.strings.today
          onClicked: root.home()
        }

        PageButton {
          ink: root.ink
          name: root.strings.monthBefore
          chevron: -1
          onClicked: root.go(-1)
        }

        PageButton {
          ink: root.ink
          name: root.strings.monthAfter
          chevron: 1
          onClicked: root.go(1)
        }
      }
    }

    Item {
      width: month.width
      height: month.height

      MouseArea {
        anchors.fill: parent
        acceptedButtons: Qt.NoButton
        onWheel: function(wheel) {
          var w = Workspaces.wheel(root.rest, -wheel.angleDelta.y)
          root.rest = w.rest
          if (w.steps !== 0) root.go(w.steps)
        }
      }

      Grid {
        id: month
        columns: 7

        Repeater {
          model: Calendar.weekdays(root.locale.firstDayOfWeek % 7)

          Text {
            required property int modelData
            width: root.cell
            height: Style.space(22)
            horizontalAlignment: Text.AlignHCenter
            verticalAlignment: Text.AlignVCenter
            textFormat: Text.PlainText
            text: root.locale.dayName(modelData, Locale.ShortFormat).slice(0, 2)
            color: root.quiet
            font.family: root.family
            font.pixelSize: Style.font.bodySmall
          }
        }

        Repeater {
          model: Calendar.days(root.shown.year, root.shown.month, root.locale.firstDayOfWeek % 7, root.today)

          Item {
            id: day
            required property var modelData
            width: root.cell
            height: Style.space(30)

            Rectangle {
              anchors.centerIn: parent
              visible: day.modelData.today
              width: Style.space(30)
              height: Style.space(28)
              radius: Geometry.radius
              color: Color.accent
            }

            Text {
              anchors.centerIn: parent
              textFormat: Text.PlainText
              text: day.modelData.day
              color: day.modelData.today ? Geometry.on(Color.accent)
                : !day.modelData.inMonth ? root.faint : day.modelData.weekend ? root.quiet : root.ink
              font.family: root.family
              font.pixelSize: Style.font.body
              font.weight: day.modelData.today ? Font.DemiBold : Font.Normal
              font.features: ({ "tnum": 1 })
              Accessible.name: root.locale.toString(new Date(day.modelData.year, day.modelData.month, day.modelData.day), Locale.LongFormat)
            }
          }
        }
      }
    }
  }
}
