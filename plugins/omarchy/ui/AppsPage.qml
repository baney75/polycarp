import QtQuick
import qs.Commons
import "../lib/Apps.js" as Model

// The default apps. Only what is installed is offered; Omarchy's own command sets it.
Item {
  id: root

  property var page
  readonly property var apps: page && page.service ? page.service.apps : null
  readonly property var strings: page ? page.strings : ({})
  readonly property var rows: apps ? apps.rows : []
  property var at: ({ row: 0, col: 0 })

  function move(dx, dy) { at = Model.step(rows, at, dx, dy) }
  function activate() {
    var row = rows[at.row]
    if (row && row.choices[at.col]) pick(row.kind, row.choices[at.col])
  }
  function pick(kind, choice) { if (choice.set && !choice.now) apps.set(kind, choice.id) }

  implicitHeight: column.implicitHeight

  Column {
    id: column
    width: root.width
    topPadding: Style.space(4)
    spacing: Style.space(14)

    Repeater {
      model: root.rows

      Column {
        id: entry
        required property var modelData
        required property int index
        width: column.width
        spacing: Style.space(4)

        Note {
          page: root.page
          text: root.strings[entry.modelData.kind] || ""
          leftPadding: Style.space(2)
        }

        Note {
          page: root.page
          visible: entry.modelData.choices.length === 0
          width: parent.width
          color: Color.popups.text
          leftPadding: Style.space(2)
          text: root.strings.noChoice || ""
        }

        Flow {
          width: parent.width
          spacing: Style.space(4)

          Repeater {
            model: entry.modelData.choices

            PageButton {
              id: choice
              required property var modelData
              required property int index
              ink: Color.popups.text
              family: root.page ? root.page.family : ""
              held: modelData.now
              hasCursor: root.at.row === entry.index && root.at.col === index
              text: modelData.title
              role: Accessible.RadioButton
              opacity: root.apps && root.apps.busy === entry.modelData.kind + " " + modelData.id ? 0.55 : 1
              onHasCursorChanged: if (hasCursor && root.page) root.page.view.reveal(choice)
              onClicked: {
                root.at = { row: entry.index, col: index }
                root.pick(entry.modelData.kind, modelData)
              }
            }
          }
        }
      }
    }

    Note {
      page: root.page
      width: parent.width
      leftPadding: Style.space(2)
      visible: text !== ""
      text: root.apps && root.apps.failed ? root.strings.appFailed
        : root.rows.some(function(r) { return r.kind === "agent" && r.choices.length > 0 }) ? root.strings.agentOpens : ""
    }
  }
}
