//! `polycarp update`: one command that brings every Polycarp part on this device to origin/main.
//!
//! It works in two halves. `plan` is a pure function: from the platform, how Polycarp is installed
//! here and the options, it returns the steps as data (a title and an argv each) or a refusal.
//! `execute` then runs the steps in order through a `Runner`, stops at the first failure and says what
//! state things are in. `--dry-run` prints the plan and runs nothing.
//!
//! Only origin/main is ever built and installed, and only from a clean copy of it under the cache
//! folder: never from a branch, a changed tree or the checkout a person works in. Nothing that is
//! installed runs from that cache folder: on Linux the browser helper and the extension are copied to
//! `~/.local/share/polycarp/browser/source`.
//!
//! The `polycarp` that starts an update may be older than the one it installs (the first run is a
//! build in a checkout). So the plan ends by handing over: the newly installed command runs
//! `polycarp update --finish`, which reloads, restarts and does the final check by its own rules.

use std::ffi::OsString;
use std::fs;
use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::version::{self, Part};

/// The exit code for "an update is available", the same one `polycarp browser update --check` uses.
pub const AVAILABLE: i32 = 100;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Platform {
    Mac,
    Linux,
    Windows,
}

/// How Polycarp got onto this device, which decides how it is updated.
#[derive(Debug, Clone, PartialEq)]
pub enum Install {
    /// Built from a checkout: `--source`, or the path recorded in source.toml.
    Source {
        checkout: PathBuf,
        /// The checkout's `origin` address, when it has one.
        origin: Option<String>,
        /// Tracked files in the checkout have changes. They are never built; the plan says so.
        dirty: bool,
    },
    /// A Mac app from the disk image or the installer, with no source record: the app updates itself.
    MacRelease { spaces: Option<PathBuf> },
    /// Nothing says where Polycarp came from.
    Unknown,
}

/// Everything `plan` needs to know about this device. Reading it changes nothing.
#[derive(Debug, Clone, PartialEq)]
pub struct Facts {
    pub platform: Platform,
    pub install: Install,
    /// The clean copy of origin/main that is built, under the cache folder.
    pub worktree: PathBuf,
    pub worktree_exists: bool,
    pub home: PathBuf,
    /// The `polycarp` that is running this update. It runs the steps up to the install.
    pub polycarp: PathBuf,
    /// The `polycarp` the update installs (`~/.local/bin/polycarp`). It is the one compared with
    /// origin/main, and the one that finishes the update.
    pub installed: PathBuf,
    /// Linux: where the browser helper and the extension are installed, outside the cache.
    pub browser_home: PathBuf,
    /// Apple silicon builds for itself only, as the installer does.
    pub arm64: bool,
    /// Linux: `~/.config/hypr/hyprland.lua` is there, so the Omarchy install script applies.
    pub hyprland: bool,
    /// Linux: Node and npm are on PATH, so the browser helper can be built.
    pub node: bool,
    /// The agent skill is installed, so an update refreshes it.
    pub skill_installed: bool,
    /// Input and output are a terminal, so the plan can be shown and confirmed.
    pub terminal: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Options {
    pub check: bool,
    pub dry_run: bool,
    pub yes: bool,
    /// `--finish`: the last steps only, run by the newly installed command.
    pub finish: bool,
}

/// What a step is for. It decides what a failure means and what the failure message says.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Role {
    /// Fetches or prepares the clean copy. Touches nothing that is installed.
    Git,
    /// Asks whether there is anything to do. Exit 0: up to date, stop here. Exit 100: carry on.
    Gate,
    /// Builds inside the clean copy.
    Build,
    /// Changes what is installed.
    Install,
    /// Worth doing, but a failure does not stop the update (reloading the extension while an agent works).
    Soft,
    /// The check at the end: every part the update installs is at origin/main.
    Verify,
    /// The last step of an install: the newly installed `polycarp` runs `update --finish`.
    Handoff,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Step {
    pub title: String,
    pub argv: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub env: Vec<(String, String)>,
    pub role: Role,
}

impl Step {
    fn new(role: Role, title: &str, argv: &[&str]) -> Step {
        Step {
            title: title.to_string(),
            argv: argv.iter().map(|a| a.to_string()).collect(),
            cwd: None,
            env: Vec::new(),
            role,
        }
    }
    fn in_dir(mut self, dir: &Path) -> Step {
        self.cwd = Some(dir.to_path_buf());
        self
    }
    fn with_env(mut self, env: &[(String, String)]) -> Step {
        self.env = env.to_vec();
        self
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Plan {
    /// Nothing is run. `code` is the exit code.
    Refuse { code: i32, message: String },
    Run {
        /// One line saying what kind of update this is.
        summary: String,
        steps: Vec<Step>,
        /// Things a person should know before saying yes.
        notes: Vec<String>,
        /// Show the plan and ask once before running it.
        ask: bool,
    },
}

/// True for the addresses of the Polycarp repo on GitHub, over https or ssh.
pub fn is_polycarp_origin(url: &str) -> bool {
    let u = url.trim().trim_end_matches('/').to_ascii_lowercase();
    let u = u.strip_suffix(".git").unwrap_or(&u);
    [
        "https://github.com/baney75/polycarp",
        "git@github.com:baney75/polycarp",
        "ssh://git@github.com/baney75/polycarp",
    ]
    .contains(&u)
}

const WINDOWS: &str = "\
polycarp update is not supported on Windows yet. Build from source instead, in a checkout of
https://github.com/baney75/polycarp (see spaces/platforms/windows/README.md):

  git pull
  cargo install --locked --path cli
  cd spaces
  cargo build --release --locked -p baneyspaces-windows
  platforms/windows/scripts/build-engine.ps1 -Install

`polycarp version` works on Windows and shows what is installed.";

const NO_SOURCE: &str = "\
polycarp update does not know how Polycarp was installed on this device.
Point it at a checkout of https://github.com/baney75/polycarp once:

  polycarp update --source /path/to/polycarp

It remembers the path (source.toml in Polycarp's config folder) and from then on `polycarp update`
fetches origin/main, builds it in a clean copy and installs every part.";

fn s(p: &Path) -> String {
    p.display().to_string()
}

/// The steps for this device, or why there are none. Pure: it reads nothing and runs nothing.
pub fn plan(f: &Facts, o: Options) -> Plan {
    if f.platform == Platform::Windows {
        return Plan::Refuse {
            code: 2,
            message: WINDOWS.to_string(),
        };
    }
    let (summary, steps, notes) = match &f.install {
        Install::Unknown => {
            return Plan::Refuse {
                code: 2,
                message: NO_SOURCE.to_string(),
            };
        }
        Install::MacRelease { spaces: None } => {
            return Plan::Refuse {
                code: 1,
                message: "polycarp update: Polycarp.app is installed, but its polycarp-spaces command was not found, so the app cannot be asked to update itself. Open Polycarp and use Settings > Updates, or run `polycarp update --source <checkout>` to build from source.".to_string(),
            };
        }
        Install::MacRelease {
            spaces: Some(spaces),
        } => release_steps(spaces, o),
        Install::Source {
            checkout,
            origin,
            dirty,
        } => {
            match origin.as_deref() {
                Some(url) if is_polycarp_origin(url) => {}
                Some(url) => {
                    return Plan::Refuse {
                        code: 1,
                        message: format!(
                            "polycarp update: {} has origin {url}, which is not the Polycarp repo (https://github.com/baney75/polycarp). Nothing was run. Give a checkout of that repo with --source.",
                            checkout.display()
                        ),
                    };
                }
                None => {
                    return Plan::Refuse {
                        code: 1,
                        message: format!(
                            "polycarp update: {} is not a git checkout with an origin. Nothing was run. Give a checkout of https://github.com/baney75/polycarp with --source.",
                            checkout.display()
                        ),
                    };
                }
            }
            source_steps(f, checkout, *dirty, o)
        }
    };
    // Looking is always allowed. Changing things needs a yes: the flag, or one answer on a terminal.
    // `--finish` is run by an update that already had its yes.
    let changes = !o.check && !o.dry_run && !o.finish;
    if changes && !o.yes && !f.terminal {
        return Plan::Refuse {
            code: 2,
            message: "polycarp update: there is no terminal to ask on, so nothing was run. Add --yes to run the plan, or --dry-run to see it.".to_string(),
        };
    }
    Plan::Run {
        summary,
        steps,
        notes,
        ask: changes && !o.yes,
    }
}

fn release_steps(spaces: &Path, o: Options) -> (String, Vec<Step>, Vec<String>) {
    let spaces = s(spaces);
    let summary = "release install: Polycarp.app updates itself".to_string();
    if o.check {
        let step = Step::new(
            Role::Gate,
            "Ask Polycarp whether a newer release is out",
            &[&spaces, "update", "--check"],
        );
        return (summary, vec![step], Vec::new());
    }
    let step = Step::new(
        Role::Install,
        "Ask Polycarp to install the newest release",
        &[&spaces, "update", "--now"],
    );
    let notes = vec![
        "Polycarp downloads the release in the background, checks that it is signed with the release key, installs it and restarts itself. Run `polycarp version --check` once it is back.".to_string(),
    ];
    (summary, vec![step], notes)
}

/// `git fetch` with the refspec spelled out, so origin/main moves even in a checkout that tracks one branch.
const FETCH: [&str; 3] = [
    "fetch",
    "origin",
    "+refs/heads/main:refs/remotes/origin/main",
];
const TARGET: &str = "refs/remotes/origin/main";

/// The parts an update on this device installs, as `polycarp version` names them. The gate and the
/// final check need each of them to be installed, so a part that is missing is installed by the
/// next update and never passes for "up to date".
fn needs(f: &Facts) -> String {
    let mut names = vec!["polycarp command"];
    match f.platform {
        Platform::Mac => names.extend(["app", "spaces command", "browser helper"]),
        Platform::Linux => {
            if f.hyprland {
                names.push("spaces command");
            }
            if f.node {
                names.push("browser helper");
            }
        }
        Platform::Windows => {}
    }
    names.join(",")
}

fn source_steps(
    f: &Facts,
    checkout: &Path,
    dirty: bool,
    o: Options,
) -> (String, Vec<Step>, Vec<String>) {
    let (co, wt, me) = (s(checkout), s(&f.worktree), s(&f.polycarp));
    let installed = s(&f.installed);
    let needs = needs(f);
    let summary = format!("source install: origin/main of {co}, built in {wt}");
    let mut notes = Vec::new();
    if o.finish {
        // Run by the command this update just installed: only what comes after the install.
        return (summary, finish_steps(f), notes);
    }
    let mut steps = vec![Step::new(
        Role::Git,
        "Fetch origin/main",
        &["git", "-C", &co, FETCH[0], FETCH[1], FETCH[2]],
    )];
    if o.check {
        steps.push(Step::new(
            Role::Gate,
            "Compare what is installed with origin/main",
            &[
                &me,
                "update",
                "--is-current",
                &co,
                TARGET,
                "--needs",
                &needs,
            ],
        ));
        return (summary, steps, notes);
    }
    if dirty {
        notes.push(format!(
            "{co} has uncommitted changes. They are left alone and are not installed: only origin/main is."
        ));
    }
    if f.worktree_exists {
        steps.push(Step::new(
            Role::Git,
            "Reset the clean copy to origin/main",
            &["git", "-C", &wt, "reset", "--hard", TARGET],
        ));
        steps.push(Step::new(
            Role::Git,
            "Remove stray files from the clean copy",
            &["git", "-C", &wt, "clean", "-fd"],
        ));
    } else {
        steps.push(Step::new(
            Role::Git,
            "Forget clean copies that were deleted",
            &["git", "-C", &co, "worktree", "prune"],
        ));
        steps.push(Step::new(
            Role::Git,
            "Make a clean copy of origin/main",
            &[
                "git", "-C", &co, "worktree", "add", "--detach", "--force", &wt, TARGET,
            ],
        ));
    }
    steps.push(Step::new(
        Role::Gate,
        "Stop here if every part this update installs is already at that commit",
        &[
            &me,
            "update",
            "--is-current",
            &wt,
            "HEAD",
            "--needs",
            &needs,
        ],
    ));
    match f.platform {
        Platform::Mac => mac_steps(f, &mut steps),
        Platform::Linux => linux_steps(f, &mut steps, &mut notes),
        Platform::Windows => {}
    }
    let last: Vec<String> = finish_steps(f).into_iter().map(|st| st.title).collect();
    steps.push(Step::new(
        Role::Handoff,
        "Hand over to the polycarp that was just installed, for the last steps",
        &[&installed, "update", "--finish", "--source", &co],
    ));
    notes.push(format!(
        "The last step is run by the newly installed command ({installed}), by its own rules. With this version they are: {}.",
        last.join("; ")
    ));
    if f.polycarp != f.installed {
        notes.push(format!(
            "This polycarp ({me}) is not the installed command. It fetches, builds and installs. The installed one ({installed}) is the one compared with origin/main, and the one that finishes the update, so an updater older than what it installs changes nothing about the result."
        ));
    }
    (summary, steps, notes)
}

/// What comes after the install, built and run by the newly installed command (`update --finish`):
/// reload the extension, restart what runs, and check every part against the clean copy's commit.
fn finish_steps(f: &Facts) -> Vec<Step> {
    let installed = s(&f.installed);
    let wt = s(&f.worktree);
    let mut steps = Vec::new();
    const RELOAD: &str =
        "Reload the extension, unless an agent is working in the browser, and wait for it to run the new build";
    match f.platform {
        Platform::Mac => steps.push(reload_step(
            f,
            RELOAD,
            &[&installed, "browser", "reload", "--if-idle"],
        )),
        Platform::Linux => {
            if f.node {
                let entry = s(&f.browser_home.join("cli/dist/index.js"));
                steps.push(
                    reload_step(f, RELOAD, &["node", &entry, "reload", "--if-idle"])
                        .in_dir(&f.browser_home),
                );
            }
            if f.hyprland {
                // The repo's restart path: the daemon refuses to run twice, and a config reload starts it.
                steps.push(Step::new(
                    Role::Soft,
                    "Stop the running spaces daemon",
                    &[&s(&f.home.join(".local/bin/baneyspaces")), "stop"],
                ));
                steps.push(Step::new(
                    Role::Soft,
                    "Reload Hyprland, which starts the new daemon",
                    &["hyprctl", "reload"],
                ));
            }
        }
        Platform::Windows => {}
    }
    steps.push(Step::new(
        Role::Verify,
        "Check that every part this update installs is at origin/main",
        &[
            &installed,
            "update",
            "--is-current",
            &wt,
            "HEAD",
            "--needs",
            &needs(f),
            "--after-install",
            "--wait",
            "30",
        ],
    ));
    steps
}

/// The reload, run by `update --reload-wait`: it reloads, waits for every connected extension to report
/// the clean copy's commit, and reloads once more if one still runs the old build (#207).
fn reload_step(f: &Facts, title: &str, reload: &[&str]) -> Step {
    let (installed, wt) = (s(&f.installed), s(&f.worktree));
    let mut argv = vec![
        installed.as_str(),
        "update",
        "--reload-wait",
        wt.as_str(),
        "HEAD",
        "--wait",
        "30",
        "--",
    ];
    argv.extend_from_slice(reload);
    Step::new(Role::Soft, title, &argv)
}

/// `npm install` in the sibling setup can rewrite a package-lock.json. In the clean copy that is the only
/// kind of change there can be, and it would stamp every part built after it as "dirty", so it is undone.
fn restore_step(worktree: &Path) -> Step {
    Step::new(
        Role::Git,
        "Put back any tracked file the setup rewrote",
        &["git", "-C", &s(worktree), "checkout", "--", "."],
    )
}

/// `browser/scripts/setup-siblings.sh`: it clones the pinned pi-mono and mini-lit next to `browser/`
/// and runs `npm install` in `browser/` and in `browser/cli`, so a clean copy made a moment ago has
/// every package the two builds after it need (`a_fresh_clean_copy_gets_its_packages_before_any_build`).
fn siblings_step(worktree: &Path) -> Step {
    let browser = worktree.join("browser");
    Step::new(
        Role::Build,
        "Get what the extension builds against, and the packages for the helper and the extension",
        &[&s(&browser.join("scripts/setup-siblings.sh"))],
    )
    .in_dir(&browser)
}

fn mac_steps(f: &Facts, steps: &mut Vec<Step>) {
    let wt = &f.worktree;
    let env: Vec<(String, String)> = if f.arm64 {
        vec![("BANEYSPACES_ARM64_ONLY".to_string(), "1".to_string())]
    } else {
        Vec::new()
    };
    steps.push(siblings_step(wt));
    steps.push(restore_step(wt));
    // What `make -C spaces install` does: bundle.sh builds the app with the command, the helper, the
    // extension and the skill inside, and install-app.sh quits the running app, swaps it, links the
    // commands in ~/.local/bin (polycarp among them) and opens it again.
    steps.push(
        Step::new(
            Role::Install,
            "Build Polycarp.app (command, helper, extension and skill inside), install it and restart it",
            &["make", "-C", "spaces", "install"],
        )
        .in_dir(wt)
        .with_env(&env),
    );
    if f.skill_installed {
        steps.push(
            Step::new(
                Role::Install,
                "Refresh the installed agent skill from the new app",
                &[
                    &s(&f.home.join(".local/bin/polycarp-spaces")),
                    "skill",
                    "install",
                ],
            )
            .in_dir(wt),
        );
    }
}

/// Linux: every build first, so a build that fails has changed nothing that is installed. Then the
/// installs, with the `polycarp` command last: every step before it is still run by the polycarp
/// that made this plan.
fn linux_steps(f: &Facts, steps: &mut Vec<Step>, notes: &mut Vec<String>) {
    let wt = &f.worktree;
    let spaces = wt.join("spaces");
    let browser = wt.join("browser");
    if f.hyprland {
        steps.push(
            Step::new(
                Role::Build,
                "Build the spaces daemon",
                &[
                    "cargo",
                    "build",
                    "--release",
                    "--locked",
                    "-p",
                    "baneyspaces-linux",
                ],
            )
            .in_dir(&spaces),
        );
        steps.push(
            Step::new(
                Role::Build,
                "Build the pinned hands engine",
                &[&s(&spaces.join("platforms/linux/scripts/build-engine.sh"))],
            )
            .in_dir(&spaces),
        );
    } else {
        notes.push(
            "No ~/.config/hypr/hyprland.lua here, so the spaces daemon (Hyprland only) is not built or installed.".to_string(),
        );
    }
    if f.node {
        steps.push(siblings_step(wt));
        steps.push(restore_step(wt));
        steps.push(
            Step::new(
                Role::Build,
                "Build the browser helper",
                &["npm", "run", "build"],
            )
            .in_dir(&browser.join("cli")),
        );
        // TABKYRA_NO_BUMP: a plain build edits static/manifest.chrome.json, a tracked file, and every
        // part built after that would be stamped as built from a changed tree.
        steps.push(
            Step::new(Role::Build, "Build the extension", &["npm", "run", "build"])
                .in_dir(&browser)
                .with_env(&[("TABKYRA_NO_BUMP".to_string(), "1".to_string())]),
        );
        let home = s(&f.browser_home);
        let entry = s(&f.browser_home.join("cli/dist/index.js"));
        steps.push(
            Step::new(
                Role::Install,
                "Copy the helper and the extension out of the clean copy, and link polycarp-browser in ~/.local/bin",
                &[
                    &s(&f.polycarp),
                    "update",
                    "--place-browser",
                    &s(&browser),
                    &home,
                    &s(&f.home.join(".local/bin/polycarp-browser")),
                ],
            )
            .in_dir(wt),
        );
        steps.push(
            Step::new(
                Role::Install,
                "Register the helper with your browsers",
                &["node", &entry, "setup", "--yes", "--no-wait"],
            )
            .in_dir(&f.browser_home),
        );
        notes.push(format!(
            "The browser helper and the extension are installed in {home}, and nothing installed runs from the cache folder. Browsers load the extension from {home}/dist-chrome. If yours loaded it from another folder before, `polycarp browser setup` shows how to load this one."
        ));
    } else {
        notes.push(
            "Node and npm are not on PATH, so the browser helper and the extension are not built. Install Node, then run `polycarp update` again: it installs them even when nothing else has changed.".to_string(),
        );
    }
    if f.hyprland {
        steps.push(
            Step::new(
                Role::Install,
                "Install the daemon, the engine and the Hyprland include (Omarchy install script)",
                &[&s(&spaces.join("platforms/linux/omarchy/install.sh"))],
            )
            .in_dir(&spaces),
        );
    }
    steps.push(
        Step::new(
            Role::Install,
            "Build the polycarp command and install it in ~/.local/bin",
            &[
                "cargo",
                "install",
                "--locked",
                "--path",
                "cli",
                "--root",
                &s(&f.home.join(".local")),
            ],
        )
        .in_dir(wt),
    );
}

/// Linux: copies the built browser helper and extension from the clean copy (`from`, its `browser/`
/// folder) to `to`, a folder that stays, and points `link` (`~/.local/bin/polycarp-browser`) at the
/// helper there. The copy is made next to `to` and swapped in by rename, so `to` is never half
/// written, and a failure before the swap leaves the old one as it was.
#[cfg(unix)]
pub fn place_browser(from: &Path, to: &Path, link: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let at = |e: std::io::Error, p: &Path| format!("{}: {e}", p.display());
    if !to.is_absolute() || !link.is_absolute() {
        return Err("the folder and the link must be absolute paths".to_string());
    }
    // Only what runs: the helper is one bundled file, and it reads these to know its version.
    let wanted = [
        "package.json",
        "static/manifest.chrome.json",
        "cli/package.json",
        "cli/dist",
        "dist-chrome",
    ];
    for must in ["cli/dist/index.js", "dist-chrome/manifest.json"] {
        if !from.join(must).is_file() {
            return Err(format!(
                "{} is missing, so there is no build to install",
                from.join(must).display()
            ));
        }
    }
    // The link is made when the name is free and moved when it is a link already. A real file there
    // is someone's own: it is left alone, and nothing is copied.
    if fs::symlink_metadata(link).is_ok_and(|meta| !meta.file_type().is_symlink()) {
        return Err(format!(
            "{} is a file this update did not make. Move it away, then run `polycarp update` again.",
            link.display()
        ));
    }
    let name = to
        .file_name()
        .ok_or("the folder has no name")?
        .to_string_lossy();
    let (next, old) = (
        to.with_file_name(format!("{name}.new")),
        to.with_file_name(format!("{name}.old")),
    );
    for stale in [&next, &old] {
        if stale.exists() {
            fs::remove_dir_all(stale).map_err(|e| at(e, stale))?;
        }
    }
    fn copy(from: &Path, to: &Path) -> std::io::Result<()> {
        if fs::metadata(from)?.is_dir() {
            fs::create_dir_all(to)?;
            for entry in fs::read_dir(from)? {
                let entry = entry?;
                copy(&entry.path(), &to.join(entry.file_name()))?;
            }
            return Ok(());
        }
        if let Some(dir) = to.parent() {
            fs::create_dir_all(dir)?;
        }
        fs::copy(from, to).map(|_| ())
    }
    for item in wanted {
        copy(&from.join(item), &next.join(item)).map_err(|e| at(e, &from.join(item)))?;
    }
    let helper = next.join("cli/dist/index.js");
    fs::set_permissions(&helper, fs::Permissions::from_mode(0o755)).map_err(|e| at(e, &helper))?;
    if to.exists() {
        fs::rename(to, &old).map_err(|e| at(e, to))?;
    }
    fs::rename(&next, to).map_err(|e| at(e, to))?;
    let _ = fs::remove_dir_all(&old);
    let dir = link.parent().ok_or("the link has no folder")?;
    fs::create_dir_all(dir).map_err(|e| at(e, dir))?;
    let fresh = dir.join(".polycarp-browser.new");
    let _ = fs::remove_file(&fresh);
    std::os::unix::fs::symlink(to.join("cli/dist/index.js"), &fresh).map_err(|e| at(e, &fresh))?;
    fs::rename(&fresh, link).map_err(|e| at(e, link))
}

#[cfg(not(unix))]
pub fn place_browser(_from: &Path, _to: &Path, _link: &Path) -> Result<(), String> {
    Err("placing the browser helper is not supported on Windows yet".to_string())
}

// ---- Running a plan ------------------------------------------------------------------------------

/// What a step did. `output` is whatever was not already shown as it ran.
pub struct Ran {
    /// None: the program could not be started at all.
    pub code: Option<i32>,
    pub output: String,
}

pub trait Runner {
    fn run(&mut self, step: &Step) -> Ran;
}

#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    /// Every step ran.
    Done,
    /// A gate said there is nothing to do; the steps after it were not run.
    UpToDate,
    /// A gate said an update is waiting, and it was the last step (a `--check` plan).
    Available,
    /// `step` (counted from 0) failed and nothing after it ran.
    Failed { step: usize, code: Option<i32> },
}

/// What is true on the device after step `failed` did not finish.
pub fn state_after_failure(steps: &[Step], failed: usize) -> &'static str {
    let installed_before = steps[..failed].iter().any(|st| st.role == Role::Install);
    match steps[failed].role {
        Role::Verify => "Every step before this one ran, but the parts do not all match yet. `polycarp version` shows which.",
        Role::Handoff => "Every part was installed. The last steps (reloading the extension, restarting what runs, the final check) did not finish. `polycarp version` shows what is installed.",
        Role::Install if !installed_before => "This step installs. It did not finish, so some parts may be new and others old. `polycarp version` shows what is installed.",
        _ if installed_before => "Earlier steps already installed some parts, so some may be new and others old. `polycarp version` shows what is installed.",
        _ => "Nothing that is installed on this device was changed.",
    }
}

/// Runs the steps in order, printing `step N of M: title` for each, and stops at the first failure
/// with the step's own output, the state things are in and how to retry.
pub fn execute(steps: &[Step], runner: &mut dyn Runner, out: &mut dyn Write) -> Outcome {
    let total = steps.len();
    for (i, step) in steps.iter().enumerate() {
        let _ = writeln!(out, "step {} of {total}: {}", i + 1, step.title);
        let _ = out.flush();
        let ran = runner.run(step);
        if !ran.output.is_empty() {
            let _ = writeln!(out, "{}", ran.output.trim_end());
        }
        match (step.role, ran.code) {
            (Role::Gate, Some(0)) => return Outcome::UpToDate,
            (Role::Gate, Some(AVAILABLE)) if i + 1 == total => return Outcome::Available,
            (Role::Gate, Some(AVAILABLE)) => {}
            (_, Some(0)) => {}
            (Role::Soft, code) => {
                let _ = writeln!(
                    out,
                    "note: this step did not happen ({}). The update carries on.",
                    exit_text(code)
                );
            }
            (_, code) => {
                let _ = writeln!(
                    out,
                    "\nstep {} of {total} failed ({}): {}",
                    i + 1,
                    exit_text(code),
                    step.title
                );
                let _ = writeln!(out, "  command: {}", step.argv.join(" "));
                let _ = writeln!(out, "  state:   {}", state_after_failure(steps, i));
                let _ = writeln!(
                    out,
                    "  retry:   fix what the step reported above, then run `polycarp update` again. It starts over from a clean copy of origin/main."
                );
                return Outcome::Failed { step: i, code };
            }
        }
    }
    Outcome::Done
}

fn exit_text(code: Option<i32>) -> String {
    match code {
        Some(c) => format!("exit {c}"),
        None => "it could not be started".to_string(),
    }
}

/// A bare program name as an absolute path, from the trusted folders on PATH only: never a relative
/// entry, the current folder's tree or a `node_modules/.bin` (`crate::trusted_tool`).
pub fn on_path(name: &str, path: Option<&OsString>) -> Option<PathBuf> {
    let file = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    std::env::split_paths(path?)
        .map(|d| d.join(&file))
        .find(|p| crate::trusted_tool(p))
}

/// Before the plan is shown, each bare program in it is looked up once and named by the path that
/// will run. One that is not found stays bare, and its step fails without starting anything.
pub fn resolve(steps: &mut [Step], path: Option<&OsString>) {
    let mut found = std::collections::BTreeMap::new();
    for first in steps.iter_mut().filter_map(|st| st.argv.first_mut()) {
        let tool = found
            .entry(first.clone())
            .or_insert_with_key(|name| on_path(name, path));
        if let Some(p) = tool.as_ref().filter(|_| !Path::new(first).is_absolute()) {
            *first = s(p);
        }
    }
}

/// The first `name` on PATH when it is not `new`: an older copy that keeps answering in a shell.
pub fn shadowed(name: &str, new: &Path, path: Option<&OsString>) -> Option<PathBuf> {
    let first = on_path(name, path)?;
    (new.exists() && fs::canonicalize(&first).ok() != fs::canonicalize(new).ok()).then_some(first)
}

/// Runs steps for real: no shell, input closed, output straight to the terminal as it comes.
struct RealRunner {
    path: Option<OsString>,
}

impl RealRunner {
    fn new(home: &Path) -> RealRunner {
        RealRunner::with_path(home, std::env::var_os("PATH"))
    }
    /// The one way a runner is made, from a PATH (second-F5 of the review of PR 236).
    fn with_path(home: &Path, path: Option<OsString>) -> RealRunner {
        // rustup's default spot, for a shell that has not picked it up (the installer does the same).
        let mut dirs: Vec<PathBuf> = Vec::new();
        let cargo = home.join(".cargo/bin");
        if cargo.is_dir() {
            dirs.push(cargo);
        }
        if let Some(p) = path {
            dirs.extend(std::env::split_paths(&p));
        }
        // What a step starts looks tools up too: it gets the trusted folders and no others.
        dirs.retain(|d| crate::trusted_dir(d));
        RealRunner {
            path: std::env::join_paths(dirs).ok(),
        }
    }
}

impl Runner for RealRunner {
    fn run(&mut self, step: &Step) -> Ran {
        let Some(first) = step.argv.first() else {
            return Ran {
                code: None,
                output: "the step has no command".to_string(),
            };
        };
        let program = if Path::new(first).is_absolute() {
            PathBuf::from(first)
        } else {
            match on_path(first, self.path.as_ref()) {
                Some(p) => p,
                None => {
                    return Ran {
                        code: None,
                        output: format!("{first} is not installed, or not on PATH"),
                    }
                }
            }
        };
        let mut cmd = Command::new(program);
        cmd.args(&step.argv[1..]).stdin(Stdio::null());
        if let Some(path) = &self.path {
            cmd.env("PATH", path);
        }
        if let Some(dir) = &step.cwd {
            cmd.current_dir(dir);
        }
        for (k, v) in &step.env {
            cmd.env(k, v);
        }
        match cmd.status() {
            Ok(status) => Ran {
                code: Some(status.code().unwrap_or(1)),
                output: String::new(),
            },
            Err(e) => Ran {
                code: None,
                output: format!("could not start {first}: {e}"),
            },
        }
    }
}

// ---- The plan, printed -----------------------------------------------------------------------------

pub fn render(summary: &str, steps: &[Step], notes: &[String]) -> String {
    let mut out = format!("polycarp update, {summary}\n\n");
    for (i, step) in steps.iter().enumerate() {
        out.push_str(&format!("  {}. {}\n", i + 1, step.title));
        out.push_str(&format!("     {}\n", step.argv.join(" ")));
        let mut context = Vec::new();
        if let Some(dir) = &step.cwd {
            context.push(format!("in {}", dir.display()));
        }
        for (k, v) in &step.env {
            context.push(format!("with {k}={v}"));
        }
        if !context.is_empty() {
            out.push_str(&format!("     ({})\n", context.join(", ")));
        }
    }
    for note in notes {
        out.push_str(&format!("\nnote: {note}\n"));
    }
    out
}

// ---- Reading the device ----------------------------------------------------------------------------

/// Where the clean copy lives: POLYCARP_CACHE_DIR (an absolute path), else the platform's cache folder.
fn cache_dir(home: &Path) -> PathBuf {
    let nonempty = |k: &str| {
        std::env::var_os(k)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
    };
    if let Some(d) = nonempty("POLYCARP_CACHE_DIR") {
        return d;
    }
    if cfg!(target_os = "macos") {
        return home.join("Library/Caches/polycarp");
    }
    if cfg!(windows) {
        if let Some(d) = nonempty("LOCALAPPDATA") {
            return d.join("Polycarp").join("Cache");
        }
    }
    nonempty("XDG_CACHE_HOME")
        .unwrap_or_else(|| home.join(".cache"))
        .join("polycarp")
}

/// The clean copy for one checkout. The name carries a hash of the checkout's path, so a copy that
/// exists always belongs to the checkout that is being fetched.
pub fn worktree_for(cache: &Path, checkout: &Path) -> PathBuf {
    // FNV-1a, 64 bit: stable across runs and versions, which a std hasher is not promised to be.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in checkout.to_string_lossy().bytes() {
        hash ^= u64::from(b);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    cache.join(format!("source-{:08x}", hash & 0xffff_ffff))
}

fn git_line(dir: &Path, args: &[&str]) -> Option<String> {
    let git = on_path("git", std::env::var_os("PATH").as_ref())?;
    let out = Command::new(git)
        .arg("-C")
        .arg(dir)
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

const SOURCE_FILE: &str = "source.toml";

/// The checkout recorded by an earlier `polycarp update --source`.
fn recorded_source(config: &Path) -> Option<PathBuf> {
    let text = fs::read_to_string(config.join(SOURCE_FILE)).ok()?;
    let table: toml::Table = toml::from_str(&text).ok()?;
    table
        .get("checkout")
        .and_then(|v| v.as_str())
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
}

fn record_source(config: &Path, checkout: &Path) -> Result<(), String> {
    let mut table = toml::Table::new();
    table.insert(
        "checkout".to_string(),
        toml::Value::String(checkout.to_string_lossy().into_owned()),
    );
    let text = format!(
        "# Written by `polycarp update --source`. `polycarp update` fetches origin/main of this checkout\n# and builds it in a clean copy; the checkout's own files are never built or changed.\n{}",
        toml::to_string(&table).map_err(|e| e.to_string())?
    );
    fs::create_dir_all(config).map_err(|e| format!("{}: {e}", config.display()))?;
    let file = config.join(SOURCE_FILE);
    fs::write(&file, text).map_err(|e| format!("{}: {e}", file.display()))
}

/// What `main.rs` knows and this module should not find by itself.
pub struct Device<'a> {
    pub home: Option<PathBuf>,
    /// The installed Polycarp.app (Mac only).
    pub app: Option<PathBuf>,
    /// The spaces command, as `polycarp spaces` would run it.
    pub spaces: Option<PathBuf>,
    /// Polycarp's config folder.
    pub config: Result<PathBuf, String>,
    /// Every part on this device, for the up-to-date check.
    pub parts: &'a dyn Fn() -> Vec<Part>,
}

pub const USAGE: &str = "\
usage: polycarp update [--check] [--dry-run] [--yes] [--source <checkout>]

Brings every Polycarp part on this device to origin/main, together.

  --check             say whether an update is waiting: exit 0 when up to date, 100 when there is one
  --dry-run           print the steps and run nothing
  --yes               run the steps without asking (needed when there is no terminal)
  --source <checkout> a checkout of https://github.com/baney75/polycarp to build from; remembered

A source install fetches origin/main, builds it in a clean copy under the cache folder (never your
checkout, a branch or changed files) and installs it. A Mac app from the disk image or the installer
is asked to update itself. On Windows this is not supported yet.
";

struct Args {
    options: Options,
    source: Option<PathBuf>,
}

fn parse(args: &[OsString]) -> Result<Args, String> {
    let mut out = Args {
        options: Options::default(),
        source: None,
    };
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.to_str() {
            Some("--check") => out.options.check = true,
            Some("--dry-run") => out.options.dry_run = true,
            Some("--yes") | Some("-y") => out.options.yes = true,
            // Not in the usage text: an update runs it as its last step, with the command it installed.
            Some("--finish") => {
                out.options.finish = true;
                out.options.yes = true;
            }
            Some("--source") => {
                let path = it.next().ok_or("--source needs the path of a checkout")?;
                out.source = Some(PathBuf::from(path));
            }
            _ => return Err(format!("unknown option {}", a.to_string_lossy())),
        }
    }
    Ok(out)
}

fn platform() -> Platform {
    if cfg!(windows) {
        Platform::Windows
    } else if cfg!(target_os = "macos") {
        Platform::Mac
    } else {
        Platform::Linux
    }
}

/// What `update --is-current` was asked, after `<dir> <rev>`.
#[derive(Debug, Default, PartialEq)]
struct Check {
    /// Part names that must be installed (`--needs a,b`): what an update on this device installs.
    needs: Vec<String>,
    /// `--after-install`: the final check of an update, not the gate before one.
    after_install: bool,
    /// `--wait <seconds>`: keep looking that long (an app that is restarting).
    wait: u64,
}

fn parse_check(args: &[OsString]) -> Result<Check, String> {
    let mut check = Check::default();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.to_str() {
            Some("--needs") => {
                let list = it.next().ok_or("--needs needs a list of parts")?;
                check.needs = list
                    .to_string_lossy()
                    .split(',')
                    .filter(|n| !n.is_empty())
                    .map(str::to_string)
                    .collect();
            }
            Some("--after-install") => check.after_install = true,
            Some("--wait") => {
                check.wait = it
                    .next()
                    .and_then(|v| v.to_str())
                    .and_then(|v| v.parse().ok())
                    .map(|secs: u64| secs.min(600))
                    .ok_or("--wait needs a number of seconds")?;
            }
            _ => return Err(format!("unknown option {}", a.to_string_lossy())),
        }
    }
    Ok(check)
}

/// What the parts on the device say about `target`, for the gate before an update and the check after.
#[derive(Debug, PartialEq)]
pub enum Standing {
    /// Every part the update installs is installed and at the target, built from a clean tree.
    Current,
    /// The same, except that a browser still runs an older extension: it only has to reload.
    ReloadPending(Vec<String>),
    /// Something is missing, older or odd: an update would change it.
    Behind,
}

/// Pure: how `parts` stand against `target`. A part that gave no answer in time is left out, so a slow
/// browser alone never makes an update fail or run again.
pub fn standing(parts: &[Part], needs: &[&str], target: &str) -> Standing {
    if !version::missing(parts, needs).is_empty() {
        return Standing::Behind;
    }
    if version::is_current(parts, target) {
        return Standing::Current;
    }
    let rest = version::without_extensions(parts);
    if rest.len() < parts.len() && version::is_current(&rest, target) {
        let waiting = parts
            .iter()
            .filter(|p| p.name.starts_with("extension"))
            .filter(|p| !version::is_current(std::slice::from_ref(p), target))
            .filter(|p| matches!(p.found, version::Found::Installed { .. }))
            .map(|p| p.name.clone())
            .collect();
        return Standing::ReloadPending(waiting);
    }
    Standing::Behind
}

/// What the browser helper's `reload --if-idle` exits with when an agent is working in the browser.
const RELOAD_BUSY: i32 = 75;

/// An extension drops off for a few seconds as it reloads, so each reload gets at least this long
/// before the wait can end.
const RELOAD_SETTLE: std::time::Duration = std::time::Duration::from_secs(4);

/// The extensions that do not run `target` yet: an older build, no answer, or none connected (one
/// that is reloading drops off for a few seconds).
fn not_reloaded(parts: &[Part], target: &str) -> Vec<String> {
    parts
        .iter()
        .filter(|p| p.name.starts_with("extension"))
        .filter(|p| {
            !matches!(p.found, version::Found::Installed { .. })
                || !version::is_current(std::slice::from_ref(p), target)
        })
        .map(|p| p.name.clone())
        .collect()
}

/// The extensions that report a build other than `target`: the only ones a second reload can help.
fn old_builds(parts: &[Part], target: &str) -> Vec<String> {
    parts
        .iter()
        .filter(|p| p.name.starts_with("extension"))
        .filter(|p| matches!(p.found, version::Found::Installed { .. }))
        .filter(|p| !version::is_current(std::slice::from_ref(p), target))
        .map(|p| p.name.clone())
        .collect()
}

/// Whether any browser's extension is there to reload: it reports a build, or it is there but slow
/// to answer. "No browser is connected" and "not installed" are not.
fn extension_connected(parts: &[Part]) -> bool {
    parts
        .iter()
        .any(|p| p.name.starts_with("extension") && !matches!(p.found, version::Found::Absent(_)))
}

/// Reload the extension and wait, until `wait` has passed on `clock`, for every connected one to
/// report `target`. With no browser connected for `RELOAD_SETTLE` there is nothing to reload or wait
/// for: the browser loads the new build when it starts. Once half the time has passed, an extension
/// that still reports the old build gets one more reload: Helium can keep the old one after the
/// first (#207). 0 when every extension runs `target` or none reports a build, the reload's own code
/// when it could not run (75: an agent is working in the browser), 1 when one whose last report was an
/// old build, before the reload or since, does not report `target` by the end. The time is bounded by up to 4 s for a browser
/// to connect, then `wait` (at least 4 s after each reload), plus one pause and one look, however
/// slowly the parts answer.
pub fn reload_wait(
    target: &str,
    wait: std::time::Duration,
    reload: &mut dyn FnMut() -> Option<i32>,
    parts: &dyn Fn() -> Vec<Part>,
    clock: &dyn Fn() -> std::time::Duration,
    pause: &mut dyn FnMut(),
    out: &mut dyn Write,
) -> i32 {
    let at = version::short(target);
    // One look is not enough: an extension that is reloading or reconnecting drops off for a moment (first-F1 of the
    // review of PR 236).
    let first = clock();
    let mut before = parts();
    while !extension_connected(&before) {
        if clock().saturating_sub(first) >= RELOAD_SETTLE {
            let _ = writeln!(
                out,
                "No browser is connected, so there is no extension to reload: the browser loads {at} when it starts."
            );
            return 0;
        }
        pause();
        before = parts();
    }
    // Each extension whose last report was an old build, the look before the reload included, and whether it said so
    // since the reload: it passes only once it reports `target`, whether it then goes quiet or drops out of the list
    // (first-F2 of the review of PR 236; first-F1, second-F5, second-F6 of the review of PR 244).
    let mut last_old: std::collections::BTreeMap<String, bool> = old_builds(&before, target)
        .into_iter()
        .map(|n| (n, false))
        .collect();
    match reload() {
        Some(0) => {}
        code => return code.unwrap_or(1),
    }
    let started = clock();
    let mut deadline = wait.max(RELOAD_SETTLE);
    let mut retried = false;
    loop {
        pause();
        let now = parts();
        for p in now.iter().filter(|p| p.name.starts_with("extension")) {
            if matches!(p.found, version::Found::Installed { .. }) {
                match version::is_current(std::slice::from_ref(p), target) {
                    true => last_old.remove(&p.name),
                    false => last_old.insert(p.name.clone(), true),
                };
            }
        }
        let waiting = not_reloaded(&now, target);
        if waiting.is_empty() && last_old.is_empty() {
            let _ = writeln!(out, "The extension runs {at}.");
            return 0;
        }
        // Only one that said so since the reload gets another: one that hasn't answered may yet (first-F2 of PR 244).
        let old: Vec<String> = last_old
            .iter()
            .filter(|(_, since)| **since)
            .map(|(n, _)| n.clone())
            .collect();
        let spent = clock().saturating_sub(started);
        if !retried && !old.is_empty() && spent >= wait / 2 {
            retried = true;
            // The helper's reload has no browser selector: every connected extension reloads.
            let _ = writeln!(
                out,
                "{} still runs the build from before, so every browser's extension is reloaded once more.",
                old.join(", ")
            );
            if reload() == Some(RELOAD_BUSY) {
                return RELOAD_BUSY;
            }
            deadline = deadline.max(spent + RELOAD_SETTLE);
            continue;
        }
        if spent >= deadline {
            if last_old.is_empty() {
                let _ = writeln!(
                    out,
                    "note: {} reported no build in {} s, so it was not compared. `polycarp version` asks again.",
                    waiting.join(", "),
                    wait.as_secs()
                );
                return 0;
            }
            let stale: Vec<&str> = last_old.keys().map(String::as_str).collect();
            let _ = writeln!(
                out,
                "{} still does not run {at}, after {}.",
                stale.join(", "),
                if retried { "two reloads" } else { "the reload" }
            );
            return 1;
        }
    }
}

/// The final check's words for a browser that still runs the build from before. Never "up to date":
/// what the user works with is still the old build (#207).
fn reload_pending_line(at: &str, waiting: &[String]) -> String {
    format!(
        "reload pending: every other part is at origin/main ({at}), but {} still runs the build from before. Run `polycarp browser reload` when no agent is working in the browser.",
        waiting.join(", ")
    )
}

/// `--wait <seconds> -- <reload command...>`, after `update --reload-wait <dir> <rev>`.
fn parse_reload_wait(args: &[OsString]) -> Result<(u64, Vec<OsString>), String> {
    let mut wait = 30;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.to_str() {
            Some("--wait") => {
                wait = it
                    .next()
                    .and_then(|v| v.to_str())
                    .and_then(|v| v.parse().ok())
                    .map(|secs: u64| secs.min(600))
                    .ok_or("--wait needs a number of seconds")?;
            }
            Some("--") => {
                let argv: Vec<OsString> = it.cloned().collect();
                if argv.is_empty() {
                    return Err("--reload-wait needs the reload command after --".to_string());
                }
                return Ok((wait, argv));
            }
            _ => return Err(format!("unknown option {}", a.to_string_lossy())),
        }
    }
    Err("--reload-wait needs the reload command after --".to_string())
}

/// `polycarp update --reload-wait <dir> <rev> [--wait <seconds>] -- <reload command...>`, the plan's
/// reload step (`args` starts at `--reload-wait`): see `reload_wait`. The reload command runs through
/// `runner`, which finds its program the way it finds every step's: absolute, or from the trusted
/// folders on PATH only (`RealRunner`, cli/AGENTS.md).
fn reload_wait_command(args: &[OsString], device: &Device, runner: &mut dyn Runner) -> i32 {
    let (wait, argv) = match parse_reload_wait(&args[3..]) {
        Ok(parsed) => parsed,
        Err(e) => {
            eprintln!("polycarp update: {e}");
            return 2;
        }
    };
    let (dir, rev) = (Path::new(&args[1]), args[2].to_string_lossy());
    let Some(target) = git_line(
        dir,
        &["rev-parse", "--verify", &format!("{rev}^{{commit}}")],
    ) else {
        eprintln!("polycarp update: could not read {rev} in {}", dir.display());
        return 1;
    };
    let words: Vec<String> = argv
        .iter()
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    let words: Vec<&str> = words.iter().map(String::as_str).collect();
    let step = Step::new(Role::Soft, "Reload the browser extension", &words);
    let mut reload = || {
        let _ = std::io::stdout().flush();
        let ran = runner.run(&step);
        if !ran.output.is_empty() {
            eprintln!("polycarp update: {}", ran.output);
        }
        ran.code
    };
    let started = std::time::Instant::now();
    let mut pause = || std::thread::sleep(std::time::Duration::from_secs(2));
    reload_wait(
        &target,
        std::time::Duration::from_secs(wait),
        &mut reload,
        device.parts,
        &|| started.elapsed(),
        &mut pause,
        &mut std::io::stdout(),
    )
}

/// `polycarp update --is-current <dir> <rev> [--needs <parts>] [--after-install] [--wait <seconds>]`,
/// which the plan runs twice. As the gate: exit 0 when there is nothing to install, 100 when an update
/// would change something. With `--after-install`, as the final check: exit 0 when every part is at
/// `rev`, 1 when one is not.
fn is_current(dir: &Path, rev: &str, check: &Check, device: &Device) -> i32 {
    let Some(target) = git_line(
        dir,
        &["rev-parse", "--verify", &format!("{rev}^{{commit}}")],
    ) else {
        eprintln!("polycarp update: could not read {rev} in {}", dir.display());
        return 1;
    };
    let needs: Vec<&str> = check.needs.iter().map(String::as_str).collect();
    let at = version::short(&target);
    let started = std::time::Instant::now();
    // The gate judges the command an update installs. With none there, the one that is running (a
    // build in a checkout, on the first run) does not stand in for it: it counts as not installed.
    let placed = device.home.as_ref().map(|h| h.join(".local/bin/polycarp"));
    let placed = cfg!(windows) || placed.is_some_and(|p| p.is_file());
    let (parts, standing) = loop {
        let mut parts = (device.parts)();
        parts.retain(|p| placed || p.name != "polycarp command");
        let standing = standing(&parts, &needs, &target);
        if standing == Standing::Current || started.elapsed().as_secs() >= check.wait {
            break (parts, standing);
        }
        std::thread::sleep(std::time::Duration::from_secs(2));
    };
    let quiet = version::unanswered(&parts);
    if !quiet.is_empty() {
        println!(
            "note: {} gave no answer in time, so it was not compared. `polycarp version` asks again.",
            quiet.join(", ")
        );
    }
    let helper = parts.iter().find(|p| p.name == "browser helper");
    if let Some(version::Found::Installed { path: Some(p), .. }) = helper.map(|p| &p.found) {
        println!("browser helper: `polycarp browser` runs {}", p.display());
    }
    match standing {
        Standing::Current => {
            println!("up to date: every installed part is at origin/main ({at})");
            0
        }
        Standing::ReloadPending(waiting) => {
            println!("{}", reload_pending_line(at, &waiting));
            0
        }
        Standing::Behind => {
            let missing = version::missing(&parts, &needs);
            if check.after_install {
                print!("{}", version::table(&parts));
                println!("\nnot every part is at origin/main ({at}) yet.");
            } else {
                println!("update available: origin/main is at {at}");
            }
            if !missing.is_empty() {
                println!("not installed yet: {}", missing.join(", "));
            }
            println!("{}", version::summary(&parts, &version::compare(&parts)));
            if check.after_install {
                1
            } else {
                AVAILABLE
            }
        }
    }
}

pub fn run(args: &[OsString], device: &Device) -> i32 {
    // The two commands a plan runs for itself. Neither is in the usage text.
    match args.first().and_then(|a| a.to_str()) {
        Some("--is-current") if args.len() >= 3 => {
            return match parse_check(&args[3..]) {
                Ok(check) => is_current(
                    Path::new(&args[1]),
                    &args[2].to_string_lossy(),
                    &check,
                    device,
                ),
                Err(e) => {
                    eprintln!("polycarp update: {e}");
                    2
                }
            };
        }
        Some("--reload-wait") if args.len() >= 3 => {
            let mut runner = RealRunner::new(device.home.as_deref().unwrap_or(Path::new("/")));
            return reload_wait_command(args, device, &mut runner);
        }
        Some("--place-browser") if args.len() == 4 => {
            let [from, to, link] = [&args[1], &args[2], &args[3]].map(Path::new);
            return match place_browser(from, to, link) {
                Ok(()) => {
                    println!(
                        "The browser helper and the extension are in {}.",
                        to.display()
                    );
                    0
                }
                Err(e) => {
                    eprintln!("polycarp update: {e}");
                    1
                }
            };
        }
        _ => {}
    }
    if args.iter().any(|a| a == "--help" || a == "-h") {
        print!("{USAGE}");
        return 0;
    }
    let parsed = match parse(args) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("polycarp update: {e}\n");
            eprint!("{USAGE}");
            return 2;
        }
    };
    let o = parsed.options;
    let Some(home) = device.home.clone() else {
        eprintln!(
            "polycarp update: the home folder is not set, so there is nowhere to install to."
        );
        return 1;
    };
    // --source, else the recorded checkout, else (on a Mac with the app) the app's own updater.
    let given = match &parsed.source {
        Some(p) => match fs::canonicalize(p) {
            Ok(c) if c.is_dir() => Some(c),
            _ => {
                eprintln!("polycarp update: --source {} is not a folder.", p.display());
                return 2;
            }
        },
        None => None,
    };
    // The record is read only when no checkout was given.
    let recorded = || device.config.as_ref().ok().and_then(|c| recorded_source(c));
    let install = match given.clone().or_else(recorded) {
        Some(checkout) => Install::Source {
            origin: git_line(&checkout, &["remote", "get-url", "origin"]),
            dirty: git_line(
                &checkout,
                &["status", "--porcelain", "--untracked-files=no"],
            )
            .is_some_and(|t| !t.is_empty()),
            checkout,
        },
        None if platform() == Platform::Mac && device.app.is_some() => Install::MacRelease {
            spaces: device.spaces.clone(),
        },
        None => Install::Unknown,
    };
    let worktree = match &install {
        Install::Source { checkout, .. } => worktree_for(&cache_dir(&home), checkout),
        _ => cache_dir(&home).join("source"),
    };
    let path = std::env::var_os("PATH");
    let installed = home.join(".local/bin/polycarp");
    let facts = Facts {
        platform: platform(),
        worktree_exists: worktree.join(".git").exists(),
        worktree,
        // This binary runs the steps up to the install: the installed one may be older and not know
        // them. After the install, the installed one takes over.
        polycarp: std::env::current_exe()
            .ok()
            .filter(|p| p.is_absolute())
            .unwrap_or_else(|| installed.clone()),
        browser_home: home.join(".local/share/polycarp/browser/source"),
        installed: installed.clone(),
        arm64: cfg!(target_arch = "aarch64"),
        hyprland: home.join(".config/hypr/hyprland.lua").is_file(),
        node: on_path("node", path.as_ref()).is_some() && on_path("npm", path.as_ref()).is_some(),
        skill_installed: home.join(".claude/skills/baneyspaces/SKILL.md").is_file(),
        terminal: std::io::stdin().is_terminal() && std::io::stdout().is_terminal(),
        home: home.clone(),
        install,
    };
    let (summary, mut steps, notes, ask) = match plan(&facts, o) {
        Plan::Refuse { code, message } => {
            eprintln!("{message}");
            return code;
        }
        Plan::Run {
            summary,
            steps,
            notes,
            ask,
        } => (summary, steps, notes, ask),
    };
    let mut runner = RealRunner::new(&home);
    resolve(&mut steps, runner.path.as_ref());
    if o.dry_run {
        print!("{}", render(&summary, &steps, &notes));
        println!("\ndry run: nothing was run.");
        return 0;
    }
    if ask {
        print!("{}", render(&summary, &steps, &notes));
        print!("\nRun these {} steps? [y/N] ", steps.len());
        let _ = std::io::stdout().flush();
        let mut answer = String::new();
        let _ = std::io::stdin().read_line(&mut answer);
        if !matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes") {
            println!("Nothing was run.");
            return 1;
        }
    }
    // Remember the checkout only once a plan for it was accepted: a refused origin is never recorded.
    // `--finish` is the same update still going: the run that started it did the remembering.
    if let (Some(checkout), Ok(config), false) = (&given, &device.config, o.finish) {
        if recorded_source(config).as_deref() != Some(checkout.as_path()) {
            match record_source(config, checkout) {
                Ok(()) => println!("Remembered {} as the source (in {}).", checkout.display(), config.join(SOURCE_FILE).display()),
                Err(e) => eprintln!("polycarp update: could not remember the source: {e}. Pass --source again next time."),
            }
        }
    }
    let mut out = std::io::stdout();
    match execute(&steps, &mut runner, &mut out) {
        Outcome::UpToDate => 0,
        Outcome::Available => AVAILABLE,
        // The run that handed over prints the notes and the last line.
        Outcome::Done if o.check || o.finish => 0,
        Outcome::Done => {
            for note in &notes {
                println!("note: {note}");
            }
            // An older copy earlier on PATH would keep answering to `polycarp`: say so once.
            if let Some(first) = on_path("polycarp", path.as_ref()) {
                let same = fs::canonicalize(&first).ok() == fs::canonicalize(&installed).ok();
                if !same && installed.exists() {
                    println!(
                        "note: `polycarp` in your shell is {}, not the updated command at {}. Remove the old one, or put {} first on PATH.",
                        first.display(),
                        installed.display(),
                        installed.parent().unwrap_or(&installed).display()
                    );
                }
            }
            let link = installed.with_file_name("polycarp-browser");
            if let Some(old) = shadowed("polycarp-browser", &link, path.as_ref()) {
                let (old, link) = (old.display(), link.display());
                println!("note: `polycarp-browser` in your shell is {old}, an older copy. `polycarp browser` runs the updated one at {link}. Remove the old one with `rm {old}`.");
            }
            println!("polycarp update: done.");
            0
        }
        Outcome::Failed { .. } => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOME: &str = "/home/u";
    const CHECKOUT: &str = "/home/u/src/polycarp";
    const WORKTREE: &str = "/home/u/.cache/polycarp/source-1234abcd";
    const ORIGIN: &str = "https://github.com/baney75/polycarp.git";
    /// The polycarp that starts the update: a build somewhere else, not the installed command.
    const BOOT: &str = "/home/u/build/polycarp";
    const INSTALLED: &str = "/home/u/.local/bin/polycarp";
    const BROWSER_HOME: &str = "/home/u/.local/share/polycarp/browser/source";

    fn source(origin: Option<&str>, dirty: bool) -> Install {
        Install::Source {
            checkout: PathBuf::from(CHECKOUT),
            origin: origin.map(str::to_string),
            dirty,
        }
    }

    fn facts(platform: Platform, install: Install) -> Facts {
        Facts {
            platform,
            install,
            worktree: PathBuf::from(WORKTREE),
            worktree_exists: false,
            home: PathBuf::from(HOME),
            polycarp: PathBuf::from(BOOT),
            installed: PathBuf::from(INSTALLED),
            browser_home: PathBuf::from(BROWSER_HOME),
            arm64: true,
            hyprland: true,
            node: true,
            skill_installed: false,
            terminal: false,
        }
    }

    const YES: Options = Options {
        check: false,
        dry_run: false,
        yes: true,
        finish: false,
    };
    /// What the newly installed command runs: `--finish` carries its own yes.
    const FINISH: Options = Options {
        check: false,
        dry_run: false,
        yes: true,
        finish: true,
    };
    const DRY: Options = Options {
        check: false,
        dry_run: true,
        yes: false,
        finish: false,
    };
    const CHECK: Options = Options {
        check: true,
        dry_run: false,
        yes: false,
        finish: false,
    };

    fn steps_of(plan: Plan) -> Vec<Step> {
        match plan {
            Plan::Run { steps, .. } => steps,
            Plan::Refuse { message, .. } => panic!("refused: {message}"),
        }
    }
    fn refusal(plan: Plan) -> (i32, String) {
        match plan {
            Plan::Refuse { code, message } => (code, message),
            Plan::Run { .. } => panic!("the plan was not refused"),
        }
    }
    fn commands(steps: &[Step]) -> Vec<String> {
        steps.iter().map(|st| st.argv.join(" ")).collect()
    }

    #[cfg(unix)]
    #[test]
    fn mac_source_plan() {
        const MAC_NEEDS: &str = "polycarp command,app,spaces command,browser helper";
        let f = facts(Platform::Mac, source(Some(ORIGIN), false));
        let steps = steps_of(plan(&f, YES));
        assert_eq!(
            commands(&steps),
            vec![
                format!("git -C {CHECKOUT} fetch origin +refs/heads/main:refs/remotes/origin/main"),
                format!("git -C {CHECKOUT} worktree prune"),
                format!("git -C {CHECKOUT} worktree add --detach --force {WORKTREE} refs/remotes/origin/main"),
                format!("{BOOT} update --is-current {WORKTREE} HEAD --needs {MAC_NEEDS}"),
                format!("{WORKTREE}/browser/scripts/setup-siblings.sh"),
                format!("git -C {WORKTREE} checkout -- ."),
                "make -C spaces install".to_string(),
                format!("{INSTALLED} update --finish --source {CHECKOUT}"),
            ]
        );
        let make = &steps[6];
        assert_eq!(make.cwd.as_deref(), Some(Path::new(WORKTREE)));
        assert_eq!(
            make.env,
            vec![("BANEYSPACES_ARM64_ONLY".to_string(), "1".to_string())]
        );
        assert_eq!(steps.last().unwrap().role, Role::Handoff);
        // What the installed command then runs.
        let last = steps_of(plan(&f, FINISH));
        assert_eq!(
            commands(&last),
            vec![
                format!("{INSTALLED} update --reload-wait {WORKTREE} HEAD --wait 30 -- {INSTALLED} browser reload --if-idle"),
                format!("{INSTALLED} update --is-current {WORKTREE} HEAD --needs {MAC_NEEDS} --after-install --wait 30"),
            ]
        );
        assert_eq!(last[0].role, Role::Soft);
        assert_eq!(last[1].role, Role::Verify);

        // An Intel Mac builds the universal app, and an installed skill is refreshed after the app.
        let mut f = f;
        f.arm64 = false;
        f.skill_installed = true;
        let steps = steps_of(plan(&f, YES));
        assert!(steps[6].env.is_empty());
        assert_eq!(
            steps[7].argv,
            ["/home/u/.local/bin/polycarp-spaces", "skill", "install"]
        );
    }

    #[test]
    fn an_existing_clean_copy_is_reset_not_made_again() {
        let mut f = facts(Platform::Mac, source(Some(ORIGIN), false));
        f.worktree_exists = true;
        let cmds = commands(&steps_of(plan(&f, YES)));
        assert_eq!(
            cmds[1],
            format!("git -C {WORKTREE} reset --hard refs/remotes/origin/main")
        );
        assert_eq!(cmds[2], format!("git -C {WORKTREE} clean -fd"));
        assert!(!cmds.iter().any(|c| c.contains("worktree add")));
    }

    #[cfg(unix)]
    #[test]
    fn linux_source_plan_with_hyprland() {
        let f = facts(Platform::Linux, source(Some(ORIGIN), false));
        let steps = steps_of(plan(&f, YES));
        let needs = "polycarp command,spaces command,browser helper";
        assert_eq!(
            commands(&steps)[3..],
            [
                format!("{BOOT} update --is-current {WORKTREE} HEAD --needs {needs}"),
                // Every build first.
                "cargo build --release --locked -p baneyspaces-linux".to_string(),
                format!("{WORKTREE}/spaces/platforms/linux/scripts/build-engine.sh"),
                format!("{WORKTREE}/browser/scripts/setup-siblings.sh"),
                format!("git -C {WORKTREE} checkout -- ."),
                "npm run build".to_string(),
                "npm run build".to_string(),
                // Then the installs, the polycarp command last.
                format!("{BOOT} update --place-browser {WORKTREE}/browser {BROWSER_HOME} /home/u/.local/bin/polycarp-browser"),
                format!("node {BROWSER_HOME}/cli/dist/index.js setup --yes --no-wait"),
                format!("{WORKTREE}/spaces/platforms/linux/omarchy/install.sh"),
                "cargo install --locked --path cli --root /home/u/.local".to_string(),
                format!("{INSTALLED} update --finish --source {CHECKOUT}"),
            ]
        );
        // The helper build, then the extension build, which must not edit the tracked manifest.
        assert_eq!(
            steps[8].cwd.as_deref(),
            Some(Path::new(WORKTREE).join("browser/cli").as_path())
        );
        assert_eq!(
            steps[9].cwd.as_deref(),
            Some(Path::new(WORKTREE).join("browser").as_path())
        );
        assert_eq!(
            steps[9].env,
            vec![("TABKYRA_NO_BUMP".to_string(), "1".to_string())]
        );
        let first_install = steps
            .iter()
            .position(|st| st.role == Role::Install)
            .unwrap();
        assert!(
            steps[first_install..]
                .iter()
                .all(|st| st.role != Role::Build),
            "a build after an install: a failed build would leave parts mixed"
        );
        assert_eq!(
            commands(&steps_of(plan(&f, FINISH))),
            vec![
                format!("{INSTALLED} update --reload-wait {WORKTREE} HEAD --wait 30 -- node {BROWSER_HOME}/cli/dist/index.js reload --if-idle"),
                "/home/u/.local/bin/baneyspaces stop".to_string(),
                "hyprctl reload".to_string(),
                format!("{INSTALLED} update --is-current {WORKTREE} HEAD --needs {needs} --after-install --wait 30"),
            ]
        );
    }

    #[test]
    fn linux_source_plan_without_hyprland_or_node() {
        let mut f = facts(Platform::Linux, source(Some(ORIGIN), false));
        f.hyprland = false;
        let Plan::Run { steps, notes, .. } = plan(&f, YES) else {
            panic!("refused")
        };
        let cmds = commands(&steps);
        assert!(
            !cmds.iter().any(|c| c.contains("baneyspaces")
                || c.contains("hyprctl")
                || c.contains("omarchy")),
            "{cmds:?}"
        );
        assert!(cmds.iter().any(|c| c.starts_with("cargo install")));
        assert!(cmds.iter().any(|c| c.ends_with("setup --yes --no-wait")));
        assert!(
            notes.iter().any(|n| n.contains("hyprland.lua")),
            "{notes:?}"
        );
        // The gate needs the helper, so a device that gained Node since the last update is not "up to date".
        assert!(
            cmds[3].ends_with("--needs polycarp command,browser helper"),
            "{}",
            cmds[3]
        );

        f.node = false;
        let Plan::Run { steps, notes, .. } = plan(&f, YES) else {
            panic!("refused")
        };
        let cmds = commands(&steps);
        assert_eq!(
            cmds.len(),
            6,
            "fetch, two for the copy, the gate, the command, the handover: {cmds:?}"
        );
        assert!(cmds[3].ends_with("--needs polycarp command"), "{}", cmds[3]);
        assert!(
            notes.iter().any(|n| n.contains("Node and npm")),
            "{notes:?}"
        );
        let last = commands(&steps_of(plan(&f, FINISH)));
        assert_eq!(last.len(), 1, "only the final check: {last:?}");
    }

    /// The polycarp that starts an update can be older than the one it installs (the documented first
    /// run is a build in a checkout). It runs the steps up to the install; after the step that
    /// replaces the command, only the installed command runs, and it makes its own list of last steps.
    #[test]
    fn the_installed_command_finishes_the_update_not_the_one_that_started_it() {
        for platform in [Platform::Mac, Platform::Linux] {
            for boot in [BOOT, INSTALLED] {
                let mut f = facts(platform, source(Some(ORIGIN), false));
                f.polycarp = PathBuf::from(boot);
                let Plan::Run { steps, notes, .. } = plan(&f, YES) else {
                    panic!("refused")
                };
                let replaces = steps
                    .iter()
                    .position(|st| {
                        let c = st.argv.join(" ");
                        c == "make -C spaces install" || c.starts_with("cargo install ")
                    })
                    .expect("a step installs the polycarp command");
                // Up to there, polycarp is the one that made the plan, gate included.
                for st in &steps[..replaces] {
                    if st.argv.get(1).map(String::as_str) == Some("update") {
                        assert_eq!(st.argv[0], boot, "{}", st.title);
                    }
                }
                let gate = steps.iter().find(|st| st.role == Role::Gate).unwrap();
                assert_eq!(gate.argv[0], boot);
                // After it, the starter runs nothing, and the plan ends by handing over.
                if boot != INSTALLED {
                    for st in &steps[replaces + 1..] {
                        assert!(!st.argv.contains(&boot.to_string()), "{:?}", st.argv);
                    }
                }
                let last = steps.last().unwrap();
                assert_eq!(last.role, Role::Handoff);
                assert_eq!(last.argv[..3], [INSTALLED, "update", "--finish"]);
                assert!(
                    !steps
                        .iter()
                        .any(|st| matches!(st.role, Role::Soft | Role::Verify)),
                    "the reload, the restart and the final check belong to the installed command"
                );
                // The plan says so, and says more when the starter is not the installed command.
                assert!(
                    notes
                        .iter()
                        .any(|n| n.contains("run by the newly installed command")),
                    "{notes:?}"
                );
                assert_eq!(
                    notes
                        .iter()
                        .any(|n| n.contains("is not the installed command")),
                    boot != INSTALLED,
                    "{notes:?}"
                );
                // What the installed command runs: never the starter, and the check is its own.
                let finish = steps_of(plan(&f, FINISH));
                for st in &finish {
                    assert!(
                        boot == INSTALLED || !st.argv.contains(&boot.to_string()),
                        "{:?}",
                        st.argv
                    );
                }
                let verify = finish.last().unwrap();
                assert_eq!(verify.role, Role::Verify);
                assert_eq!(verify.argv[0], INSTALLED);
                assert!(verify.argv.contains(&"--after-install".to_string()));
            }
        }
        // `--finish` never asks and needs no terminal: the run that handed over had the yes.
        let f = facts(Platform::Linux, source(Some(ORIGIN), false));
        assert!(matches!(plan(&f, FINISH), Plan::Run { ask: false, .. }));
    }

    /// A clean copy made a moment ago has no node_modules. The sibling setup installs them (in
    /// `browser/` and in `browser/cli`), so it has to come before every build that needs them.
    #[test]
    fn a_fresh_clean_copy_gets_its_packages_before_any_build() {
        // What the plan relies on, read from the real script: if it stops installing the helper's
        // packages, this fails and the plan needs a step of its own.
        let script = fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../browser/scripts/setup-siblings.sh"),
        )
        .unwrap();
        let tail = script.rsplit_once("cd \"$here\"").unwrap().1;
        assert!(
            tail.contains("\nnpm install") && tail.contains("(cd cli && npm install"),
            "setup-siblings.sh no longer installs the packages for browser/ and browser/cli: {tail}"
        );
        for platform in [Platform::Mac, Platform::Linux] {
            let f = facts(platform, source(Some(ORIGIN), false));
            assert!(!f.worktree_exists);
            let steps = steps_of(plan(&f, YES));
            let setup = steps
                .iter()
                .position(|st| {
                    Path::new(&st.argv[0]).ends_with("browser/scripts/setup-siblings.sh")
                })
                .unwrap_or_else(|| panic!("{platform:?}: no sibling setup"));
            assert_eq!(
                steps[setup].cwd.as_deref(),
                Some(Path::new(WORKTREE).join("browser").as_path())
            );
            for (i, st) in steps.iter().enumerate() {
                let c = st.argv.join(" ");
                if c == "npm run build" || c == "make -C spaces install" {
                    assert!(
                        i > setup,
                        "{platform:?}: `{c}` runs before the packages are there"
                    );
                }
            }
        }
    }

    /// The same, with real files: the build steps of a Linux plan run through the real runner in a
    /// folder with no node_modules. `npm run build` here fails exactly as the real one does without
    /// its packages, and the sibling setup does what the real script's last lines do.
    #[cfg(unix)]
    #[test]
    fn the_build_steps_work_in_a_copy_with_no_node_modules() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("polycarp-fresh-copy-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let (wt, bin) = (root.join("copy"), root.join("bin"));
        let script = |path: &Path, body: &str| {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        };
        fs::create_dir_all(wt.join("browser/cli")).unwrap();
        script(
            &wt.join("browser/scripts/setup-siblings.sh"),
            "/bin/mkdir -p node_modules cli/node_modules",
        );
        script(
            &bin.join("npm"),
            "[ \"$1 $2\" = 'run build' ] && [ -d node_modules ] && : > built",
        );
        let mut f = facts(Platform::Linux, source(Some(ORIGIN), false));
        f.hyprland = false;
        f.worktree = wt.clone();
        let builds: Vec<Step> = steps_of(plan(&f, YES))
            .into_iter()
            .filter(|st| st.role == Role::Build)
            .collect();
        assert_eq!(builds.len(), 3, "{:?}", commands(&builds));
        let run = |steps: &[Step]| {
            let mut runner = RealRunner::with_path(&root, Some(bin.clone().into_os_string()));
            let mut out = Vec::new();
            execute(steps, &mut runner, &mut out)
        };
        // Without the sibling setup the first build fails: this is the failure a missing install gives.
        assert_eq!(
            run(&builds[1..]),
            Outcome::Failed {
                step: 0,
                code: Some(1)
            }
        );
        assert_eq!(run(&builds), Outcome::Done);
        assert!(wt.join("browser/cli/built").is_file() && wt.join("browser/built").is_file());
        let _ = fs::remove_dir_all(&root);
    }

    /// Nothing that is installed may run from the cache folder: it can be pruned, and the next update
    /// rebuilds in it. On Linux the helper and the extension are copied out, and every command that
    /// stays in use is run from where it was installed.
    #[test]
    fn linux_installs_the_browser_outside_the_cache() {
        let f = facts(Platform::Linux, source(Some(ORIGIN), false));
        let Plan::Run { steps, notes, .. } = plan(&f, YES) else {
            panic!("refused")
        };
        let cmds = commands(&steps);
        assert!(
            !cmds.iter().any(|c| c.starts_with("npm link")),
            "npm link leaves polycarp-browser pointing into the clean copy: {cmds:?}"
        );
        let place = steps
            .iter()
            .find(|st| st.argv.get(2).map(String::as_str) == Some("--place-browser"))
            .expect("a step copies the browser part out of the cache");
        assert_eq!(place.role, Role::Install);
        let (to, link) = (Path::new(&place.argv[4]), Path::new(&place.argv[5]));
        assert_eq!(to, Path::new(BROWSER_HOME));
        assert_eq!(link, Path::new(HOME).join(".local/bin/polycarp-browser"));
        assert!(!to.starts_with(WORKTREE) && !to.starts_with(Path::new(HOME).join(".cache")));
        // Registering with the browsers and reloading run the installed helper, never the cache's.
        let all: Vec<Step> = steps
            .into_iter()
            .chain(steps_of(plan(&f, FINISH)))
            .collect();
        // The reload runs inside `update --reload-wait ... -- node <entry> reload`.
        let node: Vec<(&Step, usize)> = all
            .iter()
            .filter_map(|st| st.argv.iter().position(|a| a == "node").map(|i| (st, i)))
            .collect();
        assert_eq!(node.len(), 2, "setup and reload");
        for (st, i) in node {
            assert!(
                Path::new(&st.argv[i + 1]).starts_with(BROWSER_HOME),
                "{:?}",
                st.argv
            );
            assert_eq!(st.cwd.as_deref(), Some(Path::new(BROWSER_HOME)));
        }
        assert!(
            notes
                .iter()
                .any(|n| n.contains(BROWSER_HOME)
                    && n.contains("nothing installed runs from the cache")),
            "{notes:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn placing_the_browser_copies_it_out_and_survives_the_cache_being_deleted() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("polycarp-place-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let from = root.join("cache/source-1/browser");
        let to = root.join("home/.local/share/polycarp/browser/source");
        let link = root.join("home/.local/bin/polycarp-browser");
        let write = |rel: &str, text: &str| {
            let p = from.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, text).unwrap();
        };
        // Not built yet: refused, and nothing is made.
        write("package.json", "{}");
        assert!(place_browser(&from, &to, &link)
            .unwrap_err()
            .contains("no build to install"));
        assert!(!to.exists() && fs::symlink_metadata(&link).is_err());

        write("static/manifest.chrome.json", "{\"version\":\"1.0.0\"}");
        write("cli/package.json", "{}");
        write("cli/dist/index.js", "#!/bin/sh\necho one\n");
        write("cli/dist/build-info.json", "{}");
        write("dist-chrome/manifest.json", "{}");
        write("dist-chrome/assets/a.js", "a");
        write("node_modules/big/index.js", "not copied");
        write("src/secret.ts", "not copied");
        place_browser(&from, &to, &link).unwrap();
        for rel in [
            "package.json",
            "static/manifest.chrome.json",
            "cli/package.json",
            "cli/dist/build-info.json",
            "dist-chrome/assets/a.js",
        ] {
            assert!(to.join(rel).is_file(), "{rel}");
        }
        assert!(!to.join("node_modules").exists() && !to.join("src").exists());
        let helper = to.join("cli/dist/index.js");
        assert_eq!(fs::read_link(&link).unwrap(), helper);
        assert!(fs::metadata(&helper).unwrap().permissions().mode() & 0o111 != 0);

        // The cache is pruned: the installed command still resolves, to a file outside the cache.
        fs::remove_dir_all(root.join("cache")).unwrap();
        let real = fs::canonicalize(&link).unwrap();
        assert!(
            real.is_file() && !real.starts_with(fs::canonicalize(&root).unwrap().join("cache"))
        );
        assert_eq!(fs::read_to_string(&link).unwrap(), "#!/bin/sh\necho one\n");

        // The next update swaps the new build in whole, and files it no longer has are gone.
        write("package.json", "{}");
        write("static/manifest.chrome.json", "{\"version\":\"1.0.1\"}");
        write("cli/package.json", "{}");
        write("cli/dist/index.js", "#!/bin/sh\necho two\n");
        write("dist-chrome/manifest.json", "{}");
        place_browser(&from, &to, &link).unwrap();
        assert_eq!(fs::read_to_string(&link).unwrap(), "#!/bin/sh\necho two\n");
        assert!(!to.join("dist-chrome/assets").exists());
        assert!(
            !to.with_file_name("source.new").exists() && !to.with_file_name("source.old").exists()
        );

        // A real file where the link goes is someone's own: refused before anything is copied.
        fs::remove_file(&link).unwrap();
        fs::write(&link, "mine").unwrap();
        write("cli/dist/index.js", "#!/bin/sh\necho three\n");
        assert!(place_browser(&from, &to, &link)
            .unwrap_err()
            .contains("did not make"));
        assert_eq!(fs::read_to_string(&link).unwrap(), "mine");
        assert_eq!(
            fs::read_to_string(&helper).unwrap(),
            "#!/bin/sh\necho two\n"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn mac_release_hands_off_to_the_app() {
        let spaces =
            PathBuf::from("/Applications/Polycarp.app/Contents/Resources/bin/polycarp-spaces");
        let f = facts(
            Platform::Mac,
            Install::MacRelease {
                spaces: Some(spaces.clone()),
            },
        );
        let steps = steps_of(plan(&f, YES));
        assert_eq!(
            commands(&steps),
            vec![format!("{} update --now", spaces.display())]
        );
        let steps = steps_of(plan(&f, CHECK));
        assert_eq!(
            commands(&steps),
            vec![format!("{} update --check", spaces.display())]
        );
        assert_eq!(steps[0].role, Role::Gate);
        // The app is there but its command is not: say so, build nothing.
        let (code, message) = refusal(plan(
            &facts(Platform::Mac, Install::MacRelease { spaces: None }),
            YES,
        ));
        assert_eq!(code, 1);
        assert!(message.contains("polycarp-spaces command was not found"));
    }

    #[test]
    fn windows_is_refused_with_the_build_steps() {
        for install in [source(Some(ORIGIN), false), Install::Unknown] {
            for o in [YES, DRY, CHECK, FINISH] {
                let (code, message) = refusal(plan(&facts(Platform::Windows, install.clone()), o));
                assert_eq!(code, 2);
                assert!(message.contains("not supported on Windows yet"));
                assert!(message.contains("cargo build --release --locked -p baneyspaces-windows"));
            }
        }
    }

    #[test]
    fn an_install_nobody_recorded_is_refused_with_what_to_do() {
        let (code, message) = refusal(plan(&facts(Platform::Linux, Install::Unknown), YES));
        assert_eq!(code, 2);
        assert!(message.contains("polycarp update --source"));
    }

    #[test]
    fn a_wrong_origin_is_refused_and_a_dirty_checkout_is_never_built() {
        for origin in [
            Some("https://github.com/someone/polycarp.git"),
            Some("https://github.com/baney75/tabkyra"),
            None,
        ] {
            for o in [YES, DRY, CHECK, FINISH] {
                let (code, message) =
                    refusal(plan(&facts(Platform::Mac, source(origin, false)), o));
                assert_eq!(code, 1, "{origin:?}");
                assert!(message.contains("Nothing was run"), "{message}");
            }
        }
        for origin in [
            ORIGIN,
            "git@github.com:baney75/polycarp.git",
            "ssh://git@github.com/baney75/polycarp",
            "https://github.com/Baney75/Polycarp/",
        ] {
            assert!(is_polycarp_origin(origin), "{origin}");
        }
        // Uncommitted changes in the checkout: the plan says they are not installed, and it is the same
        // plan as for a clean checkout, built in the clean copy.
        let clean = plan(&facts(Platform::Mac, source(Some(ORIGIN), false)), YES);
        let Plan::Run { steps, notes, .. } =
            plan(&facts(Platform::Mac, source(Some(ORIGIN), true)), YES)
        else {
            panic!("refused")
        };
        assert_eq!(steps, steps_of(clean));
        assert!(
            notes
                .iter()
                .any(|n| n.contains("uncommitted changes") && n.contains("not installed")),
            "{notes:?}"
        );
    }

    #[test]
    fn no_terminal_and_no_yes_is_refused_but_looking_is_not() {
        let mut f = facts(Platform::Mac, source(Some(ORIGIN), false));
        let none = Options::default();
        let (code, message) = refusal(plan(&f, none));
        assert_eq!(code, 2);
        assert!(message.contains("no terminal") && message.contains("--yes"));
        assert!(matches!(plan(&f, DRY), Plan::Run { ask: false, .. }));
        assert!(matches!(plan(&f, CHECK), Plan::Run { ask: false, .. }));
        assert!(matches!(plan(&f, YES), Plan::Run { ask: false, .. }));
        f.terminal = true;
        assert!(matches!(plan(&f, none), Plan::Run { ask: true, .. }));
        assert!(matches!(plan(&f, YES), Plan::Run { ask: false, .. }));
    }

    #[test]
    fn check_only_fetches_and_compares() {
        let f = facts(Platform::Linux, source(Some(ORIGIN), true));
        let steps = steps_of(plan(&f, CHECK));
        assert_eq!(
            commands(&steps),
            vec![
                format!("git -C {CHECKOUT} fetch origin +refs/heads/main:refs/remotes/origin/main"),
                format!("{BOOT} update --is-current {CHECKOUT} refs/remotes/origin/main --needs polycarp command,spaces command,browser helper"),
            ]
        );
        assert_eq!(steps[1].role, Role::Gate);
    }

    /// Every plan, for every platform and option that builds: nothing is built or installed from
    /// anywhere but the clean copy, and the person's checkout is only ever named to git.
    #[test]
    fn nothing_is_ever_built_outside_the_clean_copy() {
        let mut seen = 0;
        for platform in [Platform::Mac, Platform::Linux] {
            for dirty in [false, true] {
                for exists in [false, true] {
                    for (hyprland, node, skill) in [
                        (true, true, true),
                        (false, true, false),
                        (true, false, true),
                        (false, false, false),
                    ] {
                        let mut f = facts(platform, source(Some(ORIGIN), dirty));
                        f.worktree_exists = exists;
                        f.hyprland = hyprland;
                        f.node = node;
                        f.skill_installed = skill;
                        let all = steps_of(plan(&f, YES))
                            .into_iter()
                            .chain(steps_of(plan(&f, FINISH)));
                        for step in all {
                            if matches!(step.role, Role::Build | Role::Install) {
                                let cwd = step.cwd.as_deref().unwrap_or_else(|| {
                                    panic!("{} has no working directory", step.title)
                                });
                                // A build only ever runs in the clean copy. An install runs there
                                // too, or in the folder the browser part was installed into.
                                assert!(
                                    cwd.starts_with(WORKTREE)
                                        || (step.role == Role::Install
                                            && cwd.starts_with(BROWSER_HOME)),
                                    "{} runs in {}",
                                    step.title,
                                    cwd.display()
                                );
                                seen += 1;
                            }
                            // The handover names the checkout only so the installed command can
                            // find the same clean copy. It builds nothing there.
                            if !matches!(step.role, Role::Git | Role::Handoff) {
                                let names_checkout = step.argv.iter().any(|a| a.contains(CHECKOUT))
                                    || step.cwd.as_deref().is_some_and(|d| d.starts_with(CHECKOUT));
                                assert!(
                                    !names_checkout,
                                    "{} touches the checkout: {:?}",
                                    step.title, step.argv
                                );
                            }
                            // The only ref ever checked out or built is origin/main.
                            if step.role == Role::Git
                                && (step.argv.contains(&"reset".to_string())
                                    || step.argv.contains(&"add".to_string()))
                            {
                                assert_eq!(
                                    step.argv.last().map(String::as_str),
                                    Some("refs/remotes/origin/main")
                                );
                            }
                        }
                    }
                }
            }
        }
        assert!(seen > 40, "the table built nothing ({seen} steps)");
    }

    /// A runner that runs nothing: it answers each step from a script and remembers what it was asked.
    struct Fake {
        codes: Vec<Option<i32>>,
        ran: Vec<String>,
    }
    impl Runner for Fake {
        fn run(&mut self, step: &Step) -> Ran {
            let code = self.codes.get(self.ran.len()).copied().unwrap_or(Some(0));
            self.ran.push(step.title.clone());
            Ran {
                code,
                output: if code == Some(0) {
                    String::new()
                } else {
                    format!("{} said no", step.title)
                },
            }
        }
    }
    fn run_fake(steps: &[Step], codes: &[Option<i32>]) -> (Outcome, Vec<String>, String) {
        let mut fake = Fake {
            codes: codes.to_vec(),
            ran: Vec::new(),
        };
        let mut out = Vec::new();
        let outcome = execute(steps, &mut fake, &mut out);
        (outcome, fake.ran, String::from_utf8(out).unwrap())
    }

    #[test]
    fn the_executor_stops_at_the_first_failure_and_reports_the_step() {
        let steps = steps_of(plan(
            &facts(Platform::Mac, source(Some(ORIGIN), false)),
            YES,
        ));
        // The fifth step (the siblings) fails; the gate before it said "an update is waiting".
        let codes = [Some(0), Some(0), Some(0), Some(AVAILABLE), Some(7)];
        let (outcome, ran, text) = run_fake(&steps, &codes);
        assert_eq!(
            outcome,
            Outcome::Failed {
                step: 4,
                code: Some(7)
            }
        );
        assert_eq!(ran.len(), 5, "nothing after the failed step ran: {ran:?}");
        assert!(
            text.contains("step 5 of 8: Get what the extension builds against"),
            "{text}"
        );
        assert!(
            text.contains("the packages for the helper and the extension said no"),
            "the step's own output: {text}"
        );
        assert!(text.contains("step 5 of 8 failed (exit 7)"), "{text}");
        assert!(
            text.contains("Nothing that is installed on this device was changed."),
            "{text}"
        );
        assert!(text.contains("run `polycarp update` again"), "{text}");
        assert!(!text.contains("step 6 of 8"), "{text}");

        // The install step itself fails: say that parts may be mixed.
        let codes = [
            Some(0),
            Some(0),
            Some(0),
            Some(AVAILABLE),
            Some(0),
            Some(0),
            Some(1),
        ];
        let (outcome, ran, text) = run_fake(&steps, &codes);
        assert_eq!(steps[6].role, Role::Install);
        assert_eq!(
            outcome,
            Outcome::Failed {
                step: 6,
                code: Some(1)
            }
        );
        assert_eq!(ran.len(), 7);
        assert!(
            text.contains("some parts may be new and others old"),
            "{text}"
        );

        // The handover fails: every part is installed, and the report says what did not finish.
        let codes = [
            Some(0),
            Some(0),
            Some(0),
            Some(AVAILABLE),
            Some(0),
            Some(0),
            Some(0),
            Some(1),
        ];
        let (outcome, _, text) = run_fake(&steps, &codes);
        assert_eq!(
            outcome,
            Outcome::Failed {
                step: 7,
                code: Some(1)
            }
        );
        assert!(
            text.contains("Every part was installed. The last steps")
                && text.contains("did not finish"),
            "{text}"
        );

        // A program that cannot be started is a failure too.
        let (outcome, ran, text) = run_fake(&steps, &[None]);
        assert_eq!(
            outcome,
            Outcome::Failed {
                step: 0,
                code: None
            }
        );
        assert_eq!(ran.len(), 1);
        assert!(text.contains("it could not be started"), "{text}");
    }

    #[test]
    fn the_executor_stops_early_when_everything_is_up_to_date() {
        let steps = steps_of(plan(
            &facts(Platform::Mac, source(Some(ORIGIN), false)),
            YES,
        ));
        let (outcome, ran, text) = run_fake(&steps, &[Some(0), Some(0), Some(0), Some(0)]);
        assert_eq!(outcome, Outcome::UpToDate);
        assert_eq!(ran.len(), 4, "the gate was the last step run: {ran:?}");
        assert!(
            !text.contains("make") && !text.contains("step 5 of 8"),
            "{text}"
        );
        // A gate that fails for another reason (git could not read the commit) is a failure, not "carry on".
        let (outcome, ran, _) = run_fake(&steps, &[Some(0), Some(0), Some(0), Some(1)]);
        assert_eq!(
            outcome,
            Outcome::Failed {
                step: 3,
                code: Some(1)
            }
        );
        assert_eq!(ran.len(), 4);
    }

    #[test]
    fn a_soft_step_that_fails_does_not_stop_the_update_but_the_check_does() {
        // The last steps, as the installed command runs them.
        let steps = steps_of(plan(
            &facts(Platform::Mac, source(Some(ORIGIN), false)),
            FINISH,
        ));
        // The reload says an agent is working (exit 75); the check at the end then fails.
        let (outcome, ran, text) = run_fake(&steps, &[Some(75), Some(1)]);
        assert_eq!(ran.len(), 2, "every step ran: {ran:?}");
        assert_eq!(
            outcome,
            Outcome::Failed {
                step: 1,
                code: Some(1)
            }
        );
        assert!(
            text.contains("note: this step did not happen (exit 75). The update carries on."),
            "{text}"
        );
        assert!(text.contains("the parts do not all match yet"), "{text}");
        // All green, here and in the plan that hands over.
        assert_eq!(run_fake(&steps, &[]).0, Outcome::Done);
        let steps = steps_of(plan(
            &facts(Platform::Mac, source(Some(ORIGIN), false)),
            YES,
        ));
        let codes = [Some(0), Some(0), Some(0), Some(AVAILABLE)];
        assert_eq!(run_fake(&steps, &codes).0, Outcome::Done);
    }

    #[test]
    fn a_check_plan_ends_in_up_to_date_or_available() {
        let steps = steps_of(plan(
            &facts(Platform::Linux, source(Some(ORIGIN), false)),
            CHECK,
        ));
        assert_eq!(run_fake(&steps, &[Some(0), Some(0)]).0, Outcome::UpToDate);
        assert_eq!(
            run_fake(&steps, &[Some(0), Some(AVAILABLE)]).0,
            Outcome::Available
        );
        assert_eq!(
            run_fake(&steps, &[Some(128)]).0,
            Outcome::Failed {
                step: 0,
                code: Some(128)
            }
        );
    }

    #[test]
    fn the_printed_plan_shows_each_command_and_where_it_runs() {
        let f = facts(Platform::Mac, source(Some(ORIGIN), true));
        let Plan::Run {
            summary,
            steps,
            notes,
            ..
        } = plan(&f, DRY)
        else {
            panic!("refused")
        };
        let text = render(&summary, &steps, &notes);
        assert!(
            text.starts_with(&format!(
                "polycarp update, source install: origin/main of {CHECKOUT}, built in {WORKTREE}\n"
            )),
            "{text}"
        );
        assert!(text.contains("  7. Build Polycarp.app"), "{text}");
        assert!(
            text.contains(&format!(
                "     make -C spaces install\n     (in {WORKTREE}, with BANEYSPACES_ARM64_ONLY=1)"
            )),
            "{text}"
        );
        assert!(
            text.contains("note: /home/u/src/polycarp has uncommitted changes."),
            "{text}"
        );
    }

    #[test]
    fn each_checkout_gets_its_own_clean_copy_and_the_record_round_trips() {
        let cache = Path::new("/c");
        let a = worktree_for(cache, Path::new("/src/one"));
        assert_eq!(a, worktree_for(cache, Path::new("/src/one")));
        assert_ne!(a, worktree_for(cache, Path::new("/src/two")));
        assert!(a.starts_with(cache));

        let dir = std::env::temp_dir().join(format!("polycarp-update-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(recorded_source(&dir), None);
        // Absolute on every system (`/src/...` is not, on Windows), with characters that need escaping.
        let checkout = dir.join("src").join("with \"quotes\" and spaces");
        record_source(&dir, &checkout).unwrap();
        assert_eq!(recorded_source(&dir).as_deref(), Some(checkout.as_path()));
        fs::write(dir.join(SOURCE_FILE), "checkout = \"relative/path\"\n").unwrap();
        assert_eq!(
            recorded_source(&dir),
            None,
            "a relative path is not a checkout"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    const T: &str = "aaaaaaa1111111111111111111111111111111aa";
    const OLD: &str = "bbbbbbb2222222222222222222222222222222bb";
    #[cfg(unix)]
    #[test]
    fn an_older_helper_earlier_on_path_is_named_and_one_in_a_node_modules_is_never_a_tool() {
        let root = std::env::temp_dir().join(format!("polycarp-shadow-{}", std::process::id()));
        let dirs = ["p/node_modules/.bin", "npm/bin", "home/.local/bin"].map(|d| root.join(d));
        for d in &dirs {
            fs::create_dir_all(d).unwrap();
            fs::copy("/bin/sh", d.join("polycarp-browser")).unwrap();
        }
        let [modules, old, new] = dirs.map(|d| d.join("polycarp-browser"));
        let path =
            |list: &[&PathBuf]| std::env::join_paths(list.iter().map(|p| p.parent().unwrap())).ok();
        let all = path(&[&modules, &old, &new]);
        assert_eq!(on_path("polycarp-browser", all.as_ref()), Some(old.clone()));
        assert_eq!(
            shadowed("polycarp-browser", &new, all.as_ref()),
            Some(old.clone())
        );
        assert_eq!(
            shadowed("polycarp-browser", &new, path(&[&new, &old]).as_ref()),
            None
        );
        let mut steps = vec![Step::new(Role::Build, "t", &["polycarp-browser", "x"])];
        resolve(&mut steps, all.as_ref());
        assert_eq!(steps[0].argv[0], s(&old));
        let _ = fs::remove_dir_all(&root);
    }

    fn at(name: &str, commit: &str) -> Part {
        Part::installed(name, None, version::Build::new(commit, "", false), None)
    }

    #[test]
    fn a_slow_browser_alone_never_fails_the_update_or_starts_one() {
        let needs = ["polycarp command", "browser helper"];
        let parts = vec![
            at("polycarp command", T),
            at("browser helper", T),
            Part::unanswered("extension (Helium)", version::NO_ANSWER),
        ];
        assert_eq!(standing(&parts, &needs, T), Standing::Current);
        // The helper itself gave no answer: still not missing, still not a reason to fail.
        let parts = vec![
            at("polycarp command", T),
            Part::unanswered("browser helper", version::NO_ANSWER),
            Part::unanswered("extension", version::NO_ANSWER),
        ];
        assert_eq!(standing(&parts, &needs, T), Standing::Current);
        // A part that did answer and is older is still behind.
        let parts = vec![
            at("polycarp command", OLD),
            Part::unanswered("browser helper", version::NO_ANSWER),
        ];
        assert_eq!(standing(&parts, &needs, T), Standing::Behind);
    }

    #[test]
    fn a_part_the_update_would_install_makes_it_run() {
        // Everything that is installed matches, but the helper is not there yet (Node was added).
        let parts = vec![
            at("polycarp command", T),
            Part::absent("browser helper", "not installed"),
            Part::absent("extension", "not installed"),
        ];
        assert_eq!(
            standing(&parts, &["polycarp command"], T),
            Standing::Current
        );
        assert_eq!(
            standing(&parts, &["polycarp command", "browser helper"], T),
            Standing::Behind
        );
        // A part nobody listed at all is missing too.
        assert_eq!(
            standing(&parts, &["polycarp command", "spaces command"], T),
            Standing::Behind
        );
    }

    /// A browser for `reload_wait` to wait on, on a fake clock: each pause is 2 s and each look at
    /// the parts takes `look_secs`. `ready_after` reloads make Helium run `T` (0: never); Chrome runs
    /// `T` after the first. Before any reload both run `OLD`, and right after each reload the
    /// extension is gone for one look. `helium_late`: Helium gives no answer until the clock reaches
    /// that many seconds after the start. `absent_looks`: the first looks see no browser connected.
    /// `helium_quiet_from`: Helium gives no answer from then on; `helium_gone_from`: it is not listed
    /// from then on. `chrome_quiet`: Chrome never answers, before the reload too.
    struct Browser {
        ready_after: u32,
        code: i32,
        look_secs: u64,
        helium_late: u64,
        none_connected: bool,
        absent_looks: u32,
        helium_quiet_from: u64,
        helium_gone_from: u64,
        chrome_quiet: bool,
    }
    impl Browser {
        fn new(ready_after: u32) -> Browser {
            Browser {
                ready_after,
                code: 0,
                look_secs: 0,
                helium_late: 0,
                none_connected: false,
                absent_looks: 0,
                helium_quiet_from: u64::MAX,
                helium_gone_from: u64::MAX,
                chrome_quiet: false,
            }
        }
    }

    /// Runs `reload_wait` for `wait_secs`. Returns the exit code, the reloads run, the looks taken,
    /// the seconds the fake clock reached and the output.
    fn reload_run(b: Browser, wait_secs: u64) -> (i32, u32, u32, u64, String) {
        use std::cell::Cell;
        let (reloads, looks, now) = (Cell::new(0u32), Cell::new(0u32), Cell::new(0u64));
        let since_reload = Cell::new(0u32);
        let mut reload = || {
            reloads.set(reloads.get() + 1);
            since_reload.set(0);
            Some(b.code)
        };
        let parts = || {
            looks.set(looks.get() + 1);
            now.set(now.get() + b.look_secs);
            since_reload.set(since_reload.get() + 1);
            if b.none_connected || (reloads.get() == 0 && looks.get() <= b.absent_looks) {
                return vec![Part::absent("extension", "no browser is connected")];
            }
            let chrome = |commit| match b.chrome_quiet {
                true => Part::unanswered("extension (Chrome)", "no answer in time"),
                false => at("extension (Chrome)", commit),
            };
            if reloads.get() == 0 {
                return vec![chrome(OLD), at("extension (Helium)", OLD)];
            }
            if since_reload.get() == 1 {
                return vec![Part::absent("extension", "no browser is connected")];
            }
            let ready = b.ready_after > 0 && reloads.get() >= b.ready_after;
            let helium = if now.get() < b.helium_late || now.get() >= b.helium_quiet_from {
                Part::unanswered("extension (Helium)", "no answer in time")
            } else {
                at("extension (Helium)", if ready { T } else { OLD })
            };
            match now.get() >= b.helium_gone_from {
                true => vec![chrome(T)],
                false => vec![chrome(T), helium],
            }
        };
        let clock = || std::time::Duration::from_secs(now.get());
        let mut pause = || now.set(now.get() + 2);
        let mut out = Vec::new();
        let rc = reload_wait(
            T,
            std::time::Duration::from_secs(wait_secs),
            &mut reload,
            &parts,
            &clock,
            &mut pause,
            &mut out,
        );
        let out = String::from_utf8(out).unwrap();
        (rc, reloads.get(), looks.get(), now.get(), out)
    }

    #[test]
    fn the_reload_step_waits_for_every_extension_to_run_the_new_build() {
        // #207: the first reload took, after a moment with no browser connected.
        let (rc, reloads, _, _, out) = reload_run(Browser::new(1), 30);
        assert_eq!((rc, reloads), (0, 1), "{out}");
        assert!(
            out.contains(&format!("runs {}", version::short(T))),
            "{out}"
        );
        // Helium kept the old build after the first reload: one more, then it runs the new one.
        let (rc, reloads, _, _, out) = reload_run(Browser::new(2), 30);
        assert_eq!((rc, reloads), (0, 2), "{out}");
        assert!(
            out.contains("extension (Helium) still runs the build from before"),
            "{out}"
        );
        assert!(!out.contains("extension (Chrome) still runs"), "{out}");
    }

    #[test]
    fn the_reload_step_retries_once_and_stops_at_its_bound() {
        let (rc, reloads, _, _, out) = reload_run(Browser::new(0), 30);
        assert_eq!((rc, reloads), (1, 2), "never a third reload: {out}");
        assert!(
            out.contains("extension (Helium) still does not run") && out.contains("two reloads"),
            "{out}"
        );
        // An agent working in the browser: no reload, no wait, and the helper's code goes through.
        let busy = Browser {
            code: RELOAD_BUSY,
            ..Browser::new(1)
        };
        let (rc, reloads, _, _, out) = reload_run(busy, 30);
        assert_eq!((rc, reloads), (RELOAD_BUSY, 1), "{out}");
        // A wait shorter than two looks still gets its one retry.
        let (rc, reloads, _, _, _) = reload_run(Browser::new(2), 0);
        assert_eq!((rc, reloads), (0, 2));
    }

    #[test]
    fn first_f1_review_of_pr_218_no_browser_connected_ends_the_wait_at_once() {
        let none = Browser {
            none_connected: true,
            ..Browser::new(1)
        };
        // It looks until a reload would have settled (first-F1 of the review of PR 236), then ends.
        let (rc, reloads, looks, secs, out) = reload_run(none, 30);
        assert_eq!((rc, reloads, looks, secs), (0, 0, 3, 4), "{out}");
        assert!(out.contains("No browser is connected"), "{out}");
        assert!(!out.contains("two reloads"), "{out}");
    }

    #[test]
    fn first_f2_review_of_pr_218_the_wait_is_bounded_by_time_not_looks() {
        // A helper that takes 5 s per look, on a browser that never takes the new build: with a
        // count of 15 looks this ran 15 x 7 s. Now it ends one pause and one look past 30 s.
        let slow = Browser {
            look_secs: 5,
            ..Browser::new(0)
        };
        let (rc, reloads, _, secs, out) = reload_run(slow, 30);
        assert_eq!((rc, reloads), (1, 2), "{out}");
        assert!(secs <= 30 + 4 + 2 + 5 + 5, "the wait ran {secs} s: {out}");
        // The retry comes once half the time has passed, not at half the looks.
        let (_, _, looks, _, out) = reload_run(Browser::new(2), 30);
        assert!(
            looks >= 8,
            "retried after {looks} looks, before 15 s: {out}"
        );
    }

    #[test]
    fn first_f3_review_of_pr_218_no_second_reload_for_an_extension_that_only_has_not_answered() {
        // Helium answers late, then runs the new build: at the halfway look it reports no build,
        // so nothing is reloaded a second time.
        let late = Browser {
            helium_late: 20,
            ..Browser::new(1)
        };
        let (rc, reloads, _, _, out) = reload_run(late, 30);
        assert_eq!((rc, reloads), (0, 1), "{out}");
        assert!(!out.contains("reloaded once more"), "{out}");
        // One that never answers after the reload last reported the old build (second-F5 of the review
        // of PR 244): it fails, after the one reload that ran, with no second one.
        let silent = Browser {
            helium_late: 1000,
            ..Browser::new(1)
        };
        let (rc, reloads, _, _, out) = reload_run(silent, 30);
        assert_eq!((rc, reloads), (1, 1), "{out}");
        assert!(
            out.contains("extension (Helium) still does not run")
                && out.contains("after the reload."),
            "{out}"
        );
    }

    #[test]
    fn second_f6_review_of_pr_218_the_second_reload_says_every_browser_reloads() {
        let (_, _, _, _, out) = reload_run(Browser::new(2), 30);
        assert!(
            out.contains("so every browser's extension is reloaded once more"),
            "{out}"
        );
        assert!(!out.contains("so it is reloaded once more"), "{out}");
    }

    #[test]
    fn first_f1_review_of_pr_236_a_browser_that_connects_a_moment_late_is_reloaded() {
        let late = Browser {
            absent_looks: 1,
            ..Browser::new(1)
        };
        let (rc, reloads, _, _, out) = reload_run(late, 30);
        assert_eq!((rc, reloads), (0, 1), "{out}");
        assert!(!out.contains("No browser is connected"), "{out}");
    }

    #[test]
    fn first_f2_review_of_pr_236_one_seen_on_the_old_build_that_goes_quiet_fails() {
        let quiet = Browser {
            helium_quiet_from: 20,
            ..Browser::new(0)
        };
        let (rc, reloads, _, _, out) = reload_run(quiet, 30);
        assert_eq!((rc, reloads), (1, 2), "{out}");
        assert!(
            out.contains("extension (Helium) still does not run"),
            "{out}"
        );
    }

    #[test]
    fn first_f1_second_f5_review_of_pr_244_one_on_the_old_build_that_drops_out_fails() {
        // first-F1: seen on the old build after the reload, then gone from the list while Chrome runs T.
        let gone = Browser {
            helium_gone_from: 6,
            ..Browser::new(0)
        };
        let (rc, reloads, _, _, out) = reload_run(gone, 30);
        assert_eq!((rc, reloads), (1, 2), "{out}");
        assert!(
            out.contains("extension (Helium) still does not run"),
            "{out}"
        );
        // second-F5: on the old build before the reload, and in no look after it.
        let never = Browser {
            helium_gone_from: 0,
            ..Browser::new(0)
        };
        let (rc, reloads, _, _, out) = reload_run(never, 30);
        assert_eq!((rc, reloads), (1, 1), "{out}");
        assert!(
            out.contains("extension (Helium) still does not run")
                && out.contains("after the reload."),
            "{out}"
        );
    }

    #[test]
    fn first_f2_review_of_pr_244_one_that_went_quiet_before_halfway_gets_its_second_reload() {
        let quiet = Browser {
            helium_quiet_from: 10,
            ..Browser::new(0)
        };
        let (rc, reloads, _, _, out) = reload_run(quiet, 30);
        assert_eq!((rc, reloads), (1, 2), "{out}");
        assert!(out.contains("after two reloads."), "{out}");
    }

    #[test]
    fn second_f6_review_of_pr_244_a_late_answer_after_the_new_build_is_no_failure() {
        // Chrome never answers; Helium runs the old build, then T after the second reload, then is quiet.
        let late = Browser {
            chrome_quiet: true,
            helium_quiet_from: 26,
            ..Browser::new(2)
        };
        let (rc, reloads, _, _, out) = reload_run(late, 30);
        assert_eq!((rc, reloads), (0, 2), "{out}");
        assert!(out.contains("reported no build"), "{out}");
    }

    /// A git repository of one empty commit in a temp folder, and that commit: no test reads the
    /// developer's checkout (first-F3 of the review of PR 236).
    /// Removes its folders when dropped, a failed assert included (first-F4 of the review of PR 244).
    struct Gone(Vec<PathBuf>);
    impl Drop for Gone {
        fn drop(&mut self) {
            for dir in &self.0 {
                let _ = fs::remove_dir_all(dir);
            }
        }
    }

    fn temp_repo(name: &str) -> (PathBuf, String) {
        let dir = std::env::temp_dir().join(format!("polycarp-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let git = |a: &[&str]| {
            let who = [
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "-c",
                "commit.gpgsign=false",
            ];
            // Git's own variables would point it at the checkout a hook runs in (first-F3 of PR 244).
            let ran = Command::new("git")
                .arg("-C")
                .arg(&dir)
                .args(who)
                .args(a)
                .env_remove("GIT_DIR")
                .env_remove("GIT_WORK_TREE")
                .env_remove("GIT_INDEX_FILE")
                .output()
                .unwrap();
            assert!(ran.status.success(), "git {a:?}: {ran:?}");
            ran
        };
        git(&["init", "-q"]);
        git(&["commit", "-q", "--allow-empty", "-m", "t"]);
        let head = String::from_utf8(git(&["rev-parse", "HEAD"]).stdout).unwrap();
        (dir, head.trim().to_string())
    }

    /// second-F5 (review of PR 236): the reload runs through a real runner, made the one way every
    /// runner is. A stub in a trusted PATH folder runs, with only the trusted folders on its PATH; one
    /// in a folder under the current one never starts.
    #[cfg(unix)]
    #[test]
    fn second_f5_review_of_pr_236_the_real_runner_starts_only_a_trusted_reload() {
        use std::os::unix::fs::PermissionsExt;
        let (repo, head) = temp_repo("real-runner");
        let trusted = repo.join("bin");
        // cargo runs tests in the crate's folder, so a folder under it is not trusted.
        let here = std::env::current_dir().unwrap();
        let untrusted = here.join(format!("target/polycarp-untrusted-{}", std::process::id()));
        let _gone = Gone(vec![repo.clone(), untrusted.clone()]);
        let said = repo.join("said");
        for dir in [&trusted, &untrusted] {
            fs::create_dir_all(dir).unwrap();
            let stub = dir.join("polycarp-reload-stub");
            fs::write(
                &stub,
                format!(
                    "#!/bin/sh\nprintf '%s\\n%s' \"$1\" \"$PATH\" > '{}'\n",
                    said.display()
                ),
            )
            .unwrap();
            fs::set_permissions(&stub, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let word = OsString::from("/tmp/cafe");
        let mut args: Vec<OsString> = [
            "--reload-wait",
            "",
            "HEAD",
            "--wait",
            "0",
            "--",
            "polycarp-reload-stub",
        ]
        .map(OsString::from)
        .to_vec();
        args[1] = repo.clone().into_os_string();
        args.push(word.clone());
        let parts = || vec![at("extension (Chrome)", &head)];
        let device = Device {
            home: None,
            app: None,
            spaces: None,
            config: Err("none".to_string()),
            parts: &parts,
        };
        let both = std::env::join_paths([&trusted, &untrusted]).unwrap();
        let mut runner = RealRunner::with_path(&repo, Some(both));
        assert_eq!(reload_wait_command(&args, &device, &mut runner), 0);
        let path = trusted.into_os_string();
        let seen = [word.as_encoded_bytes(), b"\n", path.as_encoded_bytes()].concat();
        assert_eq!(fs::read(&said).unwrap(), seen);
        fs::remove_file(&said).unwrap();
        let mut runner = RealRunner::with_path(&repo, Some(untrusted.clone().into_os_string()));
        assert_eq!(reload_wait_command(&args, &device, &mut runner), 1);
        assert!(!said.exists());
    }

    /// `second-F5` (review of PR 218): the plan's own reload argv, as `polycarp update` hands it to
    /// `run`, gets past parsing and runs its reload through the steps' runner (`first-F4`).
    #[test]
    fn second_f5_first_f4_review_of_pr_218_the_plans_reload_argv_reaches_the_runner() {
        let f = facts(Platform::Linux, source(Some(ORIGIN), false));
        let step = steps_of(plan(&f, FINISH))
            .into_iter()
            .find(|st| st.argv.iter().any(|a| a == "--reload-wait"))
            .expect("the plan has a reload step");
        assert_eq!(&step.argv[1..3], ["update", "--reload-wait"]);
        let dashes = step.argv.iter().position(|a| a == "--").unwrap();
        let reload = step.argv[dashes + 1..].to_vec();
        // `polycarp update` drops the program and "update" before `run`. The clean copy is a temp
        // repository, so its HEAD resolves.
        let mut args: Vec<OsString> = step.argv[2..].iter().map(OsString::from).collect();
        let repo = temp_repo("plan-argv").0;
        let _gone = Gone(vec![repo.clone()]);
        args[1] = repo.into_os_string();
        let parts = || vec![at("extension (Chrome)", OLD)];
        let device = Device {
            home: None,
            app: None,
            spaces: None,
            config: Err("none".to_string()),
            parts: &parts,
        };
        let mut fake = Recorder::default();
        let rc = reload_wait_command(&args, &device, &mut fake);
        assert_ne!(rc, 2, "the plan's argv did not parse");
        assert_eq!(fake.argv.first(), Some(&reload));
        // A reload the runner cannot start ends the step without a wait.
        assert_eq!(rc, 1);
        assert_eq!(fake.argv.len(), 1);
    }

    /// A runner that starts nothing and remembers each argv: every reload "could not be started".
    #[derive(Default)]
    struct Recorder {
        argv: Vec<Vec<String>>,
    }
    impl Runner for Recorder {
        fn run(&mut self, step: &Step) -> Ran {
            self.argv.push(step.argv.clone());
            Ran {
                code: None,
                output: "not started".to_string(),
            }
        }
    }

    #[test]
    fn the_final_check_says_reload_pending_never_up_to_date() {
        let line = reload_pending_line("abc1234", &["extension (Helium)".to_string()]);
        assert!(line.starts_with("reload pending:"), "{line}");
        assert!(
            line.contains("extension (Helium) still runs the build from before"),
            "{line}"
        );
        assert!(!line.to_lowercase().contains("up to date"), "{line}");
    }

    #[test]
    fn reload_wait_arguments() {
        let os = |v: &[&str]| v.iter().map(OsString::from).collect::<Vec<_>>();
        assert_eq!(
            parse_reload_wait(&os(&["--wait", "30", "--", "node", "x.js", "reload"])),
            Ok((30, os(&["node", "x.js", "reload"])))
        );
        assert_eq!(parse_reload_wait(&os(&["--", "p"])), Ok((30, os(&["p"]))));
        assert!(parse_reload_wait(&os(&["--wait", "30"])).is_err());
        assert!(parse_reload_wait(&os(&["--wait", "30", "--"])).is_err());
        assert!(parse_reload_wait(&os(&["--bogus"])).is_err());
    }

    #[test]
    fn an_extension_that_only_has_to_reload_is_not_a_reason_to_rebuild() {
        let needs = ["polycarp command", "browser helper"];
        let parts = vec![
            at("polycarp command", T),
            at("browser helper", T),
            at("extension (Helium)", OLD),
            at("extension (Chrome)", T),
        ];
        assert_eq!(
            standing(&parts, &needs, T),
            Standing::ReloadPending(vec!["extension (Helium)".to_string()])
        );
        // Anything else behind is a real update.
        let parts = vec![
            at("polycarp command", T),
            at("browser helper", OLD),
            at("extension (Helium)", OLD),
        ];
        assert_eq!(standing(&parts, &needs, T), Standing::Behind);
    }

    #[test]
    fn the_gate_reads_its_options() {
        let args = |list: &[&str]| -> Vec<OsString> { list.iter().map(OsString::from).collect() };
        assert_eq!(parse_check(&[]), Ok(Check::default()));
        assert_eq!(
            parse_check(&args(&[
                "--needs",
                "polycarp command,browser helper",
                "--after-install",
                "--wait",
                "30"
            ])),
            Ok(Check {
                needs: vec!["polycarp command".into(), "browser helper".into()],
                after_install: true,
                wait: 30,
            })
        );
        assert_eq!(parse_check(&args(&["--wait", "9999"])).unwrap().wait, 600);
        assert!(parse_check(&args(&["--needs"])).is_err());
        assert!(parse_check(&args(&["--wait", "soon"])).is_err());
        assert!(parse_check(&args(&["--force"])).is_err());
    }
}
