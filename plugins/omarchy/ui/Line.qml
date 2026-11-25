import QtQuick

// Its children in one line, along the bar. Rows and columns are never both 1 while the bar turns: with two children that
// is a grid too small for them, and Qt says so.
Grid {
  property bool vertical: false
  columns: vertical && rows === -1 ? 1 : -1
  rows: !vertical && columns === -1 ? 1 : -1
}
