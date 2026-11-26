import QtQuick
import qs.Commons
import qs.Ui
import "ui"

// One place on the bar. `show` picks what is in it: the mark, the workspaces and the agents together, or one part alone.
// Everything the parts share is in Service.qml.
BarWidget {
  id: root
  moduleName: "baney75.polycarp"

  readonly property var service: bar && bar.shell && typeof bar.shell.serviceFor === "function" ? bar.shell.serviceFor("baney75.polycarp") : null
  readonly property string show: String(setting("show", "all"))

  implicitWidth: parts.implicitWidth
  implicitHeight: parts.implicitHeight

  readonly property bool still: service ? service.still : false

  function ms(duration) {
    return service ? service.ms(duration) : 0
  }

  function has(part) {
    return show === part || (show === "all" && (part === "mark" || part === "workspaces" || part === "agents"))
  }

  // What is open under the bar: "", "panel", "agents", "clock" or "tray". The page outlives it while the surface fades.
  property string part: ""
  property string shownPart: ""
  property Item anchor: root
  // The tray app whose menu is open.
  property var trayItem: null
  onPartChanged: if (part !== "") shownPart = part; else if (popup.item && !popup.item.visible) shownPart = ""

  function togglePart(name, item) {
    if (part === name) {
      close()
      return
    }
    // The page under an open surface changes; the surface stays.
    anchor = item || root
    shownPart = name
    part = name
  }

  // The bar's own words for a panel: `omarchy-shell shell toggle baney75.polycarp` arrives here. With Polycarp on the bar
  // more than once it must arrive at the one with the mark, and the bar asks only those whose `opened` is defined.
  readonly property var opened: has("mark") || !service || service.marks === 0 ? part !== "" : undefined
  function open() { if (part !== "panel") togglePart("panel", markLoader.item) }
  function close() { part = "" }
  function switchPanel(direction) {
    return bar && typeof bar.switchPanelFrom === "function" ? bar.switchPanelFrom(root, direction) : false
  }

  // What the bar closes when another panel opens. Not the widget itself: the bar underlines the middle of the widget it
  // has open, and the part that is open says so with its own face.
  property QtObject popout: QtObject {
    property bool popoutSwitchClosing: false
    function close() { root.close() }
    function closeForPopoutSwitch() {
      popoutSwitchClosing = true
      root.close()
      Qt.callLater(function() { popoutSwitchClosing = false })
    }
  }

  Line {
    id: parts
    vertical: root.vertical
    spacing: Style.space(4)

    Loader {
      id: markLoader
      active: root.service !== null && root.has("mark")
      visible: active
      sourceComponent: MarkPart { host: root }
    }

    Loader {
      active: root.service !== null && root.has("workspaces")
      visible: active
      sourceComponent: WorkspacesPart { host: root }
    }

    Loader {
      active: root.service !== null && root.has("agents")
      visible: active && item !== null && item.any
      sourceComponent: AgentsPart { host: root }
    }

    Loader {
      active: root.service !== null && root.has("tray")
      visible: active && item !== null && item.any
      sourceComponent: TrayPart { host: root }
    }

    Loader {
      active: root.service !== null && root.has("clock")
      visible: active
      sourceComponent: ClockPart { host: root }
    }
  }

  Loader {
    id: popup
    // Asked for before the service is up, it opens when the service is.
    active: root.shownPart !== "" && root.service !== null
    sourceComponent: Popup {
      host: root
      anchorItem: root.anchor
      onVisibleChanged: if (!visible && root.part === "") root.shownPart = ""
    }
  }
}
