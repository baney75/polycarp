//! `polycarp sync`: Polycarp's settings, and later the browser's, kept the same on each of your own devices, through
//! a relay you own that holds only ciphertext. Docs: docs/sync.md.
//!
//! This first part is the pure core: what an item is and how two copies merge. The settings, the command, the crypto
//! and the relay come next, so until then the core is only reached from its tests.
#![allow(dead_code)]

pub mod model;
