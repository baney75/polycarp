.pragma library

// What the bar's layout says, from the copy Omarchy hands each widget as `bar.layoutConfig`: regions of entries, each an
// id or an object with an `id`.

function has(layout, id) {
  if (!layout || typeof layout !== "object") return false
  var regions = ["left", "center", "right"]
  for (var r = 0; r < regions.length; r++) {
    var entries = layout[regions[r]]
    if (!Array.isArray(entries)) continue
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i]
      if ((entry && typeof entry === "object" ? entry.id : entry) === id) return true
    }
  }
  return false
}
