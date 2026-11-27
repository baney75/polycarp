//! `polycarp sync`: Polycarp's settings kept the same on each of your own devices, through a relay you own that
//! holds only ciphertext. Docs: docs/sync.md.

pub mod auto;
pub mod cmd;
pub mod crypto;
pub mod model;
pub mod prefs;
pub mod relay;
pub mod settings;
pub mod store;
