//! A software passkey for the tests.
#![allow(dead_code)]

pub mod chrome;
pub mod http;
pub mod vaults;

use polycarp_sync::passkey::{self, Passkey, Proof};
use serde_json::{json, Value};
use url::Url;
use webauthn_authenticator_rs::{softpasskey::SoftPasskey, AuthenticatorBackend};
use webauthn_rs_core::proto::{
    PublicKeyCredentialCreationOptions, PublicKeyCredentialRequestOptions,
};

pub const PAGE: &str = "http://localhost:4711";

pub struct Soft(SoftPasskey);

/// How an answer may differ from an honest one.
pub struct Ask<'a> {
    pub origin: &'a str,
    pub verified: bool,
}

impl Default for Ask<'_> {
    fn default() -> Self {
        Ask {
            origin: PAGE,
            verified: true,
        }
    }
}

impl Soft {
    pub fn new() -> Soft {
        Soft(SoftPasskey::new(true))
    }

    pub fn register(&mut self, label: &str) -> Passkey {
        let (options, state) = passkey::begin(&[]).unwrap();
        let answer = self.answer_registration(options, PAGE);
        passkey::finish(label, answer, &state).unwrap()
    }

    pub fn answer_registration(&mut self, options: Value, origin: &str) -> Value {
        let options: PublicKeyCredentialCreationOptions = serde_json::from_value(options).unwrap();
        let answer = self
            .0
            .perform_register(Url::parse(origin).unwrap(), options, 1000)
            .unwrap();
        serde_json::to_value(answer).unwrap()
    }

    pub fn sign(&mut self, passkeys: &[Passkey], challenge: &[u8; 32]) -> Proof {
        self.sign_as(passkeys, challenge, Ask::default())
    }

    pub fn sign_as(&mut self, passkeys: &[Passkey], challenge: &[u8; 32], ask: Ask) -> Proof {
        Proof::from_json(self.answer(passkey::request(passkeys, challenge, None).unwrap(), ask))
            .unwrap()
    }

    pub fn answer(&mut self, mut options: Value, ask: Ask) -> Value {
        if !ask.verified {
            options["userVerification"] = json!("discouraged");
        }
        let options: PublicKeyCredentialRequestOptions = serde_json::from_value(options).unwrap();
        let answer = self
            .0
            .perform_auth(Url::parse(ask.origin).unwrap(), options, 1000)
            .unwrap();
        serde_json::to_value(answer).unwrap()
    }
}
