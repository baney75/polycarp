# Releases

Polycarp has one update stream. Every commit to `main` whose CI passes is built, signed and published to the
rolling `nightly` release, and every installed copy updates from it. Polycarp no longer follows the stable, nightly
and dev channel scheme of [local-studio](https://github.com/baney75/local-studio/blob/main/docs/channels.md): there is
no stable branch, no promotion and no channel choice.

## The release

| Release | Holds | Kept |
| --- | --- | --- |
| `nightly` | the newest build, rolling | always |
| `nightly-YYYYMMDDHHMMSS` | one build, immutable | 14 days, and always the newest and the one the feed names |
| `dev` | the newest build again, with a dev-shaped feed (see "One stream") | until the mirror is retired |

Each release carries `Polycarp.zip`, `Polycarp.zip.sha256`, `Polycarp.dmg` and `latest.json`, built for Apple
silicon. The feed is `https://github.com/baney75/polycarp/releases/download/nightly/latest.json` and the download
link on dbaney.com is `nightly/Polycarp.dmg`.

Install mode is **replace**: one app (`com.baney.polycarp`), signed by the one identity in
`spaces/scripts/release-requirement.txt`, so an update never asks for a macOS permission again.

## Versions

The base version is `spaces/VERSION`. `spaces/scripts/build-version.sh` prints the string a build carries:

| Build | Version | Example |
| --- | --- | --- |
| release | `X.Y.Z-nightly.YYYYMMDDHHMMSS+<sha7>` | `0.4.0-nightly.20261118070000+1a2b3c4` |
| local build | `X.Y.Z-dev.0+local.<sha7>` | `0.4.0-dev.0+local.9f8e7d6` |

`spaces/scripts/bundle.sh` stamps it into the app: `PolycarpVersion` (the full string), `PolycarpChannel`
(`nightly` for a release build, `local` otherwise), `CFBundleShortVersionString` (`X.Y.Z`) and `CFBundleVersion`
(the build time, `YYYYMMDD.HHMMSS`). A release build sets `POLYCARP_RELEASE=1`; nothing else does, so a local
build never passes for a release one.

## The feed

`spaces/scripts/write-feed.sh` writes `latest.json`: Tauri v2's updater manifest plus `product`, `channel`
(always `nightly`), `commit`, `protocol` and `sha256`. Polycarp's Mac app does not check Tauri's minisign
`signature` (it is empty). An update is trusted by the code signature (`requirement`, the release requirement)
and the zip's `sha256`, both checked by the installer before anything is replaced. The feed's `url` names the
immutable `nightly-YYYYMMDDHHMMSS` release, so any copy of a feed stays good for the 14 days that release is kept.
`verify-release.sh` fails a release whose feed doesn't name its zip's checksum, version and commit.

## Publishing

Every release is signed by the one release identity. Without it nothing ships: an ad-hoc build never does.

`release.yml` starts when CI passes on a push to main, or by hand. It builds that commit when it is ahead of the
one `nightly` offers and publishes it (see "One stream" below). A run that is publishing is never cancelled; a
newer one waits. It waits while an open issue is labeled both `regression` and `blocks-nightly`, and it deletes
`nightly-<time>` prereleases over 14 days old.

Builds run on GitHub's hosted macOS runners (`macos-15`, free for this public repository), never a self-hosted
one, with the same script the Mac runs: `spaces/scripts/release.sh`. They sign only when the repository has the
secrets `POLYCARP_SIGNING_P12` (base64 of the owner's signing keychain, or of a .p12, holding the key
`release-requirement.txt` pins) and `POLYCARP_SIGNING_P12_PASSWORD` (its password: letters, digits and `.-_`),
which `spaces/scripts/ci-signing.sh` opens, or imports into a throwaway keychain. Without them the
run warns, builds nothing and publishes nothing. The owner sets both from the Mac that holds the key with one
command, `spaces/scripts/set-ci-signing.sh`: it checks the signing keychain holds only the pinned key, sets the
keychain file and its password through `gh` and prints neither. It exports nothing, since the key trusts only
`/usr/bin/codesign` and macOS would ask on screen first.

The owner's Mac can still publish by hand: `spaces/scripts/release.sh` on a clean checkout of a commit on
`origin/main` builds, signs, packages and verifies, then `publish.sh` uploads into drafts, downloads them back,
checks them, and only then moves the rolling tags. `--dry-run` skips the main check and the publish, so it
runs on a branch.

No workflow starts on a pushed tag. `spaces/scripts/channels-test.sh` checks that on every pull request
(`.github/workflows/channels.yml`), along with the version order, that CI signing fails closed, and the releases
the publisher leaves.

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
