//! Where the gateway keeps its state, and the small pieces of crypto it needs. Everything lives in `agent/` under
//! Polycarp's config folder: the folder is 0700 and every file in it 0600 on Unix, written whole and renamed into
//! place, so a reader never sees half a file. Secrets are stored only as SHA-256 hashes.

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// The port `polycarp agent serve` listens on, on loopback (and on this device's Tailscale addresses with --tailnet).
pub const PORT: u16 = 41772;

pub const AUTH_FILE: &str = "auth.json";
pub const SETTINGS_FILE: &str = "agent.toml";
pub const TUNNEL_FILE: &str = "tunnel.json";
pub const INVITE_FILE: &str = "invite.json";
/// What the app may show: the connections waiting for the owner's approval (no secrets in it).
pub const APPROVALS_FILE: &str = "approvals.json";
const LOCK_FILE: &str = "state.lock";

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// `n` bytes from the operating system's random number generator.
pub fn random(n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    // A machine that can't give random numbers can't run an authorization server: stop rather than mint weak tokens.
    getrandom::getrandom(&mut buf).expect("the operating system gave no random numbers");
    buf
}

/// Base64url without padding (RFC 4648 section 5), as PKCE and tokens use it.
pub fn b64url(bytes: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..=chunk.len() {
            out.push(A[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    out
}

/// A fresh secret: a prefix and 32 random bytes.
pub fn secret(prefix: &str) -> String {
    format!("{prefix}{}", b64url(&random(32)))
}

pub fn sha256_hex(s: &str) -> String {
    Sha256::digest(s.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The PKCE S256 transform: base64url(SHA-256(verifier)).
pub fn s256(verifier: &str) -> String {
    b64url(&Sha256::digest(verifier.as_bytes()))
}

/// Equal without an early exit, for comparing hashes.
pub fn same(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

/// `agent/` under Polycarp's config folder.
pub fn agent_dir() -> Result<PathBuf, String> {
    Ok(crate::theme::config_dir()?.join("agent"))
}

/// Creates the folder, private to this user.
pub fn ensure_dir(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("could not make {} private: {e}", dir.display()))?;
    }
    Ok(())
}

/// Writes `bytes` to `path` as a private file (0600 on Unix), whole: a temp file in the same folder, then a rename.
pub fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or("a file needs a folder")?;
    ensure_dir(dir)?;
    let tmp = dir.join(format!(
        ".{}.{}.tmp",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("file"),
        std::process::id()
    ));
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let written = opts.open(&tmp).and_then(|mut f| {
        f.write_all(bytes)?;
        f.sync_all()
    });
    if let Err(e) = written {
        let _ = fs::remove_file(&tmp);
        return Err(format!("could not write {}: {e}", path.display()));
    }
    // A file made by an older build, or by hand, keeps its mode across the rename on some systems: set it again.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("could not save {}: {e}", path.display())
    })
}

/// The Unix mode bits of a file, or None where there are none.
pub fn mode(path: &Path) -> Option<u32> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(path)
            .ok()
            .map(|m| m.permissions().mode() & 0o777)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        None
    }
}

/// Reads a JSON file; an absent one is the default.
pub fn read_json<T: DeserializeOwned + Default>(path: &Path) -> Result<T, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| {
            format!(
                "{} is not valid: {e}. Move it aside to start over; every client will need to connect again.",
                path.display()
            )
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(e) => Err(format!("could not read {}: {e}", path.display())),
    }
}

pub fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let text = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    write_private(path, &text)
}

/// One writer at a time across processes (`serve` and `approve` both change auth.json). A lock older than 30 seconds
/// is a leftover of a process that died and is taken over.
pub struct Lock(PathBuf);

impl Lock {
    pub fn take(dir: &Path) -> Result<Lock, String> {
        ensure_dir(dir)?;
        let path = dir.join(LOCK_FILE);
        let start = Instant::now();
        loop {
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(_) => return Ok(Lock(path)),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    let stale = fs::metadata(&path)
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|t| t.elapsed().ok())
                        .is_some_and(|age| age > Duration::from_secs(30));
                    if stale {
                        let _ = fs::remove_file(&path);
                        continue;
                    }
                    if start.elapsed() > Duration::from_secs(5) {
                        return Err(format!(
                            "{} is held by another polycarp process. Try again; if it stays, remove that file.",
                            path.display()
                        ));
                    }
                    std::thread::sleep(Duration::from_millis(15));
                }
                Err(e) => return Err(format!("could not lock {}: {e}", path.display())),
            }
        }
    }
}

impl Drop for Lock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

/// The owner's settings, `agent/agent.toml`. Every key is optional.
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct Settings {
    /// Default 41772.
    pub port: Option<u16>,
    /// Also listen on this device's Tailscale addresses (the same as `serve --tailnet`).
    pub tailnet: bool,
    /// When not empty, only these of the owner's devices may connect over the tailnet.
    pub allow_devices: Vec<String>,
    /// More https callbacks an OAuth client may register, each matched exactly.
    pub extra_redirects: Vec<String>,
}

impl Settings {
    pub fn load(dir: &Path) -> Result<Settings, String> {
        let path = dir.join(SETTINGS_FILE);
        match fs::read_to_string(&path) {
            Ok(text) => toml::from_str(&text).map_err(|e| format!("{}: {e}", path.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
            Err(e) => Err(format!("could not read {}: {e}", path.display())),
        }
    }

    pub fn port(&self) -> u16 {
        self.port.unwrap_or(PORT)
    }
}

/// The route a tunnel command set up, `agent/tunnel.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Tunnel {
    /// `cloudflare`, `tailscale` (Serve, tailnet only) or `funnel` (Tailscale Funnel, public).
    pub kind: String,
    /// What a connector is given, without `/mcp`: `https://agent.example.com`.
    pub public_url: String,
    /// The Host header requests through the tunnel carry.
    pub host: String,
    /// The Cloudflare tunnel's name, for `cloudflared tunnel delete`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub created: i64,
}

impl Tunnel {
    pub fn load(dir: &Path) -> Option<Tunnel> {
        read_json::<Option<Tunnel>>(&dir.join(TUNNEL_FILE))
            .ok()
            .flatten()
    }

    pub fn route(&self) -> Option<super::policy::Route> {
        use super::policy::Route;
        match self.kind.as_str() {
            "cloudflare" => Some(Route::Cloudflare),
            "tailscale" => Some(Route::TailscaleServe),
            "funnel" => Some(Route::TailscaleFunnel),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_and_pkce_match_the_published_vectors() {
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        // RFC 7636 appendix B.
        assert_eq!(
            s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        assert_eq!(b64url(b""), "");
        assert_eq!(b64url(b"f"), "Zg");
        assert_eq!(b64url(b"fo"), "Zm8");
        assert_eq!(b64url(b"foo"), "Zm9v");
        assert_eq!(b64url(&[0xfb, 0xff]), "-_8");
        assert!(same("abc", "abc") && !same("abc", "abd") && !same("abc", "ab"));
        let (a, b) = (secret("x_"), secret("x_"));
        assert_ne!(a, b);
        assert_eq!(a.len(), 2 + 43);
    }

    #[test]
    fn private_files_are_0600_in_a_0700_folder() {
        let d = std::env::temp_dir().join(format!("pc-agent-store-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        let f = d.join("agent").join("auth.json");
        write_private(&f, b"{}").unwrap();
        assert_eq!(fs::read(&f).unwrap(), b"{}");
        if cfg!(unix) {
            assert_eq!(mode(&f), Some(0o600));
            assert_eq!(mode(f.parent().unwrap()), Some(0o700));
        }
        let l = Lock::take(&d).unwrap();
        assert!(d.join(LOCK_FILE).exists());
        drop(l);
        assert!(!d.join(LOCK_FILE).exists());
        let _ = fs::remove_dir_all(&d);
    }
}
