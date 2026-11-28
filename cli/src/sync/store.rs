//! Where this device keeps its one sync secret: the Keychain on a Mac, the Credential Manager on Windows, libsecret
//! (`secret-tool`) on Linux. A file only its owner can read is the fallback only where there is no store, and the
//! command says so. The secret never leaves this device, and nothing here prints it.
//!
//! A background run reads with [`Ask::Never`]: on a Mac a read that would need the Keychain to ask (a rebuilt,
//! ad-hoc signed `polycarp` no longer matches the item's access list) fails as [`KeyError::NeedsPrompt`] instead of
//! putting a dialog on screen.
//!
//! Test hook, never set in real use: `POLYCARP_SYNC_KEY_STORE=file` keeps the secret in the file, so no test reaches a
//! real Keychain.

use age::secrecy::{ExposeSecret, SecretString};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub const SERVICE: &str = "Polycarp Sync";

/// errSecInteractionNotAllowed: the Keychain would have to ask, and asking is turned off.
#[cfg(target_os = "macos")]
pub const INTERACTION_NOT_ALLOWED: i32 = -25308;
/// errSecAuthFailed. With asking turned off no password is ever entered, so this is how macOS 27 answers a read whose
/// access list does not name this `polycarp` (seen on Donovan's Mac, 2026-11-28): the Keychain wanted to ask.
#[cfg(target_os = "macos")]
pub const AUTH_FAILED: i32 = -25293;

/// Whether reading the key may put a system prompt on screen.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ask {
    Prompt,
    Never,
}

#[derive(Debug, PartialEq, Eq)]
pub enum KeyError {
    /// The store would have to ask, and the read was made with [`Ask::Never`].
    NeedsPrompt,
    Failed(String),
}

impl From<String> for KeyError {
    fn from(e: String) -> Self {
        KeyError::Failed(e)
    }
}

impl From<KeyError> for String {
    fn from(e: KeyError) -> Self {
        match e {
            KeyError::NeedsPrompt => {
                "the Keychain must ask before polycarp can read the sync key; run `polycarp sync now` once to allow it"
                    .into()
            }
            KeyError::Failed(e) => e,
        }
    }
}

/// What a read from the Keychain or Credential Manager means. Only a read made with [`Ask::Never`] can need a prompt;
/// with [`Ask::Prompt`] the same codes (a Deny click) are plain failures. The error text carries only the store's code.
#[cfg(any(target_os = "macos", windows))]
fn native_result(
    r: Result<String, keyring_core::Error>,
    ask: Ask,
) -> Result<Option<SecretString>, KeyError> {
    match r {
        Ok(s) => Ok(Some(SecretString::from(s))),
        Err(keyring_core::Error::NoEntry) => Ok(None),
        Err(e) if ask == Ask::Never && needs_prompt(&e) => Err(KeyError::NeedsPrompt),
        Err(e) => Err(KeyError::Failed(format!(
            "the system's secret store refused: {e}"
        ))),
    }
}

#[cfg(target_os = "macos")]
fn needs_prompt(e: &keyring_core::Error) -> bool {
    use std::error::Error as _;
    let mut src = e.source();
    while let Some(s) = src {
        if let Some(sf) = s.downcast_ref::<security_framework::base::Error>() {
            return [INTERACTION_NOT_ALLOWED, AUTH_FAILED].contains(&sf.code());
        }
        src = s.source();
    }
    false
}

#[cfg(windows)]
fn needs_prompt(_: &keyring_core::Error) -> bool {
    false
}

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
        // A key already in the file stays there, so a store that appears later (secret-tool installed after init)
        // never hides it and leads to a new key.
        if dir.join("identity").exists()
            || std::env::var_os("POLYCARP_SYNC_KEY_STORE").is_some_and(|v| v == "file")
        {
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

    /// Reads the secret; a Mac may ask first.
    pub fn load(&self) -> Result<Option<SecretString>, String> {
        match self {
            #[cfg(any(target_os = "macos", windows))]
            Store::Native(_) => self.load_with(Ask::Prompt).map_err(String::from),
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

    /// Reads the secret. With [`Ask::Never`] a Mac turns off Keychain prompts for this process around the one read
    /// and turns them back on after it; if they can't be turned off, nothing is read. The other stores never ask.
    pub fn load_with(&self, ask: Ask) -> Result<Option<SecretString>, KeyError> {
        match self {
            #[cfg(target_os = "macos")]
            Store::Native(e) => {
                use security_framework::os::macos::keychain::SecKeychain;
                let _quiet = match ask {
                    Ask::Never => Some(SecKeychain::disable_user_interaction().map_err(|e| {
                        KeyError::Failed(format!("could not turn off Keychain prompts: {e}"))
                    })?),
                    Ask::Prompt => None,
                };
                native_result(e.get_password(), ask)
            }
            #[cfg(windows)]
            Store::Native(e) => native_result(e.get_password(), ask),
            _ => {
                let _ = ask;
                self.load().map_err(KeyError::Failed)
            }
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

    #[cfg(target_os = "macos")]
    #[test]
    fn a_keychain_that_would_ask_is_told_apart_from_other_failures() {
        use security_framework::base::Error as SfError;
        let platform = |code| {
            Err(keyring_core::Error::PlatformFailure(Box::new(
                SfError::from_code(code),
            )))
        };
        for code in [INTERACTION_NOT_ALLOWED, AUTH_FAILED] {
            assert_eq!(
                native_result(platform(code), Ask::Never).unwrap_err(),
                KeyError::NeedsPrompt
            );
            // Asked by hand, the same code (a Deny click) is a plain failure with the store's own words.
            assert!(matches!(
                native_result(platform(code), Ask::Prompt),
                Err(KeyError::Failed(_))
            ));
        }
        // errSecNoDefaultKeychain and the like stay plain failures, so the wait after failures still applies.
        assert!(matches!(
            native_result(platform(-25307), Ask::Never),
            Err(KeyError::Failed(_))
        ));
        // Any other error in the chain (not one from Security) is a failure too.
        assert!(matches!(
            native_result(
                Err(keyring_core::Error::PlatformFailure("other".into())),
                Ask::Never
            ),
            Err(KeyError::Failed(_))
        ));
        assert!(native_result(Err(keyring_core::Error::NoEntry), Ask::Never)
            .unwrap()
            .is_none());
        assert_eq!(
            native_result(Ok("AGE-SECRET-KEY-1X".into()), Ask::Never)
                .unwrap()
                .unwrap()
                .expose_secret(),
            "AGE-SECRET-KEY-1X"
        );
    }

    #[test]
    fn the_needs_prompt_text_names_the_fix() {
        let s = String::from(KeyError::NeedsPrompt);
        assert!(s.contains("`polycarp sync now`"));
        assert_eq!(String::from(KeyError::from("x".to_string())), "x");
    }

    #[test]
    fn a_file_store_never_asks_either_way() {
        let dir =
            std::env::temp_dir().join(format!("polycarp-sync-store-ask-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let s = Store::File(dir.join("identity"));
        assert_eq!(s.load_with(Ask::Never).unwrap().map(|_| ()), None);
        fs::write(dir.join("identity"), "AGE-SECRET-KEY-1F").unwrap();
        for ask in [Ask::Never, Ask::Prompt] {
            assert_eq!(
                s.load_with(ask).unwrap().unwrap().expose_secret(),
                "AGE-SECRET-KEY-1F"
            );
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_key_in_the_file_is_used_whatever_store_the_system_has() {
        let dir =
            std::env::temp_dir().join(format!("polycarp-sync-store-kept-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("identity"), "AGE-SECRET-KEY-1KEPT").unwrap();
        // Not the test hook: with the file there, open picks it before any system store.
        let (s, _) = Store::open(&dir).unwrap();
        assert!(matches!(s, Store::File(_)));
        assert_eq!(
            s.load().unwrap().unwrap().expose_secret(),
            "AGE-SECRET-KEY-1KEPT"
        );
        let _ = fs::remove_dir_all(&dir);
    }

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
