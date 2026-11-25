//! The only crypto here: RustCrypto's XChaCha20-Poly1305, HKDF-SHA256 and SHA-256, and the system's random numbers.

use crate::secret::Secret;
use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, ZeroizeOnDrop};

const NONCE: usize = 24;

pub fn random<const N: usize>() -> [u8; N] {
    let mut out = [0; N];
    // Without random numbers no key or nonce made here would be safe, so there is nothing to fall back to.
    getrandom::fill(&mut out).expect("the system gave no random numbers");
    out
}

/// SHA-256 over a label and parts, each with its length in front, so no two lists of parts run together.
pub fn hash(label: &str, parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for part in std::iter::once(label.as_bytes()).chain(parts.iter().copied()) {
        h.update((part.len() as u64).to_be_bytes());
        h.update(part);
    }
    h.finalize().into()
}

/// A 256-bit key.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct Key([u8; 32]);

impl std::fmt::Debug for Key {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Key(..)")
    }
}

/// It did not open: the wrong key, the wrong place, or changed on the way.
#[derive(Debug, PartialEq, Eq)]
pub struct Unopened;

impl Key {
    pub fn random() -> Key {
        Key(random())
    }

    pub fn from_bytes(bytes: &[u8]) -> Option<Key> {
        Some(Key(bytes.try_into().ok()?))
    }

    pub fn expose(&self) -> &[u8; 32] {
        &self.0
    }

    /// A key for one use, made from this one. Two labels or two contexts give unrelated keys.
    pub fn derive(&self, label: &str, context: &[u8]) -> Key {
        let mut out = Key([0; 32]);
        Hkdf::<Sha256>::new(Some(label.as_bytes()), &self.0)
            .expand(context, &mut out.0)
            .expect("32 bytes is in range");
        out
    }

    /// What the member list says about a group key, so a device given another one can tell.
    pub fn commitment(&self) -> [u8; 32] {
        *self.derive("polycarp-sync key commitment v1", b"").expose()
    }

    /// `place` says what the sealed bytes are and where they belong; they open only there.
    pub fn seal(&self, place: &[u8], plain: &[u8]) -> Vec<u8> {
        let nonce: [u8; NONCE] = random();
        let payload = Payload {
            msg: plain,
            aad: place,
        };
        let sealed = self
            .cipher()
            .encrypt(&XNonce::from(nonce), payload)
            .expect("the message is far below the limit");
        [&nonce[..], &sealed].concat()
    }

    pub fn open(&self, place: &[u8], sealed: &[u8]) -> Result<Secret, Unopened> {
        let (nonce, body) = sealed.split_at_checked(NONCE).ok_or(Unopened)?;
        let nonce: [u8; NONCE] = nonce.try_into().map_err(|_| Unopened)?;
        let payload = Payload {
            msg: body,
            aad: place,
        };
        self.cipher()
            .decrypt(&XNonce::from(nonce), payload)
            .map(Secret::new)
            .map_err(|_| Unopened)
    }

    fn cipher(&self) -> XChaCha20Poly1305 {
        XChaCha20Poly1305::new(&self.0.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sealed_bytes_open_only_with_their_key_in_their_place() {
        let (k, other) = (Key::random(), Key::random());
        let mut sealed = k.seal(b"here", b"plain");
        assert_eq!(k.open(b"here", &sealed).unwrap().expose(), b"plain");
        assert_eq!(other.open(b"here", &sealed), Err(Unopened));
        assert_eq!(k.open(b"there", &sealed), Err(Unopened));
        assert_ne!(sealed, k.seal(b"here", b"plain"), "a nonce was used twice");
        assert_eq!(k.open(b"here", &sealed[..10]), Err(Unopened));
        *sealed.last_mut().unwrap() ^= 1;
        assert_eq!(k.open(b"here", &sealed), Err(Unopened));
        assert!(!sealed.windows(5).any(|w| w == b"plain"));
    }

    #[test]
    fn labels_contexts_and_parts_keep_apart() {
        let k = Key::random();
        assert_ne!(k.derive("a", b"x").expose(), k.derive("b", b"x").expose());
        assert_ne!(k.derive("a", b"x").expose(), k.derive("a", b"y").expose());
        assert_ne!(hash("l", &[b"ab", b"c"]), hash("l", &[b"a", b"bc"]));
        assert_ne!(k.commitment(), Key::random().commitment());
        assert_eq!(format!("{k:?}"), "Key(..)");
    }
}
