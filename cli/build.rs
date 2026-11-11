//! Stamps the build with the monorepo commit it came from (POLYCARP_BUILD_STAMP): the full sha, the
//! commit's date (UTC) and whether tracked files had changes. `polycarp --version` and `polycarp version` print it, and
//! `polycarp update` compares it with the other parts. Outside a git checkout the three are empty.
//!
//! POLYCARP_BUILD_COMMIT, POLYCARP_BUILD_DATE and POLYCARP_BUILD_DIRTY override what git says, for a
//! build made from an unpacked source archive.

use std::process::Command;

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn main() {
    for key in [
        "POLYCARP_BUILD_COMMIT",
        "POLYCARP_BUILD_DATE",
        "POLYCARP_BUILD_DIRTY",
    ] {
        println!("cargo:rerun-if-env-changed={key}");
    }
    // Naming any file turns off cargo's own "rerun when the package changes", so name the sources too:
    // an edit to them can make the tree dirty.
    for path in ["build.rs", "src", "Cargo.toml", "../themes"] {
        println!("cargo:rerun-if-changed={path}");
    }
    // HEAD's log changes on every commit, checkout and reset; the index changes when files are staged.
    for file in ["logs/HEAD", "HEAD", "index"] {
        if let Some(path) = git(&["rev-parse", "--git-path", file]) {
            println!("cargo:rerun-if-changed={path}");
        }
    }
    let given = |key: &str| std::env::var(key).ok().filter(|v| !v.is_empty());
    let commit = given("POLYCARP_BUILD_COMMIT")
        .or_else(|| git(&["rev-parse", "HEAD"]))
        .filter(|c| c.len() >= 7 && c.chars().all(|ch| ch.is_ascii_hexdigit()))
        .unwrap_or_default();
    let date = given("POLYCARP_BUILD_DATE")
        .or_else(|| {
            // The same shape bundle.sh writes into the app's Info.plist.
            Command::new("git")
                .env("TZ", "UTC")
                .args([
                    "log",
                    "-1",
                    "--format=%cd",
                    "--date=format-local:%Y-%m-%dT%H:%M:%SZ",
                ])
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        })
        .unwrap_or_default();
    // Tracked files only: build output and the sibling checkouts are untracked or ignored.
    let dirty = match given("POLYCARP_BUILD_DIRTY") {
        Some(v) => v == "1" || v == "true",
        None => {
            git(&["status", "--porcelain", "--untracked-files=no"]).is_some_and(|s| !s.is_empty())
        }
    };
    // One line inside the binary, so `polycarp version` can read an installed command's build from its
    // file without running it (the Linux spaces binary carries the same):
    //   polycarp-build|v1|<full sha>|<commit date, UTC>|<1 when tracked files had changes, else 0>|<version>|end|
    println!(
        "cargo:rustc-env=POLYCARP_BUILD_STAMP=polycarp-build|v1|{commit}|{date}|{}|{}|end|",
        if dirty { "1" } else { "0" },
        std::env::var("CARGO_PKG_VERSION").unwrap_or_default()
    );
}
