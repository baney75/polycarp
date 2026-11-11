//! `polycarp version`: every Polycarp part on this device, the commit each was built from, and one
//! line saying whether they all match. `compare` is the pure part; `gather` reads the device.
//!
//! Nothing here starts an app. The app and the spaces command are read from files (the app's
//! Info.plist, a stamp inside the Linux binary); only the browser helper is run, as `doctor` already
//! does, and it answers for itself and for each connected browser's extension.

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// What a part was built from.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Build {
    /// The monorepo commit (7 to 40 hex digits), when the part reports one.
    pub commit: Option<String>,
    /// The commit's date, as the part reports it.
    pub date: Option<String>,
    /// Tracked files had changes when it was built.
    pub dirty: bool,
}

impl Build {
    pub fn new(commit: &str, date: &str, dirty: bool) -> Build {
        Build {
            commit: valid_commit(commit),
            date: Some(date.trim().to_string()).filter(|d| !d.is_empty() && d != "unknown"),
            dirty,
        }
    }
    /// "abc1234", "abc1234-dirty" or "unknown commit".
    pub fn label(&self) -> String {
        match &self.commit {
            Some(c) if self.dirty => format!("{}-dirty", short(c)),
            Some(c) => short(c).to_string(),
            None => "unknown commit".to_string(),
        }
    }
}

/// A commit as git prints it: 7 to 40 hex digits. Anything else ("unknown", "") is no commit.
pub fn valid_commit(text: &str) -> Option<String> {
    let t = text.trim();
    ((7..=40).contains(&t.len()) && t.chars().all(|c| c.is_ascii_hexdigit()))
        .then(|| t.to_ascii_lowercase())
}

pub fn short(commit: &str) -> &str {
    &commit[..commit.len().min(7)]
}

/// Two commits name the same one when either is a prefix of the other (a part may report 7 digits).
pub fn same_commit(a: &str, b: &str) -> bool {
    let (a, b) = (a.to_ascii_lowercase(), b.to_ascii_lowercase());
    a.starts_with(&b) || b.starts_with(&a)
}

#[derive(Debug, Clone, PartialEq)]
pub enum Found {
    Installed {
        version: Option<String>,
        build: Build,
        path: Option<PathBuf>,
    },
    /// Not on this device, with the words to show: "not installed", "no browser is connected".
    Absent(&'static str),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Part {
    pub name: String,
    pub found: Found,
    /// Something a person should know: why the commit is unknown, or where the part lives.
    pub note: Option<String>,
    /// False for a part that cannot carry a commit, so it is listed but never counted as odd.
    pub compared: bool,
}

impl Part {
    pub fn installed(
        name: &str,
        version: Option<String>,
        build: Build,
        path: Option<PathBuf>,
    ) -> Part {
        Part {
            name: name.to_string(),
            found: Found::Installed {
                version,
                build,
                path,
            },
            note: None,
            compared: true,
        }
    }
    pub fn absent(name: &str, why: &'static str) -> Part {
        Part {
            name: name.to_string(),
            found: Found::Absent(why),
            note: None,
            compared: true,
        }
    }
    pub fn note(mut self, note: &str) -> Part {
        self.note = Some(note.to_string());
        self
    }
    pub fn uncompared(mut self) -> Part {
        self.compared = false;
        self
    }
}

/// A part that does not match the rest, and why.
#[derive(Debug, Clone, PartialEq)]
pub struct Odd {
    pub name: String,
    pub why: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    /// Every installed part reports the same commit, built from a clean tree. `commit` is None only
    /// when nothing that can be compared is installed.
    Match {
        commit: Option<String>,
        parts: usize,
    },
    /// At least one part is odd. `reference` is the commit most parts are at, when any reports one.
    Differ {
        reference: Option<String>,
        odd: Vec<Odd>,
    },
}

impl Verdict {
    pub fn matches(&self) -> bool {
        matches!(self, Verdict::Match { .. })
    }
    /// The one line `version`, `doctor` and `update` all print.
    pub fn line(&self) -> String {
        match self {
            Verdict::Match {
                commit: Some(c),
                parts: 1,
            } => {
                format!("versions: the 1 installed part is at commit {}", short(c))
            }
            Verdict::Match {
                commit: Some(c),
                parts,
            } => format!(
                "versions: all {parts} installed parts come from the same commit ({})",
                short(c)
            ),
            Verdict::Match { commit: None, .. } => {
                "versions: no installed part reports a commit, so there is nothing to compare"
                    .to_string()
            }
            Verdict::Differ { reference, odd } => {
                let list = odd
                    .iter()
                    .map(|o| format!("{} {}", o.name, o.why))
                    .collect::<Vec<_>>()
                    .join("; ");
                match reference {
                    Some(r) => format!(
                        "versions: the parts do not all match commit {}: {list}. Run `polycarp update`.",
                        short(r)
                    ),
                    None => format!("versions: the parts cannot be compared: {list}. Run `polycarp update`."),
                }
            }
        }
    }
}

/// Whether the installed parts all come from one commit. The reference is the commit most parts
/// report (the first listed wins a tie); a part at another commit, built from a changed tree, or
/// without a commit is odd. Parts that are absent, or that cannot carry a commit, are not counted.
pub fn compare(parts: &[Part]) -> Verdict {
    let counted: Vec<(&Part, &Build)> = parts
        .iter()
        .filter(|p| p.compared)
        .filter_map(|p| match &p.found {
            Found::Installed { build, .. } => Some((p, build)),
            Found::Absent(_) => None,
        })
        .collect();
    // Group the known commits; keep the order they first appear in.
    let mut groups: Vec<(&str, usize)> = Vec::new();
    for (_, build) in &counted {
        if let Some(c) = build.commit.as_deref() {
            match groups.iter_mut().find(|(g, _)| same_commit(g, c)) {
                Some((g, n)) => {
                    *n += 1;
                    // Keep the longest spelling, so a 7 digit report does not shorten the reference.
                    if c.len() > g.len() {
                        *g = c;
                    }
                }
                None => groups.push((c, 1)),
            }
        }
    }
    let mut reference: Option<&str> = None;
    let mut best = 0;
    for (commit, n) in &groups {
        if *n > best {
            best = *n;
            reference = Some(commit);
        }
    }
    let mut odd = Vec::new();
    for (part, build) in &counted {
        let why = match (build.commit.as_deref(), reference) {
            (None, _) => Some(
                part.note
                    .clone()
                    .unwrap_or_else(|| "does not report the commit it was built from".to_string()),
            ),
            (Some(c), Some(r)) if !same_commit(c, r) => Some(format!("is at {}", build.label())),
            (Some(_), _) if build.dirty => {
                Some("was built from a tree with uncommitted changes".to_string())
            }
            _ => None,
        };
        if let Some(why) = why {
            odd.push(Odd {
                name: part.name.clone(),
                why,
            });
        }
    }
    if odd.is_empty() {
        Verdict::Match {
            commit: reference.map(str::to_string),
            parts: counted.len(),
        }
    } else {
        Verdict::Differ {
            reference: reference.map(str::to_string),
            odd,
        }
    }
}

/// True when every installed part is at `target` and none is odd: nothing for an update to do.
pub fn is_current(parts: &[Part], target: &str) -> bool {
    match compare(parts) {
        Verdict::Match {
            commit: Some(c), ..
        } => same_commit(&c, target),
        _ => false,
    }
}

// ---- Reading the device ---------------------------------------------------------------------------

/// The build this command was compiled from (cli/build.rs).
pub fn own_build() -> Build {
    Build::new(
        env!("POLYCARP_BUILD_COMMIT"),
        env!("POLYCARP_BUILD_DATE"),
        env!("POLYCARP_BUILD_DIRTY") == "1",
    )
}

/// "polycarp 0.1.0 (abc1234)": the version the tests pin, then the commit when it is known.
pub fn own_version_line() -> String {
    let build = own_build();
    match build.commit {
        Some(_) => format!("polycarp {} ({})", env!("CARGO_PKG_VERSION"), build.label()),
        None => format!("polycarp {}", env!("CARGO_PKG_VERSION")),
    }
}

/// The string value of `key` in an XML property list (the shape bundle.sh writes).
pub fn plist_string(xml: &str, key: &str) -> Option<String> {
    let after = xml.split_once(&format!("<key>{key}</key>"))?.1.trim_start();
    let rest = after.strip_prefix("<string>")?;
    Some(rest.split_once("</string>")?.0.to_string())
}

/// What an app's Info.plist says it is: its version and the commit bundle.sh stamped in.
pub fn plist_identity(xml: &str) -> (Option<String>, Build) {
    let build = Build::new(
        &plist_string(xml, "PolycarpCommit").unwrap_or_default(),
        &plist_string(xml, "PolycarpCommitDate").unwrap_or_default(),
        plist_string(xml, "PolycarpCommitDirty").as_deref() == Some("1"),
    );
    (plist_string(xml, "CFBundleShortVersionString"), build)
}

/// The start of the stamp the Linux spaces binary carries, so its build can be read without running it:
/// `polycarp-build|v1|<commit>|<commit date>|<0 or 1 for dirty>|<version>|end|`.
pub const STAMP_START: &[u8] = b"polycarp-build|v1|";

/// The stamp in a binary's bytes, if it has one.
pub fn stamp_identity(bytes: &[u8]) -> Option<(Option<String>, Build)> {
    let at = bytes
        .windows(STAMP_START.len())
        .position(|w| w == STAMP_START)?;
    let rest = &bytes[at + STAMP_START.len()..];
    let text = String::from_utf8_lossy(&rest[..rest.len().min(200)]).into_owned();
    let fields: Vec<&str> = text.split('|').collect();
    if fields.len() < 6 || fields[4] != "end" {
        return None;
    }
    let version = Some(fields[3].to_string()).filter(|v| !v.is_empty());
    Some((version, Build::new(fields[0], fields[1], fields[2] == "1")))
}

/// The app bundle a file sits in (`X.app/Contents/Resources/bin/<file>` or `…/browser/<file>`).
fn enclosing_app(file: &Path) -> Option<PathBuf> {
    let real = fs::canonicalize(file).ok()?;
    real.ancestors()
        .find(|a| {
            a.extension().is_some_and(|e| e == "app") && a.join("Contents/Info.plist").is_file()
        })
        .map(Path::to_path_buf)
}

fn app_identity(app: &Path) -> (Option<String>, Build) {
    fs::read_to_string(app.join("Contents/Info.plist"))
        .map(|xml| plist_identity(&xml))
        .unwrap_or_default()
}

/// A command's build, read from files only: the app it sits in, else the stamp inside it.
fn file_identity(file: &Path) -> Option<(Option<String>, Build)> {
    if let Some(app) = enclosing_app(file) {
        return Some(app_identity(&app));
    }
    // A spaces binary is a few megabytes; anything huge is not one of ours.
    let meta = fs::metadata(file).ok()?;
    if meta.len() > 256 * 1024 * 1024 {
        return None;
    }
    stamp_identity(&fs::read(file).ok()?)
}

/// What the device has. The callbacks keep this free of `main.rs`'s search rules:
/// `app` is the installed Polycarp.app (Mac only), `spaces` and `browser` the commands as `polycarp`
/// would run them, `ask` runs the browser helper with arguments and returns what it printed.
pub struct Device<'a> {
    pub exe: Option<PathBuf>,
    pub home: Option<PathBuf>,
    pub app: Option<PathBuf>,
    pub spaces: Option<PathBuf>,
    pub browser: Option<PathBuf>,
    pub ask: &'a dyn Fn(&Path, &[&str]) -> Option<String>,
}

fn str_field(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|s| !s.is_empty())
}

/// The helper's own answer to `version --json`.
pub fn helper_identity(text: &str) -> Option<(Option<String>, Build)> {
    let v: Value = serde_json::from_str(text.trim()).ok()?;
    let version = str_field(&v, "version")?;
    let build = Build::new(
        &str_field(&v, "commit").unwrap_or_default(),
        &str_field(&v, "commitDate").unwrap_or_default(),
        v.get("dirty").and_then(Value::as_bool).unwrap_or(false),
    );
    Some((Some(version), build))
}

/// The extensions in the helper's `status --json`: one part per connected browser.
pub fn extension_parts(text: &str) -> Vec<Part> {
    let Ok(v) = serde_json::from_str::<Value>(text.trim()) else {
        return vec![Part::absent(
            "extension",
            "not checked: the browser helper gave no answer",
        )];
    };
    if let Some(list) = v.get("extensions").and_then(Value::as_array) {
        if list.is_empty() {
            return vec![Part::absent("extension", "no browser is connected")];
        }
        return list
            .iter()
            .map(|e| {
                let name = match str_field(e, "browser") {
                    Some(b) => format!("extension ({b})"),
                    None => "extension".to_string(),
                };
                let build = Build::new(
                    &str_field(e, "commit").unwrap_or_default(),
                    &str_field(e, "commitDate").unwrap_or_default(),
                    e.get("dirty").and_then(Value::as_bool).unwrap_or(false),
                );
                Part::installed(&name, str_field(e, "version"), build, None)
            })
            .collect();
    }
    // A helper from before this command: it names the extension's version but not its commit.
    if v.get("connected").and_then(Value::as_bool) == Some(true) {
        return vec![Part::installed(
            "extension",
            str_field(&v, "extensionVersion"),
            Build::default(),
            None,
        )
        .note("is behind a browser helper too old to report its commit")];
    }
    vec![Part::absent("extension", "no browser is connected")]
}

/// Every part, in the order they are shown. The command itself is first, so it wins a tie.
pub fn gather(d: &Device) -> Vec<Part> {
    let mut parts = vec![Part::installed(
        "polycarp command",
        Some(env!("CARGO_PKG_VERSION").to_string()),
        own_build(),
        d.exe.clone(),
    )];
    let app = d.app.as_ref().map(|a| (a, app_identity(a)));
    if cfg!(target_os = "macos") {
        parts.push(match &app {
            Some((path, (version, build))) => {
                Part::installed("app", version.clone(), build.clone(), Some((*path).clone()))
            }
            None => Part::absent("app", "not installed"),
        });
    }
    parts.push(match &d.spaces {
        Some(path) => match file_identity(path) {
            Some((version, build)) => {
                Part::installed("spaces command", version, build, Some(path.clone()))
            }
            None if cfg!(windows) => {
                Part::installed("spaces command", None, Build::default(), Some(path.clone()))
                    .note("carries no build stamp on Windows yet")
                    .uncompared()
            }
            None => Part::installed("spaces command", None, Build::default(), Some(path.clone()))
                .note("carries no build stamp (it is older than `polycarp version`, or not from this repo)"),
        },
        None => Part::absent("spaces command", "not installed"),
    });
    match &d.browser {
        Some(path) => {
            let answer = (d.ask)(path, &["version", "--json"]);
            match answer.as_deref().and_then(helper_identity) {
                Some((version, build)) => {
                    parts.push(Part::installed(
                        "browser helper",
                        version,
                        build,
                        Some(path.clone()),
                    ));
                    let status = (d.ask)(path, &["status", "--json"]).unwrap_or_default();
                    parts.extend(extension_parts(&status));
                }
                None => {
                    parts.push(
                        Part::installed(
                            "browser helper",
                            None,
                            Build::default(),
                            Some(path.clone()),
                        )
                        .note("did not answer `version --json`"),
                    );
                    parts.push(Part::absent(
                        "extension",
                        "not checked: the browser helper gave no answer",
                    ));
                }
            }
        }
        None => {
            parts.push(Part::absent("browser helper", "not installed"));
            parts.push(Part::absent("extension", "not installed"));
        }
    }
    // The voice core is a static library inside the app's own binary, so it is the app's build.
    parts.push(match &app {
        Some((path, (_, build))) => {
            Part::installed("voice core", None, build.clone(), Some((*path).clone()))
                .note("linked into the app")
        }
        None => Part::absent("voice core", "not installed"),
    });
    let skill = d
        .home
        .as_ref()
        .map(|h| h.join(".claude/skills/baneyspaces/SKILL.md"))
        .filter(|p| p.is_file());
    parts.push(match (skill, &app) {
        (None, _) => Part::absent("agent skill", "not installed"),
        (Some(path), Some((app_path, (_, build)))) => {
            let bundled = fs::read(app_path.join("Contents/Resources/skill/SKILL.md")).ok();
            if bundled.is_some() && bundled == fs::read(&path).ok() {
                Part::installed("agent skill", None, build.clone(), Some(path))
                    .note("same text as the app's copy")
            } else {
                Part::installed("agent skill", None, Build::default(), Some(path))
                    .note("differs from the copy in the app (`polycarp spaces skill install` refreshes it)")
            }
        }
        (Some(path), None) => Part::installed("agent skill", None, Build::default(), Some(path))
            .note("has no app copy to compare with")
            .uncompared(),
    });
    parts
}

// ---- Output -----------------------------------------------------------------------------------------

pub fn table(parts: &[Part]) -> String {
    let width = parts.iter().map(|p| p.name.len()).max().unwrap_or(0);
    let mut out = String::new();
    for p in parts {
        let line = match &p.found {
            Found::Absent(why) => format!("{:width$}  {why}", p.name),
            Found::Installed {
                version,
                build,
                path,
            } => {
                let mut line = format!(
                    "{:width$}  {:8}  {:14}",
                    p.name,
                    version.as_deref().unwrap_or("-"),
                    build.label()
                );
                if let Some(path) = path {
                    line.push_str(&format!("  {}", path.display()));
                }
                if let Some(note) = &p.note {
                    line.push_str(&format!("  ({note})"));
                }
                line
            }
        };
        out.push_str(line.trim_end());
        out.push('\n');
    }
    out
}

pub fn to_json(parts: &[Part], verdict: &Verdict) -> Value {
    let list: Vec<Value> = parts
        .iter()
        .map(|p| match &p.found {
            Found::Absent(why) => json!({ "name": p.name, "installed": false, "state": why }),
            Found::Installed {
                version,
                build,
                path,
            } => json!({
                "name": p.name,
                "installed": true,
                "version": version,
                "commit": build.commit,
                "commit_date": build.date,
                "dirty": build.dirty,
                "path": path.as_ref().map(|p| p.display().to_string()),
                "note": p.note,
                "compared": p.compared,
            }),
        })
        .collect();
    let (reference, odd) = match verdict {
        Verdict::Match { commit, .. } => (commit.clone(), Vec::new()),
        Verdict::Differ { reference, odd } => (
            reference.clone(),
            odd.iter()
                .map(|o| json!({ "name": o.name, "why": o.why }))
                .collect(),
        ),
    };
    json!({
        "parts": list,
        "match": verdict.matches(),
        "commit": reference,
        "odd": odd,
        "verdict": verdict.line(),
    })
}

pub const USAGE: &str = "\
usage: polycarp version [--json] [--check] [--wait <seconds>]

Lists every Polycarp part on this device with its version, the commit it was built from and where it
is, then says in one line whether they all come from the same commit.

  --json    the same as JSON
  --check   exit 0 when every installed part matches, 1 when one differs
  --wait    with --check: keep looking for up to this many seconds (an app that is restarting)
";

/// `polycarp version`. Exit 0 unless `--check` finds a difference (1) or the arguments are wrong (2).
pub fn run(args: &[OsString], device: &Device) -> i32 {
    let (mut as_json, mut check, mut wait) = (false, false, 0u64);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.to_str() {
            Some("--wait") => match it
                .next()
                .and_then(|v| v.to_str())
                .and_then(|v| v.parse().ok())
            {
                Some(secs) => wait = u64::min(secs, 600),
                None => {
                    eprintln!("polycarp: --wait needs a number of seconds\n");
                    eprint!("{USAGE}");
                    return 2;
                }
            },
            Some("--json") => as_json = true,
            Some("--check") => check = true,
            Some("--help") | Some("-h") => {
                print!("{USAGE}");
                return 0;
            }
            _ => {
                eprintln!("polycarp: unknown option {}\n", a.to_string_lossy());
                eprint!("{USAGE}");
                return 2;
            }
        }
    }
    let started = std::time::Instant::now();
    let (parts, verdict) = loop {
        let parts = gather(device);
        let verdict = compare(&parts);
        if !check || verdict.matches() || started.elapsed().as_secs() >= wait {
            break (parts, verdict);
        }
        std::thread::sleep(std::time::Duration::from_secs(2));
    };
    if as_json {
        println!(
            "{}",
            serde_json::to_string_pretty(&to_json(&parts, &verdict)).unwrap_or_default()
        );
    } else {
        print!("{}", table(&parts));
        println!("\n{}", verdict.line());
    }
    if check && !verdict.matches() {
        1
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "aaaaaaa1111111111111111111111111111111aa";
    const B: &str = "bbbbbbb2222222222222222222222222222222bb";

    fn at(name: &str, commit: &str) -> Part {
        Part::installed(name, None, Build::new(commit, "", false), None)
    }
    fn dirty(name: &str, commit: &str) -> Part {
        Part::installed(name, None, Build::new(commit, "", true), None)
    }
    fn odd(name: &str, why: &str) -> Odd {
        Odd {
            name: name.into(),
            why: why.into(),
        }
    }

    #[test]
    fn compare_table() {
        struct Case {
            name: &'static str,
            parts: Vec<Part>,
            want: Verdict,
        }
        let cases = vec![
            Case {
                name: "all match",
                parts: vec![at("command", A), at("app", A), at("helper", A)],
                want: Verdict::Match {
                    commit: Some(A.into()),
                    parts: 3,
                },
            },
            Case {
                name: "a short commit matches its long form",
                parts: vec![at("command", &A[..7]), at("app", A)],
                want: Verdict::Match {
                    commit: Some(A.into()),
                    parts: 2,
                },
            },
            Case {
                name: "one behind",
                parts: vec![at("command", A), at("app", A), at("extension (Helium)", B)],
                want: Verdict::Differ {
                    reference: Some(A.into()),
                    odd: vec![odd("extension (Helium)", "is at bbbbbbb")],
                },
            },
            Case {
                name: "a missing part is not an error",
                parts: vec![
                    at("command", A),
                    Part::absent("app", "not installed"),
                    Part::absent("extension", "no browser is connected"),
                    at("helper", A),
                ],
                want: Verdict::Match {
                    commit: Some(A.into()),
                    parts: 2,
                },
            },
            Case {
                name: "a dirty build is odd even at the same commit",
                parts: vec![at("command", A), dirty("app", A)],
                want: Verdict::Differ {
                    reference: Some(A.into()),
                    odd: vec![odd("app", "was built from a tree with uncommitted changes")],
                },
            },
            Case {
                name: "a part with no commit is odd, in its own words when it has them",
                parts: vec![
                    at("command", A),
                    Part::installed("helper", None, Build::default(), None),
                    Part::installed("skill", None, Build::default(), None)
                        .note("differs from the app"),
                ],
                want: Verdict::Differ {
                    reference: Some(A.into()),
                    odd: vec![
                        odd("helper", "does not report the commit it was built from"),
                        odd("skill", "differs from the app"),
                    ],
                },
            },
            Case {
                name: "a part that cannot carry a commit is not counted",
                parts: vec![
                    at("command", A),
                    Part::installed("skill", None, Build::default(), None).uncompared(),
                ],
                want: Verdict::Match {
                    commit: Some(A.into()),
                    parts: 1,
                },
            },
            Case {
                name: "the commit most parts are at is the reference",
                parts: vec![at("command", B), at("app", A), at("helper", A)],
                want: Verdict::Differ {
                    reference: Some(A.into()),
                    odd: vec![odd("command", "is at bbbbbbb")],
                },
            },
            Case {
                name: "a tie goes to the first listed",
                parts: vec![at("command", A), at("app", B)],
                want: Verdict::Differ {
                    reference: Some(A.into()),
                    odd: vec![odd("app", "is at bbbbbbb")],
                },
            },
            Case {
                name: "nothing reports a commit",
                parts: vec![Part::installed("command", None, Build::default(), None)],
                want: Verdict::Differ {
                    reference: None,
                    odd: vec![odd(
                        "command",
                        "does not report the commit it was built from",
                    )],
                },
            },
        ];
        for c in cases {
            assert_eq!(compare(&c.parts), c.want, "{}", c.name);
        }
    }

    #[test]
    fn is_current_needs_every_part_at_the_target() {
        let parts = vec![at("command", A), at("app", A)];
        assert!(is_current(&parts, A));
        assert!(is_current(&parts, &A[..7]));
        assert!(!is_current(&parts, B), "all match, but not the target");
        assert!(!is_current(&[at("command", A), at("app", B)], A));
        assert!(!is_current(&[at("command", A), dirty("app", A)], A));
        assert!(!is_current(
            &[Part::installed("command", None, Build::default(), None)],
            A
        ));
    }

    #[test]
    fn verdict_lines_name_the_odd_parts() {
        let v = compare(&[at("command", A), at("app", A), at("extension (Helium)", B)]);
        assert_eq!(
            v.line(),
            "versions: the parts do not all match commit aaaaaaa: extension (Helium) is at bbbbbbb. Run `polycarp update`."
        );
        let v = compare(&[at("command", A), at("app", A)]);
        assert_eq!(
            v.line(),
            "versions: all 2 installed parts come from the same commit (aaaaaaa)"
        );
    }

    #[test]
    fn reads_the_app_plist() {
        let xml = "<dict>\n  <key>CFBundleShortVersionString</key><string>0.3.0</string>\n  \
                   <key>PolycarpCommit</key><string>aaaaaaa1111111111111111111111111111111aa</string>\n  \
                   <key>PolycarpCommitDate</key>\n  <string>2026-11-09T10:00:00Z</string>\n  \
                   <key>PolycarpCommitDirty</key><string>1</string>\n</dict>";
        let (version, build) = plist_identity(xml);
        assert_eq!(version.as_deref(), Some("0.3.0"));
        assert_eq!(build, Build::new(A, "2026-11-09T10:00:00Z", true));
        // A build made outside git says "unknown", which is no commit.
        let (_, build) = plist_identity("<key>PolycarpCommit</key><string>unknown</string>");
        assert_eq!(build.commit, None);
        assert_eq!(plist_identity("not a plist").1, Build::default());
    }

    #[test]
    fn reads_the_stamp_in_a_binary() {
        let mut bytes = b"\x7fELF junk ".to_vec();
        bytes.extend_from_slice(STAMP_START);
        bytes.extend_from_slice(format!("{A}|2026-11-09T10:00:00Z|0|0.1.0|end|\0more").as_bytes());
        let (version, build) = stamp_identity(&bytes).unwrap();
        assert_eq!(version.as_deref(), Some("0.1.0"));
        assert_eq!(build, Build::new(A, "2026-11-09T10:00:00Z", false));
        assert_eq!(stamp_identity(b"no stamp here"), None);
        let mut cut = STAMP_START.to_vec();
        cut.extend_from_slice(b"aaaaaaa|date");
        assert_eq!(
            stamp_identity(&cut),
            None,
            "a stamp without its end is not read"
        );
    }

    #[test]
    fn reads_the_helper_and_each_browsers_extension() {
        let (version, build) = helper_identity(&format!(
            r#"{{"version":"1.1.10","commit":"{A}","builtAt":"x","dirty":true}}"#
        ))
        .unwrap();
        assert_eq!(version.as_deref(), Some("1.1.10"));
        assert_eq!(build, Build::new(A, "", true));
        assert_eq!(helper_identity("tabkyra 9.9.9"), None);

        let status = format!(
            r#"{{"connected":true,"extensions":[{{"browser":"Helium","version":"1.1.10","commit":"{A}"}},{{"version":"1.1.9","commit":""}}]}}"#
        );
        let parts = extension_parts(&status);
        assert_eq!(parts.len(), 2);
        assert_eq!(
            parts[0],
            Part::installed(
                "extension (Helium)",
                Some("1.1.10".into()),
                Build::new(A, "", false),
                None
            )
        );
        assert_eq!(
            parts[1],
            Part::installed("extension", Some("1.1.9".into()), Build::default(), None)
        );
        assert_eq!(
            extension_parts(r#"{"connected":false,"extensions":[]}"#),
            vec![Part::absent("extension", "no browser is connected")]
        );
        // An older helper: connected, a version, no commit. Listed, and odd.
        let old = extension_parts(r#"{"connected":true,"extensionVersion":"1.1.2"}"#);
        assert!(matches!(&old[0].found, Found::Installed { build, .. } if build.commit.is_none()));
        assert!(!compare(&old).matches());
    }
}
