"""Exit 0 when the first version sorts above the second by SemVer 2.0 precedence (build metadata never counts).
   python3 -I scripts/semver-newer.py 0.4.0-nightly.20261118070000+1a2b3c4 0.3.0
publish-channel.sh uses it to refuse a build that isn't newer than its feed's; channels-test.sh checks it
against the semver package."""
import sys


def key(v):
    v = v.split("+", 1)[0]
    core, _, pre = v.partition("-")
    nums = tuple(int(x) for x in core.split("."))
    if len(nums) != 3:
        raise ValueError(v)
    if not pre:
        return (nums, 1, ())
    return (nums, 0, tuple((0, int(p), "") if p.isdigit() else (1, 0, p) for p in pre.split(".")))


if __name__ == "__main__":
    sys.exit(0 if key(sys.argv[1]) > key(sys.argv[2]) else 1)
