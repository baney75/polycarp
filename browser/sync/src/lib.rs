//! Sync between one person's own devices. The design and what it protects are in `browser/docs/sync.md`.

pub mod group;
pub mod hlc;
pub mod keys;
pub mod passkey;
pub mod policy;
pub mod record;
pub mod seal;
pub mod secret;

#[cfg(test)]
extern crate self as polycarp_sync;
#[cfg(test)]
#[path = "../tests/support/mod.rs"]
mod support;
