//! What the index never reads and what it leaves out as noise. These rules also gate every file
//! `serve` hands out and every file `send` sends, so a path the index skips can't be fetched either.

use std::path::{Component, Path};

/// Text is read only up to this size; bigger files are indexed by name.
pub const MAX_TEXT_BYTES: u64 = 5 * 1024 * 1024;

/// Folders that hold secrets or another program's private state. Never walked, anywhere in a path.
const SECRET_DIRS: &[&str] = &[
    ".ssh",
    ".gnupg",
    ".gpg",
    ".password-store",
    ".pass",
    ".aws",
    ".azure",
    ".kube",
    ".docker",
    ".gcloud",
    ".config",
    ".local",
    "keychains",
    "1password",
    "bitwarden",
    "keepassxc",
    "proton pass",
    // Browser profiles.
    "chrome",
    "google chrome",
    "chromium",
    "bravesoftware",
    "microsoft edge",
    "edge",
    "firefox",
    ".mozilla",
    "mozilla",
    "helium",
    "net.imput.helium",
    "safari",
    "vivaldi",
    "opera software",
    "arc",
    "user data",
    "appdata",
];

/// Noise inside a root: build output, dependencies, app bundles. Skipped with their contents.
const NOISE_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "build",
    "dist",
    "deriveddata",
    "__pycache__",
    "venv",
    "pods",
    "bower_components",
    "library",
    "$recycle.bin",
];

/// Package folders macOS shows as one file. Not walked.
const PACKAGE_EXTS: &[&str] = &[
    "app",
    "photoslibrary",
    "musiclibrary",
    "tvlibrary",
    "framework",
    "bundle",
    "xcarchive",
    "keychain",
];

/// File extensions that are keys, certificates, vaults or wallets.
const SECRET_EXTS: &[&str] = &[
    "pem",
    "key",
    "p12",
    "pfx",
    "kdbx",
    "kdb",
    "keychain",
    "keychain-db",
    "gpg",
    "asc",
    "jks",
    "keystore",
    "ovpn",
    "ppk",
    "age",
    "crt",
    "cer",
    "der",
    "csr",
];

/// Words that mark a file name as a secret.
const SECRET_WORDS: &[&str] = &[
    "key",
    "secret",
    "password",
    "passwd",
    "credential",
    "token",
    "wallet",
    "mnemonic",
    "id_rsa",
    "id_ed25519",
    "id_ecdsa",
    "id_dsa",
    "known_hosts",
    "netrc",
];

/// A folder name that is never walked, wherever it sits: a secret store, a browser profile, or Polymarket.
pub fn secret_dir(name: &str) -> bool {
    let n = name.to_lowercase();
    n.contains("polymarket") || SECRET_DIRS.contains(&n.as_str())
}

/// A file name that is never indexed, served or sent.
pub fn secret_file(name: &str) -> bool {
    let n = name.to_lowercase();
    if n.starts_with(".env") || n.contains("polymarket") {
        return true;
    }
    if let Some((_, ext)) = n.rsplit_once('.') {
        if SECRET_EXTS.contains(&ext) {
            return true;
        }
    }
    SECRET_WORDS.iter().any(|w| n.contains(w))
}

/// A folder inside a root that is left out: hidden, build output, dependencies, a package.
pub fn noise_dir(name: &str, extra: &[String]) -> bool {
    let n = name.to_lowercase();
    if n.starts_with('.') || NOISE_DIRS.contains(&n.as_str()) {
        return true;
    }
    if let Some((_, ext)) = n.rsplit_once('.') {
        if PACKAGE_EXTS.contains(&ext) {
            return true;
        }
    }
    extra.iter().any(|x| x.to_lowercase() == n)
}

/// A file inside a root that is left out: hidden files and system clutter.
pub fn noise_file(name: &str, extra: &[String]) -> bool {
    let n = name.to_lowercase();
    n.starts_with('.')
        || n.starts_with("~$")
        || n == "thumbs.db"
        || n == "desktop.ini"
        || n.ends_with(".tmp")
        || n.ends_with(".part")
        || n.ends_with(".crdownload")
        || extra.iter().any(|x| x.to_lowercase() == n)
}

/// True when any folder in the whole path is a secret folder or the file is a secret file.
pub fn never(path: &Path) -> bool {
    let names: Vec<String> = path
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    let Some((file, dirs)) = names.split_last() else {
        return false;
    };
    dirs.iter().any(|d| secret_dir(d)) || secret_dir(file) || secret_file(file)
}

/// True when `rel` (a file's path inside its root) passes every rule.
pub fn allowed_in_root(root: &Path, rel: &Path, extra: &[String]) -> bool {
    if never(&root.join(rel)) {
        return false;
    }
    let names: Vec<String> = rel
        .components()
        .map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()
        .unwrap_or_default();
    let Some((file, dirs)) = names.split_last() else {
        return false;
    };
    !dirs.iter().any(|d| noise_dir(d, extra)) && !noise_file(file, extra)
}

/// The kind of a file by its extension: md, txt, code, csv, json, doc, pdf, sheet, slides, image, audio, video,
/// archive or other.
pub fn kind(name: &str) -> &'static str {
    let ext = name
        .rsplit_once('.')
        .map(|(_, e)| e.to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "md" | "markdown" | "mdx" => "md",
        "txt" | "text" | "log" | "org" | "rst" | "tex" => "txt",
        "csv" | "tsv" => "csv",
        "json" | "jsonl" | "ndjson" | "geojson" => "json",
        "rs" | "py" | "js" | "mjs" | "cjs" | "ts" | "tsx" | "jsx" | "swift" | "go" | "c" | "h"
        | "cc" | "cpp" | "hpp" | "m" | "mm" | "java" | "kt" | "kts" | "rb" | "php" | "sh"
        | "bash" | "zsh" | "fish" | "ps1" | "lua" | "pl" | "r" | "sql" | "toml" | "yaml"
        | "yml" | "xml" | "html" | "htm" | "css" | "scss" | "vue" | "svelte" | "cs" | "fs"
        | "dart" | "zig" | "nix" | "ini" | "cfg" | "conf" | "gradle" | "cmake" | "mk"
        | "dockerfile" | "proto" | "graphql" | "ipynb" => "code",
        "doc" | "docx" | "odt" | "rtf" | "pages" => "doc",
        "pdf" => "pdf",
        "xls" | "xlsx" | "ods" | "numbers" => "sheet",
        "ppt" | "pptx" | "odp" | "key" => "slides",
        "png" | "jpg" | "jpeg" | "gif" | "heic" | "webp" | "tif" | "tiff" | "bmp" | "svg"
        | "raw" | "dng" => "image",
        "mp3" | "m4a" | "wav" | "flac" | "aac" | "ogg" | "aiff" => "audio",
        "mp4" | "mov" | "m4v" | "mkv" | "avi" | "webm" => "video",
        "zip" | "tar" | "gz" | "tgz" | "bz2" | "xz" | "7z" | "rar" | "dmg" | "iso" => "archive",
        _ if name.eq_ignore_ascii_case("makefile") || name.eq_ignore_ascii_case("dockerfile") => {
            "code"
        }
        _ => "other",
    }
}

/// Kinds whose text goes into the index.
pub fn text_kind(kind: &str) -> bool {
    matches!(kind, "md" | "txt" | "code" | "csv" | "json")
}

/// Every kind `--kind` takes.
pub const KINDS: &[&str] = &[
    "md", "txt", "code", "csv", "json", "doc", "pdf", "sheet", "slides", "image", "audio", "video",
    "archive", "other",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_are_never_allowed() {
        for p in [
            "/h/.ssh/id_ed25519",
            "/h/Documents/.env",
            "/h/Documents/.env.local",
            "/h/Documents/server.pem",
            "/h/Documents/api-key.txt",
            "/h/Documents/MyKeys.md",
            "/h/Projects/polymarket/notes.md",
            "/h/Projects/Polymarket-bot/readme.md",
            "/h/Library/Keychains/login.keychain-db",
            "/h/.gnupg/pubring.kbx",
            "/h/Library/Application Support/Google/Chrome/Default/History",
            "/h/AppData/Local/BraveSoftware/User Data/Default/Cookies",
            "/h/.password-store/bank.gpg",
            "/h/Documents/passwords.csv",
        ] {
            assert!(never(Path::new(p)), "{p} must be refused");
        }
        for p in ["/h/Documents/notes.md", "/h/Projects/app/src/main.rs"] {
            assert!(!never(Path::new(p)), "{p} must be allowed");
        }
    }

    #[test]
    fn noise_is_left_out_inside_a_root() {
        let root = Path::new("/h/Projects");
        let ok = |rel: &str| allowed_in_root(root, Path::new(rel), &[]);
        assert!(ok("app/src/main.rs"));
        assert!(!ok("app/node_modules/x/index.js"));
        assert!(!ok("app/target/debug/out.txt"));
        assert!(!ok("app/.git/config"));
        assert!(!ok("app/.hidden/notes.md"));
        assert!(!ok("Foo.app/Contents/Info.plist"));
        assert!(!ok("app/.DS_Store"));
        assert!(!allowed_in_root(
            root,
            Path::new("app/vendor/x.rs"),
            &["vendor".to_string()]
        ));
    }

    #[test]
    fn kinds() {
        assert_eq!(kind("a.MD"), "md");
        assert_eq!(kind("a.rs"), "code");
        assert_eq!(kind("a.docx"), "doc");
        assert_eq!(kind("Makefile"), "code");
        assert_eq!(kind("noext"), "other");
        assert!(text_kind("csv") && !text_kind("pdf"));
    }
}
