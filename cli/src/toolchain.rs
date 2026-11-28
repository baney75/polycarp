//! Which Xcode builds Polycarp.app, and whether a build would start on this Mac.
//!
//! A Mac running a macOS seed can have an Xcode whose SDK is newer than the system: the SDK then weak-links symbols
//! the system lacks, and the app jumps to address 0 at launch. `choose` (pure) picks a developer folder whose SDK is
//! not newer than macOS for `polycarp update`, and `polycarp update --check-build <binary>` (`check_build_command`,
//! run by `spaces/scripts/bundle.sh --install` and `--check`, which both installers use, before anything is installed) refuses a build whose imports from the
//! system don't all resolve here.
//!
//! Rules:
//! 1. An SDK is newer than macOS when its version is higher, compared number by number with a missing number as 0.
//!    At the same version the builds decide (`Build`): major, then train letter, then a release build (no trailing
//!    letter) above a seed, then the number, then the seed letter. Equal builds, or a build that doesn't parse, are
//!    not newer.
//! 2. The selected developer folder is `DEVELOPER_DIR` when set (an explicit choice), else `xcode-select -p`.
//! 3. The other candidates are the full Xcodes (`*.app/Contents/Developer` with a macOS platform SDK) in
//!    /Applications and ~/Applications, sorted by path. The Command Line Tools are never a candidate: they have no
//!    SwiftUI macro plugins, so the app does not compile with them.
//! 4. `choose`: an explicit `DEVELOPER_DIR`, an unknown macOS or an unknown selected SDK keeps the selection. A full
//!    Xcode whose SDK is not newer is kept. Otherwise the candidate with the newest SDK that is not newer than macOS
//!    is used (ties go to the first by path), with one line saying so. With none, the selection is kept with a
//!    warning line.
//! 5. The build check takes the host architecture, the system libraries the binary links (`otool -L`, under
//!    /System/ or /usr/lib/) and its imports from them (`nm -m`, weak and strong), loads each library and looks each symbol up.
//!    Exit 0: all resolve. Exit 1: some are missing; the report names them, macOS, the SDK used and the fix. Exit 2:
//!    the check could not run. Anything but 0 stops the install.
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// A macOS or SDK release, read from a `SystemVersion.plist`.
#[derive(Debug, Clone, PartialEq)]
pub struct Release {
    pub version: String,
    pub build: Option<String>,
}

impl Release {
    #[cfg(test)]
    pub fn new(version: &str, build: &str) -> Release {
        Release {
            version: version.to_string(),
            build: Some(build.to_string()),
        }
    }
    /// "27.2 (26B5091g)", or "27.2" with no build.
    pub fn label(&self) -> String {
        match &self.build {
            Some(b) => format!("{} ({b})", self.version),
            None => self.version.clone(),
        }
    }
}

fn numbers(v: &str) -> Option<Vec<u64>> {
    v.trim().split('.').map(|p| p.parse().ok()).collect()
}

/// Dotted versions, number by number, a missing number counting as 0. None when either doesn't parse.
pub fn compare_versions(a: &str, b: &str) -> Option<std::cmp::Ordering> {
    let (a, b) = (numbers(a)?, numbers(b)?);
    let n = a.len().max(b.len());
    let at = |v: &Vec<u64>, i: usize| v.get(i).copied().unwrap_or(0);
    Some(
        (0..n)
            .map(|i| at(&a, i).cmp(&at(&b, i)))
            .fold(std::cmp::Ordering::Equal, std::cmp::Ordering::then),
    )
}

/// An Apple build such as 26B5091g: major 26, train B, number 5091, seed letter g. A release build has no seed.
#[derive(Debug, Clone, PartialEq)]
pub struct Build {
    pub major: u32,
    pub train: char,
    pub number: u32,
    pub seed: Option<char>,
}

impl Build {
    pub fn parse(s: &str) -> Option<Build> {
        let s = s.trim();
        let digits = s.find(|c: char| !c.is_ascii_digit())?;
        let major = s[..digits].parse().ok()?;
        let mut rest = s[digits..].chars();
        let train = rest.next().filter(|c| c.is_ascii_uppercase())?;
        let rest: String = rest.collect();
        let (num, seed) = match rest.chars().last() {
            Some(c) if c.is_ascii_lowercase() => (&rest[..rest.len() - 1], Some(c)),
            _ => (&rest[..], None),
        };
        if num.is_empty() || !num.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        Some(Build {
            major,
            train,
            number: num.parse().ok()?,
            seed,
        })
    }
    fn key(&self) -> (u32, char, bool, u32, char) {
        (
            self.major,
            self.train,
            self.seed.is_none(),
            self.number,
            self.seed.unwrap_or('\0'),
        )
    }
}

/// Rule 1: whether a build made with `sdk` may use symbols this `os` lacks.
pub fn sdk_newer_than_os(sdk: &Release, os: &Release) -> bool {
    match compare_versions(&sdk.version, &os.version) {
        Some(std::cmp::Ordering::Greater) => true,
        Some(std::cmp::Ordering::Equal) => {
            match (
                sdk.build.as_deref().and_then(Build::parse),
                os.build.as_deref().and_then(Build::parse),
            ) {
                (Some(s), Some(o)) => s.key() > o.key(),
                _ => false,
            }
        }
        _ => false,
    }
}

/// A developer folder and the macOS SDK in it.
#[derive(Debug, Clone, PartialEq)]
pub struct DevDir {
    pub path: PathBuf,
    pub sdk: Option<Release>,
    /// A full Xcode, not the Command Line Tools.
    pub full_xcode: bool,
}

impl DevDir {
    /// "Xcode-beta.app" for an Xcode's developer folder, else the path.
    pub fn name(&self) -> String {
        self.path
            .ancestors()
            .find(|p| p.extension().is_some_and(|e| e == "app"))
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| self.path.display().to_string())
    }
    fn sdk_label(&self) -> String {
        self.sdk
            .as_ref()
            .map(|s| format!("macOS SDK {}", s.label()))
            .unwrap_or_else(|| "an unknown macOS SDK".to_string())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Choice {
    /// Build with the selected developer folder; nothing to say.
    Keep,
    /// Build with this one (passed as `DEVELOPER_DIR`), and say so in this line.
    Use { dir: PathBuf, line: String },
    /// Build with the selected one, but say this first.
    Warn { line: String },
}

/// The best candidate: a full Xcode whose SDK is not newer than macOS, the newest such SDK first, then by path.
pub fn best_fit<'a>(os: &Release, candidates: &'a [DevDir]) -> Option<&'a DevDir> {
    let mut fit: Vec<&DevDir> = candidates
        .iter()
        .filter(|d| d.full_xcode)
        .filter(|d| d.sdk.as_ref().is_some_and(|s| !sdk_newer_than_os(s, os)))
        .collect();
    fit.sort_by(|a, b| {
        let (sa, sb) = (a.sdk.as_ref().unwrap(), b.sdk.as_ref().unwrap());
        let newer = compare_versions(&sb.version, &sa.version).unwrap_or(std::cmp::Ordering::Equal);
        let build = match (
            sb.build.as_deref().and_then(Build::parse),
            sa.build.as_deref().and_then(Build::parse),
        ) {
            (Some(x), Some(y)) => x.key().cmp(&y.key()),
            _ => std::cmp::Ordering::Equal,
        };
        newer.then(build).then(a.path.cmp(&b.path))
    });
    fit.first().copied()
}

/// Rule 4. Pure.
pub fn choose(
    os: Option<&Release>,
    selected: &DevDir,
    explicit: bool,
    candidates: &[DevDir],
) -> Choice {
    let Some(os) = os else { return Choice::Keep };
    if explicit {
        return Choice::Keep;
    }
    let others: Vec<DevDir> = candidates
        .iter()
        .filter(|d| d.path != selected.path)
        .cloned()
        .collect();
    let why = if !selected.full_xcode {
        format!(
            "the selected {} is the Command Line Tools, which can't build the app (no SwiftUI macros)",
            selected.path.display()
        )
    } else {
        match &selected.sdk {
            None => return Choice::Keep,
            Some(sdk) if !sdk_newer_than_os(sdk, os) => return Choice::Keep,
            Some(sdk) => format!(
                "the selected {} has macOS SDK {}, newer than this macOS {}",
                selected.name(),
                sdk.label(),
                os.label()
            ),
        }
    };
    match best_fit(os, &others) {
        Some(d) => Choice::Use {
            dir: d.path.clone(),
            line: format!(
                "Building with {} ({}, DEVELOPER_DIR={}): {why}.",
                d.name(),
                d.sdk_label(),
                d.path.display()
            ),
        },
        None => Choice::Warn {
            line: format!(
                "Building with {}, though {why}, and no installed Xcode has an SDK that is not newer. The build check stops the install if the app would not start.",
                selected.path.display()
            ),
        },
    }
}

// ---- The build check: parsing --------------------------------------------------------------------

/// One import from `nm -m`: the symbol as nm spells it (leading `_`), the library's short name, and whether it is
/// weak. A missing weak symbol is address 0 at run time (the crash on 2026-11-27); a missing strong one stops dyld
/// at launch. Either way the app does not start.
#[derive(Debug, Clone, PartialEq)]
pub struct Import {
    pub symbol: String,
    pub from: String,
    pub weak: bool,
}

/// The undefined symbols in `nm -m` output that name the library they come from.
pub fn parse_imports(nm: &str) -> Vec<Import> {
    nm.lines()
        .filter_map(|line| {
            let rest = line.trim_start().strip_prefix("(undefined) ")?;
            let (weak, rest) = match rest.strip_prefix("weak ") {
                Some(r) => (true, r),
                None => (false, rest),
            };
            let (symbol, from) = rest.strip_prefix("external ")?.rsplit_once(" (from ")?;
            let from = from.strip_suffix(')')?;
            (!symbol.is_empty() && !symbol.contains(' ')).then(|| Import {
                symbol: symbol.to_string(),
                from: from.to_string(),
                weak,
            })
        })
        .collect()
}

/// The install paths in `otool -L` output, the binary's own line left out.
pub fn parse_linked(otool: &str) -> Vec<String> {
    otool
        .lines()
        .filter(|l| l.starts_with('\t') || l.starts_with("    "))
        .filter_map(|l| l.trim().split(" (compatibility").next())
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect()
}

/// A library linked from the system, which the build check may load.
pub fn is_system_library(path: &str) -> bool {
    path.starts_with("/System/") || path.starts_with("/usr/lib/")
}

/// The name `nm -m` gives a library in "(from X)": the framework's name, or the dylib's file name up to its first
/// dot (libSystem.B.dylib is libSystem, libcurl.4.dylib is libcurl).
pub fn short_name(path: &str) -> String {
    if let Some(i) = path.rfind(".framework/") {
        let head = &path[..i];
        return head.rsplit('/').next().unwrap_or(head).to_string();
    }
    let file = path.rsplit('/').next().unwrap_or(path);
    file.split('.').next().unwrap_or(file).to_string()
}

/// The report for a build whose imports are missing here.
pub fn report(
    missing: &[Import],
    os: Option<&Release>,
    selected: Option<&DevDir>,
    fix_dir: Option<&DevDir>,
) -> String {
    let os_label = os.map(|o| o.label()).unwrap_or_else(|| "unknown".into());
    let mut out = format!(
        "polycarp update: error: this build of Polycarp.app would crash at launch on this Mac: {} symbol{} it imports from the system {} missing from macOS {os_label}. It was not installed, and the running app was left alone.\n",
        missing.len(),
        if missing.len() == 1 { "" } else { "s" },
        if missing.len() == 1 { "is" } else { "are" },
    );
    for m in missing {
        let kind = if m.weak { "weak" } else { "strong" };
        out.push_str(&format!(
            "  missing: {} (from {}, {kind})\n",
            m.symbol, m.from
        ));
    }
    if let Some(d) = selected {
        out.push_str(&format!(
            "  built with: {} ({})\n",
            d.path.display(),
            d.sdk_label()
        ));
    }
    match fix_dir {
        Some(d) => out.push_str(&format!(
            "  fix: build with a developer folder whose SDK is not newer than macOS {os_label}: DEVELOPER_DIR={} make -C spaces install ({}, {}). `polycarp update` picks it on its own.\n",
            d.path.display(),
            d.name(),
            d.sdk_label()
        )),
        None => out.push_str(&format!(
            "  fix: build with a developer folder whose SDK is not newer than macOS {os_label}: install an Xcode with such an SDK (the Command Line Tools can't build the app), or update macOS, then build again.\n"
        )),
    }
    out
}

// ---- Reading this Mac -----------------------------------------------------------------------------

/// ProductVersion and ProductBuildVersion from a `SystemVersion.plist`.
pub fn read_release(plist_path: &Path) -> Option<Release> {
    let v = plist::Value::from_file(plist_path).ok()?;
    let d = v.as_dictionary()?;
    Some(Release {
        version: d.get("ProductVersion")?.as_string()?.to_string(),
        build: d
            .get("ProductBuildVersion")
            .and_then(|b| b.as_string())
            .map(str::to_string),
    })
}

const VERSION_PLIST: &str = "System/Library/CoreServices/SystemVersion.plist";
const PLATFORM_SDK: &str = "Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk";

pub fn os_release() -> Option<Release> {
    read_release(&Path::new("/").join(VERSION_PLIST))
}

/// What is in a developer folder: a full Xcode's platform SDK, or the Command Line Tools' SDK.
pub fn dev_dir(path: &Path) -> DevDir {
    let full = path.join(PLATFORM_SDK);
    if full.is_dir() {
        return DevDir {
            path: path.to_path_buf(),
            sdk: read_release(&full.join(VERSION_PLIST)),
            full_xcode: true,
        };
    }
    DevDir {
        path: path.to_path_buf(),
        sdk: read_release(&path.join("SDKs/MacOSX.sdk").join(VERSION_PLIST)),
        full_xcode: false,
    }
}

/// Rule 2: the selected developer folder, and whether `DEVELOPER_DIR` chose it.
pub fn selected(developer_dir: Option<OsString>) -> Option<(DevDir, bool)> {
    if let Some(d) = developer_dir.filter(|d| !d.is_empty()) {
        return Some((dev_dir(Path::new(&d)), true));
    }
    let out = Command::new("/usr/bin/xcode-select")
        .arg("-p")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !p.is_empty()).then(|| (dev_dir(Path::new(&p)), false))
}

/// Rule 3: the full Xcodes in /Applications and ~/Applications, sorted by path.
pub fn installed_xcodes(home: Option<&Path>) -> Vec<DevDir> {
    let mut roots = vec![PathBuf::from("/Applications")];
    if let Some(h) = home {
        roots.push(h.join("Applications"));
    }
    let mut out: Vec<DevDir> = roots
        .iter()
        .filter_map(|r| fs::read_dir(r).ok())
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "app"))
        .map(|p| dev_dir(&p.join("Contents/Developer")))
        .filter(|d| d.full_xcode)
        .collect();
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

/// What `polycarp update` builds with on this Mac.
pub fn choice_here(home: Option<&Path>) -> Choice {
    let Some((sel, explicit)) = selected(std::env::var_os("DEVELOPER_DIR")) else {
        return Choice::Keep;
    };
    choose(
        os_release().as_ref(),
        &sel,
        explicit,
        &installed_xcodes(home),
    )
}

// ---- The build check: running --------------------------------------------------------------------

fn host_arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        other => other,
    }
}

fn tool_output(tool: &str, args: &[&str], binary: &Path) -> Result<String, String> {
    let out = Command::new(tool)
        .args(args)
        .arg(binary)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("{tool} could not start: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "{tool} {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Rule 5: the imports of `binary` from the system that don't resolve in this process, and how many were checked.
#[cfg(target_os = "macos")]
pub fn missing_imports(binary: &Path) -> Result<(usize, Vec<Import>), String> {
    use std::ffi::CString;
    let arch = host_arch();
    let libs: Vec<String> = parse_linked(&tool_output(
        "/usr/bin/otool",
        &["-arch", arch, "-L"],
        binary,
    )?)
    .into_iter()
    .filter(|p| is_system_library(p))
    .collect();
    let mut loaded = std::collections::HashSet::new();
    for lib in &libs {
        let Ok(c) = CString::new(lib.as_str()) else {
            continue;
        };
        // SAFETY: a NUL-terminated path; the handle is kept open for the lookups below.
        if !unsafe { libc::dlopen(c.as_ptr(), libc::RTLD_LAZY | libc::RTLD_GLOBAL) }.is_null() {
            loaded.insert(short_name(lib));
        }
    }
    let system: std::collections::HashSet<String> = libs.iter().map(|l| short_name(l)).collect();
    let imports: Vec<Import> =
        parse_imports(&tool_output("/usr/bin/nm", &["-m", "-arch", arch], binary)?)
            .into_iter()
            .filter(|w| system.contains(&w.from))
            .collect();
    let missing = imports
        .iter()
        .filter(|w| {
            if !loaded.contains(&w.from) {
                return true;
            }
            let name = w.symbol.strip_prefix('_').unwrap_or(&w.symbol);
            let Ok(c) = CString::new(name) else {
                return true;
            };
            // SAFETY: a NUL-terminated name looked up in every image loaded so far.
            unsafe { libc::dlsym(libc::RTLD_DEFAULT, c.as_ptr()) }.is_null()
        })
        .cloned()
        .collect();
    Ok((imports.len(), missing))
}

#[cfg(not(target_os = "macos"))]
pub fn missing_imports(_binary: &Path) -> Result<(usize, Vec<Import>), String> {
    Err("the build check runs on a Mac only".to_string())
}

/// `polycarp update --check-build <binary>`: exit 0, 1 or 2 (rule 5).
pub fn check_build_command(args: &[OsString], home: Option<&Path>) -> i32 {
    let [binary] = args else {
        eprintln!("polycarp update: --check-build needs the path of the app's executable");
        return 2;
    };
    let binary = Path::new(binary);
    let os = os_release();
    match missing_imports(binary) {
        Err(e) => {
            eprintln!(
                "polycarp update: the build check could not run, so nothing was installed: {e}"
            );
            2
        }
        Ok((n, missing)) if missing.is_empty() => {
            println!(
                "build check: all {n} imports from the system resolve on macOS {}",
                os.as_ref()
                    .map(|o| o.label())
                    .unwrap_or_else(|| "(unknown)".into())
            );
            0
        }
        Ok((_, missing)) => {
            let sel = selected(std::env::var_os("DEVELOPER_DIR")).map(|(d, _)| d);
            let others: Vec<DevDir> = installed_xcodes(home)
                .into_iter()
                .filter(|d| Some(&d.path) != sel.as_ref().map(|s| &s.path))
                .collect();
            let fix = os.as_ref().and_then(|o| best_fit(o, &others));
            eprint!("{}", report(&missing, os.as_ref(), sel.as_ref(), fix));
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering::*;

    fn xcode(path: &str, version: &str, build: &str) -> DevDir {
        DevDir {
            path: PathBuf::from(path),
            sdk: Some(Release::new(version, build)),
            full_xcode: true,
        }
    }
    const XCODE: &str = "/Applications/Xcode.app/Contents/Developer";
    const BETA: &str = "/Applications/Xcode-beta.app/Contents/Developer";
    const CLT: &str = "/Library/Developer/CommandLineTools";

    /// This Mac on 2026-11-27: macOS 27.2 seed 26B5091g, Xcode.app with the 27.2 release SDK, Xcode-beta with 27.0.
    fn the_mac_today() -> (Release, DevDir, Vec<DevDir>) {
        let os = Release::new("27.2", "26B5091g");
        let sel = xcode(XCODE, "27.2", "26B118");
        let all = vec![xcode(BETA, "27.0", "26A5378i"), sel.clone()];
        (os, sel, all)
    }

    #[test]
    fn versions_compare_number_by_number() {
        for (a, b, want) in [
            ("27.2", "27.0", Some(Greater)),
            ("27.0", "27.2", Some(Less)),
            ("27.2", "27.2.0", Some(Equal)),
            ("27.10", "27.9", Some(Greater)),
            ("28", "27.99", Some(Greater)),
            ("27.x", "27.2", None),
        ] {
            assert_eq!(compare_versions(a, b), want, "{a} vs {b}");
        }
    }

    #[test]
    fn builds_parse() {
        assert_eq!(
            Build::parse("26B5091g"),
            Some(Build {
                major: 26,
                train: 'B',
                number: 5091,
                seed: Some('g')
            })
        );
        assert_eq!(
            Build::parse("26B118"),
            Some(Build {
                major: 26,
                train: 'B',
                number: 118,
                seed: None
            })
        );
        for bad in ["", "26", "B118", "26b118", "26B", "26Bxg"] {
            assert_eq!(Build::parse(bad), None, "{bad}");
        }
    }

    #[test]
    fn an_sdk_is_newer_by_version_then_by_build() {
        for (sdk, os, want) in [
            (("27.2", "26B118"), ("27.0", "26A425"), true),
            (("27.0", "26A5378i"), ("27.2", "26B5091g"), false),
            // The same version: the release SDK is newer than the seed system (the crash on 2026-11-27).
            (("27.2", "26B118"), ("27.2", "26B5091g"), true),
            (("27.2", "26B5091g"), ("27.2", "26B118"), false),
            (("27.2", "26C5010a"), ("27.2", "26B118"), true),
            (("27.2", "26B5120h"), ("27.2", "26B5091g"), true),
            (("27.2", "26B118"), ("27.2", "26B118"), false),
            (("27.2", "26B120"), ("27.2", "26B118"), true),
            (("27.2", "weird"), ("27.2", "26B118"), false),
        ] {
            let (s, o) = (Release::new(sdk.0, sdk.1), Release::new(os.0, os.1));
            assert_eq!(sdk_newer_than_os(&s, &o), want, "{sdk:?} vs {os:?}");
        }
        let no_build = Release {
            version: "27.2".into(),
            build: None,
        };
        assert!(!sdk_newer_than_os(
            &no_build,
            &Release::new("27.2", "26B5091g")
        ));
    }

    #[test]
    fn the_mac_today_builds_with_xcode_beta() {
        let (os, sel, all) = the_mac_today();
        match choose(Some(&os), &sel, false, &all) {
            Choice::Use { dir, line } => {
                assert_eq!(dir, PathBuf::from(BETA));
                assert!(line.contains("Xcode-beta.app"), "{line}");
                assert!(
                    line.contains("27.2 (26B118)") && line.contains("27.2 (26B5091g)"),
                    "{line}"
                );
                assert!(!line.contains('\n'), "one line: {line}");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn choose_covers_each_case() {
        let (os, sel, all) = the_mac_today();
        // An explicit DEVELOPER_DIR is the person's choice.
        assert_eq!(choose(Some(&os), &sel, true, &all), Choice::Keep);
        // Unknown macOS or SDK: nothing to judge.
        assert_eq!(choose(None, &sel, false, &all), Choice::Keep);
        let unknown = DevDir {
            sdk: None,
            ..sel.clone()
        };
        assert_eq!(choose(Some(&os), &unknown, false, &all), Choice::Keep);
        // A selected SDK that is not newer is kept.
        let release_os = Release::new("27.2", "26B118");
        assert_eq!(choose(Some(&release_os), &sel, false, &all), Choice::Keep);
        // Newer, and nothing fits: a warning, the selection kept.
        assert!(matches!(
            choose(Some(&os), &sel, false, std::slice::from_ref(&sel)),
            Choice::Warn { .. }
        ));
        // The Command Line Tools are never kept when a full Xcode fits, and never picked.
        let clt = DevDir {
            path: CLT.into(),
            sdk: Some(Release::new("27.0", "26A425")),
            full_xcode: false,
        };
        match choose(Some(&os), &clt, false, &all) {
            Choice::Use { dir, line } => {
                assert_eq!(dir, PathBuf::from(BETA));
                assert!(line.contains("Command Line Tools"), "{line}");
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(
            choose(Some(&os), &clt, false, std::slice::from_ref(&clt)),
            Choice::Warn { .. }
        ));
        // Of two that fit, the newest SDK; a tie goes to the first by path.
        let two = vec![
            xcode(
                "/Applications/Xcode-26.app/Contents/Developer",
                "26.4",
                "25E100",
            ),
            xcode(BETA, "27.0", "26A5378i"),
            xcode(
                "/Applications/Xcode-old.app/Contents/Developer",
                "27.0",
                "26A5378i",
            ),
            sel.clone(),
        ];
        assert_eq!(
            best_fit(&os, &two).map(|d| d.path.clone()),
            Some(PathBuf::from(BETA))
        );
    }

    #[test]
    fn nm_imports_parse_weak_and_strong() {
        let nm = "\
                 (undefined) weak external _$s10Foundation4DateV2leoiySbAC_ACtFZ (from Foundation)
                 (undefined) external _$s10Foundation4DateVMa (from Foundation)
0000000100001000 (__TEXT,__text) external _main
                 (undefined) weak external _$s7SwiftUI4ViewPAAE19focusEffectDisabledyQrSbF (from SwiftUI)
                 (undefined) weak external _flat_namespace_symbol
                 (undefined) weak external __swift_FORCE_LOAD_$_swiftos (from libswiftos)
";
        assert_eq!(
            parse_imports(nm),
            vec![
                Import {
                    symbol: "_$s10Foundation4DateV2leoiySbAC_ACtFZ".into(),
                    from: "Foundation".into(),
                    weak: true,
                },
                Import {
                    symbol: "_$s10Foundation4DateVMa".into(),
                    from: "Foundation".into(),
                    weak: false,
                },
                Import {
                    symbol: "_$s7SwiftUI4ViewPAAE19focusEffectDisabledyQrSbF".into(),
                    from: "SwiftUI".into(),
                    weak: true,
                },
                Import {
                    symbol: "__swift_FORCE_LOAD_$_swiftos".into(),
                    from: "libswiftos".into(),
                    weak: true,
                },
            ]
        );
    }

    #[test]
    fn otool_libraries_parse_and_get_nm_names() {
        let otool = "/x/Polycarp.app/Contents/MacOS/Polycarp (architecture arm64):
\t/System/Library/Frameworks/Foundation.framework/Versions/C/Foundation (compatibility version 300.0.0, current version 5027.0.59)
\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1359.0.0)
\t/usr/lib/swift/libswiftCoreAudio.dylib (compatibility version 1.0.0, current version 477.2.2, weak)
\t@rpath/libFoo.dylib (compatibility version 1.0.0, current version 1.0.0)
";
        let linked = parse_linked(otool);
        assert_eq!(linked.len(), 4);
        let system: Vec<String> = linked
            .iter()
            .filter(|p| is_system_library(p))
            .map(|p| short_name(p))
            .collect();
        assert_eq!(system, ["Foundation", "libSystem", "libswiftCoreAudio"]);
        for (path, name) in [
            ("/usr/lib/libobjc.A.dylib", "libobjc"),
            (
                "/usr/lib/swift/libswift_Concurrency.dylib",
                "libswift_Concurrency",
            ),
            ("/usr/lib/libc++.1.dylib", "libc++"),
            (
                "/System/Library/Frameworks/SwiftUI.framework/Versions/A/SwiftUI",
                "SwiftUI",
            ),
            ("/usr/lib/libz.1.dylib", "libz"),
            ("/usr/lib/libcurl.4.dylib", "libcurl"),
        ] {
            assert_eq!(short_name(path), name, "{path}");
        }
    }

    #[test]
    fn the_report_names_the_symbols_the_versions_and_the_fix() {
        let (os, sel, all) = the_mac_today();
        let missing = [Import {
            symbol: "_$s10Foundation4DateV2leoiySbAC_ACtFZ".into(),
            from: "Foundation".into(),
            weak: true,
        }];
        let others: Vec<DevDir> = all.into_iter().filter(|d| d.path != sel.path).collect();
        let text = report(&missing, Some(&os), Some(&sel), best_fit(&os, &others));
        for want in [
            "_$s10Foundation4DateV2leoiySbAC_ACtFZ (from Foundation, weak)",
            "macOS 27.2 (26B5091g)",
            "macOS SDK 27.2 (26B118)",
            &format!("DEVELOPER_DIR={BETA} make -C spaces install"),
            "running app was left alone",
        ] {
            assert!(text.contains(want), "{want} in:\n{text}");
        }
        let none = report(&missing, Some(&os), Some(&sel), None);
        assert!(none.contains("install an Xcode with such an SDK"), "{none}");
    }

    #[test]
    fn a_dev_dir_reads_its_sdk_and_kind() {
        let tmp = std::env::temp_dir().join(format!("polycarp-toolchain-{}", std::process::id()));
        let full = tmp.join("Xcode-beta.app/Contents/Developer");
        let plist = full.join(PLATFORM_SDK).join(VERSION_PLIST);
        fs::create_dir_all(plist.parent().unwrap()).unwrap();
        fs::write(&plist, "<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict><key>ProductBuildVersion</key><string>26A5378i</string><key>ProductVersion</key><string>27.0</string></dict></plist>").unwrap();
        let d = dev_dir(&full);
        assert!(d.full_xcode);
        assert_eq!(d.sdk, Some(Release::new("27.0", "26A5378i")));
        assert_eq!(d.name(), "Xcode-beta.app");
        let clt = dev_dir(&tmp.join("CommandLineTools"));
        assert!(!clt.full_xcode && clt.sdk.is_none());
        fs::remove_dir_all(&tmp).unwrap();
    }
}
