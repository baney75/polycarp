# Updates

Tabkyra updates from the side panel. The native host checks once a day; the panel shows
"Update available" with an **Update now** button; the update runs, and Tabkyra reloads
itself once no agent is running. Settings > About (Updates) shows what runs and offers Check now,
Update now and Roll back. `tabkyra update` does the release install from a terminal.

What "update" does depends on how Tabkyra runs (the install mode):

| Mode | When | Update now does | Roll back does |
| --- | --- | --- | --- |
| **Release** | the native host runs from `~/.local/share/tabkyra/app` | downloads the newest signed GitHub release, verifies it ([checks](#what-an-update-checks-before-it-touches-a-file)) and unpacks it to `staged/`; once idle, swaps it in | swaps back to the release before it |
| **Checkout** | the native host runs from a git checkout of Tabkyra (how Donovan runs it) | `git fetch`, `git pull --ff-only` on main, `./scripts/setup-siblings.sh`, builds the extension and the CLI into `.tabkyra-update/next/`; once idle, swaps them in | swaps back to the build before it (the git checkout stays where it is) |
| Unmanaged | anything else (an npm install, a copied folder) | refuses: run `tabkyra update` in a terminal | |

## The side panel

- **Update now** (under the header, and in Settings > About (Updates)) sends the native host one
  of a fixed set of action names. The host runs the matching fixed command
  (`tabkyra update --host`, `--host --activate`, `--host --rollback` or `--host --reinstall`)
  as a child process of the CLI it runs from, and streams each step to the panel: checking,
  downloading, verifying, pulling, installing, building, skills, then done or failed with
  the reason.
- **Two steps.** The first step (`--host`) downloads and verifies a release, or pulls and
  builds a checkout, aside; nothing the browser loads changes, so you can keep working. The
  panel then shows "Update ready". The second step (`--host --activate`) swaps the new files
  in, refreshes skills and records What's new. The service worker sends it only when no
  agent is running, and reloads Tabkyra right after, so the browser never runs a mix of old
  and new files for more than that moment. Roll back also runs only when idle. **Install
  now** in the panel asks for the second step (it still waits for idle).
- **The reload.** The extension reloads itself with `chrome.runtime.reload()`, never while an
  agent run is going in any side panel or bridge session; until then the panel says what it
  waits for. "Idle" means: no side panel run is going (a running panel beats every 15
  seconds and on agent events, so a flag a crashed panel left stops counting after 3
  minutes), no bridge request is in
  flight, and no harness made a browser call in the last 30 seconds (a harness between two
  calls looks idle after that). An automatic update also waits 3 quiet minutes before each
  step.
- **The install gate.** For an install, a rollback or the reload, the worker checks idle,
  then takes a gate (a Web Lock, `src/update/gate.ts`) and checks again. A side panel takes
  the same lock in shared mode, only if the worker doesn't hold it, to mark itself busy
  before it starts a run, so either the worker sees the run or the panel sees the install.
  Before the install or rollback is sent, the worker also writes a fence to
  `chrome.storage.session` that lasts until the reload: if the worker dies mid-install, the
  fence still holds panels off and the next worker takes the gate back before it lets a
  bridge request through. An install or rollback that fails, or doesn't answer, still ends
  in a reload, since files may have changed. While the worker holds the gate, a
  side panel send is refused with "Tabkyra is installing an update and reloads in a moment"
  (the text goes back into the editor) and a bridge request gets an error saying to repeat
  it after the bridge reconnects; a bridge request counts as running from the moment it
  arrives. After an install the gate stays held until the reload. One update operation runs
  at a time. Sessions are kept in IndexedDB
  and `chrome.storage.local`, so chats and agent tab groups come back after the reload;
  reopen the side panel to continue.
- **The updater outlives the host.** It runs in its own process group and writes each step
  to `~/.config/tabkyra/update-progress.json`. If the browser closes the native host
  mid-update, the update finishes, and the next host reports it (or reports that it stopped,
  if its process died). A host also repairs an interrupted swap when it starts.
- **What's new.** After the reload a card shows the release notes (the GitHub release
  body) as a digest: the first sentence of up to two entries per section, six in all, with
  "And N more" and a link to the full notes (notes without a bullet list show as text) or, in a checkout, the commits pulled in (first-parent, a pull request shown by its
  title, at most 20, with a link to compare on GitHub). The ✕ hides it.
- **Bundled skills.** After an update the new CLI refreshes the skills installed in Claude
  Code, Codex and OpenCode that you haven't edited (`tabkyra skill refresh`). A copy is
  refreshed only when it is exactly what Tabkyra wrote (`~/.config/tabkyra/skills-installed.json`
  records the hash of every file install writes, and the updater records the unedited copies
  right before it swaps). Edited copies are left alone and listed in What's new.
- **Version mismatch.** Each build writes `build-info.json` (a build id, the commit and the
  version) and compiles the same record in. If the installed extension and CLI come from
  different commits (an update stopped partway), the panel offers **Re-run install**. If the
  browser or the native host still runs an older build than the one installed, it offers
  **Reload Tabkyra**.
- **Settings > About (Updates)** shows the running build, the installed one, the mode, the folder,
  the channel (`main` in a checkout), the last and next check, why an update would refuse,
  and the updates choice:
  - **Off**: no checks at all.
  - **Tell me** (the default): check daily and show "Update available".
  - **Install automatically when idle**: also install on its own once no agent has run in
    any side panel or bridge session for 3 minutes; the idle check runs again right before
    the reload. It never reinstalls a release you rolled back from, never rebuilds a
    checkout you rolled back (only new commits), and doesn't retry a failed attempt for the
    same version.

### Checkout mode

The checkout is the folder the native host runs from (its `cli/dist/index.js`). The host
compares the `build-info.json` the browser serves from the extension folder with the one in
that checkout's `dist-chrome`, so it knows the browser loads the extension from there. If it
loads it from somewhere else, Update now refuses and says so.

An update refuses, changing nothing, when:

- the checkout has local changes to tracked files (untracked files don't count);
- it isn't on main (another branch or a detached HEAD);
- main and origin/main have diverged, so the pull wouldn't be a fast-forward.

The builds go to `.tabkyra-update/next/` (ignored by git) with `TABKYRA_NO_BUMP=1`, so the
build never edits the manifest. Only when both the extension and the CLI built is the build
staged (`next/staged.json`); activation refuses it if HEAD moved since. The extension folder
is swapped by renames; the CLI is replaced file by file in place (a rename over each file),
so `cli/dist/index.js`, which the native host's launcher runs, is never missing. Install
and Roll back write a journal (`.tabkyra-update/journal.json`) and keep every source whole
until they commit, so a crash at any point is finished or undone by the next updater, the
next native host start, or `tabkyra doctor`, `status`, `setup` or `update` in a terminal. The builds they replace go to `.tabkyra-update/previous/` for Roll
back. If `npm install` in `setup-siblings.sh` rewrote a `package-lock.json`, the updater puts
it back as committed (any other changed tracked file stops the update), so the next update
isn't refused for local changes. `setup-siblings.sh` fetches a pinned sibling revision the
clone doesn't have yet, and moves pi-mono to a new pin when a pull changed it. A failed build leaves the old
build live and says why; the pulled commits stay, and the next Update now builds them, with
What's new counting from the live build. One updater runs at a time
(`.tabkyra-update/update.lock`).

**Trust.** A release is checked against the minisign key in the CLI. A checkout is trusted
the way `git pull` and `npm run build` by hand are: the updater runs `setup-siblings.sh` and
the build scripts of whatever origin/main holds. Point origin only at a repository you
trust. "Install automatically when idle" in a checkout runs those scripts without a click;
use "Tell me" if you want to look at new commits first.

### What the host runs

The extension's request is `{ "type": "update_action", "action": <name> }` and nothing
else; a frame with any other field, or an unknown name, is refused before anything runs
(`parseUpdateRequest` in `src/update/logic.ts`). The names:

| Action | The host |
| --- | --- |
| `check` | checks now (a GitHub API GET, or `git fetch origin main` in a checkout) |
| `update` | runs `tabkyra update --host` (download or pull, verify or build, stage) |
| `activate` | runs `tabkyra update --host --activate` (swap the staged build in); the service worker sends it only when idle |
| `rollback` | runs `tabkyra update --host --rollback` |
| `reinstall` | runs `tabkyra update --host --reinstall` (the mismatch fix: register the host again, or rebuild a checkout from HEAD) |
| `policy-off`, `policy-notify`, `policy-auto` | writes the updates choice to `~/.config/tabkyra/update.json` |

The command lines are constants (`UPDATE_COMMANDS` in `cli/src/update-host.ts`) passed as
argv without a shell, and the updater's own commands (`git`, `npm run build`,
`scripts/setup-siblings.sh`) are fixed too. Only Tabkyra's own pages can ask the service
worker for an action; a content script can't.

## Commands

| Command | What it does | Exit code |
| --- | --- | --- |
| `tabkyra update --check` | Asks GitHub for the newest release on your channel | 0 up to date (or nothing published), **100** update available, 1 error, 2 usage |
| `tabkyra update --check --json` | The same, as JSON (`current`, `latest`, `available`, `channel`, `url`, `error`) | as above |
| `tabkyra update` | Downloads, verifies and installs the newest release | 0 done or up to date, 1 refused or failed |
| `tabkyra update --yes` | Also answers yes to "install the release" when you run from a git checkout | |
| `tabkyra update --rollback` | Swaps back to the release before this one (run it again to undo). From a git checkout it asks first (`--yes` skips the question) | 0, 1 when there is none or you said no |
| `--channel stable\|nightly` | Picks the channel. An update (not `--check`) remembers it in `~/.config/tabkyra/update.json` | |
| `tabkyra update --auto-check off` | Turns the daily check off, the same as Settings > About (Updates) > Off (`on` turns it back on). `TABKYRA_NO_UPDATE_CHECK=1` also turns it off | |
| `tabkyra skill refresh [--json]` | Refreshes the installed skills you haven't edited (the update runs it) | 0 |

Stable takes releases tagged `vX.Y.Z`. Nightly also takes prereleases such as
`vX.Y.Z-nightly.20261025`.

Script example:

```sh
tabkyra update --check; case $? in 0) echo current ;; 100) tabkyra update ;; *) echo "check failed" ;; esac
```

## Where it installs

```
~/.local/share/tabkyra/app/        the installed release: dist-chrome/, cli/dist/index.js, release.json
~/.local/share/tabkyra/previous/   the release before it, for --rollback
~/.config/tabkyra/update-status.json   the last check (the native host reads it)
~/.config/tabkyra/update.json      the channel and the updates choice
~/.config/tabkyra/last-update.json the last update, rollback or reinstall ("What's new")
<checkout>/.tabkyra-update/        checkout mode: next/ (a build in progress), previous/ (for Roll back)
```

The browser loads `~/.local/share/tabkyra/app/dist-chrome`, and the agent launcher
(`~/.config/tabkyra/tabkyra`) and native host run `app/cli/dist/index.js`. Both paths stay
the same across updates, so harness configs never change.

**From a git checkout** (how Tabkyra is developed), `tabkyra update` in a terminal doesn't
touch the checkout; Update now in the side panel updates the checkout itself (see Checkout
mode above). It offers to install the release into `~/.local/share/tabkyra/app` and points the
native host and launcher there. After that first install, remove the old Tabkyra on
`chrome://extensions` and load the new folder once. To keep running from the checkout,
answer no and use `git pull`, `./scripts/setup-siblings.sh`, `npm run build` and
`cd cli && npm run build`.

## What an update checks before it touches a file

1. **The release list.** It reads the newest non-draft release on the channel. It needs
   `tabkyra-<version>.zip`, `SHA256SUMS` and `SHA256SUMS.minisig`, and refuses a release
   without all three. Downloads use https (loopback http is allowed only for the test server),
   with size limits (64 KB for the checksum files, 200 MB for the zip).
2. **The signature.** `SHA256SUMS.minisig` must verify against the minisign public key
   built into the CLI (`keys/tabkyra-release.pub`). The verifier is `cli/src/minisign.ts`.
   It accepts only prehashed Ed25519 signatures (minisign's default), checks the key id,
   and checks the signed trusted comment.
3. **The version.** The trusted comment must say `tabkyra <version>`, the version being
   installed. An old, validly signed `SHA256SUMS` can't be passed off as a newer release.
4. **The checksum.** The zip's SHA-256 must match its line in `SHA256SUMS`.
5. **The contents.** The zip is unpacked into a staging folder. It refuses absolute paths,
   `..`, symlinks, encrypted entries, CRC mismatches and anything over 512 MB unpacked.
   `release.json` must name the version, the extension's `manifest.json` must match it, and
   every file the extension and CLI need must be there.

Any failure stops the update, and the installed release stays as it was.

## How the swap works

The update holds a lock: a directory, `update.lock`, holding the owner's pid. It is taken
over only when that pid is dead, or when no pid was written and the lock is over 10 minutes
old. Under the lock it does two renames: `app/` becomes `previous/`, and the staged folder
becomes `app/`. If the second rename fails, the first is undone. Release swaps are these renames, not the journal checkout mode uses; a crash between them leaves `app/` missing until `recover()` (below) runs. The native host and launcher run from `app/`, so with it missing run the repair by hand from the kept copy: `node ~/.local/share/tabkyra/previous/cli/dist/index.js update` (every `tabkyra update` run repairs first). Rollback is three renames
through a `.swap-*` folder.

Every `tabkyra update` run, including `--check` and `--rollback`, first repairs whatever a
crash left, without deleting a release:

- if `app/` is missing, a `.swap-*` folder or `previous/` becomes `app/`;
- if `previous/` is missing, an orphaned `.swap-*` becomes `previous/`;
- unused staging folders are removed.

After the swap, the new CLI runs `install`, which rewrites the launcher and every browser's
native host manifest if they changed. Then it tells you to reload Tabkyra
(`tabkyra reload`, or the reload button on `chrome://extensions`). The browser keeps
running the old files until you reload.

## The daily check

When the extension connects, and every hour while the host runs, the native host reads
`update-status.json` and refreshes it if it's more than a day old. In release mode that is
one GET to the GitHub releases API; in a checkout it is `git fetch origin main`. A check
never downloads or installs anything. The host sends the result to the extension
(`update_status` in `src/bridge/protocol.ts`). The ✕ on "Update available" hides it until
the next version.

## Starting with an older build

A build from before the update system has no Update now button, and its native host can't
run updates. Update a checkout once by hand, then reload Tabkyra:

```sh
git pull --ff-only && ./scripts/setup-siblings.sh
TABKYRA_NO_BUMP=1 npm run build && (cd cli && npm run build)
tabkyra reload    # or the reload button on chrome://extensions
```

`TABKYRA_NO_BUMP=1` keeps the build from editing the manifest; a checkout with local changes
can't update itself.

## Releasing

### Is the release workflow ready?

Checked 2026-10-27, before the first release:

- **Runner.** Both jobs run on `ubuntu-24.04`, GitHub-hosted. The repository is public, Actions
  are enabled for all actions, and the CI workflow already runs on the same runner and passes
  (for example run 40445740971 on main). Public repositories don't use paid minutes.
- **minisign on the runner.** The publish job installs it with apt; Ubuntu 24.04 (noble) has
  `minisign` 0.11-1 in universe, which GitHub's images enable.
- **The key.** The release key (minisign `16C760BCAEA0129D`) is on main, and its secret is in
  the `release` environment, which needs baney75's approval for every signing run (see
  "Release key" below).
- **The workflow has never run.** The `v1.0.0` tag predates it and has no release;
  `tabkyra update` reads releases, not tags, so it is ignored.
- **The version.** `static/manifest.chrome.json` says 1.1.8, so `./release.sh patch` makes
  `v1.1.9`. Build with `TABKYRA_NO_BUMP=1` (the workflow does): a plain `npm run build` bumps
  the manifest in the checkout.
- **The notes** are the `CHANGELOG.md` section for the version (`scripts/release/notes.mjs`);
  the side panel shows each entry's first sentence in "What's new", so start every entry with a
  short sentence a user understands (AGENTS.md, Changelog). Checkout mode needs no release at all.

1. Add entries under `## [Unreleased]` in `CHANGELOG.md`.
2. Stable: `./release.sh patch` (or `minor`, `major`). It bumps
   `static/manifest.chrome.json`, finalizes the changelog, commits, tags `vX.Y.Z` and
   pushes.
   Nightly: tag the commit `vX.Y.Z-nightly.<yyyymmdd>`, where `X.Y.Z` equals the manifest
   version, then push the tag.
3. `.github/workflows/release.yml` runs on the tag in two jobs.
   - **build** has a read-only token, no secrets and no persisted git credentials. It
     checks the tag against the manifest, checks out the pinned siblings (pi-mono and
     mini-lit, by commit, in `scripts/setup-siblings.sh`), builds, runs the checks and the
     CLI tests, packages (`scripts/release/package.mjs`), and uploads the files.
   - **publish** runs no npm and no repo code. It downloads those files, installs minisign,
     signs `SHA256SUMS`, verifies the signature against the public key at the tagged commit,
     and creates the release. It is the only job that holds the secret or a write token,
     so install scripts in the build can't read the key.

   A tag with a `-` becomes a prerelease.

## Release key

The release key is minisign key `16C760BCAEA0129D`, made 2026-10-27 without a password,
because CI signs unattended. `keys/tabkyra-release.pub` holds its public half, and the CLI
builds it in. The secret half exists in two places only:

- Proton Pass, Personal vault, secure note "Tabkyra release signing key (minisign
  16C760BCAEA0129D)";
- the `MINISIGN_SECRET_KEY` secret of the `release` environment on baney75/tabkyra.
  `release.yml`'s publish job and `release-key-check.yml` use it.

Every job that reads the key waits for an approval: the environment has baney75 as its
required reviewer (self-review allowed), so a run starts signing only after he approves it, in
the Actions run page or with
`gh api -X POST repos/baney75/tabkyra/actions/runs/<run id>/pending_deployments -f state=approved -F 'environment_ids[]=<id>' -f comment=ok`,
where `<id>` comes from `gh api repos/baney75/tabkyra/environments/release --jq .id`. Before
approving, check that no workflow changed since the last run you approved, for example
`git log <last v* tag>..<run's commit> -- .github/workflows`; the approval prompt doesn't show
workflow changes, and an unexpected change or an unexpected request gets rejected.
That holds whoever changed main, so a collaborator who merges a workflow that prints the key
still can't run it without that approval. Only `main` and `v*` tags can deploy to the
environment at all, so a workflow on any other branch (even one dispatched by hand) can't
read the key. Two repository rulesets keep those refs trusted: "Release tags" lets only admins create, move or delete `v*` tags, so nobody else can
tag their own commit into signing; "main" blocks deleting and force-pushing main and requires
a pull request, and only the admin role bypasses it. There is no repository-level or
organization-level `MINISIGN_SECRET_KEY`: a job falls back to one of those when its
environment lacks the secret, which would hide a broken environment secret and reach every
ref. `gh secret list --repo baney75/tabkyra` must not list it.

To cut a release, run `./release.sh patch` on a clean, up-to-date main, then approve the publish job's `release` deployment. Then, on a machine
with the CLI, `tabkyra update --check` exits 100 and `tabkyra update` installs it.

Before the first tag after any change to the secret or the public key, prove they are a pair
with the real minisign: `gh workflow run release-key-check.yml --repo baney75/tabkyra`, then
approve its `release` deployment. It
signs a scratch file and verifies it against `keys/tabkyra-release.pub`, and publishes nothing.

### Rotating the key (not supported yet)

The CLI trusts exactly one built-in public key, and `release.yml` verifies each release
against the one key committed at that tag. So there is no clean rotation today:

- A release signed with a new key is refused by every installed CLI, which only knows the
  old key.
- A "transition" release signed with the old key while shipping the new public key fails
  `release.yml`'s own verify step, which checks against the key in that commit.

Until the CLI and the workflow accept a list of trusted keys (issue #33),
replacing the key means every user reinstalls Tabkyra from a trusted channel. Keep the
current secret in both places; don't replace either unless you mean to make users reinstall.

**If the key leaks:** delete every copy of the secret so you stop signing with it, and publish
nothing more:
`gh secret delete MINISIGN_SECRET_KEY --repo baney75/tabkyra --env release`, plus a
repository-level copy if one ever appears (`gh secret delete MINISIGN_SECRET_KEY --repo
baney75/tabkyra`). Confirm with `gh secret list --repo baney75/tabkyra` and
`gh secret list --repo baney75/tabkyra --env release` that neither lists it.

Then close every other way to publish a release, because a key holder still needs one to reach
installed CLIs (the rulesets protect `v*` tags, not release assets): remove any collaborator
other than baney75 (`gh api repos/baney75/tabkyra/collaborators`), deploy keys with write
access (`gh api repos/baney75/tabkyra/keys`), and GitHub Apps or tokens with `contents: write`
on this repository. Check that no workflow outside `release.yml` grants `contents: write`. That doesn't revoke it. Every installed CLI keeps trusting the leaked key, and
whoever holds it can sign a release those CLIs accept. Tell users to reinstall from a trusted
channel with a CLI that carries a new key. There is no revocation or expiry yet.

**Making a replacement key after a leak.** This is not a rotation: every installed CLI keeps
trusting only the old key, so every user reinstalls. (Rotation without reinstalling needs #33,
and its own procedure: add the new key beside the old one in a release signed by the old key.)

1. On your Mac, in a new folder outside any repo, make a pair without a password (CI signs
   unattended): `minisign -G -W -p tabkyra-release.pub -s tabkyra-release.key`. `minisign` is
   a Homebrew formula (`brew install minisign`). Note the key ID it prints; it is also in the
   `.pub` file's comment line.
2. In one PR, replace `keys/tabkyra-release.pub` with the new file and update the key ID and
   the Pass note name in this section. Merge it.
3. Replace the Proton Pass note's contents with `tabkyra-release.key` and `tabkyra-release.pub`,
   and rename it to "Tabkyra release signing key (minisign <new key ID>)". Then set the secret
   from the file on stdin, never as an argument:
   `gh secret set MINISIGN_SECRET_KEY --repo baney75/tabkyra --env release < tabkyra-release.key`.
4. Run `gh workflow run release-key-check.yml --repo baney75/tabkyra`, approve its `release`
   deployment (the run page, or the `pending_deployments` call above), and wait for it to pass.
   A check that seems to hang is waiting for that approval.
   Push no `v*` tag between step 2 and this passing check: a release in that window would be
   signed with the wrong key for the committed public key.
5. Delete `tabkyra-release.key`. On an SSD with FileVault, deleting is all you can do; the Pass
   note and the environment secret are the intended copies.

## Tests

`cli/test/update.test.mjs` runs the flow against a fake GitHub server on 127.0.0.1 with a
throwaway key (`cli/test/helpers/minisign-sign.mjs`):

- check with nothing published;
- check that exits 100 with JSON;
- a declined install from a checkout;
- a first install from a checkout;
- the installed CLI updating itself;
- a tampered zip, a release signed by another key, a signature made for another version,
  an archive that escapes its folder, and a build with no key, all refused with nothing
  changed;
- rollback and roll forward;
- the nightly channel (a `--check` doesn't save it);
- recovery from a crash in each window of an update and a rollback;
- rollback from a checkout asking first;
- a held lock and a dead one;
- usage errors;
- the native host sending `update_status` to the extension;
- release mode from the side panel (`--host`): the steps, the notes, a tampered archive
  refused, rollback both ways, and the host's command lines accepting nothing else.

`cli/test/checkout-update.test.mjs` runs checkout mode against a throwaway checkout with its
own origin: a fast-forward, local changes, another branch and a diverged main refused, a
failed build leaving the old build, rollback, a copy that is neither mode, skill refresh, and
the native host's update action (the no-parameters rule, the settings actions, the mismatch
report, a browser that loads the extension from another folder).

`test/update-logic.test.mjs` covers the request parser, the idle gate, the extension
location, version mismatches, automatic updates and What's new; `test/update-worker.test.mjs`
covers the service worker relaying only bare actions from Tabkyra's own pages and holding the
reload while a side panel run is going.

The verifier also runs against the upstream minisign test vectors.
