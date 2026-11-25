pragma Singleton
import QtQuick
import qs.Commons

// The bar's small parts, from the theme's own tokens: how deep a face is, how round, how big an icon on a workspace.
QtObject {
  readonly property real radius: Math.min(Style.space(7), Style.cornerRadius)
  readonly property int icon: Math.round(Style.bar.iconCanvas * 0.875)
  readonly property int iconSlot: icon + Style.space(4)
  readonly property int number: Style.space(22)
  readonly property int dot: Math.max(4, Style.space(5))

  // Ink for a solid fill: whichever of the theme's two ends reads better on it.
  function on(fill) {
    return contrast(fill, Color.background) >= contrast(fill, Color.foreground) ? Color.background : Color.foreground
  }

  // A quieter ink that still reads: as faint as asked, or as strong as it has to be for `least` to 1 on this ground. Small
  // text asks for 4.5, a dot or a ring for 3.
  function quiet(ink, ground, strength, least) {
    for (var s = strength; s < 1; s += 0.04) {
      var c = Qt.rgba(ground.r + (ink.r - ground.r) * s, ground.g + (ink.g - ground.g) * s, ground.b + (ink.b - ground.b) * s, 1)
      if (contrast(c, ground) >= least) return Util.alpha(ink, s)
    }
    return ink
  }

  // The quiet words of a panel.
  readonly property color words: quiet(Color.popups.text, Color.popups.background, 0.72, 4.5)

  function luminance(c) {
    var part = function(v) { return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
    return 0.2126 * part(c.r) + 0.7152 * part(c.g) + 0.0722 * part(c.b)
  }

  function contrast(a, b) {
    var x = luminance(a)
    var y = luminance(b)
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
  }

  function face(barSize) {
    return Math.max(icon, barSize - Style.space(4))
  }
}
