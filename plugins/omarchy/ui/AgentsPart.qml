import QtQuick
import qs.Commons
import "../lib/Strings.js" as Strings

// How many coding agents want you and how many are working. Nothing at all while none are open.
Item {
  id: root

  required property var host

  readonly property var service: host.service
  readonly property var strings: service.strings
  readonly property var counts: service.agentCounts
  readonly property bool any: service.agents.length > 0
  readonly property string family: host.bar ? host.bar.fontFamily : Style.font.family
  readonly property string words: {
    var parts = []
    if (counts.needs > 0) parts.push(counts.needs === 1 ? strings.agentsNeedOne : Strings.fill(strings.agentsNeed, counts.needs))
    if (counts.working > 0) parts.push(Strings.fill(strings.agentsWorking, counts.working))
    if (counts.open > 0) parts.push(Strings.fill(strings.agentsQuiet, counts.open))
    return parts.join(", ")
  }

  // Stays while its page is open, so the popup keeps its place when the last agent closes.
  readonly property bool shown: any || slot.held
  visible: shown
  implicitWidth: shown ? slot.implicitWidth : 0
  implicitHeight: shown ? slot.implicitHeight : 0

  Slot {
    id: slot
    host: root.host
    slot: Style.bar.iconSlot
    inset: Style.space(6)
    held: root.host.part === "agents"
    tip: root.strings.agents + ": " + root.words
    onPressed: function(button) { if (button === Qt.LeftButton) root.host.togglePart("agents", slot) }

    Line {
      vertical: root.host.vertical
      spacing: root.host.vertical ? Style.space(4) : Style.space(5)
      horizontalItemAlignment: Grid.AlignHCenter
      verticalItemAlignment: Grid.AlignVCenter

      Rectangle {
        visible: root.counts.needs > 0
        width: Style.space(7)
        height: width
        radius: width / 2
        color: Color.accent
      }

      Text {
        visible: root.counts.needs > 0
        textFormat: Text.PlainText
        text: root.counts.needs
        color: slot.ink
        font.family: root.family
        font.pixelSize: Style.font.body
        font.weight: Font.DemiBold
        font.features: ({ "tnum": 1 })
      }

      Ring {
        visible: root.counts.working > 0 || root.counts.needs === 0
        size: Style.space(11)
        ink: Geometry.quiet(slot.ink, Color.bar.background, root.counts.working > 0 ? 0.72 : 0.5, 3)
      }

      Text {
        visible: root.counts.working > 0 || root.counts.needs === 0
        textFormat: Text.PlainText
        text: root.counts.working
        color: Geometry.quiet(slot.ink, Color.bar.background, 0.72, 4.5)
        font.family: root.family
        font.pixelSize: Style.font.body
        font.features: ({ "tnum": 1 })
      }
    }
  }
}
