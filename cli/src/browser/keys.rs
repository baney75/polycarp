//! The key a Chromium browser keeps in the login keychain, and the cipher made from it. Both stay in memory, and are wiped.

use std::ffi::c_void;
use std::sync::atomic::{compiler_fence, Ordering};

use super::import::Browser;

/// Bytes wiped when they are done with. No Debug: nothing can print them.
pub struct Secret(Vec<u8>);

impl Secret {
    pub fn new(bytes: Vec<u8>) -> Secret {
        Secret(bytes)
    }

    pub fn bytes(&self) -> &[u8] {
        &self.0
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        wipe(&mut self.0);
    }
}

fn wipe(bytes: &mut [u8]) {
    for byte in bytes {
        // SAFETY: a plain write to a byte this slice owns, one the compiler may not leave out.
        unsafe { std::ptr::write_volatile(byte, 0) };
    }
    compiler_fence(Ordering::SeqCst);
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Denied {
    /// There is no such item.
    Missing,
    /// The person said no, or the keychain is locked.
    Declined,
}

pub trait Keys {
    fn password(&self, service: &str, account: &str) -> Result<Secret, Denied>;
}

/// The name of a browser's item and its account. This browser's own is Helium's, compiled in.
pub fn item(browser: &Browser) -> (&'static str, &'static str) {
    match browser.word {
        "helium" => OURS,
        "chrome" => ("Chrome Safe Storage", "Chrome"),
        "brave" => ("Brave Safe Storage", "Brave"),
        "edge" => ("Microsoft Edge Safe Storage", "Microsoft Edge"),
        "vivaldi" => ("Vivaldi Safe Storage", "Vivaldi"),
        "arc" => ("Arc Safe Storage", "Arc"),
        _ => ("Chromium Safe Storage", "Chromium"),
    }
}

pub const OURS: (&str, &str) = ("Helium Storage Key", "Helium");

/// The login keychain. macOS asks the person before it answers.
pub struct Keychain;

type Status = i32;

#[link(name = "Security", kind = "framework")]
extern "C" {
    fn SecKeychainFindGenericPassword(
        keychain: *const c_void,
        service_length: u32,
        service: *const u8,
        account_length: u32,
        account: *const u8,
        length: *mut u32,
        data: *mut *mut c_void,
        item: *mut *mut c_void,
    ) -> Status;
    fn SecKeychainItemFreeContent(attributes: *mut c_void, data: *mut c_void) -> Status;
}

// CommonCrypto, part of the system library.
extern "C" {
    fn CCKeyDerivationPBKDF(
        algorithm: u32,
        password: *const u8,
        password_length: usize,
        salt: *const u8,
        salt_length: usize,
        random: u32,
        rounds: u32,
        key: *mut u8,
        key_length: usize,
    ) -> Status;
    fn CCCrypt(
        operation: u32,
        algorithm: u32,
        options: u32,
        key: *const u8,
        key_length: usize,
        iv: *const u8,
        from: *const u8,
        from_length: usize,
        to: *mut u8,
        to_length: usize,
        moved: *mut usize,
    ) -> Status;
}

impl Keys for Keychain {
    fn password(&self, service: &str, account: &str) -> Result<Secret, Denied> {
        const NOT_FOUND: Status = -25300;
        let (mut length, mut data) = (0u32, std::ptr::null_mut());
        // SAFETY: both names are read for the lengths given, and the two results are written to our own variables. A null
        // keychain is the person's usual ones; the item itself isn't asked for.
        let status = unsafe {
            SecKeychainFindGenericPassword(
                std::ptr::null(),
                service.len() as u32,
                service.as_ptr(),
                account.len() as u32,
                account.as_ptr(),
                &mut length,
                &mut data,
                std::ptr::null_mut(),
            )
        };
        match status {
            0 if !data.is_null() => {}
            NOT_FOUND => return Err(Denied::Missing),
            _ => return Err(Denied::Declined),
        }
        // SAFETY: on success `data` is `length` bytes of ours until it is freed, once, here.
        unsafe {
            let bytes = std::slice::from_raw_parts_mut(data.cast::<u8>(), length as usize);
            let secret = Secret(bytes.to_vec());
            wipe(bytes);
            SecKeychainItemFreeContent(std::ptr::null_mut(), data);
            Ok(secret)
        }
    }
}

/// Chromium's cookie cipher on a Mac: AES-128-CBC under a key made from the keychain's password.
pub struct Cipher(Secret);

const VERSION: &[u8] = b"v10";
const KEY: usize = 16;
const PADDED: u32 = 1;

impl Cipher {
    pub fn new(password: &Secret) -> Option<Cipher> {
        let (pbkdf2, hmac_sha1, rounds) = (2, 1, 1003);
        let salt = b"saltysalt";
        let mut key = Secret(vec![0; KEY]);
        // SAFETY: each pointer is good for the length beside it.
        let status = unsafe {
            CCKeyDerivationPBKDF(
                pbkdf2,
                password.0.as_ptr(),
                password.0.len(),
                salt.as_ptr(),
                salt.len(),
                hmac_sha1,
                rounds,
                key.0.as_mut_ptr(),
                KEY,
            )
        };
        (status == 0).then_some(Cipher(key))
    }

    /// None where it isn't this key's, or isn't sealed in a way known here.
    pub fn open(&self, sealed: &[u8]) -> Option<Secret> {
        let sealed = sealed.strip_prefix(VERSION)?;
        if sealed.is_empty() || sealed.len() % KEY != 0 {
            return None;
        }
        // The padding is taken off here: the system's own removal takes any for good, and so would open with a wrong key.
        let mut plain = self.crypt(1, 0, sealed)?;
        let pad = usize::from(*plain.0.last()?);
        let whole = plain.0.len().checked_sub(pad)?;
        let good =
            (1..=KEY).contains(&pad) && plain.0[whole..].iter().all(|b| usize::from(*b) == pad);
        wipe(&mut plain.0[whole..]);
        plain.0.truncate(whole);
        good.then_some(plain)
    }

    pub fn seal(&self, plain: &Secret) -> Option<Vec<u8>> {
        let sealed = self.crypt(0, PADDED, &plain.0)?;
        Some([VERSION, &sealed.0].concat())
    }

    fn crypt(&self, operation: u32, options: u32, from: &[u8]) -> Option<Secret> {
        let (aes, iv) = (0, [b' '; KEY]);
        // One block more than went in is the most that comes out.
        let mut to = Secret(vec![0; from.len() + KEY]);
        let mut moved = 0;
        // SAFETY: each pointer is good for the length beside it, and the cipher writes no more than `to` holds.
        let status = unsafe {
            CCCrypt(
                operation,
                aes,
                options,
                self.0 .0.as_ptr(),
                KEY,
                iv.as_ptr(),
                from.as_ptr(),
                from.len(),
                to.0.as_mut_ptr(),
                to.0.len(),
                &mut moved,
            )
        };
        to.0.truncate(moved);
        (status == 0).then_some(to)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Made with openssl: the hash of a host, then a value.
    const SEALED: &str = "4e7fb5bed648239bc80f52cc6db0c6a937c1009a3029020d09fc96f55b52702f\
                          d260f57c66478872d3c32c7f3b936dac";

    fn sealed() -> Vec<u8> {
        let byte = |i| u8::from_str_radix(&SEALED[i..i + 2], 16).unwrap();
        let bytes = (0..SEALED.len()).step_by(2).map(byte);
        VERSION.iter().copied().chain(bytes).collect()
    }

    fn cipher(password: &str) -> Cipher {
        Cipher::new(&Secret::new(password.into())).unwrap()
    }

    #[test]
    fn it_opens_and_seals_what_openssl_does() {
        let cipher = cipher("made up password");
        let plain = cipher.open(&sealed()).unwrap();
        assert_eq!(&plain.bytes()[32..], b"made up value");
        assert!(cipher.seal(&plain).unwrap() == sealed());
    }

    #[test]
    fn another_key_or_another_kind_of_seal_opens_nothing() {
        // About one wrong key in 256 leaves good padding; the host in front of a cookie is for those.
        for n in 0..20 {
            let other = cipher(&format!("another password {n}")).open(&sealed());
            assert!(other.is_none(), "{n}");
        }
        let ours = cipher("made up password");
        let mut kind = sealed();
        kind[2] = b'1';
        assert!(ours.open(&kind).is_none());
        assert!(ours.open(b"").is_none());
        assert!(ours.open(&sealed()[..20]).is_none());
    }

    #[test]
    fn a_secret_is_wiped() {
        let mut bytes = b"made up".to_vec();
        wipe(&mut bytes);
        assert_eq!(bytes, [0; 7]);
    }

    #[test]
    fn each_browser_has_its_own_item() {
        let items: Vec<_> = super::super::import::BROWSERS.iter().map(item).collect();
        let mut different = items.clone();
        different.sort();
        different.dedup();
        assert_eq!(different.len(), items.len());
        assert_eq!(items[0], OURS);
        assert_eq!(items[1].0, "Chrome Safe Storage");
    }
}
