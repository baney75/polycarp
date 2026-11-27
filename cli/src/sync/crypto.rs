//! Who may read and write sync bundles, and how a bundle is sealed.
//!
//! Each device makes one secret, an age X25519 identity, and keeps it. Its signing key (Ed25519) is derived from that
//! secret, so there is still only one secret to keep. The device list says which devices take part; it is signed by
//! a device already on the list the reader trusts, and its version only goes up. A bundle on the relay is encrypted
//! with age to every listed device and signed by the device that wrote it, over its kind, the list version and the
//! ciphertext. A device removed from the list can't open a bundle made after it, and a bundle changed on the relay is
//! refused with its kind named.

use age::secrecy::ExposeSecret;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};

/// This device's secret, and what it derives.
pub struct Me {
    age: age::x25519::Identity,
    sign: SigningKey,
}

impl Me {
    pub fn generate() -> Me {
        Me::from_age(age::x25519::Identity::generate())
    }
    /// From the stored secret (`AGE-SECRET-KEY-1...`).
    pub fn from_secret(s: &str) -> Result<Me, String> {
        s.trim()
            .parse::<age::x25519::Identity>()
            .map(Me::from_age)
            .map_err(|_| "the stored sync key is not an age identity".to_string())
    }
    fn from_age(age: age::x25519::Identity) -> Me {
        let sign = signing_key(age.to_string().expose_secret().as_bytes());
        Me { age, sign }
    }
    /// The secret to store. Never print it.
    pub fn secret(&self) -> age::secrecy::SecretString {
        self.age.to_string()
    }
    /// This device's public record.
    pub fn device(&self, name: &str) -> Device {
        let recipient = self.age.to_public().to_string();
        let verify = B64.encode(self.sign.verifying_key().to_bytes());
        Device {
            id: id_of(&recipient, &verify),
            name: name.to_string(),
            recipient,
            verify,
        }
    }
    fn sign(&self, msg: &[u8]) -> String {
        B64.encode(self.sign.sign(msg).to_bytes())
    }
}

/// HKDF-SHA256's salt and info for the signing key. Fixed for good: every enrolled device's verifying key, and so its
/// id and fingerprint, comes from them. A new derivation gets a new info string (v2) and a way to move devices over.
const SIGN_SALT: &[u8] = b"polycarp-sync";
const SIGN_INFO: &[u8] = b"ed25519 signing key v1";

/// The Ed25519 signing key derived from a device's age secret, so each device keeps one secret.
fn signing_key(secret: &[u8]) -> SigningKey {
    let hk = hkdf::Hkdf::<Sha256>::new(Some(SIGN_SALT), secret);
    let mut seed = [0u8; 32];
    hk.expand(SIGN_INFO, &mut seed)
        .expect("32 bytes is a valid HKDF length");
    let sign = SigningKey::from_bytes(&seed);
    seed.fill(0);
    sign
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Device {
    /// Derived from both public keys, so a record can't claim another device's id.
    pub id: String,
    pub name: String,
    /// The age recipient, `age1...`.
    pub recipient: String,
    /// The Ed25519 verifying key, base64.
    pub verify: String,
}

fn digest(recipient: &str, verify: &str) -> [u8; 32] {
    Sha256::digest(format!("polycarp-sync device v1\n{recipient}\n{verify}\n").as_bytes()).into()
}

fn id_of(recipient: &str, verify: &str) -> String {
    digest(recipient, verify)[..8]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

impl Device {
    /// What a person reads on both screens: 24 hex digits in groups of four.
    pub fn fingerprint(&self) -> String {
        let hex: String = digest(&self.recipient, &self.verify)[..12]
            .iter()
            .map(|b| format!("{b:02X}"))
            .collect();
        hex.as_bytes()
            .chunks(4)
            .map(|c| std::str::from_utf8(c).unwrap())
            .collect::<Vec<_>>()
            .join("-")
    }
    /// The record's id matches its keys, and both keys parse.
    pub fn check(&self) -> Result<(), String> {
        if self.id != id_of(&self.recipient, &self.verify) {
            return Err(format!(
                "device {} has an id that doesn't match its keys",
                self.name
            ));
        }
        self.recipient
            .parse::<age::x25519::Recipient>()
            .map_err(|_| format!("device {} has no valid age key", self.name))?;
        self.verifier().map(|_| ())
    }
    fn verifier(&self) -> Result<VerifyingKey, String> {
        let b: [u8; 32] = B64
            .decode(&self.verify)
            .ok()
            .and_then(|v| v.try_into().ok())
            .ok_or_else(|| format!("device {} has no valid signing key", self.name))?;
        VerifyingKey::from_bytes(&b)
            .map_err(|_| format!("device {} has no valid signing key", self.name))
    }
    fn verifies(&self, msg: &[u8], sig: &str) -> bool {
        let Ok(key) = self.verifier() else {
            return false;
        };
        let Some(sig) = B64
            .decode(sig)
            .ok()
            .and_then(|b| Signature::from_slice(&b).ok())
        else {
            return false;
        };
        key.verify_strict(msg, &sig).is_ok()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DeviceList {
    pub version: u64,
    pub devices: Vec<Device>,
    /// The id of the device that signed it.
    pub signer: String,
    pub sig: String,
}

fn list_message(version: u64, devices: &[Device]) -> Vec<u8> {
    let body = serde_json::to_string(devices).expect("devices serialize");
    format!("polycarp-sync devices v1\n{version}\n{body}").into_bytes()
}

impl DeviceList {
    pub fn signed(me: &Me, my_name: &str, version: u64, devices: Vec<Device>) -> DeviceList {
        DeviceList {
            version,
            signer: me.device(my_name).id,
            sig: me.sign(&list_message(version, &devices)),
            devices,
        }
    }
    pub fn get(&self, id: &str) -> Option<&Device> {
        self.devices.iter().find(|d| d.id == id)
    }
    /// Whether to take `self` in place of `trusted`, the list this device holds: it must be newer and signed by a
    /// device on the trusted list. Every record must match its keys.
    pub fn accept(&self, trusted: &DeviceList, me_id: &str) -> Result<(), String> {
        self.accept_from(Some(trusted), me_id, None)
    }

    /// A device just approved takes its first list only when the device that signed it has the fingerprint the
    /// person read on the approving device's screen, and the list holds this device. Anyone can make a key and sign
    /// a list naming this device, the relay included, so the fingerprint is what makes it the person's own device.
    pub fn accept_first(&self, me_id: &str, approver: &str) -> Result<(), String> {
        self.accept_from(None, me_id, Some(approver))
    }

    fn accept_from(
        &self,
        trusted: Option<&DeviceList>,
        me_id: &str,
        approver: Option<&str>,
    ) -> Result<(), String> {
        for d in &self.devices {
            d.check()?;
        }
        let signers = trusted.unwrap_or(self);
        let signer = signers
            .get(&self.signer)
            .ok_or("the device list on the relay is signed by a device this one doesn't trust")?;
        if let Some(fp) = approver {
            let norm = |s: &str| s.to_ascii_uppercase().replace(['-', ' '], "");
            if norm(&signer.fingerprint()) != norm(fp) {
                return Err(format!(
                    "the device list on the relay was signed by {} with fingerprint {}, not the {fp} you read on the \
                     approving device, so it was refused",
                    signer.name,
                    signer.fingerprint()
                ));
            }
        }
        if !signer.verifies(&list_message(self.version, &self.devices), &self.sig) {
            return Err(
                "the device list on the relay has a bad signature, so it was refused".into(),
            );
        }
        match trusted {
            Some(t) if self.version < t.version => Err(
                "the device list on the relay is older than this device's, so it was refused"
                    .into(),
            ),
            Some(t) if self.version == t.version && self.devices != t.devices => Err(
                "the device list on the relay differs from this device's at the same version"
                    .into(),
            ),
            None if self.get(me_id).is_none() => {
                Err("this device is not on the device list yet".into())
            }
            _ => Ok(()),
        }
    }
}

/// A bundle as the relay holds it.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Sealed {
    pub kind: String,
    pub list_version: u64,
    pub signer: String,
    /// The age ciphertext, base64.
    pub ct: String,
    pub sig: String,
}

fn sealed_message(kind: &str, list_version: u64, signer: &str, ct: &[u8]) -> Vec<u8> {
    let h: String = Sha256::digest(ct)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    format!("polycarp-sync bundle v1\n{kind}\n{list_version}\n{signer}\n{h}").into_bytes()
}

/// Encrypts `plain` to every device on `list` and signs it as `me`.
pub fn seal(
    me: &Me,
    my_id: &str,
    list: &DeviceList,
    kind: &str,
    plain: &[u8],
) -> Result<Sealed, String> {
    let recipients: Vec<age::x25519::Recipient> = list
        .devices
        .iter()
        .map(|d| {
            d.recipient
                .parse()
                .map_err(|_| format!("device {} has no valid age key", d.name))
        })
        .collect::<Result<_, _>>()?;
    let enc = age::Encryptor::with_recipients(recipients.iter().map(|r| r as &dyn age::Recipient))
        .map_err(|e| format!("could not encrypt the {kind} bundle: {e}"))?;
    let mut ct = Vec::new();
    let mut w = enc
        .wrap_output(&mut ct)
        .map_err(|e| format!("could not encrypt the {kind} bundle: {e}"))?;
    w.write_all(plain)
        .and_then(|_| w.finish().map(|_| ()))
        .map_err(|e| format!("could not encrypt the {kind} bundle: {e}"))?;
    Ok(Sealed {
        kind: kind.to_string(),
        list_version: list.version,
        signer: my_id.to_string(),
        sig: me.sign(&sealed_message(kind, list.version, my_id, &ct)),
        ct: B64.encode(ct),
    })
}

/// Checks and opens a bundle of `kind`. Any failure names the kind, and nothing of the bundle is returned.
pub fn open(me: &Me, list: &DeviceList, kind: &str, s: &Sealed) -> Result<Vec<u8>, String> {
    let refuse = |why: &str| {
        format!("the {kind} bundle on the relay was refused: {why}; nothing of it was applied")
    };
    if s.kind != kind {
        return Err(refuse("it is labeled as another kind"));
    }
    let signer = list
        .get(&s.signer)
        .ok_or_else(|| refuse("it was written by a device not on the device list"))?;
    let ct = B64
        .decode(&s.ct)
        .map_err(|_| refuse("it is not readable"))?;
    if !signer.verifies(
        &sealed_message(kind, s.list_version, &s.signer, &ct),
        &s.sig,
    ) {
        return Err(refuse(
            "its signature does not match, so it was changed after it was written",
        ));
    }
    let dec = age::Decryptor::new(&ct[..]).map_err(|_| refuse("it is not readable"))?;
    let mut r = dec
        .decrypt(std::iter::once(&me.age as &dyn age::Identity))
        .map_err(|_| {
            refuse("this device can't open it (it may have been removed from the list)")
        })?;
    let mut plain = Vec::new();
    r.read_to_end(&mut plain)
        .map_err(|_| refuse("it is damaged"))?;
    Ok(plain)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list_of(signer: &Me, version: u64, devs: &[(&Me, &str)]) -> DeviceList {
        DeviceList::signed(
            signer,
            devs[0].1,
            version,
            devs.iter().map(|(m, n)| m.device(n)).collect(),
        )
    }

    #[test]
    fn the_secret_round_trips_and_derives_the_same_device() {
        let a = Me::generate();
        let again = Me::from_secret(a.secret().expose_secret()).unwrap();
        assert_eq!(a.device("mac"), again.device("mac"));
        assert!(Me::from_secret("not a key").is_err());
        let fp = a.device("mac").fingerprint();
        assert_eq!(fp.len(), 29);
        assert_eq!(fp.matches('-').count(), 5);
    }

    #[test]
    fn every_listed_device_opens_a_bundle_and_a_removed_one_cannot() {
        let (a, b, c) = (Me::generate(), Me::generate(), Me::generate());
        let ida = a.device("a").id;
        let v1 = list_of(&a, 1, &[(&a, "a"), (&b, "b"), (&c, "c")]);
        let s = seal(&a, &ida, &v1, "settings", b"{}").unwrap();
        for m in [&a, &b, &c] {
            assert_eq!(open(m, &v1, "settings", &s).unwrap(), b"{}");
        }
        let v2 = list_of(&a, 2, &[(&a, "a"), (&b, "b")]);
        let after = seal(&a, &ida, &v2, "settings", b"{\"x\":1}").unwrap();
        assert!(open(&b, &v2, "settings", &after).is_ok());
        let err = open(&c, &v2, "settings", &after).unwrap_err();
        assert!(err.contains("can't open it"), "{err}");
    }

    #[test]
    fn a_bundle_changed_on_the_relay_is_refused_with_its_kind() {
        let (a, b) = (Me::generate(), Me::generate());
        let ida = a.device("a").id;
        let list = list_of(&a, 1, &[(&a, "a"), (&b, "b")]);
        let good = seal(&a, &ida, &list, "settings", b"{}").unwrap();
        let mut flipped = good.clone();
        let mut ct = B64.decode(&flipped.ct).unwrap();
        let n = ct.len() - 1;
        ct[n] ^= 1;
        flipped.ct = B64.encode(ct);
        // The relay knows every public key, so it can encrypt a bundle of its own; the signature still stops it.
        let forged = Sealed {
            sig: good.sig.clone(),
            ..seal(&b, &ida, &list, "settings", b"{\"evil\":1}").unwrap()
        };
        let relabeled = Sealed {
            kind: "cookies".into(),
            ..good.clone()
        };
        let stranger = Me::generate();
        let outsider = seal(
            &stranger,
            &stranger.device("s").id,
            &list,
            "settings",
            b"{}",
        )
        .unwrap();
        for (bad, kind) in [
            (&flipped, "settings"),
            (&forged, "settings"),
            (&outsider, "settings"),
            (&relabeled, "settings"),
        ] {
            let err = open(&b, &list, kind, bad).unwrap_err();
            assert!(
                err.starts_with("the settings bundle on the relay was refused"),
                "{err}"
            );
        }
        let err = open(&b, &list, "cookies", &good).unwrap_err();
        assert!(err.starts_with("the cookies bundle"), "{err}");
    }

    #[test]
    fn the_device_list_moves_only_forward_and_only_by_a_trusted_device() {
        let (a, b, stranger) = (Me::generate(), Me::generate(), Me::generate());
        let idb = b.device("b").id;
        let v1 = list_of(&a, 1, &[(&a, "a"), (&b, "b")]);
        let fpa = a.device("a").fingerprint();
        assert!(
            v1.accept_first(&idb, &fpa).is_ok(),
            "a device just approved takes its first list"
        );
        assert!(v1
            .accept_first(&idb, &fpa.to_lowercase().replace('-', " "))
            .is_ok());
        assert!(
            v1.accept_first(&stranger.device("s").id, &fpa).is_err(),
            "not if it isn't on it"
        );
        // The relay makes a key, names the new device and signs: refused, the fingerprint is not the approver's.
        let relay = list_of(&stranger, 1, &[(&stranger, "a"), (&b, "b")]);
        let err = relay.accept_first(&idb, &fpa).unwrap_err();
        assert!(err.contains("not the"), "{err}");
        let v2 = list_of(&a, 2, &[(&a, "a")]);
        assert!(v2.accept(&v1, &idb).is_ok());
        assert!(v1.accept(&v2, &idb).is_err(), "an older list is refused");
        let rogue = list_of(&stranger, 3, &[(&stranger, "s"), (&a, "a")]);
        assert!(
            rogue.accept(&v2, &idb).is_err(),
            "signed by a device not trusted"
        );
        let mut tampered = v2.clone();
        tampered.devices.push(stranger.device("s"));
        assert!(
            tampered.accept(&v1, &idb).is_err(),
            "a device added after signing"
        );
        let mut fake = stranger.device("s");
        fake.id = idb.clone();
        let spoof = DeviceList::signed(&a, "a", 3, vec![a.device("a"), fake]);
        assert!(
            spoof.accept(&v2, &idb).is_err(),
            "a record whose id isn't its keys'"
        );
    }

    /// The derivation is fixed for good, since enrolled devices' ids come from it. The vector was checked outside this
    /// code: RFC 5869 HKDF-SHA256 by hand with Python's hmac, and the Ed25519 public key from `cryptography`.
    #[test]
    fn the_signing_key_derivation_matches_its_test_vector() {
        assert_eq!(SIGN_SALT, b"polycarp-sync");
        assert_eq!(SIGN_INFO, b"ed25519 signing key v1");
        let k = signing_key(b"polycarp-sync test vector input");
        assert_eq!(
            k.to_bytes()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>(),
            "ab85ddd577fa18db100bdb2c81d90bffa15d9a642a1f105067f94b9a29b2306b"
        );
        assert_eq!(
            B64.encode(k.verifying_key().to_bytes()),
            "oLpP/A0Gpx2rsN+Jkd8Ei85ovZQIulkOB3NE536nRBw="
        );
    }
}
