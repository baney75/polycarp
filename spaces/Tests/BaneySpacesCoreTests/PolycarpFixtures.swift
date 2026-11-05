import Foundation

/// Files written by `polycarp theme set <name> --mode <mode>` (still-water auto, blocks dark), cut to
/// what Spaces reads. They let the parser tests run where the CLI isn't built.
enum PolycarpFixtures {
    static let still_water = #"""
{
 "mode": "auto",
 "name": "still-water",
 "schema": 1,
 "surfaces": {
  "spaces": {
   "dark": {
    "accent": "#a5cfcb",
    "background": "#1f2a2d",
    "border": "#3a4d52",
    "done": "#8ccbb0",
    "foreground": "#e8f0f0",
    "muted": "#b3c5c8",
    "on_accent": "#12201f",
    "selection": "#2f4a4b",
    "strong": "#ffffff",
    "sunken": "#182225",
    "surface": "#28363a",
    "urgent": "#e58a76",
    "working": "#cdb57a"
   },
   "light": {
    "accent": "#3f6b6a",
    "background": "#f1f5f5",
    "border": "#cbd8d9",
    "done": "#2f6b55",
    "foreground": "#233033",
    "muted": "#51636a",
    "on_accent": "#f1f5f5",
    "selection": "#d3e4e2",
    "strong": "#142022",
    "sunken": "#e3ebeb",
    "surface": "#fafdfd",
    "urgent": "#a33a2a",
    "working": "#80651f"
   },
   "motion": {
    "easing": "cubic-bezier(0.2, 0, 0, 1)",
    "fast": 120,
    "normal": 200,
    "reduced": false,
    "scale_from": 0.98,
    "slow": 320
   },
   "shape": {
    "blur": 0,
    "border_width": 1,
    "density": "regular",
    "indicator": "dot",
    "radius": 10,
    "radius_large": 16,
    "radius_small": 6,
    "shadow": 0.12
   },
   "type": {
    "display": "Newsreader, \"Iowan Old Style\", Georgia, serif",
    "line_height": 1.5,
    "mono": "ui-monospace, \"SF Mono\", Menlo, Consolas, monospace",
    "size": 16,
    "ui": "system-ui, -apple-system, \"Segoe UI\", Roboto, Ubuntu, Cantarell, sans-serif",
    "weight": 400
   }
  }
 },
 "title": "Still Water"
}
"""#
    static let blocks = #"""
{
 "mode": "dark",
 "name": "blocks",
 "schema": 1,
 "surfaces": {
  "spaces": {
   "dark": {
    "accent": "#a9bb8a",
    "background": "#2b2e26",
    "border": "#4a4e41",
    "done": "#8ebdb9",
    "foreground": "#f6f3e8",
    "muted": "#bdbfaf",
    "on_accent": "#20231a",
    "selection": "#3d4634",
    "strong": "#ffffff",
    "sunken": "#23261f",
    "surface": "#34382e",
    "urgent": "#e58a76",
    "working": "#c7b07a"
   },
   "light": {
    "accent": "#59693f",
    "background": "#f6f3e8",
    "border": "#d5d0bf",
    "done": "#3f6b6a",
    "foreground": "#2b2e26",
    "muted": "#5c6152",
    "on_accent": "#f6f3e8",
    "selection": "#dce3cc",
    "strong": "#1c1e18",
    "sunken": "#ece7d8",
    "surface": "#fffdf6",
    "urgent": "#a33a2a",
    "working": "#856a29"
   },
   "motion": {
    "easing": "linear",
    "fast": 60,
    "normal": 100,
    "reduced": false,
    "scale_from": 1.0,
    "slow": 160
   },
   "shape": {
    "blur": 0,
    "border_width": 2,
    "density": "regular",
    "indicator": "number-block",
    "radius": 0,
    "radius_large": 0,
    "radius_small": 0,
    "shadow": 0.0
   },
   "type": {
    "display": "Newsreader, \"Iowan Old Style\", Georgia, serif",
    "line_height": 1.5,
    "mono": "ui-monospace, \"SF Mono\", Menlo, Consolas, monospace",
    "size": 16,
    "ui": "ui-monospace, \"SF Mono\", Menlo, Consolas, monospace",
    "weight": 400
   }
  }
 },
 "title": "Blocks"
}
"""#
}
