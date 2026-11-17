# Turning the release channels on

The steps that move Polycarp from the one `preview` prerelease to stable, nightly and dev
([releases.md](releases.md), issue #425). The repo can't do these itself: each one is a setting, a secret or a
publish. Do them in this order. **Donovan** marks the steps that are his; the gate lead does the rest.

## 1. Merge the code

Merge, in order: #443 (versions, feeds, `publish-channel.sh`), #454 (the workflows), #456 (the app's updater) and
#437 (`polycarp update --channel`). Leave this PR (the installer and the README link) for step 8.

Check: on main, `bash scripts/check-channels.sh && bash scripts/tests/check-channels-test.sh` exits 0,
`bash spaces/scripts/channels-test.sh` prints `channels-test: pass`, and `cat spaces/VERSION` is `0.4.0`.

## 2. Labels

```sh
gh label create regression -R baney75/polycarp --color B60205 --description "A change made something worse; blocks promotion to stable"
gh label create blocks-nightly -R baney75/polycarp --color D93F0B --description "With regression: stops the nightly build"
```

`nightly.yml` skips a night while an open issue has both labels. `promote.yml` refuses while any open issue has
`regression`.

## 3. The `stable` environment

Settings > Environments > New environment, named `stable`. Deployment branches: selected branches, `main` only
(`promote.yml` is started from main, and `stable-build.yml` runs inside it). Add Donovan as a required reviewer if
each promotion should wait for his click.

## 4. The `stable` branch and the rulesets

Make the branch once, at main's commit after step 1 (any commit every later nightly contains):

```sh
gh api repos/baney75/polycarp/git/refs -f ref=refs/heads/stable -f sha="$(git rev-parse origin/main)"
```

Then two rulesets (Settings > Rules > Rulesets):

- **stable branch** (target `stable`): restrict deletions, block force pushes, require a pull request (hotfixes
  merge through one). Bypass: only the actor behind `POLYCARP_RELEASE_TOKEN` (step 5), so `promote.yml` can
  fast-forward it.
- **release tags** (target tags `v*`): restrict creations, restrict updates, restrict deletions. Same bypass, so
  only `promote.yml` makes a `vX.Y.Z` tag and no tag ever moves.

## 5. Secrets (Donovan)

- **`POLYCARP_RELEASE_TOKEN`**: a fine-grained token (or a GitHub App token) with Contents read and write on
  baney75/polycarp, whose actor is the rulesets' bypass. Without it `promote.yml` pushes with the workflow's own
  token, which the rulesets above refuse.
- **Signing, Donovan's decision.** The release key pinned in `spaces/scripts/release-requirement.txt` is on his Mac.
  - *Keep it on the Mac* (no signing secrets): `nightly.yml`, `dev.yml` and `stable-build.yml` warn and publish
    nothing. Each nightly is `spaces/scripts/release.sh --channel nightly` on the Mac, and each stable upload is
    `git checkout vX.Y.Z && spaces/scripts/release.sh`.
  - *Let CI sign*: add `POLYCARP_SIGNING_P12` (base64 of a .p12 holding that key) and
    `POLYCARP_SIGNING_P12_PASSWORD` (letters and digits only, such as `openssl rand -hex 24`) as repository
    secrets. Nightly and dev then publish on their own. The key then lives in GitHub too.

  If CI signs, add the secrets only after step 6, so the 07:00 nightly can't publish before the bridge build.

## 6. The bridge build: the first nightly

On the Mac, on a clean checkout of main after step 1:

```sh
cd spaces
scripts/release.sh --channel nightly --bridge --dry-run   # builds and checks, uploads nothing
scripts/release.sh --channel nightly --bridge
```

It publishes the first nightly (`0.4.0-nightly.<time>+<sha>`) and puts the same files on `preview`, whose title
becomes "Preview (moved to Nightly)". Run `--bridge` once, never again.

Check:

```sh
curl -fsSL https://github.com/baney75/polycarp/releases/download/nightly/latest.json   # "channel": "nightly", the new version
curl -fsSL https://github.com/baney75/polycarp/releases/download/preview/latest.json   # the same version and commit
```

Keep `preview` and its `latest.json` served until every install has moved. Never delete it to roll back.

## 7. Live check of the updater

On a Mac with a preview build installed, Settings > Updates > Check for Updates Now must offer the nightly. Install it, then
`polycarp-spaces update --check --channel nightly` must say it's up to date, and `--channel dev` must answer (a
dev build, or nothing on Dev yet).

## 8. Merge this PR

Once step 6's nightly feed answers, merge the installer and README change: `install.sh` tries stable, then
nightly, then preview, and the README's download link is the newest nightly.

## 9. The first stable

After the nightly has been out 72 hours with no open `regression` issue:

1. `gh workflow run promote.yml -R baney75/polycarp -f nightly=nightly-<time>`. It fast-forwards `stable`, tags
   `v0.4.0` and makes the draft release, whose notes end in the marker line
   `<!-- baneyspaces commit=<sha> date=<time> -->`. Keep that line in any edit of the notes: builds from before the
   channels find the release by it.
2. The draft gets its files from `stable-build.yml` (CI signing) or from the Mac:
   `git checkout v0.4.0 && spaces/scripts/release.sh`.
3. Install the draft's build on rectory1 and run `scripts/soak-check.sh` there until it prints `SOAK PASSED`.
   Sol APPROVE must name the receipt path (spaces/AGENTS.md, "Stable releases").
4. On the Mac: `spaces/scripts/release.sh --soak <receipt>`. That publishes the draft as Latest, which is the
   stable feed.
5. A pull request points the README's download link at
   `https://github.com/baney75/polycarp/releases/latest/download/Polycarp.dmg` (and `EasyInstallTests` with it).

Check: `curl -fsSL https://github.com/baney75/polycarp/releases/latest/download/latest.json` says
`"channel": "stable"` and `0.4.0`.

## 10. After each stable

A pull request moves `spaces/VERSION` on main to the next minor version (after 0.4.0, 0.5.0), so every nightly
sorts above the stable it follows. Patches are hotfixes merged into `stable` and released with
`promote.yml -f hotfix=true`.
