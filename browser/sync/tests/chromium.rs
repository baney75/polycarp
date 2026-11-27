//! The real page in a real Chromium, with a virtual passkey and a throwaway profile.

mod support;

use polycarp_sync::ceremony::{Ask, Ceremony, Words};
use polycarp_sync::passkey::{self, Passkey, Proof};
use serde_json::Value;
use std::time::Duration;
use support::chrome::Chrome;

const ASKED: [u8; 32] = [7; 32];

fn words() -> Words {
    Words {
        title: "Add Desktop </script>?".into(),
        lines: vec!["Go on only if Desktop shows this code too.".into()],
        code: Some("123 456".into()),
        go: "Use a passkey".into(),
        skip: Some("Not now".into()),
    }
}

async fn register(chrome: &mut Chrome, existing: &[Passkey]) -> Result<(Passkey, bool), String> {
    let (options, state) = passkey::begin(existing).unwrap();
    let mut page = Ceremony::open(Ask::Register(options), words())
        .await
        .unwrap();
    chrome.visit(page.url()).await;
    chrome.click("go").await;
    let answer = loop {
        if let Ok(answer) = page.answer_within(Duration::from_millis(100)).await {
            break answer;
        }
        let said = chrome
            .run("document.getElementById('said').textContent")
            .await;
        if said != "" {
            return Err(said.as_str().unwrap().to_string());
        }
    };
    assert!(answer.prf.is_none());
    let made = passkey::finish("Key", answer.credential.clone().unwrap(), &state).unwrap();
    let keys = answer.makes_keys;
    answer.done(Ok("Done."));
    assert_eq!(chrome.said().await, "Done.");
    Ok((made, keys))
}

async fn allow(
    chrome: &mut Chrome,
    passkeys: &[Passkey],
    prf: Option<[u8; 32]>,
) -> (Value, Option<Vec<u8>>) {
    let ask = Ask::Allow {
        passkeys: passkeys.to_vec(),
        challenge: ASKED,
        prf,
    };
    let mut page = Ceremony::open(ask, words()).await.unwrap();
    chrome.visit(page.url()).await;
    let seen = chrome.run("document.body.innerText").await;
    for text in [
        "Add Desktop </script>?",
        "Go on only if Desktop shows this code too.",
        "123 456",
        "Not now",
    ] {
        assert!(
            seen.as_str().unwrap().contains(text),
            "{text} not on the page: {seen}"
        );
    }
    chrome.click("go").await;
    let answer = page.answer().await.unwrap();
    let got = (
        answer.credential.clone().unwrap(),
        answer.prf.as_ref().map(|p| p.expose().to_vec()),
    );
    answer.done(Ok("Desktop joined."));
    assert_eq!(chrome.said().await, "Desktop joined.");
    got
}

#[tokio::test(flavor = "multi_thread")]
async fn chromium_registers_and_answers() {
    let Some(mut chrome) = Chrome::start().await else {
        return;
    };
    chrome.passkey(true).await;
    let (key, makes_keys) = register(&mut chrome, &[]).await.unwrap();
    assert!(makes_keys, "this passkey can make keys");
    let passkeys = [key];

    let (answer, none) = allow(&mut chrome, &passkeys, None).await;
    assert!(none.is_none());
    let proof = Proof::from_json(answer).unwrap();
    let (_, counter) = passkey::verify(&passkeys, |_| 0, &ASKED, &proof).unwrap();
    assert!(passkey::verify(&passkeys, |_| 0, &[8; 32], &proof).is_err());

    // The same salt gives the same key, another salt another, and none of it is in what is kept.
    let (answer, one) = allow(&mut chrome, &passkeys, Some([1; 32])).await;
    let (_, same) = allow(&mut chrome, &passkeys, Some([1; 32])).await;
    let (_, other) = allow(&mut chrome, &passkeys, Some([2; 32])).await;
    let one = one.unwrap();
    assert_eq!((one.len(), Some(&one)), (32, same.as_ref()));
    assert_ne!(Some(&one), other.as_ref());
    let text = answer.to_string();
    assert!(
        !text.contains(&data_encoding::BASE64URL_NOPAD.encode(&one)) && !text.contains("prf"),
        "{text}"
    );
    let proof = Proof::from_json(answer).unwrap();
    let (_, later) = passkey::verify(&passkeys, |_| counter, &ASKED, &proof).unwrap();
    assert!(later > counter);
}

#[tokio::test(flavor = "multi_thread")]
async fn chromium_asks_for_the_person_and_for_a_new_passkey() {
    let Some(mut chrome) = Chrome::start().await else {
        return;
    };
    let first = chrome.passkey(false).await;
    let (key, makes_keys) = register(&mut chrome, &[]).await.unwrap();
    assert!(!makes_keys);
    assert!(
        allow(&mut chrome, std::slice::from_ref(&key), Some([1; 32]))
            .await
            .1
            .is_none()
    );
    // The one it already has does not count as a second.
    let refused = register(&mut chrome, std::slice::from_ref(&key))
        .await
        .unwrap_err();
    assert_eq!(
        refused,
        "That passkey is already in use here. Choose another."
    );
    // One that does not check who it is makes no passkey here.
    chrome.forget(&first).await;
    let weak = chrome.passkey(false).await;
    chrome.verified(&weak, false).await;
    assert_eq!(
        register(&mut chrome, &[]).await.unwrap_err(),
        "Nothing was sent. You can try again."
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn skipping_is_an_answer() {
    let Some(mut chrome) = Chrome::start().await else {
        return;
    };
    let (options, _) = passkey::begin(&[]).unwrap();
    let mut page = Ceremony::open(Ask::Register(options), words())
        .await
        .unwrap();
    chrome.visit(page.url()).await;
    chrome.click("skip").await;
    let answer = page.answer().await.unwrap();
    assert!(answer.credential.is_none() && answer.prf.is_none());
    answer.done(Ok("Skipped."));
    assert_eq!(chrome.said().await, "Skipped.");
}
