//! Vaults in memory, and a passkey to change their group with.

use super::Soft;
use polycarp_sync::group::{Action, Id};
use polycarp_sync::keys::{Identity, Memory};
use polycarp_sync::policy::Skip;
use polycarp_sync::record::Kind;
use polycarp_sync::seal::Key;
use polycarp_sync::store::Store;
use polycarp_sync::vault::{Vault, VaultError};

pub fn device() -> Identity {
    Identity::load_or_create(&Memory::default()).unwrap()
}

pub fn vault() -> Vault {
    let identity = device();
    let store = Store::memory(&identity.storage).unwrap();
    Vault::open(identity, store).unwrap()
}

/// A vault with a group of its own.
pub fn first(soft: &mut Soft, now: u64) -> Vault {
    let mut v = vault();
    v.create("Laptop", vec![soft.register("Pass manager")], now)
        .unwrap();
    v
}

pub fn allow(
    soft: &mut Soft,
    v: &mut Vault,
    action: Action,
    key: Option<Key>,
    now: u64,
) -> Result<(), VaultError> {
    let request = v.request(action, now)?;
    let proof = soft.sign(request.passkeys(), &request.challenge());
    v.allow(request, proof, key, now)
}

/// Adds `new` to the group of `v`, as pairing does.
pub fn add(soft: &mut Soft, v: &mut Vault, new: &mut Vault, name: &str, now: u64) {
    let (device, name) = (new.identity.bytes(), name.to_string());
    allow(soft, v, Action::AddDevice { device, name }, None, now).unwrap();
    new.join(v.group().unwrap().clone(), v.key().unwrap().clone())
        .unwrap();
}

pub fn remove(soft: &mut Soft, v: &mut Vault, device: Id, now: u64) -> Result<(), VaultError> {
    let new = Key::random();
    let key = new.commitment();
    allow(
        soft,
        v,
        Action::RemoveDevice { device, key },
        Some(new),
        now,
    )
}

pub fn page(n: u32) -> String {
    format!(r#"{{"url":"https://site.example/{n}","title":"Page {n}"}}"#)
}

pub fn visit(v: &mut Vault, n: u32, now: u64) -> Result<bool, Skip> {
    v.put(Kind::History, page(n).as_bytes(), now).unwrap()
}

/// A cookie with a year to live.
pub fn cookie(domain: &str, value: &str, now: u64) -> String {
    let expires = now / 1000 + 31_536_000;
    format!(
        r#"{{"domain":"{domain}","path":"/","name":"sid","value":"{value}","secure":true,"expires":{expires}}}"#
    )
}
