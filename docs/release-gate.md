# Turning the release channels on

The steps that move Polycarp from the one `preview` prerelease to stable, nightly and dev
([releases.md](releases.md), issue #425). The repo can't do these itself: each one is a setting, a secret or a
publish. Do them in this order. **Donovan only** marks the one step only he can do (the signing secrets); the gate
lead does the rest.

## 1. Merge the code

Merge, in order: #443 (versions, feeds, `publish-channel.sh`), #454 (the workflows) and #456 (the app's updater).
`polycarp update --channel` (#437, #529) is already on main. Leave this PR (the installer and the README link) for
step 8.

Check: on main, `bash scripts/check-channels.sh && bash scripts/tests/check-channels-test.sh` exits 0,
`bash spaces/scripts/channels-test.sh` prints `channels-test: pass`, `cat spaces/VERSION` is `0.4.0`, and
`gh workflow list -R baney75/polycarp` shows Nightly, Dev, Promote, Channel build and Stable build.

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

## 5. Secrets

Nightly and dev are built, signed and published by GitHub's hosted macOS runners (`macos-15`; the repository is
public, so the minutes are free). No workflow uses a self-hosted runner, and none may on this public repository.

- **`POLYCARP_RELEASE_TOKEN`** (gate lead): a fine-grained token (or a GitHub App token) with Contents read and
  write on baney75/polycarp, whose actor is the rulesets' bypass. Without it `promote.yml` pushes with the
  workflow's own token, which the rulesets above refuse.

  ```sh
  gh secret set POLYCARP_RELEASE_TOKEN -R baney75/polycarp   # paste the token at the prompt
  ```

- **The signing secrets (Donovan only).** CI signs with the release key pinned in
  `spaces/scripts/release-requirement.txt` (certificate SHA-1 `d1cfbd7446f84f6c625b9db83c5bf96da33b157e`), the
  "BaneySpaces Local Signing" identity on his Mac. Without these two secrets every build workflow warns, builds
  nothing and publishes nothing.

  Export that one identity as a .p12. In Keychain Access, find "BaneySpaces Local Signing" under My Certificates
  (the login keychain, or `~/Library/Application Support/BaneySpaces/Signing/baneyspaces-signing.keychain-db`,
  where `signing-identity.sh` keeps it; add that file with File > Add Keychain if it isn't listed), choose
  File > Export Items, save it as `polycarp-signing.p12`, and give it a password of letters and digits only
  (`ci-signing.sh` refuses others), for example one from `openssl rand -hex 24`. Then:

  ```sh
  base64 -i polycarp-signing.p12 | gh secret set POLYCARP_SIGNING_P12 -R baney75/polycarp
  gh secret set POLYCARP_SIGNING_P12_PASSWORD -R baney75/polycarp   # paste the .p12 password at the prompt
  rm -P polycarp-signing.p12
  gh secret list -R baney75/polycarp   # both names listed
  ```

  The key then lives in GitHub's secrets too. Once both are set, `dev.yml` publishes a dev build after each green
  CI run on main, and `nightly.yml` publishes at 07:00 UTC. Do step 6 the same day.

## 6. The bridge build: the first nightly

After step 5, start the first nightly by hand on the hosted runner, with the bridge:

```sh
gh workflow run nightly.yml -R baney75/polycarp -f bridge=true
gh run watch -R baney75/polycarp "$(gh run list -R baney75/polycarp --workflow nightly.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

It publishes the first nightly (`0.4.0-nightly.<time>+<sha>`): the immutable `nightly-<time>` release and the
rolling `nightly` release, whose notes end in `<!-- baneyspaces commit=<sha> date=<time> -->`. It also puts the
same files on `preview`, whose title becomes "Preview (moved to Nightly)". Run the bridge once. If the 07:00
nightly ran first, the bridge still works later: each build's time makes it newer. On the Mac,
`spaces/scripts/release.sh --channel nightly --bridge` does the same without CI.

Check:

```sh
curl -fsSL https://github.com/baney75/polycarp/releases/download/nightly/latest.json   # "channel": "nightly", the new version
curl -fsSL https://github.com/baney75/polycarp/releases/download/preview/latest.json   # the same version and commit
gh release view nightly -R baney75/polycarp --json isDraft,isPrerelease,body,assets \
  --jq '[.isDraft, .isPrerelease, (.body | test("<!-- baneyspaces commit=[0-9a-f]{40} date=")), [.assets[].name]]'
# [false, true, true, ["Polycarp.dmg","Polycarp.zip","Polycarp.zip.sha256","latest.json"]] in some order
```

Keep `preview` and its `latest.json` served until every install has moved. Never delete it to roll back.

## 7. Live check of the updater

On Donovan's Mac (Polycarp 0.3.0 built from main, Updates channel Nightly, signed with the release key):
Settings > Updates > Check for Updates Now must offer "A new nightly build is available". Its updater reads the
release list, takes the `nightly` release by its marker, and runs that commit's `spaces/install.sh`, which
downloads `releases/download/nightly/Polycarp.zip`, checks its checksum, the release signature and that its
`PolycarpCommit` is the marker's commit, installs it and restarts Polycarp. No permission prompt: the signature is
the same. Then `polycarp-spaces update --check --channel nightly` must say it's up to date, and `--channel dev`
must answer (a dev build, or nothing on Dev yet). `~/Library/Application Support/Polycarp/update.log` shows the
install.

## 8. Merge this PR

Once step 6's nightly feed answers, merge the installer and README change: `install.sh` tries stable, then
nightly, then preview, and the README's download link is the newest nightly.

## 9. The first stable

After the nightly has been out 72 hours with no open `regression` issue:

1. `gh workflow run promote.yml -R baney75/polycarp -f nightly=nightly-<time>`. It fast-forwards `stable`, tags
   `v0.4.0` and makes the draft release, whose notes end in the marker line
   `<!-- baneyspaces commit=<sha> date=<time> -->`. Keep that line in any edit of the notes: builds from before the
   channels find the release by it.
2. The draft gets its files from `stable-build.yml` on the hosted runner (or, without the signing secrets, from
   the Mac: `git checkout v0.4.0 && spaces/scripts/release.sh`).
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
