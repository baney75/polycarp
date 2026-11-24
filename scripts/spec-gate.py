#!/usr/bin/env python3
"""Spec gate: a behavior change to Spaces ships with its spec, or says why it needs none.

Rules S-G1 to S-G7 (spaces/AGENTS.md names this gate):

  S-G1 A behavior file is a changed file under spaces/Sources/, spaces/crates/ or
       spaces/platforms/windows/ that is not a test or doc file.
  S-G2 The PR passes when it changes a file under spaces/spec/.
  S-G3 The PR passes when its body has a line `Spec: R-X1, R-Y2` and every id appears as a
       whole word in a file under spaces/spec/ at the head commit.
  S-G4 The PR passes when its body has a line `Spec: none (reason)` with a reason of at
       least 20 characters.
  S-G5 A PR with no behavior file passes.
  S-G6 On failure: exit 1, list the behavior files (at most 20), then the three ways to pass.
  S-G7 In Actions it reads base, head and body from GITHUB_EVENT_PATH.

Usage:
  python3 scripts/spec-gate.py --base <sha> --head <sha> --body-file <path>
  python3 scripts/spec-gate.py            (in Actions, on a pull_request event)

Exit 0 pass, 1 gate failure, 2 usage or git error. Standard library only, Python 3.9+.
"""

import argparse
import json
import os
import re
import subprocess
import sys
from typing import List, Optional, Tuple

BEHAVIOR_PREFIXES = ("spaces/Sources/", "spaces/crates/", "spaces/platforms/windows/")
SPEC_PREFIX = "spaces/spec/"
TEST_SEGMENTS = {"Tests", "tests", "test", "benches", "fixtures"}
TEST_SUFFIXES = ("Tests.swift", "_test.rs", ".md", ".txt")
MAX_LISTED = 20
MIN_REASON = 20

RULE_ID = r"R-[A-Z]+\d+"
IDS_LINE = re.compile(r"^Spec:\s*(" + RULE_ID + r")(\s*,\s*" + RULE_ID + r")*\s*$")
NONE_LINE = re.compile(r"^Spec:\s*none\s*\((.+)\)\s*$")

WAYS_TO_PASS = """Ways to pass:
  S-G2 Edit the rule in spaces/spec/ in this PR.
       Example: change spaces/spec/bar.md
  S-G3 Name the existing rules this PR follows, on a line of its own in the PR body.
       Example: Spec: R-S1, R-L2
  S-G4 State why no rule changes (20 characters or more), on a line of its own in the PR body.
       Example: Spec: none (refactor only, no visible change)"""


class GateError(Exception):
    """A usage or git error: exit 2."""


def git(*args: str) -> bytes:
    try:
        proc = subprocess.run(
            ["git", *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False
        )
    except OSError as err:
        raise GateError("cannot run git: %s" % err)
    if proc.returncode != 0:
        msg = proc.stderr.decode("utf-8", "replace").strip()
        raise GateError("git %s failed: %s" % (" ".join(args), msg))
    return proc.stdout


def changed_files(base: str, head: str) -> List[str]:
    # --no-renames reports a rename as a delete plus an add, so both names count.
    # --name-only lists deleted files too.
    out = git("diff", "-z", "--name-only", "--no-renames", "%s...%s" % (base, head))
    names = [n for n in out.decode("utf-8", "surrogateescape").split("\0") if n]
    return sorted(set(names))


def is_test_or_doc(path: str) -> bool:
    segments = path.split("/")
    if any(seg in TEST_SEGMENTS for seg in segments):
        return True
    return segments[-1].endswith(TEST_SUFFIXES)


def is_behavior_file(path: str) -> bool:
    return path.startswith(BEHAVIOR_PREFIXES) and not is_test_or_doc(path)


def spec_text_at(head: str) -> str:
    listing = git("ls-tree", "-r", "-z", "--name-only", head, "--", SPEC_PREFIX)
    parts = []
    for name in listing.decode("utf-8", "surrogateescape").split("\0"):
        if name:
            parts.append(git("show", "%s:%s" % (head, name)).decode("utf-8", "replace"))
    return "\n".join(parts)


def id_in_spec(rule_id: str, spec_text: str) -> bool:
    pattern = r"(?<![A-Za-z0-9_])" + re.escape(rule_id) + r"(?![A-Za-z0-9_])"
    return re.search(pattern, spec_text) is not None


def check_body(body: str, head: str) -> Tuple[Optional[str], List[str]]:
    """Return (passing rule and detail, or None) and the problems found on Spec lines."""
    problems = []
    spec_text = None
    for raw in body.splitlines():
        line = raw.rstrip("\r")
        if IDS_LINE.match(line):
            ids = re.findall(RULE_ID, line[len("Spec:"):])
            if spec_text is None:
                spec_text = spec_text_at(head)
            missing = [i for i in ids if not id_in_spec(i, spec_text)]
            if not missing:
                return "S-G3: %s found in spaces/spec/" % ", ".join(ids), problems
            for i in missing:
                problems.append("%s does not appear in spaces/spec/ at the head commit" % i)
            continue
        m = NONE_LINE.match(line)
        if m:
            reason = m.group(1).strip()
            if len(reason) >= MIN_REASON:
                return "S-G4: no spec change (%s)" % reason, problems
            problems.append(
                "the reason in \"%s\" is too short: %d characters, need %d"
                % (line.strip(), len(reason), MIN_REASON)
            )
    return None, problems


def gate(base: str, head: str, body: str) -> int:
    files = changed_files(base, head)
    behavior = [f for f in files if is_behavior_file(f)]
    if not behavior:
        print("spec gate: pass (S-G5): no behavior files")
        return 0
    spec_edits = [f for f in files if f.startswith(SPEC_PREFIX)]
    if spec_edits:
        print("spec gate: pass (S-G2): %s changed" % spec_edits[0])
        return 0
    passed, problems = check_body(body, head)
    if passed:
        print("spec gate: pass (%s)" % passed)
        return 0

    print("spec gate: fail. This PR changes behavior files and does not touch spaces/spec/.")
    for p in problems:
        print("Problem: %s" % p)
    print("Behavior files:")
    for f in behavior[:MAX_LISTED]:
        print("  %s" % f)
    if len(behavior) > MAX_LISTED:
        print("  and %d more" % (len(behavior) - MAX_LISTED))
    print(WAYS_TO_PASS)
    return 1


def from_event() -> Tuple[str, str, str]:
    path = os.environ.get("GITHUB_EVENT_PATH")
    if not path:
        raise GateError("give --base, --head and --body-file, or run in Actions with GITHUB_EVENT_PATH set")
    try:
        with open(path, encoding="utf-8") as fh:
            event = json.load(fh)
    except (OSError, ValueError) as err:
        raise GateError("cannot read GITHUB_EVENT_PATH %s: %s" % (path, err))
    pr = event.get("pull_request")
    if not isinstance(pr, dict):
        raise GateError("the event has no pull_request; the spec gate runs on pull_request events only")
    try:
        base = pr["base"]["sha"]
        head = pr["head"]["sha"]
    except (KeyError, TypeError):
        raise GateError("the pull_request event has no base.sha or head.sha")
    body = pr.get("body") or ""
    return base, head, body


def main(argv: List[str]) -> int:
    parser = argparse.ArgumentParser(description="Spec gate for Spaces pull requests (S-G1 to S-G7).")
    parser.add_argument("--base", help="base commit sha")
    parser.add_argument("--head", help="head commit sha")
    parser.add_argument("--body-file", help="file holding the PR body")
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return 0 if exc.code == 0 else 2

    try:
        given = [args.base, args.head, args.body_file]
        if all(v is None for v in given):
            base, head, body = from_event()
        elif any(v is None for v in given):
            raise GateError("--base, --head and --body-file are all required together")
        else:
            try:
                with open(args.body_file, encoding="utf-8") as fh:
                    body = fh.read()
            except OSError as err:
                raise GateError("cannot read --body-file: %s" % err)
            base, head = args.base, args.head
        return gate(base, head, body)
    except GateError as err:
        print("spec gate: error: %s" % err, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
