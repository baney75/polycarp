# Releases

Polycarp ships on three channels, **stable**, **nightly** and **dev**, under the one scheme every Local Studio
product follows: [docs/channels.md in baney75/local-studio](https://github.com/baney75/local-studio/blob/main/docs/channels.md).
Where this file and that one disagree, that one wins. This file says how Polycarp does it.

## Channels

| Channel | Built from | Tag | Feed (`latest.json`) |
| --- | --- | --- | --- |
| stable | `stable` branch | `vX.Y.Z`, immutable | `https://github.com/baney75/polycarp/releases/latest/download/latest.json` |
| nightly | `main` | rolling `nightly`, plus `nightly-YYYYMMDDHHMMSS` kept 14 days | `https://github.com/baney75/polycarp/releases/download/nightly/latest.json` |
| dev | `main` | rolling `dev` | `https://github.com/baney75/polycarp/releases/download/dev/latest.json` |

Each release carries `Polycarp.zip`, `Polycarp.zip.sha256`, `Polycarp.dmg` and `latest.json`. Nightly and dev are
Apple silicon; stable is universal.

Dev is for testing. Settings > Updates lists it only on a dev build (`PolycarpChannel` is `dev`) or a copy whose
saved choice is already dev, and the app refuses `update --channel dev` anywhere else (`UpdateChannel.offered`). A local
build counts as stable there, as it does for the updater.

Install mode is **replace**: one app (`com.baney.polycarp`) for every channel, signed by the one identity in
`spaces/scripts/release-requirement.txt`, so moving between channels never asks for a macOS permission again.
Because every channel shares that identity, the feeds keep the channels apart, not the keys.

## Versions

The base version is `spaces/VERSION`. `spaces/scripts/channel-version.sh` prints the string a build carries:

| Channel | Version | Example |
| --- | --- | --- |
| stable | `X.Y.Z` | `0.4.0` |
| nightly | `X.Y.Z-nightly.YYYYMMDDHHMMSS+<sha7>` | `0.4.0-nightly.20261118070000+1a2b3c4` |
| dev | `X.Y.Z-dev.YYYYMMDDHHMMSS+<sha7>` | `0.4.0-dev.20261117131042+9f8e7d6` |
| local build | `X.Y.Z-dev.0+local.<sha7>` | `0.4.0-dev.0+local.9f8e7d6` |

`spaces/scripts/bundle.sh` stamps it into the app: `PolycarpVersion` (the full string), `PolycarpChannel`
(`stable`, `nightly`, `dev`, or `local` when `POLYCARP_CHANNEL` is unset), `CFBundleShortVersionString` (`X.Y.Z`)
and `CFBundleVersion` (the build time, `YYYYMMDD.HHMMSS`). The updater compares versions within its own channel.
After stable `X.Y.Z` ships, `main` bumps to `X.(Y+1).0`; patches belong to hotfixes on `stable`.

## The feed

`spaces/scripts/write-feed.sh` writes `latest.json`: Tauri v2's updater manifest plus `product`, `channel`,
`commit`, `protocol` and `sha256`. Polycarp's Mac app does not check Tauri's minisign `signature` (it is empty).
An update is trusted by the code signature (`requirement`, the release requirement) and the zip's `sha256`, both
checked by the installer before anything is replaced. A feed's `url` names a release whose files never change: `vX.Y.Z` for stable and
`nightly-YYYYMMDDHHMMSS` for nightly, so any copy of a nightly feed stays good for the 14 days that release is
kept. Dev has only its rolling release, so a dev feed is good until the next dev build and can't be rolled back to. `verify-release.sh` fails a release whose feed doesn't
name its zip's checksum, version and commit.

## Publishing

Every release is signed by the one release identity. Without it nothing ships: an ad-hoc build never does.

| Workflow | Starts on | Does |
| --- | --- | --- |
| `release.yml` | CI passing on a push to main, or by hand | Builds that commit when it is ahead of the one `nightly` offers, and publishes it (see "One stream" below). A run that is publishing is never cancelled; a newer one waits. Waits while an open issue is labeled both `regression` and `blocks-nightly`. Deletes `nightly-<time>` prereleases over 14 days old, always keeping the newest. |
| `promote.yml` | By hand only, with `nightly=nightly-<time>` or `hotfix=true` | Checks the nightly is 72 hours old, stable is behind it and no `regression` issue is open (a hotfix: VERSION is the last tag's patch + 1). Fast-forwards `stable`, tags `vX.Y.Z` on it, makes the draft release, then calls `stable-build.yml`. |
| `stable-build.yml` | `promote.yml` only | Builds the universal app at the tag and uploads it into the draft. It never publishes. |

Nightly and dev are built, signed and published on GitHub's hosted macOS runners (`macos-15`, free for this
public repository). No workflow here uses a self-hosted runner. `release.yml` and `stable-build.yml` run
the same scripts the Mac runs: `spaces/scripts/release.sh` (`--channel nightly`, or the stable path). They
sign only when the repository has the secrets
`POLYCARP_SIGNING_P12` (base64 of the owner's signing keychain, or of a .p12, holding the key
`release-requirement.txt` pins) and `POLYCARP_SIGNING_P12_PASSWORD` (its password: letters, digits, dot, dash or underscore), which
`spaces/scripts/ci-signing.sh` unlocks, or imports into a throwaway keychain. Without them the run warns, builds nothing and
publishes nothing. The owner sets both from the Mac that holds the key with one command,
`spaces/scripts/set-ci-signing.sh`: it checks the signing keychain holds only the pinned key, sets the keychain file
and its password through `gh` and prints neither. It exports nothing, since the key trusts only `/usr/bin/codesign`
and macOS would ask on screen first. The owner's Mac can still publish by hand:

- Nightly: `spaces/scripts/release.sh --channel nightly` on a clean checkout of `main`. It builds, signs,
  packages and verifies, then `publish.sh` uploads into a draft, downloads it back, checks it, and only then
  moves the rolling tags. It refuses a build that isn't newer than the nightly feed's.
- Stable: after `promote.yml`, `git checkout vX.Y.Z && spaces/scripts/release.sh` uploads into the draft.

Stable is published only from the Mac: after `scripts/soak-check.sh` prints `SOAK PASSED` on rectory1 for that
build, `spaces/scripts/release.sh --soak <receipt>` checks the uploaded files again and publishes the draft as
Latest, which is the stable feed. A `--ci` receipt never counts (spaces/AGENTS.md, "Stable releases").

`promote.yml` runs in the `stable` environment. Pushing to `stable` needs a token its ruleset lets through: the
optional secret `POLYCARP_RELEASE_TOKEN`, else the workflow's own token. The `stable` branch is made once by hand;
`promote.yml` never makes it. After stable `X.Y.Z` ships, a pull request moves `main` to `X.(Y+1).0`.

No workflow starts on a pushed tag. `scripts/check-channels.sh` (copied from local-studio) checks that and the
version order on every pull request (`.github/workflows/channels.yml`), with `spaces/scripts/channels-test.sh`,
which also checks that CI signing fails closed and that no workflow publishes a stable release.

## One stream

Every build `release.yml` publishes goes to three releases: the immutable `nightly-<time>` its feed names, the
rolling `nightly` (the download link on dbaney.com and the feed copies read), and the rolling `dev`. Dev is no
longer built on its own. Its release holds the same files with a `latest.json` said the old dev way (`channel`
`dev`, version `X.Y.Z-dev.<time>+<sha7>`), because a copy that reads the dev feed refuses any other: a dev build,
or any copy whose Settings chose Dev. Such a copy installs the build from the `dev` release (the zip, or the `dev`
tag when it builds from source) and, once it runs an app with no channel choice, reads the nightly feed.
`verify-release.sh` accepts that feed only as the same build with `-nightly.` said as `-dev.`.

Each publish checks every draft before it publishes any, then moves `dev` before `nightly`. A run that stops
partway leaves `nightly` behind, so the gate still takes that commit: start Release again by hand and it finishes
both. The gate skips a commit from before `publish.sh`, whose release script would move `nightly` alone.

Keep the dev mirror until every copy that read the dev feed runs an app with no channel choice. A download count
can't show that, since each publish replaces the `dev` release and its count starts again at zero. Its last build
stays installable from it after it stops.

## From preview to nightly

Until November 2026 Polycarp shipped one rolling prerelease, `preview`, whose builds carried the plain base
version (`0.3.0`). `nightly` sorts below a plain version of the same base, so `main` went to `0.4.0` at the
rename. One bridge build (published 2026-11-22; the step is gone now) was both the first nightly and the last
preview: its updater follows nightly, and the `preview` release keeps serving it, with a `latest.json`, until
every install has moved. Then `preview` is retired. Releases are never deleted to roll back: re-publish the last
good `latest.json` and fix forward.

A copy from before the channels (0.3.0 and older) doesn't read `latest.json`. On the Nightly channel it reads
GitHub's release list, takes the release tagged exactly `nightly`, and reads the commit and date from the
`<!-- baneyspaces commit=<sha> date=<ISO> -->` line of its notes. `publish.sh` writes that line into every
nightly's notes, so such a copy is offered the newest nightly, installs it with the `install.sh` of that commit
(the ready-made `Polycarp.zip` when it is signed with the release identity, else a build on the Mac). The build it lands on follows `latest.json` once
it has the updater that reads it. `channels-test.sh` runs the publisher against a stand-in for GitHub and checks
the releases it leaves the way those updaters read them.

The settings, secrets and publishes that turn the channels on, in order, are in [release-gate.md](release-gate.md).
