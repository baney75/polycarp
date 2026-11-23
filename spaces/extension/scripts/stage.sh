#!/bin/sh
# Stage the extension as Polycarp ships it: scripts/stage.sh <dest> [version_name]
# scripts/bundle.sh runs this into Polycarp.app/Contents/Resources/extension with the app's full version,
# which the extension compares on disk to know the app updated it (src/background.js).
# Leaves out tests, scripts, docs, dev pages (dev-*), notes and OS junk.
# Fails if a file the manifest or a page names is missing, or if any page loads remote or inline script.
set -eu
[ $# -ge 1 ] || { echo "usage: scripts/stage.sh <dest> [version_name]" >&2; exit 2; }
EXT=$(cd "$(dirname "$0")/.." && pwd)
DEST=$1
rm -rf "$DEST"; mkdir -p "$DEST"
rsync -a --exclude '/tests' --exclude '/scripts' --exclude '/docs' --exclude '/*.md' \
  --exclude 'dev-*' --exclude '.DS_Store' --exclude '*.map' "$EXT/" "$DEST/"

python3 - "$DEST" "${2:-}" <<'PY'
import json, os, re, sys
root, version_name = sys.argv[1], sys.argv[2]; bad = []
mp = os.path.join(root, "manifest.json")
m = json.load(open(mp))
if version_name:
    m["version_name"] = version_name
    with open(mp, "w") as f: json.dump(m, f, indent=2); f.write("\n")
refs = list(m.get("icons", {}).values()) + list(m["action"].get("default_icon", {}).values())
refs += [m["action"]["default_popup"], m["background"]["service_worker"], m["options_ui"]["page"]]
refs += list(m.get("chrome_url_overrides", {}).values())
for cs in m.get("content_scripts", []): refs += cs.get("js", []) + cs.get("css", [])
for r in refs:
    if not os.path.isfile(os.path.join(root, r)): bad.append("manifest names missing " + r)
for d, _, files in os.walk(root):
    for f in files:
        p = os.path.join(d, f)
        if f.endswith(".html"):
            html = open(p, encoding="utf-8").read()
            for src in re.findall(r'<(?:script|link)[^>]+(?:src|href)="([^"]+)"', html):
                if re.match(r"https?:|//", src): bad.append(f"{p}: remote resource {src}")
                elif not src.startswith(("#", "data:")) and not os.path.isfile(os.path.normpath(os.path.join(d, src))):
                    bad.append(f"{p}: missing {src}")
            if re.search(r"<script>(?!\s*</script>)", html): bad.append(f"{p}: inline script")
        if f.startswith("dev-"): bad.append("dev file shipped " + p)
if bad: print("\n".join(bad)); sys.exit(1)
PY
echo "staged $DEST ($(du -sh "$DEST" | cut -f1), $(find "$DEST" -type f | wc -l | tr -d ' ') files)"
