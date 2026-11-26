//! `polycarp sync`: Polycarp's settings, and later the browser's, kept the same on each of your own devices, through
//! a relay you own that holds only ciphertext. Docs: docs/sync.md.
//!
//! Until the command lands, these parts are only reached from their tests.
#![allow(dead_code)]

pub mod model;
pub mod settings;
