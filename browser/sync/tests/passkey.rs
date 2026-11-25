//! Every answer a passkey can give that must not count.

mod support;

use polycarp_sync::passkey::{begin, finish, verify, Passkey, Proof, Refused};
use serde_json::{json, Value};
use support::{Ask, Soft, PAGE};

const ASKED: [u8; 32] = [7; 32];

fn check(p: &Passkey, proof: &Proof) -> Result<(Vec<u8>, u32), Refused> {
    verify(std::slice::from_ref(p), |_| 0, &ASKED, proof)
}

#[test]
fn a_verified_answer_to_this_request_counts() {
    let mut key = Soft::new();
    let p = key.register("Key");
    let proof = key.sign(std::slice::from_ref(&p), &ASKED);
    let (id, counter) = check(&p, &proof).unwrap();
    assert_eq!(id, p.id().unwrap());
    assert!(counter > 0);
}

#[test]
fn an_answer_to_another_request_does_not() {
    let mut key = Soft::new();
    let p = key.register("Key");
    let proof = key.sign(std::slice::from_ref(&p), &[8; 32]);
    assert_eq!(check(&p, &proof), Err(Refused::Challenge));
}

#[test]
fn an_answer_from_another_page_does_not() {
    let mut key = Soft::new();
    let p = key.register("Key");
    // softpasskey, like a browser, will not sign for a page that is not the relying party's, so the page is moved
    // under a good signature, which the order of the checks makes the origin's refusal and not the signature's.
    for origin in [
        "https://localhost",
        "http://localhost.example.com",
        "http://evil.example",
        "http://sub.localhost:4711",
    ] {
        let mut proof = key.sign(std::slice::from_ref(&p), &ASKED);
        edit(&mut proof, "origin", json!(origin));
        assert_eq!(check(&p, &proof), Err(Refused::Origin), "{origin}");
    }
}

#[test]
fn an_answer_from_a_framed_page_does_not() {
    let mut key = Soft::new();
    let p = key.register("Key");
    for value in [json!(true), json!("false"), json!(1)] {
        let mut proof = key.sign(std::slice::from_ref(&p), &ASKED);
        edit(&mut proof, "crossOrigin", value);
        assert_eq!(check(&p, &proof), Err(Refused::Origin));
    }
}

#[test]
fn an_answer_without_the_person_verified_does_not() {
    let mut key = Soft::new();
    let p = key.register("Key");
    let proof = key.sign_as(
        std::slice::from_ref(&p),
        &ASKED,
        Ask {
            verified: false,
            ..Ask::default()
        },
    );
    assert_eq!(check(&p, &proof), Err(Refused::NotVerified));
}

#[test]
fn a_counter_that_did_not_go_up_does_not() {
    let mut key = Soft::new();
    let p = key.register("Key");
    let proof = key.sign(std::slice::from_ref(&p), &ASKED);
    let (_, counter) = check(&p, &proof).unwrap();
    let seen = |n| verify(std::slice::from_ref(&p), move |_| n, &ASKED, &proof);
    assert_eq!(seen(counter), Err(Refused::Counter));
    assert_eq!(seen(counter + 1), Err(Refused::Counter));
    assert!(seen(counter - 1).is_ok());
}

#[test]
fn a_passkey_outside_the_group_does_not() {
    let (mut key, mut other) = (Soft::new(), Soft::new());
    let p = key.register("Key");
    let stranger = other.register("Other");
    let proof = other.sign(std::slice::from_ref(&stranger), &ASKED);
    assert_eq!(check(&p, &proof), Err(Refused::Unknown));
    // Nor does its signature under a member's id.
    let proof = Proof {
        credential: p.id().unwrap(),
        ..proof
    };
    assert_eq!(check(&p, &proof), Err(Refused::Signature));
}

#[test]
fn a_changed_answer_does_not() {
    let mut key = Soft::new();
    let p = key.register("Key");
    let good = key.sign(std::slice::from_ref(&p), &ASKED);
    let mut counter = good.clone();
    *counter.authenticator_data.last_mut().unwrap() ^= 1;
    assert_eq!(check(&p, &counter), Err(Refused::Signature));
    let mut port = good.clone();
    edit(&mut port, "origin", json!("http://localhost:1"));
    assert_eq!(check(&p, &port), Err(Refused::Signature));
    let mut kind = good.clone();
    edit(&mut kind, "type", json!("webauthn.create"));
    assert_eq!(check(&p, &kind), Err(Refused::Malformed));
    let mut site = good;
    site.authenticator_data[0] ^= 1;
    assert_eq!(check(&p, &site), Err(Refused::Origin));
}

#[test]
fn a_passkey_registered_without_verification_is_not_usable() {
    let mut key = Soft::new();
    let (mut options, state) = begin(&[]).unwrap();
    options["authenticatorSelection"]["userVerification"] = json!("discouraged");
    let answer = key.answer_registration(options, PAGE);
    assert_eq!(finish("Key", answer, &state), Err(Refused::NotVerified));
    // Nor one that another device wrote into the list that way.
    for (field, value) in [
        ("user_verified", json!(false)),
        ("registration_policy", json!("preferred")),
    ] {
        let good = key.register("Key");
        let mut list = serde_json::to_value(&good).unwrap();
        let mut inner: Value = serde_json::from_str(list["credential"].as_str().unwrap()).unwrap();
        inner[field] = value;
        list["credential"] = json!(inner.to_string());
        let weak: Passkey = serde_json::from_value(list).unwrap();
        assert_eq!(weak.usable(), Err(Refused::NotVerified));
        let proof = key.sign(std::slice::from_ref(&weak), &ASKED);
        assert_eq!(check(&weak, &proof), Err(Refused::NotVerified));
    }
}

#[test]
fn a_registration_for_another_request_or_page_is_refused() {
    let mut key = Soft::new();
    let (options, _) = begin(&[]).unwrap();
    let (_, other) = begin(&[]).unwrap();
    let answer = key.answer_registration(options.clone(), PAGE);
    assert_eq!(finish("Key", answer, &other), Err(Refused::Challenge));
    let (options, state) = begin(&[]).unwrap();
    let mut answer = key.answer_registration(options, PAGE);
    let data = answer["response"]["clientDataJSON"].as_str().unwrap();
    let mut data: Value = serde_json::from_slice(&decode(data)).unwrap();
    data["origin"] = json!("http://evil.example");
    answer["response"]["clientDataJSON"] =
        json!(data_encoding::BASE64URL_NOPAD.encode(data.to_string().as_bytes()));
    assert_eq!(finish("Key", answer, &state), Err(Refused::Origin));
}

#[test]
fn a_proof_keeps_no_extension_output() {
    let mut key = Soft::new();
    let p = key.register("Key");
    let options = polycarp_sync::passkey::request(std::slice::from_ref(&p), &ASKED, None).unwrap();
    let mut answer = key.answer(options, Ask::default());
    answer.as_object_mut().unwrap().remove("extensions");
    answer["clientExtensionResults"] =
        json!({ "prf": { "results": { "first": "c2VjcmV0LXByZi1vdXRwdXQ" } } });
    let proof = Proof::from_json(answer).unwrap();
    assert!(check(&p, &proof).is_ok());
    let kept = serde_json::to_string(&proof).unwrap();
    assert!(!kept.contains("prf") && !kept.contains("c2VjcmV0"));
}

#[test]
fn a_request_asks_for_this_challenge_and_the_person() {
    let mut key = Soft::new();
    let p = key.register("Key");
    let options =
        polycarp_sync::passkey::request(std::slice::from_ref(&p), &ASKED, Some(&[1; 32])).unwrap();
    assert_eq!(options["userVerification"], "required");
    assert_eq!(options["rpId"], "localhost");
    assert_eq!(decode(options["challenge"].as_str().unwrap()), ASKED);
    assert_eq!(
        decode(options["allowCredentials"][0]["id"].as_str().unwrap()),
        p.id().unwrap()
    );
    assert_eq!(
        decode(
            options["extensions"]["prf"]["eval"]["first"]
                .as_str()
                .unwrap()
        ),
        [1; 32]
    );
    let (options, _) = begin(std::slice::from_ref(&p)).unwrap();
    assert_eq!(
        options["authenticatorSelection"]["userVerification"],
        "required"
    );
    assert_eq!(
        decode(options["excludeCredentials"][0]["id"].as_str().unwrap()),
        p.id().unwrap()
    );
}

fn decode(text: &str) -> Vec<u8> {
    data_encoding::BASE64URL_NOPAD
        .decode(text.as_bytes())
        .unwrap()
}

fn edit(proof: &mut Proof, field: &str, value: Value) {
    let mut data: Value = serde_json::from_slice(&proof.client_data).unwrap();
    data[field] = value;
    proof.client_data = serde_json::to_vec(&data).unwrap();
}
