#!/usr/bin/env python3
"""Writes the licence texts of the Rust crates statically linked into the app, for its licenses folder.

    rust-licenses.py --out FILE --own DIR [--target TRIPLE ...] MANIFEST:PACKAGE ...

Each MANIFEST:PACKAGE is a Cargo.toml and the package the app ships from it (the polycarp command).
Only normal dependencies reach the binary. Path crates under --own are Polycarp's, which LICENSE covers. Run it after the builds, so cargo has every crate's source on disk.
"""
import argparse
import json
import os
import subprocess
import sys

NAMES = ("LICENSE", "LICENCE", "COPYING", "NOTICE", "UNLICENSE")

ap = argparse.ArgumentParser()
ap.add_argument("--out", required=True)
ap.add_argument("--own", required=True)
ap.add_argument("--target", action="append", default=[])
ap.add_argument("roots", nargs="+")
args = ap.parse_args()
own = os.path.realpath(args.own) + os.sep

crates = {}  # (name, version) -> package
for spec in args.roots:
    manifest, _, root_name = spec.rpartition(":")
    cmd = ["cargo", "metadata", "--format-version", "1", "--locked", "--manifest-path", manifest]
    for t in args.target:
        cmd += ["--filter-platform", t]
    meta = json.loads(subprocess.run(cmd, check=True, capture_output=True, text=True).stdout)
    packages = {p["id"]: p for p in meta["packages"]}
    nodes = {n["id"]: n for n in meta["resolve"]["nodes"]}
    roots = [i for i, p in packages.items() if p["name"] == root_name and i in meta["workspace_members"]]
    if not roots:
        sys.exit(f"rust-licenses: {manifest} has no package {root_name}")
    seen, todo = set(), roots
    while todo:
        i = todo.pop()
        if i in seen:
            continue
        seen.add(i)
        todo += [d["pkg"] for d in nodes[i]["deps"] if any(k["kind"] is None for k in d["dep_kinds"])]
    for i in seen:
        p = packages[i]
        if p["source"] is None and os.path.realpath(p["manifest_path"]).startswith(own):
            continue
        crates[(p["name"], p["version"])] = p

HERE = os.path.dirname(os.path.abspath(__file__))
TEXTS = {"MIT": os.path.join(HERE, "licence-texts", "MIT.txt"), "Zlib": os.path.join(HERE, "licence-texts", "Zlib.txt"),
         "Apache-2.0": os.path.join(HERE, "licence-texts", "Apache-2.0.txt")}

def standard_texts(name, version, p):
    """The first alternative of the crate's licence expression whose every licence has a text here (OR: one is enough,
    AND: all are needed). None does: the build stops, so no crate ships uncredited."""
    expr = (p.get("license") or "").replace("/", " OR ").replace("(", " ").replace(")", " ")
    for alternative in expr.split(" OR "):
        ids = [term.split(" WITH ")[0].strip() for term in alternative.split(" AND ")]
        if ids and all(i in TEXTS for i in ids):
            holders = ", ".join(p.get("authors") or [f"the {name} authors"])
            return "\n\n".join(open(TEXTS[i], encoding="utf-8").read().strip().replace("{holders}", holders) for i in ids)
    sys.exit(f"rust-licenses: {name} {version} has no licence file and no text here for {p.get('license')!r}: "
             f"add the licence's text to scripts/licence-texts and to TEXTS")

parts = ["The Rust crates compiled into Polycarp (the polycarp command), with their licences.", ""]
for (name, version), p in sorted(crates.items()):
    folder = os.path.dirname(p["manifest_path"])
    files = [os.path.join(folder, p["license_file"])] if p.get("license_file") else \
        sorted(os.path.join(folder, f) for f in os.listdir(folder) if f.upper().startswith(NAMES))
    parts.append(f"{name} {version} ({p.get('license') or 'see below'})")
    parts.append("=" * 72)
    texts = [open(f, encoding="utf-8", errors="replace").read().strip() for f in files if os.path.isfile(f)]
    parts.append("\n\n".join(texts) if texts else standard_texts(name, version, p))
    parts.append("")
with open(args.out, "w", encoding="utf-8") as out:
    out.write("\n".join(parts))
print(f"rust-licenses: {len(crates)} crates")
