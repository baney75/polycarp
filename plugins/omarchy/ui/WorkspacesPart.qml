import QtQuick
import Quickshell
import Quickshell.Hyprland
import qs.Commons
import "../lib/Workspaces.js" as Model
import "../lib/Strings.js" as Strings

// The monitor's workspaces: a number and the apps on it, with one marker that slides to the one you're on. Click a mark
// to go there, turn the wheel over them for the one before or after. All of it comes from Hyprland's events.
Item {
  id: root

  required property var host

  readonly property var service: host.service
  readonly property var strings: service.strings
  readonly property color ink: host.bar ? host.bar.barForeground : Color.foreground
  readonly property color urgent: host.bar ? host.bar.urgent : Color.urgent
  readonly property string family: host.bar ? host.bar.fontFamily : Style.font.family
  readonly property bool vertical: host.vertical
  readonly property int iconMax: host.setting("icons", true) ? Math.max(1, Number(host.setting("maxIcons", 3)) || 3) : 0

  readonly property var monitor: host.QsWindow.window ? Hyprland.monitorFor(host.QsWindow.window.screen) : null
  readonly property string monitorName: monitor ? monitor.name : ""
  readonly property int activeId: monitor && monitor.activeWorkspace ? monitor.activeWorkspace.id : 1

  // Titles stay out of this: an agent's spinner changes its window's title ten times a second, and the bar must not
  // rebuild for that. The tooltip reads them when it is asked for.
  readonly property var all: {
    var out = []
    var values = Hyprland.workspaces.values
    for (var i = 0; i < values.length; i++) {
      var w = values[i]
      var windows = []
      var tops = w.toplevels.values
      var wants = w.urgent
      for (var j = 0; j < tops.length; j++) {
        windows.push({ app: tops[j].wayland ? tops[j].wayland.appId : "", title: "" })
        if (tops[j].urgent || service.wants(tops[j].address)) wants = true
      }
      out.push({
        id: w.id, name: w.name, monitor: w.monitor ? w.monitor.name : "", windows: windows, urgent: wants,
        layout: w.lastIpcObject && w.lastIpcObject.tiledLayout ? w.lastIpcObject.tiledLayout : ""
      })
    }
    return out
  }
  readonly property int first: Model.blockStart(all, monitorName, activeId)
  readonly property var shown: Model.shown(all, monitorName, activeId, Number(host.setting("empty", 0)) || 0)
  readonly property var byId: {
    var map = {}
    for (var i = 0; i < shown.length; i++) map[shown[i].id] = shown[i]
    return map
  }
  readonly property string layout: byId[activeId] && host.setting("layout", true) ? Model.layoutKind(byId[activeId].layout) : ""

  property Item current: null
  property real rest: 0

  function go(workspace) {
    if (host.bar && workspace) host.bar.run("hyprctl dispatch " + Util.shellQuote(Model.focusCommand(workspace)))
  }

  function turn(delta) {
    // Away from you, or left, is the one before.
    var w = Model.wheel(rest, -delta)
    rest = w.rest
    if (w.steps !== 0) go(Model.step(shown, activeId, w.steps))
  }

  function tip(id) {
    var w = byId[id]
    if (!w) return ""
    var windows = []
    var values = Hyprland.workspaces.values
    for (var i = 0; i < values.length; i++) {
      if (values[i].id !== id) continue
      for (var j = 0; j < values[i].toplevels.values.length; j++) windows.push({ title: values[i].toplevels.values[j].title })
    }
    return Model.describe({ id: id, name: w.name, windows: windows, urgent: w.urgent }, strings)
  }

  implicitWidth: vertical ? host.barSize : flow.width
  implicitHeight: vertical ? flow.height : host.barSize

  Rectangle {
    id: pill
    readonly property real across: Geometry.face(root.host.barSize)
    visible: root.current !== null
    x: root.vertical ? (root.width - across) / 2 : flow.x + (root.current ? root.current.x : 0)
    y: root.vertical ? flow.y + (root.current ? root.current.y : 0) : (root.height - across) / 2
    width: root.vertical ? across : root.current ? root.current.width : 0
    height: root.vertical ? (root.current ? root.current.height : 0) : across
    radius: Geometry.radius
    color: Util.alpha(Color.accent, 0.26)

    Behavior on x { enabled: !root.vertical && pill.ready; NumberAnimation { duration: root.host.ms(220); easing.type: Easing.OutQuint } }
    Behavior on y { enabled: root.vertical && pill.ready; NumberAnimation { duration: root.host.ms(220); easing.type: Easing.OutQuint } }
    Behavior on width { enabled: !root.vertical && pill.ready; NumberAnimation { duration: root.host.ms(220); easing.type: Easing.OutQuint } }
    Behavior on height { enabled: root.vertical && pill.ready; NumberAnimation { duration: root.host.ms(220); easing.type: Easing.OutQuint } }
    // Takes its first place without sliding in from the corner.
    property bool ready: false
    onVisibleChanged: if (visible) Qt.callLater(function() { pill.ready = true }); else pill.ready = false
  }

  Line {
    id: flow
    vertical: root.vertical
    spacing: Style.space(2)

    Repeater {
      model: ScriptModel {
        values: root.shown.map(function(w) { return w.id })
      }

      Slot {
        id: mark
        required property int modelData

        readonly property var workspace: root.byId[modelData] || null
        readonly property bool here: modelData === root.activeId
        readonly property var apps: workspace ? Model.icons(workspace.windows, root.iconMax) : { apps: [], more: 0 }
        readonly property bool bare: root.iconMax === 0 || apps.apps.length === 0
        readonly property color text: here || hovered ? root.ink : Geometry.quiet(root.ink, Color.bar.background, 0.66, 4.5)

        host: root.host
        slot: Geometry.number
        inset: bare ? 0 : Style.space(5)
        plain: here
        name: workspace ? Strings.fill(root.strings.workspace, workspace.name) : ""
        onHereChanged: if (here) root.current = mark
        Component.onCompleted: if (here) root.current = mark
        Component.onDestruction: if (root.current === mark) root.current = null
        onHoveredChanged: tip = hovered ? root.tip(modelData) : ""
        onPressed: function(button) { if (button === Qt.LeftButton) root.go(workspace) }
        onWheeled: function(delta) { root.turn(delta) }

        Line {
          vertical: root.vertical
          spacing: 0
          horizontalItemAlignment: Grid.AlignHCenter
          verticalItemAlignment: Grid.AlignVCenter

          Text {
            width: root.vertical ? implicitWidth : Math.max(implicitWidth, mark.bare ? 0 : Style.space(9))
            horizontalAlignment: Text.AlignHCenter
            textFormat: Text.PlainText
            text: mark.workspace ? Model.label(mark.workspace, root.host.setting("labels", "numbers"), root.first) : ""
            color: mark.text
            font.family: root.family
            font.pixelSize: Style.font.body
            font.weight: mark.here ? Font.DemiBold : Font.Normal
            font.features: ({ "tnum": 1 })
            Behavior on color { ColorAnimation { duration: root.host.ms(120) } }
          }

          Item {
            visible: !mark.bare
            width: root.vertical ? 1 : Style.space(3)
            height: root.vertical ? Style.space(3) : 1
          }

          Repeater {
            model: mark.bare ? [] : mark.apps.apps

            Item {
              required property string modelData
              width: Geometry.iconSlot
              height: Geometry.iconSlot
              AppIcon {
                anchors.centerIn: parent
                app: parent.modelData
                size: Geometry.icon
                ink: mark.text
                family: root.family
                opacity: mark.here || mark.hovered ? 1 : 0.78
                Behavior on opacity { NumberAnimation { duration: root.host.ms(120) } }
              }
            }
          }

          Text {
            visible: !mark.bare && mark.apps.more > 0
            leftPadding: root.vertical ? 0 : Style.space(2)
            textFormat: Text.PlainText
            text: Strings.fill(root.strings.moreApps, mark.apps.more)
            color: mark.text
            font.family: root.family
            font.pixelSize: Style.font.caption
          }
        }

        // Outside the press scale, so it stays put.
        Rectangle {
          parent: mark
          visible: mark.workspace !== null && mark.workspace.urgent
          anchors.top: parent.top
          anchors.right: parent.right
          anchors.topMargin: (root.vertical ? 0 : (parent.height - Geometry.face(root.host.barSize)) / 2) + Style.space(1)
          anchors.rightMargin: (root.vertical ? (parent.width - Geometry.face(root.host.barSize)) / 2 : 0) + Style.space(1)
          width: Geometry.dot
          height: Geometry.dot
          radius: width / 2
          color: root.urgent
        }
      }
    }

    Slot {
      visible: root.layout !== ""
      host: root.host
      slot: Geometry.number
      tip: root.layout === "scrolling" ? root.strings.layoutScrolling : root.layout === "single" ? root.strings.layoutSingle : root.strings.layoutTiled
      onPressed: function(button) {
        if (button !== Qt.LeftButton || !root.host.bar) return
        root.host.bar.run("omarchy-hyprland-workspace-layout-toggle")
        root.service.refreshSoon()
      }
      onWheeled: function(delta) { root.turn(delta) }

      LayoutGlyph {
        kind: root.layout
        ink: Geometry.quiet(root.ink, Color.bar.background, 0.66, 3)
      }
    }
  }
}
