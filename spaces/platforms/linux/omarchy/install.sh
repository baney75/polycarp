#!/bin/sh
# The Linux desktop is retired. An older `polycarp update` on Linux still runs this script, so it
# stays as a stub: it installs nothing, changes nothing in your home folder and exits 0. If an earlier
# install's block is still in hyprland.lua, it says how to take it out (uninstall.sh, beside it).
# See ../README.md.
echo "Polycarp runs on macOS and Windows. The Linux desktop is retired. For browser and computer use on Linux, install Tychicus: https://github.com/baney75/tychicus"
main="$HOME/.config/hypr/hyprland.lua"
if [ -f "$main" ] && grep -qF -- "-- >>> baneyspaces (managed by baneyspaces install.sh) >>>" "$main"; then
  here="$(cd "$(dirname "$0")" && pwd)"
  echo "An earlier install still binds your workspace keys to the retired daemon in $main."
  echo "To take it out and get Omarchy's own keys back, run: $here/uninstall.sh   (add --dry-run to see what it does first)"
  echo "Or delete the lines from '-- >>> baneyspaces' through '-- <<< baneyspaces <<<' in that file, then run: hyprctl reload"
fi
exit 0
