//! `polycarp update`: one command that brings every Polycarp part on this device to origin/main.
//!
//! It works in two halves. `plan` is a pure function: from the platform, how Polycarp is installed
//! here and the options, it returns the steps as data (a title and an argv each) or a refusal.
//! `execute` then runs the steps in order through a `Runner`, stops at the first failure and says what
//! state things are in. `--dry-run` prints the plan and runs nothing.
//!
//! Only origin/main is ever built and installed, and only from a clean copy of it under the cache
//! folder: never from a branch, a changed tree or the checkout a person works in.

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
    /// This command, as later steps should call it.
    pub polycarp: PathBuf,
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
    /// The check at the end: `polycarp version --check`.
    Verify,
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
    let changes = !o.check && !o.dry_run;
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

fn source_steps(
    f: &Facts,
    checkout: &Path,
    dirty: bool,
    o: Options,
) -> (String, Vec<Step>, Vec<String>) {
    let (co, wt, me) = (s(checkout), s(&f.worktree), s(&f.polycarp));
    let summary = format!("source install: origin/main of {co}, built in {wt}");
    let mut notes = Vec::new();
    let mut steps = vec![Step::new(
        Role::Git,
        "Fetch origin/main",
        &["git", "-C", &co, FETCH[0], FETCH[1], FETCH[2]],
    )];
    if o.check {
        steps.push(Step::new(
            Role::Gate,
            "Compare what is installed with origin/main",
            &[&me, "update", "--is-current", &co, TARGET],
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
        "Stop here if every installed part is already at that commit",
        &[&me, "update", "--is-current", &wt, "HEAD"],
    ));
    match f.platform {
        Platform::Mac => mac_steps(f, &mut steps),
        Platform::Linux => linux_steps(f, &mut steps, &mut notes),
        Platform::Windows => {}
    }
    steps.push(Step::new(
        Role::Verify,
        "Check that every part now comes from the same commit",
        &[&me, "version", "--check", "--wait", "30"],
    ));
    (summary, steps, notes)
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

fn mac_steps(f: &Facts, steps: &mut Vec<Step>) {
    let wt = &f.worktree;
    let me = s(&f.polycarp);
    let env: Vec<(String, String)> = if f.arm64 {
        vec![("BANEYSPACES_ARM64_ONLY".to_string(), "1".to_string())]
    } else {
        Vec::new()
    };
    steps.push(
        Step::new(
            Role::Build,
            "Get what the extension builds against",
            &[&s(&wt.join("browser/scripts/setup-siblings.sh"))],
        )
        .in_dir(&wt.join("browser")),
    );
    steps.push(restore_step(wt));
    // What `make -C spaces install` does: bundle.sh builds the app with the command, the helper, the
    // extension and the skill inside, and install-app.sh quits the running app, swaps it, links the
    // commands in ~/.local/bin and opens it again.
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
    steps.push(Step::new(
        Role::Soft,
        "Reload the extension, unless an agent is working in the browser",
        &[&me, "browser", "reload", "--if-idle"],
    ));
}

fn linux_steps(f: &Facts, steps: &mut Vec<Step>, notes: &mut Vec<String>) {
    let wt = &f.worktree;
    let spaces = wt.join("spaces");
    let browser = wt.join("browser");
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
        steps.push(
            Step::new(
                Role::Install,
                "Install the daemon, the engine and the Hyprland include (Omarchy install script)",
                &[&s(&spaces.join("platforms/linux/omarchy/install.sh"))],
            )
            .in_dir(&spaces),
        );
    } else {
        notes.push(
            "No ~/.config/hypr/hyprland.lua here, so the spaces daemon (Hyprland only) is not built or installed.".to_string(),
        );
    }
    if f.node {
        let entry = s(&browser.join("cli/dist/index.js"));
        steps.push(
            Step::new(
                Role::Build,
                "Get what the extension builds against",
                &[&s(&browser.join("scripts/setup-siblings.sh"))],
            )
            .in_dir(&browser),
        );
        steps.push(restore_step(wt));
        steps.push(
            Step::new(
                Role::Build,
                "Build the browser helper",
                &["npm", "run", "build"],
            )
            .in_dir(&browser.join("cli")),
        );
        steps.push(
            Step::new(
                Role::Install,
                "Put polycarp-browser on PATH",
                &["npm", "link"],
            )
            .in_dir(&browser.join("cli")),
        );
        steps.push(
            Step::new(
                Role::Install,
                "Build the extension and register the helper with your browsers",
                &["node", &entry, "setup", "--yes", "--no-wait"],
            )
            .in_dir(&browser),
        );
        steps.push(
            Step::new(
                Role::Soft,
                "Reload the extension, unless an agent is working in the browser",
                &["node", &entry, "reload", "--if-idle"],
            )
            .in_dir(&browser),
        );
        notes.push(format!(
            "The browser helper and the extension run from {}. Keep that folder; `polycarp update` rebuilds it if it is ever deleted.",
            browser.display()
        ));
    } else {
        notes.push(
            "Node and npm are not on PATH, so the browser helper and the extension are not built. Install Node, then run `polycarp update` again.".to_string(),
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

/// A bare program name as an absolute path, from the absolute folders on PATH only: `.` and other
/// relative entries are skipped, so nothing in the current folder is ever picked up.
pub fn on_path(name: &str, path: Option<&OsString>) -> Option<PathBuf> {
    let file = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    std::env::split_paths(path?)
        .filter(|d| d.is_absolute())
        .map(|d| d.join(&file))
        .find(|p| crate::is_executable_file(p))
}

/// Runs steps for real: no shell, input closed, output straight to the terminal as it comes.
struct RealRunner {
    path: Option<OsString>,
}

impl RealRunner {
    fn new(home: &Path) -> RealRunner {
        // rustup's default spot, for a shell that has not picked it up (the installer does the same).
        let mut dirs: Vec<PathBuf> = Vec::new();
        let cargo = home.join(".cargo/bin");
        if cargo.is_dir() {
            dirs.push(cargo);
        }
        if let Some(p) = std::env::var_os("PATH") {
            dirs.extend(std::env::split_paths(&p));
        }
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

/// `polycarp update --is-current <dir> <rev>`, the gate the plan runs: exit 0 when every installed part
/// is at `rev` of the repo in `dir`, 100 when an update would change something.
fn is_current(dir: &Path, rev: &str, device: &Device) -> i32 {
    let Some(target) = git_line(
        dir,
        &["rev-parse", "--verify", &format!("{rev}^{{commit}}")],
    ) else {
        eprintln!("polycarp update: could not read {rev} in {}", dir.display());
        return 1;
    };
    let parts = (device.parts)();
    if version::is_current(&parts, &target) {
        println!(
            "up to date: every installed part is at origin/main ({})",
            version::short(&target)
        );
        return 0;
    }
    println!(
        "update available: origin/main is at {}",
        version::short(&target)
    );
    println!("{}", version::compare(&parts).line());
    AVAILABLE
}

pub fn run(args: &[OsString], device: &Device) -> i32 {
    if args.first().and_then(|a| a.to_str()) == Some("--is-current") && args.len() == 3 {
        return is_current(Path::new(&args[1]), &args[2].to_string_lossy(), device);
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
    let local = home.join(".local/bin/polycarp");
    let facts = Facts {
        platform: platform(),
        worktree_exists: worktree.join(".git").exists(),
        worktree,
        // This binary, not whichever `polycarp` is installed: an older one would not know the
        // commands the steps use.
        polycarp: std::env::current_exe()
            .ok()
            .filter(|p| p.is_absolute())
            .unwrap_or(local),
        arm64: cfg!(target_arch = "aarch64"),
        hyprland: home.join(".config/hypr/hyprland.lua").is_file(),
        node: on_path("node", path.as_ref()).is_some() && on_path("npm", path.as_ref()).is_some(),
        skill_installed: home.join(".claude/skills/baneyspaces/SKILL.md").is_file(),
        terminal: std::io::stdin().is_terminal() && std::io::stdout().is_terminal(),
        home: home.clone(),
        install,
    };
    let (summary, steps, notes, ask) = match plan(&facts, o) {
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
    if let (Some(checkout), Ok(config)) = (&given, &device.config) {
        if recorded_source(config).as_deref() != Some(checkout.as_path()) {
            match record_source(config, checkout) {
                Ok(()) => println!("Remembered {} as the source (in {}).", checkout.display(), config.join(SOURCE_FILE).display()),
                Err(e) => eprintln!("polycarp update: could not remember the source: {e}. Pass --source again next time."),
            }
        }
    }
    let mut out = std::io::stdout();
    match execute(&steps, &mut RealRunner::new(&home), &mut out) {
        Outcome::UpToDate => 0,
        Outcome::Available => AVAILABLE,
        Outcome::Done if o.check => 0,
        Outcome::Done => {
            for note in &notes {
                println!("note: {note}");
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
            polycarp: PathBuf::from("/home/u/.local/bin/polycarp"),
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
    };
    const DRY: Options = Options {
        check: false,
        dry_run: true,
        yes: false,
    };
    const CHECK: Options = Options {
        check: true,
        dry_run: false,
        yes: false,
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

    #[test]
    fn mac_source_plan() {
        let f = facts(Platform::Mac, source(Some(ORIGIN), false));
        let steps = steps_of(plan(&f, YES));
        assert_eq!(
            commands(&steps),
            vec![
                format!("git -C {CHECKOUT} fetch origin +refs/heads/main:refs/remotes/origin/main"),
                format!("git -C {CHECKOUT} worktree prune"),
                format!("git -C {CHECKOUT} worktree add --detach --force {WORKTREE} refs/remotes/origin/main"),
                format!("/home/u/.local/bin/polycarp update --is-current {WORKTREE} HEAD"),
                format!("{WORKTREE}/browser/scripts/setup-siblings.sh"),
                format!("git -C {WORKTREE} checkout -- ."),
                "make -C spaces install".to_string(),
                "/home/u/.local/bin/polycarp browser reload --if-idle".to_string(),
                "/home/u/.local/bin/polycarp version --check --wait 30".to_string(),
            ]
        );
        let make = &steps[6];
        assert_eq!(make.cwd.as_deref(), Some(Path::new(WORKTREE)));
        assert_eq!(
            make.env,
            vec![("BANEYSPACES_ARM64_ONLY".to_string(), "1".to_string())]
        );
        assert_eq!(steps.last().unwrap().role, Role::Verify);

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

    #[test]
    fn linux_source_plan_with_hyprland() {
        let f = facts(Platform::Linux, source(Some(ORIGIN), false));
        let cmds = commands(&steps_of(plan(&f, YES)));
        assert_eq!(
            cmds[4..],
            [
                "cargo install --locked --path cli --root /home/u/.local".to_string(),
                "cargo build --release --locked -p baneyspaces-linux".to_string(),
                format!("{WORKTREE}/spaces/platforms/linux/scripts/build-engine.sh"),
                format!("{WORKTREE}/spaces/platforms/linux/omarchy/install.sh"),
                format!("{WORKTREE}/browser/scripts/setup-siblings.sh"),
                format!("git -C {WORKTREE} checkout -- ."),
                "npm run build".to_string(),
                "npm link".to_string(),
                format!("node {WORKTREE}/browser/cli/dist/index.js setup --yes --no-wait"),
                format!("node {WORKTREE}/browser/cli/dist/index.js reload --if-idle"),
                "/home/u/.local/bin/baneyspaces stop".to_string(),
                "hyprctl reload".to_string(),
                "/home/u/.local/bin/polycarp version --check --wait 30".to_string(),
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

        f.node = false;
        let Plan::Run { steps, notes, .. } = plan(&f, YES) else {
            panic!("refused")
        };
        let cmds = commands(&steps);
        assert_eq!(
            cmds.len(),
            6,
            "fetch, two for the copy, the gate, the command, the check: {cmds:?}"
        );
        assert!(
            notes.iter().any(|n| n.contains("Node and npm")),
            "{notes:?}"
        );
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
            for o in [YES, DRY, CHECK] {
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
            for o in [YES, DRY, CHECK] {
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
                format!("/home/u/.local/bin/polycarp update --is-current {CHECKOUT} refs/remotes/origin/main"),
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
                        for step in steps_of(plan(&f, YES)) {
                            if matches!(step.role, Role::Build | Role::Install) {
                                let cwd = step.cwd.as_deref().unwrap_or_else(|| {
                                    panic!("{} has no working directory", step.title)
                                });
                                assert!(
                                    cwd.starts_with(WORKTREE),
                                    "{} runs in {}",
                                    step.title,
                                    cwd.display()
                                );
                                seen += 1;
                            }
                            if step.role != Role::Git {
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
            text.contains("step 5 of 9: Get what the extension builds against"),
            "{text}"
        );
        assert!(
            text.contains("Get what the extension builds against said no"),
            "the step's own output: {text}"
        );
        assert!(text.contains("step 5 of 9 failed (exit 7)"), "{text}");
        assert!(
            text.contains("Nothing that is installed on this device was changed."),
            "{text}"
        );
        assert!(text.contains("run `polycarp update` again"), "{text}");
        assert!(!text.contains("step 6 of 9"), "{text}");

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
            !text.contains("make") && !text.contains("step 5 of 9"),
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
        let steps = steps_of(plan(
            &facts(Platform::Mac, source(Some(ORIGIN), false)),
            YES,
        ));
        // Step 8, the reload, says an agent is working (exit 75); the check at the end then fails.
        let codes = [
            Some(0),
            Some(0),
            Some(0),
            Some(AVAILABLE),
            Some(0),
            Some(0),
            Some(0),
            Some(75),
            Some(1),
        ];
        let (outcome, ran, text) = run_fake(&steps, &codes);
        assert_eq!(ran.len(), 9, "every step ran: {ran:?}");
        assert_eq!(
            outcome,
            Outcome::Failed {
                step: 8,
                code: Some(1)
            }
        );
        assert!(
            text.contains("note: this step did not happen (exit 75). The update carries on."),
            "{text}"
        );
        assert!(text.contains("the parts do not all match yet"), "{text}");
        // All green.
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
        record_source(&dir, Path::new("/src/with \"quotes\" and spaces")).unwrap();
        assert_eq!(
            recorded_source(&dir).as_deref(),
            Some(Path::new("/src/with \"quotes\" and spaces"))
        );
        fs::write(dir.join(SOURCE_FILE), "checkout = \"relative/path\"\n").unwrap();
        assert_eq!(
            recorded_source(&dir),
            None,
            "a relative path is not a checkout"
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
