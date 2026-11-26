//! This device's identity and where it is kept: the macOS Keychain or the Windows Credential Manager.

use crate::seal::Key;
use crate::secret::Secret;
use iroh_base::{PublicKey, SecretKey};
use std::fmt;
use std::fs::{File, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Why the device's keys can't be had. It never repeats any of them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KeyError {
    /// The keychain said no, or can't be reached.
    Keychain(String),
    /// The key file can't be read or written.
    File(String),
    /// The key file can be read by other people on this computer.
    Open(PathBuf),
    /// Keys are there and are not the right shape.
    Damaged,
    /// There is no keychain here and no leave to keep the keys in a file.
    NoKeychain,
    /// There is a keychain here, so the file is not used.
    HasKeychain,
}

impl fmt::Display for KeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            KeyError::Keychain(why) => write!(f, "the keychain refused: {why}"),
            KeyError::File(why) => write!(f, "the key file can't be used: {why}"),
            KeyError::Open(p) => write!(f, "other people can read {}; run chmod 600 on it", p.display()),
            KeyError::Damaged => f.write_str("this device's keys are damaged"),
            KeyError::NoKeychain => f.write_str(
                "this computer has no keychain Polycarp can use; pass --allow-key-file to keep this device's keys in a \
                 file only you can read",
            ),
            KeyError::HasKeychain => f.write_str("this computer has a keychain, so --allow-key-file is refused"),
        }
    }
}

/// One place that holds one secret.
pub trait KeyStore: Send + Sync {
    fn load(&self) -> Result<Option<Secret>, KeyError>;
    fn save(&self, secret: &Secret) -> Result<(), KeyError>;
    fn delete(&self) -> Result<(), KeyError>;
    /// Held while keys are made, so two programs never both make them and one save over the other's. None where only
    /// one program can reach the store.
    fn lock(&self) -> Result<Option<File>, KeyError>;
}

/// An exclusive lock on `path`, held until the file is dropped.
fn hold(path: &Path) -> Result<File, KeyError> {
    let mut new = OpenOptions::new();
    new.create(true).truncate(false).write(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut new, 0o600);
    let file = new.open(path).map_err(|e| KeyError::File(e.to_string()))?;
    file.lock().map_err(|e| KeyError::File(e.to_string()))?;
    Ok(file)
}

const HAS_KEYCHAIN: bool = cfg!(any(target_os = "macos", windows));

/// The place for the keys of the sync state in `dir`. The file is for a system with no keychain, and only when asked for.
pub fn open(dir: &Path, allow_file: bool) -> Result<Box<dyn KeyStore>, KeyError> {
    match (HAS_KEYCHAIN, allow_file) {
        (true, true) => Err(KeyError::HasKeychain),
        (false, false) => Err(KeyError::NoKeychain),
        (false, true) => Ok(Box::new(KeyFile(dir.join("device.key")))),
        #[cfg(any(target_os = "macos", windows))]
        (true, false) => Ok(Box::new(Keychain::new(dir)?)),
        #[cfg(not(any(target_os = "macos", windows)))]
        (true, false) => Err(KeyError::NoKeychain),
    }
}

#[cfg(any(target_os = "macos", windows))]
pub struct Keychain {
    entry: keyring_core::Entry,
    lock: PathBuf,
}

#[cfg(any(target_os = "macos", windows))]
impl Keychain {
    pub const SERVICE: &str = "Polycarp Browser Sync";

    /// One entry for each state folder, named by it.
    pub fn new(dir: &Path) -> Result<Self, KeyError> {
        use keyring_core::api::CredentialStoreApi;
        #[cfg(target_os = "macos")]
        let store = apple_native_keyring_store::keychain::Store::new();
        #[cfg(windows)]
        let store = windows_native_keyring_store::Store::new();
        let entry = store.and_then(|s| s.build(Self::SERVICE, &dir.to_string_lossy(), None));
        let entry = entry.map_err(refused)?;
        let lock = dir.join("keys.lock");
        Ok(Keychain { entry, lock })
    }
}

/// The store's own words, without the bytes one of its errors carries.
#[cfg(any(target_os = "macos", windows))]
fn refused(e: keyring_core::Error) -> KeyError {
    match e {
        keyring_core::Error::BadEncoding(_) | keyring_core::Error::BadDataFormat(..) => {
            KeyError::Damaged
        }
        e => KeyError::Keychain(e.to_string()),
    }
}

#[cfg(any(target_os = "macos", windows))]
impl KeyStore for Keychain {
    fn load(&self) -> Result<Option<Secret>, KeyError> {
        match self.entry.get_secret() {
            Ok(bytes) => Ok(Some(Secret::new(bytes))),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(e) => Err(refused(e)),
        }
    }

    fn save(&self, secret: &Secret) -> Result<(), KeyError> {
        self.entry.set_secret(secret.expose()).map_err(refused)
    }

    fn delete(&self) -> Result<(), KeyError> {
        match self.entry.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(e) => Err(refused(e)),
        }
    }

    fn lock(&self) -> Result<Option<File>, KeyError> {
        hold(&self.lock).map(Some)
    }
}

/// A file only its owner can read, for a system with no keychain.
pub struct KeyFile(pub PathBuf);

impl KeyStore for KeyFile {
    fn load(&self) -> Result<Option<Secret>, KeyError> {
        let mut file = match File::open(&self.0) {
            Ok(f) => f,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(KeyError::File(e.to_string())),
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = file
                .metadata()
                .map_err(|e| KeyError::File(e.to_string()))?
                .permissions()
                .mode();
            if mode & 0o077 != 0 {
                return Err(KeyError::Open(self.0.clone()));
            }
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|e| KeyError::File(e.to_string()))?;
        Ok(Some(Secret::new(bytes)))
    }

    /// Never over an existing file: a device's identity does not change.
    fn save(&self, secret: &Secret) -> Result<(), KeyError> {
        let mut new = OpenOptions::new();
        new.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut new, 0o600);
        let written = new.open(&self.0).and_then(|mut f| {
            f.write_all(secret.expose())?;
            f.sync_all()
        });
        written.map_err(|e| KeyError::File(e.to_string()))
    }

    fn delete(&self) -> Result<(), KeyError> {
        match std::fs::remove_file(&self.0) {
            Err(e) if e.kind() != ErrorKind::NotFound => Err(KeyError::File(e.to_string())),
            _ => Ok(()),
        }
    }

    fn lock(&self) -> Result<Option<File>, KeyError> {
        hold(&self.0.with_extension("lock")).map(Some)
    }
}

/// In memory, for tests.
#[derive(Default)]
pub struct Memory(Mutex<Option<Secret>>);

impl KeyStore for Memory {
    fn load(&self) -> Result<Option<Secret>, KeyError> {
        Ok(self.0.lock().unwrap().clone())
    }

    fn save(&self, secret: &Secret) -> Result<(), KeyError> {
        *self.0.lock().unwrap() = Some(secret.clone());
        Ok(())
    }

    fn delete(&self) -> Result<(), KeyError> {
        *self.0.lock().unwrap() = None;
        Ok(())
    }

    fn lock(&self) -> Result<Option<File>, KeyError> {
        Ok(None)
    }
}

/// This device: an Ed25519 key that is its name on the network and in the member list, and the key its files are
/// sealed with. Both are made here and never leave.
#[derive(Clone)]
pub struct Identity {
    pub signing: SecretKey,
    pub storage: Key,
}

impl fmt::Debug for Identity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Identity({})", self.id().fmt_short())
    }
}

impl Identity {
    /// The identity in the store, or a new one saved there. Made under the store's lock, so a program that finds none
    /// while another is making one gets that one.
    pub fn load_or_create(store: &dyn KeyStore) -> Result<Identity, KeyError> {
        if let Some(found) = Self::load(store)? {
            return Ok(found);
        }
        let _held = store.lock()?;
        if let Some(found) = Self::load(store)? {
            return Ok(found);
        }
        let both = [crate::seal::random::<32>(), crate::seal::random::<32>()].concat();
        store.save(&Secret::new(both))?;
        Self::load(store)?.ok_or(KeyError::Damaged)
    }

    pub fn load(store: &dyn KeyStore) -> Result<Option<Identity>, KeyError> {
        let Some(both) = store.load()? else {
            return Ok(None);
        };
        let (signing, storage) = both
            .expose()
            .split_at_checked(32)
            .ok_or(KeyError::Damaged)?;
        let signing: &[u8; 32] = signing.try_into().map_err(|_| KeyError::Damaged)?;
        let storage = Key::from_bytes(storage).ok_or(KeyError::Damaged)?;
        Ok(Some(Identity {
            signing: SecretKey::from_bytes(signing),
            storage,
        }))
    }

    pub fn id(&self) -> PublicKey {
        self.signing.public()
    }

    pub fn bytes(&self) -> [u8; 32] {
        *self.id().as_bytes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_identity_is_made_once_and_kept() {
        let store = Memory::default();
        assert!(Identity::load(&store).unwrap().is_none());
        let a = Identity::load_or_create(&store).unwrap();
        let b = Identity::load_or_create(&store).unwrap();
        assert_eq!(a.id(), b.id());
        assert_eq!(a.storage.expose(), b.storage.expose());
        assert_ne!(a.signing.to_bytes(), *a.storage.expose());
        assert_eq!(
            format!("{a:?}"),
            format!("Identity({})", a.id().fmt_short())
        );
        assert_ne!(
            Identity::load_or_create(&Memory::default()).unwrap().id(),
            a.id()
        );
    }

    #[test]
    fn damaged_keys_are_refused_not_replaced() {
        for len in [0, 31, 33, 63, 65] {
            let store = Memory::default();
            store.save(&Secret::new(vec![7; len])).unwrap();
            assert_eq!(
                Identity::load_or_create(&store).unwrap_err(),
                KeyError::Damaged,
                "{len} bytes"
            );
        }
    }

    #[test]
    fn the_file_needs_leave_and_is_refused_where_there_is_a_keychain() {
        let dir = std::env::temp_dir();
        if HAS_KEYCHAIN {
            assert_eq!(open(&dir, true).err(), Some(KeyError::HasKeychain));
        } else {
            assert_eq!(open(&dir, false).err(), Some(KeyError::NoKeychain));
            assert!(open(&dir, true).is_ok());
        }
    }

    #[cfg(unix)]
    #[test]
    fn the_key_file_is_private_and_never_overwritten() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch();
        let file = KeyFile(dir.join("device.key"));
        let id = Identity::load_or_create(&file).unwrap().id();
        let mode =
            |m| std::fs::set_permissions(&file.0, std::fs::Permissions::from_mode(m)).unwrap();
        assert_eq!(
            std::fs::metadata(&file.0).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(matches!(
            file.save(&Secret::new(vec![0; 64])),
            Err(KeyError::File(_))
        ));
        assert_eq!(Identity::load(&file).unwrap().unwrap().id(), id);
        mode(0o640);
        assert_eq!(
            Identity::load(&file).unwrap_err(),
            KeyError::Open(file.0.clone())
        );
        mode(0o600);
        file.delete().unwrap();
        assert!(file.load().unwrap().is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn hex(b: &[u8]) -> String {
        b.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// The real keychain, on a throwaway CI machine only: a person's own is never touched by a test.
    #[cfg(any(target_os = "macos", windows))]
    #[test]
    fn the_keychain_keeps_and_forgets_an_identity_on_ci() {
        if std::env::var_os("GITHUB_ACTIONS").is_none() {
            return;
        }
        let dir = scratch();
        let chain = Keychain::new(&dir).unwrap();
        chain.delete().unwrap();
        assert!(Identity::load(&chain).unwrap().is_none());
        let id = Identity::load_or_create(&chain).unwrap().id();
        assert_eq!(Identity::load(&chain).unwrap().unwrap().id(), id);
        chain.delete().unwrap();
        assert!(Identity::load(&chain).unwrap().is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Saves over what is there, as a keychain does, and lets both makers look before either saves.
    struct Racing {
        keys: Memory,
        lock: PathBuf,
        looked: std::sync::Barrier,
        looks: std::sync::atomic::AtomicUsize,
        saves: std::sync::atomic::AtomicUsize,
    }

    impl Racing {
        fn new(dir: &Path) -> Racing {
            Racing {
                keys: Memory::default(),
                lock: dir.join("keys.lock"),
                looked: std::sync::Barrier::new(2),
                looks: Default::default(),
                saves: Default::default(),
            }
        }

        fn saves(&self) -> usize {
            self.saves.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    impl KeyStore for Racing {
        fn load(&self) -> Result<Option<Secret>, KeyError> {
            if self.looks.fetch_add(1, std::sync::atomic::Ordering::SeqCst) < 2 {
                self.looked.wait();
            }
            self.keys.load()
        }

        fn save(&self, secret: &Secret) -> Result<(), KeyError> {
            self.saves.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.keys.save(secret)
        }

        fn delete(&self) -> Result<(), KeyError> {
            self.keys.delete()
        }

        fn lock(&self) -> Result<Option<File>, KeyError> {
            hold(&self.lock).map(Some)
        }
    }

    #[test]
    fn two_that_find_no_identity_at_once_get_the_same_one() {
        let dir = scratch();
        let store = Racing::new(&dir);
        let make = || Identity::load_or_create(&store).unwrap().id();
        let (a, b) = std::thread::scope(|s| {
            let (a, b) = (s.spawn(make), s.spawn(make));
            (a.join().unwrap(), b.join().unwrap())
        });
        assert_eq!(a, b);
        assert_eq!(Identity::load(&store).unwrap().unwrap().id(), a);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// One program is making keys and holds the lock; another finds none meanwhile. It waits, saves nothing, and gets
    /// the keys the first one made.
    #[test]
    fn one_that_finds_no_identity_while_another_makes_it_waits_for_it() {
        let dir = scratch();
        let store = Racing::new(&dir);
        store.looks.store(1, std::sync::atomic::Ordering::SeqCst);
        let held = store.lock().unwrap();
        std::thread::scope(|s| {
            let other = s.spawn(|| Identity::load_or_create(&store).unwrap().id());
            store.looked.wait();
            std::thread::sleep(std::time::Duration::from_millis(200));
            assert!(!other.is_finished(), "it did not wait for the lock");
            assert_eq!(store.saves(), 0);
            let both = [crate::seal::random::<32>(), crate::seal::random::<32>()].concat();
            store.save(&Secret::new(both)).unwrap();
            let made = Identity::load(&store.keys).unwrap().unwrap().id();
            drop(held);
            assert_eq!(other.join().unwrap(), made);
        });
        assert_eq!(store.saves(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "polycarp-sync-{}",
            hex(&crate::seal::random::<8>())
        ));
        std::fs::create_dir(&dir).unwrap();
        dir
    }
}
