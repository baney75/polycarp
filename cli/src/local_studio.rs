//! `polycarp install --local-studio`: puts the Polycarp plugin (`plugins/polycarp` in the repo, built into this
//! command as text) in Local Studio's plugin folder, so Local Studio's own agent, often on a local model, drives
//! Polycarp through `polycarp agent serve --stdio`. Then it grants the plugin its one power, `mcp-server`, with
//! Local Studio's own command; Local Studio writes the server into Eukhe's settings itself. `--uninstall` revokes
//! the grant and removes the folder.
//!
//! Only the `polycarp` folder in the plugin folder is written or removed. Nothing runs through a shell.

use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

/// The plugin's id, which Local Studio requires to be its folder's name too.
pub const ID: &str = "polycarp";

/// Each file of `plugins/polycarp`: its path inside the folder, its text, and whether it runs.
/// A new file there must be added here (`every_plugin_file_is_built_in` checks).
pub const FILES: &[(&str, &str, bool)] = &[
    (
        "plugin.toml",
        include_str!("../../plugins/polycarp/plugin.toml"),
        false,
    ),
    (
        "bin/polycarp-mcp",
        include_str!("../../plugins/polycarp/bin/polycarp-mcp"),
        true,
    ),
    (
        "skills/polycarp/SKILL.md",
        include_str!("../../plugins/polycarp/skills/polycarp/SKILL.md"),
        false,
    ),
];

const USAGE: &str = "\
Usage:
  polycarp install --local-studio               add the Polycarp plugin to Local Studio and grant its tools
  polycarp install --local-studio --uninstall   revoke its grant and remove it

The plugin goes in $LOCAL_STUDIO_DATA_DIR/plugins/polycarp, or ~/.local-studio/plugins/polycarp.
";

/// The grant that starts the plugin's MCP server, as Local Studio's command takes it.
const GRANT: [&str; 4] = ["plugin", "grant", ID, "mcp-server"];
const REVOKE: [&str; 3] = ["plugin", "revoke", ID];

pub fn run(args: &[OsString], local_studio: Option<PathBuf>) -> i32 {
    let words: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
    if words.len() != args.len() {
        eprint!("polycarp install: an argument is not valid text\n\n{USAGE}");
        return 2;
    }
    if words.iter().any(|w| *w == "--help" || *w == "-h") {
        print!("{USAGE}");
        return 0;
    }
    let uninstall = match words.as_slice() {
        ["--local-studio"] => false,
        ["--local-studio", "--uninstall"] | ["--uninstall", "--local-studio"] => true,
        _ => {
            eprint!("{USAGE}");
            return 2;
        }
    };
    if cfg!(windows) {
        eprintln!("polycarp install --local-studio: the plugin's server is a POSIX script; on Windows it is not ready yet.");
        return 2;
    }
    let Some(root) = plugins_dir() else {
        eprintln!("polycarp install: HOME is not set, so Local Studio's plugin folder is unknown.");
        return 1;
    };
    if uninstall {
        remove(&root, local_studio.as_deref())
    } else {
        install(&root, local_studio.as_deref())
    }
}

/// Local Studio's plugin folder (its `plugins::plugins_dir`): `$LOCAL_STUDIO_DATA_DIR/plugins`, else
/// `~/.local-studio/plugins`.
pub fn plugins_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("LOCAL_STUDIO_DATA_DIR").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(dir).join("plugins"));
    }
    std::env::var_os("HOME")
        .filter(|v| !v.is_empty())
        .map(|h| PathBuf::from(h).join(".local-studio").join("plugins"))
}

fn install(root: &Path, local_studio: Option<&Path>) -> i32 {
    let dest = root.join(ID);
    if let Err(e) = write_plugin(root) {
        eprintln!("polycarp install: could not write {}: {e}", dest.display());
        return 1;
    }
    println!("Installed the Polycarp plugin in {}", dest.display());
    let Some(ls) = local_studio else {
        println!(
            "Local Studio's command was not found. To start Polycarp's tools, run:\n  local-studio {}",
            GRANT.join(" ")
        );
        return 0;
    };
    match Command::new(ls).args(GRANT).status() {
        Ok(s) if s.success() => {
            println!("Granted mcp-server: Local Studio's agent can now use Polycarp's tools.");
            0
        }
        Ok(s) => {
            eprintln!(
                "polycarp install: `{} {}` failed ({s}). Run it again once Local Studio is set up.",
                ls.display(),
                GRANT.join(" ")
            );
            1
        }
        Err(e) => {
            eprintln!("polycarp install: could not start {}: {e}", ls.display());
            1
        }
    }
}

/// Writes every file into a hidden folder beside the plugin (Local Studio skips dot folders), then swaps it in, so
/// a half-written plugin is never loaded and a second install leaves exactly the same files.
fn write_plugin(root: &Path) -> io::Result<()> {
    fs::create_dir_all(root)?;
    let staging = root.join(format!(".{ID}.installing"));
    remove_any(&staging)?;
    for (rel, text, runs) in FILES {
        let path = staging.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&path, text)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = if *runs { 0o755 } else { 0o644 };
            fs::set_permissions(&path, fs::Permissions::from_mode(mode))?;
        }
        #[cfg(not(unix))]
        let _ = runs;
    }
    let dest = root.join(ID);
    remove_any(&dest)?;
    fs::rename(&staging, &dest)
}

/// Removes a folder, or only the link when `path` is a symlink (never what it points to). Missing is fine.
fn remove_any(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

fn remove(root: &Path, local_studio: Option<&Path>) -> i32 {
    let dest = root.join(ID);
    let mut code = 0;
    match local_studio {
        Some(ls) => match Command::new(ls).args(REVOKE).status() {
            Ok(s) if s.success() => {}
            Ok(s) => {
                eprintln!(
                    "polycarp install: `{} {}` failed ({s}); removing the plugin anyway.",
                    ls.display(),
                    REVOKE.join(" ")
                );
                code = 1;
            }
            Err(e) => {
                eprintln!("polycarp install: could not start {}: {e}", ls.display());
                code = 1;
            }
        },
        None => println!(
            "Local Studio's command was not found. To drop the plugin's grant too, run:\n  local-studio {}",
            REVOKE.join(" ")
        ),
    }
    if fs::symlink_metadata(&dest).is_err() {
        println!("The Polycarp plugin is not installed in {}", root.display());
        return code;
    }
    match remove_any(&dest) {
        Ok(()) => {
            println!("Removed the Polycarp plugin from {}", dest.display());
            code
        }
        Err(e) => {
            eprintln!("polycarp install: could not remove {}: {e}", dest.display());
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use std::collections::{BTreeMap, BTreeSet};

    fn plugin_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/polycarp")
    }

    /// Local Studio's manifest (core/src/plugins.rs `Manifest`), with its `deny_unknown_fields`: a field it does
    /// not know fails the plugin's load, so it fails here too.
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    #[allow(dead_code)]
    struct Manifest {
        id: String,
        version: String,
        description: String,
        skills: Option<String>,
        prompts: Option<String>,
        #[serde(default)]
        commands: Vec<ManifestCommand>,
        #[serde(default)]
        capabilities: Vec<String>,
        mcp: Option<ManifestMcp>,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    #[allow(dead_code)]
    struct ManifestMcp {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: BTreeMap<String, String>,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    #[allow(dead_code)]
    struct ManifestCommand {
        name: String,
        description: String,
        prompt: Option<String>,
        skill: Option<String>,
    }

    fn manifest() -> Manifest {
        toml::from_str(FILES[0].1).expect("plugin.toml has only fields Local Studio knows")
    }

    /// A path Local Studio's `inside` accepts: relative, no `..`, no root.
    fn inside(rel: &str) -> bool {
        let p = Path::new(rel);
        !p.is_absolute()
            && p.components().all(|c| {
                matches!(
                    c,
                    std::path::Component::Normal(_) | std::path::Component::CurDir
                )
            })
    }

    #[test]
    fn the_manifest_loads_as_local_studio_reads_it() {
        let m = manifest();
        assert_eq!(m.id, ID);
        assert_eq!(
            plugin_dir().canonicalize().unwrap().file_name().unwrap(),
            ID,
            "Local Studio requires the folder to be named for the id"
        );
        assert!(!m.description.trim().is_empty());
        assert_eq!(m.capabilities, ["mcp-server"]);
        let mcp = m.mcp.expect("mcp-server needs an [mcp] table");
        assert!(inside(&mcp.command), "{}", mcp.command);
        assert!(plugin_dir().join(&mcp.command).is_file());
        assert!(mcp.env.is_empty());
        let skills = m.skills.as_deref().unwrap();
        assert!(inside(skills));
        for c in &m.commands {
            assert!(c.prompt.is_none());
            let skill = c.skill.as_deref().expect("each command names its skill");
            assert!(
                plugin_dir()
                    .join(skills)
                    .join(skill)
                    .join("SKILL.md")
                    .is_file(),
                "command {} names a missing skill {skill}",
                c.name
            );
        }
        assert!(m.commands.iter().any(|c| c.name == "desk"));
    }

    #[test]
    fn the_plugin_version_is_the_release_version() {
        let version =
            fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../spaces/VERSION"))
                .unwrap();
        assert_eq!(manifest().version, version.trim());
    }

    #[test]
    fn every_plugin_file_is_built_in() {
        fn walk(dir: &Path, base: &Path, out: &mut BTreeSet<String>) {
            for e in fs::read_dir(dir).unwrap() {
                let p = e.unwrap().path();
                // Finder's .DS_Store and other dot files are not the plugin's; Local Studio skips them too.
                if p.file_name()
                    .is_some_and(|n| n.to_string_lossy().starts_with('.'))
                {
                    continue;
                }
                if p.is_dir() {
                    walk(&p, base, out);
                } else {
                    out.insert(
                        p.strip_prefix(base)
                            .unwrap()
                            .to_string_lossy()
                            .replace('\\', "/"),
                    );
                }
            }
        }
        let mut on_disk = BTreeSet::new();
        walk(&plugin_dir(), &plugin_dir(), &mut on_disk);
        let built: BTreeSet<String> = FILES.iter().map(|f| f.0.to_string()).collect();
        assert_eq!(on_disk, built);
    }

    #[test]
    fn the_server_script_hands_off_to_the_agent_gateway_and_says_when_polycarp_is_missing() {
        let script = FILES[1].1;
        assert!(script.starts_with("#!/bin/sh\n"));
        assert!(script.contains("command -v polycarp"));
        assert!(script.contains("\"$HOME/.local/bin/polycarp\""));
        assert!(script.contains("/Applications/Polycarp.app/Contents/Resources/bin/polycarp\""));
        assert!(script.contains("exec \"$p\" agent serve --stdio"));
        assert!(script.contains("exit 127"));
    }

    #[test]
    fn nothing_in_the_plugin_uses_long_dashes() {
        for (rel, text, _) in FILES {
            assert!(
                !text.contains('\u{2014}') && !text.contains('\u{2013}'),
                "{rel} has an em or en dash"
            );
        }
    }
}
