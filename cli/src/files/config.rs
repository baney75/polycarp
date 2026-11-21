//! `files.toml`, next to the theme config: which folders are indexed, the port, and who may connect.

use serde::Deserialize;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

/// The fixed port `polycarp files serve` listens on, on this device's Tailscale addresses only.
pub const PORT: u16 = 41771;

/// What the owner can set. Every field is optional; an absent file means the defaults.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    /// Replaces the default roots when set. `~/` means the home folder.
    pub roots: Option<Vec<String>>,
    /// Added to the roots (default or `roots`).
    pub extra_roots: Vec<String>,
    /// More folder or file names to leave out, compared without case.
    pub skip: Vec<String>,
    /// The port to serve on. Default 41771.
    pub port: Option<u16>,
    /// Let other devices of the same owner save files into the inbox folder. Off by default.
    pub allow_save: bool,
    /// When not empty, only these devices (Tailscale names) may connect, and only if they are the owner's.
    pub allow_devices: Vec<String>,
    /// Where the index lives. Default: the platform cache folder.
    pub index_path: Option<String>,
    /// Where received files go. Default `~/Downloads/Polycarp Inbox`.
    pub inbox: Option<String>,
    /// An index older than this many hours is stale. Default 24.
    pub stale_hours: Option<u64>,
}

/// A folder the index walks. `text` false keeps it to names (a streamed cloud drive).
#[derive(Debug, Clone, PartialEq)]
pub struct Root {
    pub path: PathBuf,
    pub text: bool,
}

pub fn home() -> Option<PathBuf> {
    crate::home()
}

/// `~/x` under the home folder, anything else as written.
pub fn expand(p: &str, home: Option<&Path>) -> PathBuf {
    match (p.strip_prefix("~/").or(p.strip_prefix("~\\")), home) {
        (Some(rest), Some(h)) => h.join(rest),
        _ if p == "~" => home
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from(p)),
        _ => PathBuf::from(p),
    }
}

pub fn config_file() -> Result<PathBuf, String> {
    Ok(crate::theme::config_dir()?.join("files.toml"))
}

impl Config {
    pub fn load() -> Result<Config, String> {
        let path = config_file()?;
        match fs::read_to_string(&path) {
            Ok(text) => Config::parse(&text).map_err(|e| format!("{}: {e}", path.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Config::default()),
            Err(e) => Err(format!("could not read {}: {e}", path.display())),
        }
    }

    pub fn parse(text: &str) -> Result<Config, String> {
        toml::from_str(text).map_err(|e| e.to_string())
    }

    pub fn port(&self) -> u16 {
        self.port.unwrap_or(PORT)
    }

    pub fn stale_secs(&self) -> u64 {
        self.stale_hours.unwrap_or(24) * 3600
    }

    pub fn roots(&self) -> Vec<Root> {
        let home = home();
        let mut out = match &self.roots {
            Some(list) => list
                .iter()
                .map(|r| Root {
                    path: expand(r, home.as_deref()),
                    text: true,
                })
                .collect(),
            None => default_roots(home.as_deref(), Os::current()),
        };
        for r in &self.extra_roots {
            out.push(Root {
                path: expand(r, home.as_deref()),
                text: true,
            });
        }
        out.retain(|r| r.path.is_absolute());
        // Where a folder really is, so the watcher's paths and the index's agree (not on Windows, where that
        // would add the \\?\ prefix every opener refuses).
        if !cfg!(windows) {
            for r in &mut out {
                if let Ok(c) = fs::canonicalize(&r.path) {
                    r.path = c;
                }
            }
        }
        out.dedup_by(|a, b| a.path == b.path);
        out
    }

    pub fn index_path(&self) -> Result<PathBuf, String> {
        if let Some(p) = &self.index_path {
            return Ok(expand(p, home().as_deref()));
        }
        default_index_path()
    }

    pub fn inbox(&self) -> Result<PathBuf, String> {
        if let Some(p) = &self.inbox {
            return Ok(expand(p, home().as_deref()));
        }
        let home = home().ok_or("the home folder is not set")?;
        Ok(home.join("Downloads").join("Polycarp Inbox"))
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Os {
    Mac,
    Windows,
    Linux,
}

impl Os {
    pub fn current() -> Os {
        if cfg!(target_os = "macos") {
            Os::Mac
        } else if cfg!(windows) {
            Os::Windows
        } else {
            Os::Linux
        }
    }
}

/// Documents, Desktop, Downloads and Projects; on a Mac every cloud folder under `~/Library/CloudStorage`;
/// on Windows the OneDrive and Google Drive folders; on Linux the whole home folder (hidden folders are skipped).
pub fn default_roots(home: Option<&Path>, os: Os) -> Vec<Root> {
    let Some(home) = home else {
        return Vec::new();
    };
    let plain = |p: PathBuf| Root {
        path: p,
        text: true,
    };
    let mut out = Vec::new();
    if os == Os::Linux {
        out.push(plain(home.to_path_buf()));
        return out;
    }
    for d in ["Documents", "Desktop", "Downloads", "Projects"] {
        out.push(plain(home.join(d)));
    }
    match os {
        Os::Mac => {
            // OneDrive, Google Drive, Proton Drive, Dropbox: each File Provider folder. Files not on disk are
            // indexed by name only, so the index never downloads them.
            if let Ok(rd) = fs::read_dir(home.join("Library").join("CloudStorage")) {
                let mut found: Vec<PathBuf> = rd
                    .filter_map(Result::ok)
                    .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
                    .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
                    .map(|e| e.path())
                    .collect();
                found.sort();
                out.extend(found.into_iter().map(plain));
            }
        }
        Os::Windows => {
            for var in ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"] {
                if let Some(v) = env::var_os(var).filter(|v| !v.is_empty()) {
                    out.push(plain(PathBuf::from(v)));
                }
            }
            // Google Drive for desktop: mirrored folders in the home folder, or the streamed drive (names only).
            for d in ["Google Drive", "My Drive"] {
                let p = home.join(d);
                if p.is_dir() {
                    out.push(plain(p));
                }
            }
            for letter in ["G", "H", "I"] {
                let p = PathBuf::from(format!("{letter}:\\My Drive"));
                if p.is_dir() {
                    out.push(Root {
                        path: p,
                        text: false,
                    });
                }
            }
        }
        Os::Linux => {}
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out.dedup_by(|a, b| a.path == b.path);
    out
}

/// The index file: POLYCARP_CONFIG_DIR's `files/index.sqlite` when that is set (tests and hand runs), else the
/// platform cache folder, since the index can always be built again.
pub fn default_index_path() -> Result<PathBuf, String> {
    let nonempty = |k: &str| env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from);
    if nonempty("POLYCARP_CONFIG_DIR").is_some() {
        return Ok(crate::theme::config_dir()?
            .join("files")
            .join("index.sqlite"));
    }
    let base = if cfg!(windows) {
        nonempty("LOCALAPPDATA")
            .ok_or("LOCALAPPDATA is not set")?
            .join("Polycarp")
    } else if cfg!(target_os = "macos") {
        home()
            .ok_or("HOME is not set")?
            .join("Library/Caches/Polycarp")
    } else if let Some(x) = nonempty("XDG_CACHE_HOME").filter(|p| p.is_absolute()) {
        x.join("polycarp")
    } else {
        home().ok_or("HOME is not set")?.join(".cache/polycarp")
    };
    Ok(base.join("files").join("index.sqlite"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_file_is_the_defaults_and_unknown_keys_are_refused() {
        let c = Config::parse("").unwrap();
        assert_eq!(c.port(), PORT);
        assert!(!c.allow_save);
        assert!(Config::parse("alow_save = true").is_err());
        let c =
            Config::parse("allow_save = true\nallow_devices = [\"parish1\"]\nport = 5000").unwrap();
        assert!(c.allow_save);
        assert_eq!(c.port(), 5000);
    }

    #[test]
    fn default_roots_per_platform() {
        let home = Path::new("/h");
        let mac = default_roots(Some(home), Os::Mac);
        assert!(mac.iter().any(|r| r.path == home.join("Documents")));
        assert!(mac.iter().any(|r| r.path == home.join("Projects")));
        let linux = default_roots(Some(home), Os::Linux);
        assert_eq!(
            linux,
            vec![Root {
                path: home.to_path_buf(),
                text: true
            }]
        );
    }

    #[test]
    fn tilde_expands_to_home() {
        assert_eq!(
            expand("~/Docs", Some(Path::new("/h"))),
            PathBuf::from("/h/Docs")
        );
        assert_eq!(expand("/abs", Some(Path::new("/h"))), PathBuf::from("/abs"));
    }
}
