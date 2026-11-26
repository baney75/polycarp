//! Bytes that must not be seen: a cookie, a bookmark, a key.

use serde::de::{Deserialize, Deserializer, Error, Visitor};
use std::fmt;
use zeroize::{Zeroize, ZeroizeOnDrop};

/// Private bytes. `Debug` prints no content, there is no `Display` and no `Serialize`, and the memory is wiped on drop.
#[derive(Clone, Default, PartialEq, Eq, PartialOrd, Ord, Zeroize, ZeroizeOnDrop)]
pub struct Secret(Vec<u8>);

impl Secret {
    pub fn new(bytes: Vec<u8>) -> Self {
        Secret(bytes)
    }

    /// The bytes themselves. Every use is a place they can escape: never format, log or put them in an error.
    pub fn expose(&self) -> &[u8] {
        &self.0
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(..)")
    }
}

/// Reads a JSON string. The error never repeats what was there (serde's own "invalid type" message would).
impl<'de> Deserialize<'de> for Secret {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct Text;
        impl Visitor<'_> for Text {
            type Value = Secret;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("text")
            }
            fn visit_str<E: Error>(self, s: &str) -> Result<Secret, E> {
                Ok(Secret(s.as_bytes().to_vec()))
            }
            fn visit_string<E: Error>(self, s: String) -> Result<Secret, E> {
                Ok(Secret(s.into_bytes()))
            }
        }
        d.deserialize_string(Text)
            .map_err(|_| Error::custom("expected text"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_shows_nothing() {
        let s = Secret::new(b"planted".to_vec());
        assert_eq!(
            format!("{s:?} {:#?}", Some(&s)).matches("planted").count(),
            0
        );
    }

    #[test]
    fn a_wrong_type_is_not_repeated() {
        for bad in ["738291", "738.291", "true"] {
            let e = serde_json::from_str::<Secret>(bad).unwrap_err().to_string();
            assert!(e.starts_with("expected text") && !e.contains(bad), "{e}");
        }
    }
}
