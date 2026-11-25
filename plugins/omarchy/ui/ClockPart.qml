import QtQuick
import Quickshell
import qs.Commons
import "../lib/Calendar.js" as Calendar

// The clock in two tones: the time in full, the day and the AM or PM a step quieter. It opens the calendar.
Slot {
  id: root

  readonly property string family: host.bar ? host.bar.fontFamily : Style.font.family
  readonly property var locale: Qt.locale()
  readonly property var time: Calendar.time(clock.hours, clock.minutes, Calendar.twelveHour(host.setting("clock", "auto"), locale.timeFormat(Locale.ShortFormat)))
  readonly property string day: host.setting("day", true) ? locale.toString(clock.date, "ddd MMM d") : ""
  readonly property color quiet: Geometry.quiet(ink, Color.bar.background, 0.72, 4.5)

  inset: Style.space(7)
  held: host.part === "clock"
  name: locale.toString(clock.date, Locale.ShortFormat)
  tip: ""
  onPressed: function(button) { if (button === Qt.LeftButton) host.togglePart("clock", root) }

  SystemClock {
    id: clock
    precision: SystemClock.Minutes
  }

  // Only the one for the bar's direction exists: a hidden one would still count in the slot's size and push this off
  // its place.
  Loader {
    sourceComponent: root.vertical ? stacked : inline
  }

  Component {
    id: inline

    Row {
      spacing: Style.space(6)

      Text {
        visible: root.day !== ""
        anchors.baseline: digits.baseline
        textFormat: Text.PlainText
        text: root.day
        color: root.quiet
        font.family: root.family
        font.pixelSize: Style.font.body
        font.features: ({ "tnum": 1 })
      }

      Text {
        id: digits
        textFormat: Text.PlainText
        text: root.time.hour + ":" + root.time.minute
        color: root.ink
        font.family: root.family
        font.pixelSize: Style.font.body
        font.weight: Font.Medium
        font.features: ({ "tnum": 1 })
      }

      Text {
        visible: root.time.half !== ""
        anchors.baseline: digits.baseline
        leftPadding: -Style.space(2)
        textFormat: Text.PlainText
        text: root.time.half
        color: root.quiet
        font.family: root.family
        font.pixelSize: Style.font.body
      }
    }

  }

  Component {
    id: stacked

    Column {
      topPadding: Style.space(4)
      bottomPadding: Style.space(4)

      Repeater {
        model: [root.time.hour, root.time.minute, root.time.half]

        Text {
          required property string modelData
          required property int index
          visible: modelData !== ""
          anchors.horizontalCenter: parent.horizontalCenter
          textFormat: Text.PlainText
          text: modelData
          color: index === 2 ? root.quiet : root.ink
          font.family: root.family
          font.pixelSize: index === 2 ? Style.font.caption : Style.font.body
          font.weight: index === 2 ? Font.Normal : Font.Medium
          font.features: ({ "tnum": 1 })
        }
      }
    }
  }
}
