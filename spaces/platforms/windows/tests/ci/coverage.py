"""Per-file line coverage of the Windows daemon from `cargo llvm-cov --json --summary-only`.

Prints a Markdown table (for GITHUB_STEP_SUMMARY) and exits 1 when any gated file is under the floor.
Usage: python coverage.py <cov.json> [floor percent, default 50]
"""
import json
import sys

GATED = ["cloak.rs", "hook.rs", "daemon.rs", "winapi.rs"]


def main() -> int:
    path = sys.argv[1]
    floor = float(sys.argv[2]) if len(sys.argv) > 2 else 50.0
    with open(path, encoding="utf-8") as f:
        data = json.load(f)["data"][0]
    rows = {}
    for entry in data["files"]:
        name = entry["filename"].replace("\\", "/")
        if "/platforms/windows/baneyspaces/src/" not in name:
            continue
        lines = entry["summary"]["lines"]
        rows[name.rsplit("/", 1)[-1]] = (lines["covered"], lines["count"], lines["percent"])
    failed = []
    print(f"### Windows daemon unit test coverage (lines; gate {floor:.0f}% on {', '.join(GATED)})\n")
    print("| File | Lines covered | Percent | Gate |")
    print("| --- | ---: | ---: | --- |")
    for name in sorted(rows):
        covered, count, percent = rows[name]
        gate = ""
        if name in GATED:
            gate = "pass" if percent >= floor else "FAIL"
            if percent < floor:
                failed.append(f"{name} {percent:.1f}%")
        print(f"| {name} | {covered} / {count} | {percent:.1f}% | {gate} |")
    for name in GATED:
        if name not in rows:
            failed.append(f"{name} missing from the report")
    print()
    if failed:
        print(f"**FAIL**: under {floor:.0f}%: {'; '.join(failed)}")
        return 1
    print("**PASS**: every gated file is at or over the floor.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
