//! Where this device keeps its one sync secret: the Keychain on a Mac, the Credential Manager on Windows, libsecret
//! (`secret-tool`) on Linux. A file only its owner can read is the fallback only where there is no store, and the
//! command says so. The secret never leaves this device, and nothing here prints it.
//!
//! Test hook, never set in real use: `POLYCARP_SYNC_KEY_STORE=file` keeps the secret in the file, so no test reaches a
//! real Keychain.

use age::secrecy::{ExposeSecret, SecretString};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub const SERVICE: &str = "Polycarp Sync";

pub enum Store {
    #[cfg(any(target_os = "macos", windows))]
    Native(keyring_core::Entry),
    #[cfg(all(unix, not(target_os = "macos")))]
    Libsecret {
        tool: PathBuf,
        account: String,
    },
    File(PathBuf),
}

impl Store {
    /// The store for the sync folder `dir`, and a note to print when it is the file.
    pub fn open(dir: &Path) -> Result<(Store, Option<String>), String> {
        let file = Store::File(dir.join("identity"));
        let note = Some(format!(
            "This system has no secret store, so this device's sync key is in {}, readable only by you.",
            dir.join("identity").display()
        ));
        if std::env::var_os("POLYCARP_SYNC_KEY_STORE").is_some_and(|v| v == "file") {
            return Ok((file, note));
        }
        let real = fs::canonicalize(dir)
            .map_err(|e| format!("could not resolve {}: {e}", dir.display()))?;
        let account = format!("settings sync at {}", real.display());
        #[cfg(any(target_os = "macos", windows))]
        {
            use keyring_core::api::CredentialStoreApi;
            #[cfg(target_os = "macos")]
            let store = apple_native_keyring_store::keychain::Store::new();
            #[cfg(windows)]
            let store = windows_native_keyring_store::Store::new();
            let entry = store
                .and_then(|s| s.build(SERVICE, &account, None))
                .map_err(|e| format!("the system's secret store refused: {e}"))?;
            let _ = (file, note);
            Ok((Store::Native(entry), None))
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            let tool = PathBuf::from("/usr/bin/secret-tool");
            if tool.is_file() {
                return Ok((Store::Libsecret { tool, account }, None));
            }
            Ok((file, note))
        }
    }

    pub fn load(&self) -> Result<Option<SecretString>, String> {
        match self {
            #[cfg(any(target_os = "macos", windows))]
            Store::Native(e) => match e.get_password() {
                Ok(s) => Ok(Some(SecretString::from(s))),
                Err(keyring_core::Error::NoEntry) => Ok(None),
                Err(e) => Err(format!("the system's secret store refused: {e}")),
            },
            #[cfg(all(unix, not(target_os = "macos")))]
            Store::Libsecret { tool, account } => {
                let out = std::process::Command::new(tool)
                    .args(["lookup", "service", SERVICE, "account", account])
                    .stdin(std::process::Stdio::null())
                    .output()
                    .map_err(|e| format!("could not run secret-tool: {e}"))?;
                let text =
                    String::from_utf8(out.stdout).map_err(|_| "secret-tool gave a damaged key")?;
                let text = text.trim();
                // A missing key is exit 1 with nothing on stderr. Anything else (a locked store, no session bus) is
                // an error, so a key that is there is never taken for one that isn't and replaced.
                match (out.status.success(), text.is_empty(), out.stderr.is_empty()) {
                    (true, false, _) => Ok(Some(SecretString::from(text.to_string()))),
                    (false, true, true) => Ok(None),
                    _ => Err(format!(
                        "secret-tool could not read the sync key: {}",
                        String::from_utf8_lossy(&out.stderr).trim()
                    )),
                }
            }
            Store::File(p) => match fs::read_to_string(p) {
                Ok(s) => Ok(Some(SecretString::from(s.trim().to_string()))),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(format!("could not read {}: {e}", p.display())),
            },
        }
    }

    /// Saves the secret. A file is made new, only its owner may read it, and one that is there is never overwritten.
    pub fn save(&self, secret: &SecretString) -> Result<(), String> {
        match self {
            #[cfg(any(target_os = "macos", windows))]
            Store::Native(e) => e
                .set_password(secret.expose_secret())
                .map_err(|e| format!("the system's secret store refused: {e}")),
            #[cfg(all(unix, not(target_os = "macos")))]
            Store::Libsecret { tool, account } => {
                let mut child = std::process::Command::new(tool)
                    .args([
                        "store", "--label", SERVICE, "service", SERVICE, "account", account,
                    ])
                    .stdin(std::process::Stdio::piped())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .map_err(|e| format!("could not run secret-tool: {e}"))?;
                child
                    .stdin
                    .take()
                    .expect("piped")
                    .write_all(secret.expose_secret().as_bytes())
                    .map_err(|e| format!("could not hand the key to secret-tool: {e}"))?;
                let ok = child.wait().map_err(|e| e.to_string())?.success();
                ok.then_some(())
                    .ok_or_else(|| "secret-tool could not save the key".to_string())
            }
            Store::File(p) => {
                let mut o = fs::OpenOptions::new();
                o.write(true).create_new(true);
                #[cfg(unix)]
                std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
                let mut f = o
                    .open(p)
                    .map_err(|e| format!("could not make {}: {e}", p.display()))?;
                f.write_all(secret.expose_secret().as_bytes())
                    .and_then(|_| f.sync_all())
                    .map_err(|e| format!("could not write {}: {e}", p.display()))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn the_key_file_is_private_and_never_overwritten() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("polycarp-sync-store-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let s = Store::File(dir.join("identity"));
        assert!(s.load().unwrap().is_none());
        s.save(&SecretString::from("AGE-SECRET-KEY-1TEST".to_string()))
            .unwrap();
        let mode = fs::metadata(dir.join("identity"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
        assert!(s.save(&SecretString::from("other".to_string())).is_err());
        assert_eq!(
            s.load().unwrap().unwrap().expose_secret(),
            "AGE-SECRET-KEY-1TEST"
        );
    }
}
