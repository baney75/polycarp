#!/usr/bin/env python3
"""What a workspace switch looks like, frame by frame, on the real screen.

Records the screen with Shotate while switching between two workspaces, then counts the separate
visible changes in each switch. A clean switch is one cut: the old workspace, then the new one. Each
extra change is an in-between frame someone can see: windows arriving one app at a time, a bare desktop,
two workspaces overlapping, a window popping to the front.

    python3 scripts/switch-frames-probe.py 1 2 [--rounds 8] [--out DIR] [--max-steps N]

It switches the screen while it runs and ends where it started, so it runs only after 10 idle minutes
(--idle 0 overrides, for when you are watching it yourself), and stops switching as soon as input arrives.
Exits 3 for "couldn't run" and 1 when a switch has more than --max-steps changes. Recordings stay in --out:
they show the real screen, so never publish them.
"""
import argparse, ctypes, json, os, re, subprocess, sys, tempfile, time
import numpy as np

W, H = 240, 156
SETTLE = 0.35       # seconds after a key: later changes are the app's own (a video, a clock), not the switch
MIN_FPS = 50        # below this, separate changes merge into one frame and a switch can look cleaner than it is
CHANGE = 0.0025     # share of the frame that must differ for a frame to count as a change
PIXEL = 18          # how far one gray pixel must move to count, over video noise


def idle_seconds():
    out = subprocess.run(["ioreg", "-c", "IOHIDSystem"], capture_output=True, text=True).stdout
    m = re.search(r'"?HIDIdleTime"?\s*=\s*(\d+)', out)
    return int(m.group(1)) / 1e9 if m else 0.0


def screen_on():
    """False when the display sleeps or the session is locked, and whenever that can't be read: a dark recording is no measurement."""
    try:
        cg = ctypes.CDLL("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
        cf = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
        cg.CGMainDisplayID.restype = ctypes.c_uint32
        cg.CGDisplayIsAsleep.argtypes = [ctypes.c_uint32]
        cg.CGDisplayIsAsleep.restype = ctypes.c_int32
        if cg.CGDisplayIsAsleep(cg.CGMainDisplayID()):
            return False
        cg.CGSessionCopyCurrentDictionary.restype = ctypes.c_void_p
        session = cg.CGSessionCopyCurrentDictionary()
        if not session:
            return False
        cf.CFStringCreateWithCString.restype = ctypes.c_void_p
        cf.CFStringCreateWithCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint32]
        key = cf.CFStringCreateWithCString(None, b"CGSSessionScreenIsLocked", 0x08000100)
        cf.CFDictionaryGetValue.restype = ctypes.c_void_p
        cf.CFDictionaryGetValue.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        return not cf.CFDictionaryGetValue(session, key)
    except (OSError, AttributeError):
        return False


def go(n):
    subprocess.run(["open", "-g", f"baneyspaces://switch/{n}"], check=False)


def shotate(*args):
    r = subprocess.run(["shotate", *args], capture_output=True, text=True)
    try:
        return json.loads(r.stdout)
    except json.JSONDecodeError:
        return {"error": r.stdout + r.stderr}


def frames(video):
    info = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time", "-of", "csv=p=0", video], capture_output=True, text=True).stdout
    times = np.array([float(x.split(",")[0]) for x in info.split() if x.strip(",")])
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", video, "-vsync", "0", "-vf", f"scale={W}:{H}", "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True).stdout
    data = np.frombuffer(raw, dtype=np.uint8)
    n = len(data) // (W * H)
    return times[:n], data[: n * W * H].reshape(n, H, W)


def analyze(times, gray, marks, start_at):
    """One row per switch: the visible changes from the key to where the screen settled."""
    rows = []
    diffs = (np.abs(gray[1:].astype(np.int16) - gray[:-1].astype(np.int16)) > PIXEL).mean(axis=(1, 2))
    for i, (target, at) in enumerate(marks):
        t0 = at - start_at
        t1 = t0 + SETTLE
        idx = np.where((times[1:] >= t0) & (times[1:] < t1) & (diffs > CHANGE))[0]
        if len(idx) == 0:
            rows.append({"to": target, "steps": 0})
            continue
        steps = idx + 1
        before, after = gray[max(steps[0] - 1, 0)].astype(np.int16), gray[min(steps[-1], len(gray) - 1)].astype(np.int16)
        # A frame unlike both ends: something neither workspace shows, such as a bare desktop or both at once.
        strange = 0
        for s in steps[:-1]:
            f = gray[s].astype(np.int16)
            if (np.abs(f - before) > PIXEL).mean() > CHANGE and (np.abs(f - after) > PIXEL).mean() > CHANGE:
                strange += 1
        rows.append({"to": target, "steps": int(len(steps)), "in_between": strange, "first_ms": round((times[steps[0]] - t0) * 1000),
                     "span_ms": round((times[steps[-1]] - times[steps[0]]) * 1000), "frames": [int(s) for s in steps[:12]]})
    return rows


def main():
    p = argparse.ArgumentParser()
    p.add_argument("a", type=int)
    p.add_argument("b", type=int)
    p.add_argument("--rounds", type=int, default=8)
    p.add_argument("--gap", type=float, default=1.2)
    p.add_argument("--idle", type=float, default=600)
    p.add_argument("--out", default=tempfile.mkdtemp(prefix="switch-frames-"))
    p.add_argument("--max-steps", type=int, default=None)
    a = p.parse_args()
    os.makedirs(a.out, exist_ok=True)
    if idle_seconds() < a.idle:
        print(f"untested live: idle {idle_seconds():.0f} s, needs {a.idle:.0f}")
        return 3
    if not screen_on():
        print("untested live: the display is asleep, the session is locked, or that can't be read")
        return 3
    st = shotate("status")
    if not st.get("canRecord"):
        print(f"untested live: Shotate can't record: {st}")
        return 3
    state = os.path.expanduser("~/Library/Application Support/Polycarp/state.json")
    came_from = json.load(open(state)).get("current", a.a)
    go(a.a)
    time.sleep(0.8)
    began = time.time()
    rec = shotate("record", "screen")
    if rec.get("error") or not rec.get("video"):
        print(f"untested live: {rec}")
        return 3
    time.sleep(1.0)
    marks = []
    interrupted = False
    for r in range(a.rounds):
        for target in (a.b, a.a):
            # Someone came back: stop switching their screen at once.
            if a.idle and idle_seconds() < a.gap + 1:
                interrupted = True
                break
            marks.append((target, time.time()))
            go(target)
            time.sleep(a.gap)
        if interrupted:
            break
    if not interrupted:
        go(came_from)
    time.sleep(0.5)
    saved = shotate("stop")
    made = saved.get("video") or rec["video"]
    if not os.path.exists(made):
        print(f"untested live: no recording: {saved}")
        return 3
    # Out of the person's Screenshots folder: it is only a measurement.
    path = os.path.join(a.out, "switches.mp4")
    os.replace(made, path)
    clicks = saved.get("clicks")
    if clicks and os.path.exists(clicks):
        os.remove(clicks)
    times, gray = frames(path)
    # The video starts when Shotate's first frame arrives, shortly after `began`: line up on the first switch's change.
    diffs = (np.abs(gray[1:].astype(np.int16) - gray[:-1].astype(np.int16)) > PIXEL).mean(axis=(1, 2))
    first_change = times[1:][diffs > CHANGE]
    offset = 0.0
    if len(first_change) and marks:
        after = first_change[first_change > 0.4]
        offset = (marks[0][1] - began) - (after[0] - 0.05) if len(after) else 0.0
    rows = analyze(times, gray, marks, began + offset)
    good = [r for r in rows if r["steps"]]
    steps = sorted(r["steps"] for r in good) or [0]
    report = {"video": path, "fps": round(len(times) / max(times[-1] - times[0], 0.001), 1), "switches": len(rows), "interrupted": interrupted,
              "steps_median": steps[len(steps) // 2], "steps_max": steps[-1], "clean_cuts": sum(r["steps"] == 1 for r in good),
              "in_between_total": sum(r.get("in_between", 0) for r in good),
              "span_ms_median": sorted(r.get("span_ms", 0) for r in good)[len(good) // 2] if good else None, "rows": rows}
    with open(os.path.join(a.out, "report.json"), "w") as f:
        json.dump(report, f, indent=1)
    if len(good) < len(rows) or not rows:
        print(json.dumps({k: v for k, v in report.items() if k != "rows"}))
        print(f"untested live: {len(rows) - len(good)} of {len(rows)} switches showed no change, so this measured nothing. Is Polycarp running, and do the two workspaces look different?")
        return 3
    if report["fps"] < MIN_FPS:
        print(json.dumps({k: v for k, v in report.items() if k != "rows"}))
        print(f"untested live: recorded at {report['fps']} fps, under {MIN_FPS}, so separate changes merge into one frame")
        return 3
    print(json.dumps({k: v for k, v in report.items() if k != "rows"}))
    for r in rows:
        print(r)
    if a.max_steps is not None and steps[-1] > a.max_steps:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
