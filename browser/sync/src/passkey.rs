//! Passkeys: registering one, and checking what one signed. webauthn-rs does the WebAuthn rules; this says which apply.

use crate::seal::random;
use data_encoding::BASE64URL_NOPAD;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use url::Url;
use webauthn_rs_core::proto::{
    AuthenticationExtensionsClientOutputs, AuthenticatorAssertionResponseRaw, COSEAlgorithm,
    PublicKeyCredential, RegisterPublicKeyCredential, UserVerificationPolicy,
};
use webauthn_rs_core::proto::{AuthenticationState, Credential, RegistrationState};
use webauthn_rs_core::{error::WebauthnError, WebauthnCore};

/// The relying party. `browser/docs/sync.md` weighs it against the extension's own origin and a real domain.
pub const RP_ID: &str = "localhost";
/// How long a passkey request stands.
pub const EXPIRES_MS: u64 = 5 * 60 * 1000;

/// Why a passkey's answer was not accepted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refused {
    /// It signed some other request, or an old one.
    Challenge,
    /// It was signed on some other page.
    Origin,
    /// The person was not verified: no PIN, fingerprint or face.
    NotVerified,
    /// The passkey's counter did not go up, so a copy of it may exist.
    Counter,
    /// The passkey is not one of the group's.
    Unknown,
    /// The signature is wrong.
    Signature,
    /// Not a passkey answer, or not one this group can use.
    Malformed,
}

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Refused::Challenge => "the passkey answered a different request",
            Refused::Origin => "the passkey was used on a different page",
            Refused::NotVerified => {
                "the passkey did not check who you are (PIN, fingerprint or face)"
            }
            Refused::Counter => "the passkey's counter went backwards, so a copy of it may exist",
            Refused::Unknown => "that passkey is not one of this group's",
            Refused::Signature => "the passkey's signature is wrong",
            Refused::Malformed => "that is not an answer from a passkey",
        })
    }
}

impl From<WebauthnError> for Refused {
    fn from(e: WebauthnError) -> Self {
        match e {
            WebauthnError::MismatchedChallenge => Refused::Challenge,
            WebauthnError::InvalidRPOrigin | WebauthnError::InvalidRPIDHash => Refused::Origin,
            WebauthnError::CredentialCrossOrigin => Refused::Origin,
            WebauthnError::UserNotVerified | WebauthnError::UserNotPresent => Refused::NotVerified,
            WebauthnError::CredentialPossibleCompromise => Refused::Counter,
            WebauthnError::CredentialNotFound => Refused::Unknown,
            WebauthnError::AuthenticationFailure => Refused::Signature,
            _ => Refused::Malformed,
        }
    }
}

/// A passkey the group trusts: its public half, as webauthn-rs keeps it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Passkey {
    pub label: String,
    credential: String,
}

impl Passkey {
    fn credential(&self) -> Result<Credential, Refused> {
        serde_json::from_str(&self.credential).map_err(|_| Refused::Malformed)
    }

    pub fn id(&self) -> Result<Vec<u8>, Refused> {
        Ok(self.credential()?.cred_id)
    }

    pub fn counter(&self) -> Result<u32, Refused> {
        Ok(self.credential()?.counter)
    }

    /// Only a passkey registered with the person verified counts, whoever wrote it into a list.
    pub fn usable(&self) -> Result<(), Refused> {
        let c = self.credential()?;
        let strict = c.user_verified && c.registration_policy == UserVerificationPolicy::Required;
        if strict {
            Ok(())
        } else {
            Err(Refused::NotVerified)
        }
    }
}

/// What a passkey signed, kept with the change it allowed so every device can check it for itself.
/// Extension outputs are left out on purpose: a PRF output is a key.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Proof {
    pub credential: Vec<u8>,
    pub authenticator_data: Vec<u8>,
    pub client_data: Vec<u8>,
    pub signature: Vec<u8>,
}

impl Proof {
    /// From the JSON of `PublicKeyCredential.toJSON()`.
    pub fn from_json(json: Value) -> Result<Proof, Refused> {
        let c: PublicKeyCredential =
            serde_json::from_value(json).map_err(|_| Refused::Malformed)?;
        Ok(Proof {
            credential: c.raw_id,
            authenticator_data: c.response.authenticator_data,
            client_data: c.response.client_data_json,
            signature: c.response.signature,
        })
    }
}

/// Any port: each request has its own, and a proof is checked again later by devices that never saw it.
/// The page that takes an answer checks its exact origin too (`ceremony`).
fn rp() -> WebauthnCore {
    let origin = Url::parse("http://localhost").expect("a fixed address");
    WebauthnCore::new_unsafe_experts_only(
        "Polycarp Sync",
        RP_ID,
        vec![origin],
        Duration::from_millis(EXPIRES_MS),
        Some(false),
        Some(true),
    )
}

/// Checks one answer against one request. `counter_of` gives the highest counter seen from a passkey.
/// Returns the passkey's id and its new counter.
pub fn verify(
    passkeys: &[Passkey],
    counter_of: impl Fn(&[u8]) -> u32,
    challenge: &[u8; 32],
    proof: &Proof,
) -> Result<(Vec<u8>, u32), Refused> {
    let mut credential = None;
    for p in passkeys {
        let mut c = p.credential()?;
        if c.cred_id == proof.credential {
            p.usable()?;
            c.counter = c.counter.max(counter_of(&c.cred_id));
            credential = Some(c);
        }
    }
    let credential = credential.ok_or(Refused::Unknown)?;
    same_origin(&proof.client_data)?;
    // webauthn-rs draws challenges at random; this one names what is being allowed. Its state is made to be stored and
    // read back, which is how the challenge goes in.
    let state: AuthenticationState = serde_json::from_value(json!({
        "credentials": [],
        "policy": UserVerificationPolicy::Required,
        "challenge": base64(challenge),
        "appid": null,
        "allow_backup_eligible_upgrade": false,
    }))
    .map_err(|_| Refused::Malformed)?;
    let answer = PublicKeyCredential {
        id: String::new(),
        raw_id: proof.credential.clone(),
        response: AuthenticatorAssertionResponseRaw {
            authenticator_data: proof.authenticator_data.clone(),
            client_data_json: proof.client_data.clone(),
            signature: proof.signature.clone(),
            user_handle: None,
        },
        extensions: AuthenticationExtensionsClientOutputs::default(),
        type_: "public-key".into(),
    };
    let done = rp().authenticate_single_credential(&answer, &state, &credential)?;
    Ok((credential.cred_id, done.counter()))
}

/// webauthn-rs checks this for a registration and not for an answer.
fn same_origin(client_data: &[u8]) -> Result<(), Refused> {
    let data: Value = serde_json::from_slice(client_data).map_err(|_| Refused::Malformed)?;
    match data.get("crossOrigin") {
        None | Some(Value::Bool(false)) => Ok(()),
        _ => Err(Refused::Origin),
    }
}

/// The page a passkey was used on, as the browser told it.
pub fn origin(client_data: &[u8]) -> Option<String> {
    let data: Value = serde_json::from_slice(client_data).ok()?;
    Some(data.get("origin")?.as_str()?.to_string())
}

/// What the page hands `navigator.credentials.get`. `prf` asks for a key made from this salt.
pub fn request(
    passkeys: &[Passkey],
    challenge: &[u8; 32],
    prf: Option<&[u8; 32]>,
) -> Result<Value, Refused> {
    let mut allow = Vec::new();
    for p in passkeys {
        allow.push(json!({ "type": "public-key", "id": base64(&p.id()?) }));
    }
    let mut options = json!({
        "challenge": base64(challenge),
        "rpId": RP_ID,
        "allowCredentials": allow,
        "userVerification": "required",
        "timeout": EXPIRES_MS,
    });
    if let Some(salt) = prf {
        options["extensions"] = json!({ "prf": { "eval": { "first": base64(salt) } } });
    }
    Ok(options)
}

/// What the page hands `navigator.credentials.create`, and what to check the answer with.
pub fn begin(existing: &[Passkey]) -> Result<(Value, RegistrationState), Refused> {
    let rp = rp();
    let mut ids = Vec::new();
    for p in existing {
        ids.push(p.id()?);
    }
    let builder = rp
        .new_challenge_register_builder(&random::<32>(), "Polycarp Sync", "Polycarp Sync")?
        .user_verification_policy(UserVerificationPolicy::Required)
        .credential_algorithms(COSEAlgorithm::secure_algs())
        .exclude_credentials(Some(ids));
    let (options, state) = rp.generate_challenge_register(builder)?;
    let mut options = serde_json::to_value(options.public_key).map_err(|_| Refused::Malformed)?;
    // Kept on the authenticator where it can be, so a passkey manager lists it.
    options["authenticatorSelection"]["residentKey"] = "preferred".into();
    // Asks whether it can make keys, which a recovery copy needs.
    options["extensions"]["prf"] = json!({});
    Ok((options, state))
}

pub fn finish(label: &str, answer: Value, state: &RegistrationState) -> Result<Passkey, Refused> {
    let answer: RegisterPublicKeyCredential =
        serde_json::from_value(answer).map_err(|_| Refused::Malformed)?;
    let credential = rp().register_credential(&answer, state, None)?;
    let credential = serde_json::to_string(&credential).map_err(|_| Refused::Malformed)?;
    let passkey = Passkey {
        label: label.to_string(),
        credential,
    };
    passkey.usable()?;
    Ok(passkey)
}

fn base64(bytes: &[u8]) -> Value {
    BASE64URL_NOPAD.encode(bytes).into()
}
