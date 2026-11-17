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
checked by the installer before anything is replaced. `verify-release.sh` fails a release whose feed doesn't
name its zip's checksum, version and commit.

## Publishing

Release builds are signed on the owner's Mac; the key never leaves it.

- Nightly and dev: `spaces/scripts/release.sh --channel nightly|dev` on a clean checkout of `main`. It builds,
  signs, packages and verifies, then `publish-channel.sh` uploads into a draft, downloads it back, checks it, and
  only then moves the rolling tag. It refuses a build that isn't newer than its feed's.
- Stable: `promote.yml` tags `vX.Y.Z` on `stable` and makes the draft release. Then, on the stable checkout at
  that tag, `spaces/scripts/release.sh` uploads and leaves the draft. After `scripts/soak-check.sh` prints
  `SOAK PASSED` on rectory1 for that build, `spaces/scripts/release.sh --soak <receipt>` publishes it as Latest,
  which is the stable feed. A `--ci` receipt never counts (spaces/AGENTS.md, "Stable releases").

No workflow starts on a pushed tag. `scripts/check-channels.sh` (copied from local-studio) checks that and the
version order on every pull request (`.github/workflows/channels.yml`), with `spaces/scripts/channels-test.sh`.

## From preview to nightly

Until November 2026 Polycarp shipped one rolling prerelease, `preview`, whose builds carried the plain base
version (`0.3.0`). `nightly` sorts below a plain version of the same base, so `main` went to `0.4.0` at the
rename. One bridge build (`release.sh --channel nightly --bridge`) is both the first nightly and the last
preview: its updater follows nightly, and the `preview` release keeps serving it, with a `latest.json`, until
every install has moved. Then `preview` is retired. Releases are never deleted to roll back: re-publish the last
good `latest.json` and fix forward.
