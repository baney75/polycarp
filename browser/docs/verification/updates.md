# Updates from the side panel: records

## 2026-10-27: live check, checkout mode (narrow check, not the DC-5 Check)

Script: `~/Projects/_work/2026-10-27-tabkyra-updates/live/update-e2e.mjs`, with `setup.sh`
making a throwaway workspace in `/tmp/tku-live`: APFS clones of the sibling repos, a bare
origin holding this branch, a checkout of it one commit behind (the new commit sets the
manifest to 1.1.9, subject "Live check: version 1.1.9"), built with `TABKYRA_NO_BUMP=1`.
The native host was registered from the checkout under an isolated HOME; the extension was
loaded from the checkout's `dist-chrome` into Playwright's headless Chromium (Chrome for
Testing 156). A mock model held an agent run open on demand.

Steps and results (20 of 20 passed; last rerun on 9d6b99e, with the lock-based install gate
and the journaled commit step from review round 3):

- The panel shows "Update available: 1 new commit on main" with Update now.
- Settings > Updates: mode "Git checkout", "1 new commit on origin/main", the updates choice
  on "Tell me".
- With an agent run going, Update now: checking, pulling, installing (setup-siblings.sh,
  about 6 s), building, then "Waiting: Ready. Installing when no agent is running: an agent
  run is going in a side panel". The live build was still the old one and the new one sat
  in `.tabkyra-update/next/`; no reload for 6 more seconds while the run continued.
- The run ended: the worker sent `activate`, the updater installed and refreshed skills
  (its progress file read from outside the browser: update checking > pulling > installing >
  building > done, then activate installing > skills > done), and the extension called
  `chrome.runtime.reload()`.
- After the reload: version 1.1.9, What's new lists "Live check: version 1.1.9", the panel
  says "Tabkyra reloaded and runs 1.1.9", the session from before is still stored, the
  checkout is at the new commit with no local changes, and its build is from that commit.
- What's new dismisses; Roll back in Settings reloads into 1.1.8, the exact build from
  before the update (same build id).

What it could have failed on: no notice, wrong mode, a reload during the run, a missing
step, a build that dirtied the checkout, a lost session, no What's new, a rollback to the
wrong build.

**Limit.** In headless Chrome for Testing, `chrome.runtime.reload()` leaves any
command-line-loaded extension blocked (`ERR_BLOCKED_BY_CLIENT`), even a two-file extension
with no Tabkyra code. So after the extension called it, the script restarted the browser on
the same profile, which loads the extension from the same folder. The in-place reload in
Helium is untested live.
