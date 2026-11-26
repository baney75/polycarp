import QtQuick
import qs.Commons
import qs.Ui

// What a part opens. One surface for all of them, in Omarchy's own panel: the page is loaded while it is open and gone
// after. A page is an Item with implicitWidth, implicitHeight and any of move, activate, key, remove, tab and reset.
KeyboardPanel {
  id: root

  required property var host

  owner: host.popout
  bar: host.bar
  // Opens once it is whole: the panel hands out the keys as it opens.
  property bool built: false
  open: built && host.part !== ""
  focusTarget: keys
  contentWidth: fittedContentWidth(pageLoader.item ? pageLoader.item.implicitWidth + padding * 2 : Style.space(280))
  contentHeight: fittedContentHeight(pageLoader.item ? pageLoader.item.implicitHeight : Style.space(80))

  Component.onCompleted: Qt.callLater(function() { root.built = true })

  function send(name, a, b) {
    var page = pageLoader.item
    return page && typeof page[name] === "function" ? page[name](a, b) : undefined
  }

  PanelKeyCatcher {
    id: keys
    anchors.fill: parent
    blocked: pageLoader.item ? pageLoader.item.typing === true : false
    onMoveRequested: function(dx, dy) {
      viewport.keyed = true
      root.send("move", dx, dy)
      viewport.keyed = false
    }
    onActivateRequested: root.send("activate")
    onDeleteRequested: root.send("remove")
    onTabRequested: function(direction) { if (root.send("tab", direction) !== true) root.host.switchPanel(direction) }
    onTextKey: function(text) { root.send("key", text) }
    onCloseRequested: if (root.send("back") !== true) root.host.close()

    Component { id: panelPage; PanelPage { host: root.host; view: viewport } }
    Component { id: calendarPage; CalendarPage { host: root.host } }
    Component { id: menuPage; MenuPage { host: root.host; view: viewport } }
    Component { id: agentsPage; AgentsPage { host: root.host; view: viewport } }

    Flickable {
      id: viewport
      anchors.fill: parent
      contentWidth: width
      contentHeight: pageLoader.item ? pageLoader.item.implicitHeight : 0
      clip: contentHeight > height
      interactive: contentHeight > height
      boundsBehavior: Flickable.StopAtBounds

      // Keeps what the keys are on in view. Only for a key: scrolling under a pointer that rests on a row would move
      // the next row under it, and that one would scroll again.
      property bool keyed: false
      function reveal(item) {
        if (!keyed || !item || contentHeight <= height) return
        var y = item.mapToItem(contentItem, 0, 0).y
        if (y < contentY) contentY = Math.max(0, y - Style.space(8))
        else if (y + item.height > contentY + height) contentY = Math.min(contentHeight - height, y + item.height - height + Style.space(8))
      }

      Loader {
        id: pageLoader
        width: viewport.width
        active: root.host.shownPart !== ""
        sourceComponent: switch (root.host.shownPart) {
        case "panel": return panelPage
        case "agents": return agentsPage
        case "clock": return calendarPage
        case "tray": return menuPage
        default: return null
        }
        onLoaded: viewport.contentY = 0
      }
    }
  }
}
