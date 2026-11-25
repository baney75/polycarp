//! The member list: what it takes, and every entry it must refuse.

mod support;

use polycarp_sync::group::{check_name, Action, Bad, Body, Entry, Group};
use polycarp_sync::keys::{Identity, Memory};
use polycarp_sync::passkey::{Proof, Refused, EXPIRES_MS};
use polycarp_sync::seal::Key;
use support::{Ask, Soft};

const NOW: u64 = 1_800_000_000_000;

fn device() -> Identity {
    Identity::load_or_create(&Memory::default()).unwrap()
}

struct Home {
    soft: Soft,
    first: Identity,
    group: Group,
}

impl Home {
    fn new() -> Home {
        let (mut soft, first) = (Soft::new(), device());
        let passkeys = vec![soft.register("Pass manager")];
        let group = Group::create(&first, "Laptop", passkeys, &Key::random(), NOW).unwrap();
        Home { soft, first, group }
    }

    fn add(&self, who: &Identity) -> Action {
        Action::AddDevice {
            device: who.bytes(),
            name: "Desktop".into(),
        }
    }

    fn remove(&self, who: &Identity) -> Action {
        Action::RemoveDevice {
            device: who.bytes(),
            key: Key::random().commitment(),
        }
    }

    fn allow(&mut self, by: &Identity, action: Action) -> Result<(), Bad> {
        let request = self.group.request(by, action, NOW)?;
        let proof = self.soft.sign(request.passkeys(), &request.challenge());
        self.group.allow(by, request, proof, NOW + 1000)
    }

    /// The next entry as a device that breaks the rules would write it.
    fn body(&self, by: &Identity, action: Action) -> Body {
        Body {
            group: self.group.id(),
            seq: self.group.len() as u32,
            prev: self.group.head(),
            signer: by.bytes(),
            action,
            nonce: [3; 32],
            asked: NOW,
            at: NOW + 1000,
            proof: None,
        }
    }

    fn signed(&mut self, body: &Body) -> Option<Proof> {
        Some(self.soft.sign(self.group.passkeys(), &body.challenge()))
    }

    /// Signs `body` as `by` and tries it; the list must not change when it is refused.
    fn push(&mut self, by: &Identity, body: &Body) -> Result<(), Bad> {
        let before = self.group.clone();
        let done = self.group.extend([Entry::sign(by, body)]);
        if done.is_err() {
            assert_eq!(self.group, before);
        }
        done
    }
}

#[test]
fn a_group_grows_and_reads_back_the_same() {
    let mut h = Home::new();
    let (first, second, third) = (h.first.clone(), device(), device());
    h.allow(&first, h.add(&second)).unwrap();
    h.allow(&second, h.add(&third)).unwrap();
    h.allow(&third, h.remove(&second)).unwrap();
    let read = Group::read(h.group.entries().to_vec()).unwrap();
    assert_eq!(read, h.group);
    assert_eq!(read.devices().len(), 3);
    assert_eq!(
        read.member(&third.bytes()).unwrap().added_by,
        second.bytes()
    );
    assert!(read.member(&second.bytes()).is_none());
    assert_eq!(read.devices()[1].removed, Some((third.bytes(), NOW + 1000)));
    assert_eq!(read.key().0, 1, "removing a device changes the group key");
    assert_ne!(Home::new().group.id(), h.group.id());
}

#[test]
fn a_device_without_a_passkeys_leave_does_not_join() {
    let mut h = Home::new();
    let (first, new) = (h.first.clone(), device());
    let body = h.body(&first, h.add(&new));
    assert_eq!(h.push(&first, &body), Err(Bad::NoProof));
    let mut other = Soft::new();
    let stranger = other.register("Other");
    let proof = Some(other.sign(&[stranger], &body.challenge()));
    assert_eq!(
        h.push(&first, &Body { proof, ..body }),
        Err(Bad::Passkey(Refused::Unknown))
    );
}

#[test]
fn leave_for_one_device_is_no_leave_for_another() {
    let mut h = Home::new();
    let (first, asked, other) = (h.first.clone(), device(), device());
    let mut body = h.body(&first, h.add(&asked));
    let proof = h.signed(&body);
    body.proof = proof;
    let wrong = |body: Body| (body, Err(Bad::Passkey(Refused::Challenge)));
    let cases = [
        wrong(Body {
            action: h.add(&other),
            ..body.clone()
        }),
        wrong(Body {
            action: Action::AddDevice {
                device: asked.bytes(),
                name: "Other".into(),
            },
            ..body.clone()
        }),
        wrong(Body {
            nonce: [4; 32],
            ..body.clone()
        }),
        wrong(Body {
            asked: NOW + 1,
            ..body.clone()
        }),
    ];
    for (body, refused) in cases {
        assert_eq!(h.push(&first, &body), refused);
    }
    h.push(&first, &body).unwrap();
    // Another member can't use what the passkey told this one.
    let third = device();
    let mut body = h.body(&first, h.add(&third));
    body.proof = h.signed(&body);
    body.signer = asked.bytes();
    assert_eq!(h.push(&asked, &body), Err(Bad::Passkey(Refused::Challenge)));
}

#[test]
fn a_replayed_answer_does_nothing() {
    let mut h = Home::new();
    let (first, new) = (h.first.clone(), device());
    let mut body = h.body(&first, h.add(&new));
    body.proof = h.signed(&body);
    let entry = Entry::sign(&first, &body);
    h.group.extend([entry.clone()]).unwrap();
    assert_eq!(h.group.extend([entry]), Err(Bad::Chain));
    // At the next place in the list, asking for the same thing again after it was undone.
    h.allow(&first, h.remove(&new)).unwrap();
    let again = Body {
        seq: h.group.len() as u32,
        prev: h.group.head(),
        ..body.clone()
    };
    assert_eq!(h.push(&first, &again), Err(Bad::Known));
    let other = device();
    let again = Body {
        action: h.add(&other),
        ..again
    };
    assert_eq!(
        h.push(&first, &again),
        Err(Bad::Passkey(Refused::Challenge))
    );
    // In another group with the same passkey.
    let key = Key::random();
    let twin = Group::create(&first, "Laptop", h.group.passkeys().to_vec(), &key, NOW).unwrap();
    let twin_body = Body {
        group: twin.id(),
        prev: twin.head(),
        seq: 1,
        ..body.clone()
    };
    let refused = twin.clone().extend([Entry::sign(&first, &twin_body)]);
    assert_eq!(refused, Err(Bad::Passkey(Refused::Challenge)));
    let refused = twin.clone().extend([Entry::sign(
        &first,
        &Body {
            group: h.group.id(),
            ..twin_body
        },
    )]);
    assert_eq!(refused, Err(Bad::Chain));
}

#[test]
fn an_answer_after_five_minutes_does_not_count() {
    let mut h = Home::new();
    let (first, new) = (h.first.clone(), device());
    for (at, want) in [
        (NOW + EXPIRES_MS + 1, Err(Bad::Expired)),
        (NOW - 1, Err(Bad::Expired)),
        (NOW + EXPIRES_MS, Ok(())),
    ] {
        let request = h.group.request(&first, h.add(&new), NOW).unwrap();
        let proof = h.soft.sign(request.passkeys(), &request.challenge());
        assert_eq!(h.group.allow(&first, request, proof, at), want);
    }
}

#[test]
fn an_answer_from_the_wrong_page_or_without_the_person_does_not_count() {
    let mut h = Home::new();
    let (first, new) = (h.first.clone(), device());
    let request = h.group.request(&first, h.add(&new), NOW).unwrap();
    let proof = h.soft.sign_as(
        request.passkeys(),
        &request.challenge(),
        Ask {
            verified: false,
            ..Ask::default()
        },
    );
    assert_eq!(
        h.group.allow(&first, request, proof, NOW),
        Err(Bad::Passkey(Refused::NotVerified))
    );
    let request = h.group.request(&first, h.add(&new), NOW).unwrap();
    let mut proof = h.soft.sign(request.passkeys(), &request.challenge());
    let data = String::from_utf8(proof.client_data)
        .unwrap()
        .replace("http://localhost:4711", "http://evil.example");
    proof.client_data = data.into_bytes();
    assert_eq!(
        h.group.allow(&first, request, proof, NOW),
        Err(Bad::Passkey(Refused::Origin))
    );
}

#[test]
fn only_a_member_signs() {
    let mut h = Home::new();
    let (first, second, out, new) = (h.first.clone(), device(), device(), device());
    let mut body = h.body(&out, h.add(&new));
    body.proof = h.signed(&body);
    assert_eq!(h.push(&out, &body), Err(Bad::NotMember));
    // In a member's name, with its own key.
    let mut body = h.body(&first, h.add(&new));
    body.proof = h.signed(&body);
    assert_eq!(h.push(&out, &body), Err(Bad::Signature));
    h.allow(&first, h.add(&second)).unwrap();
    h.allow(&first, h.remove(&second)).unwrap();
    let mut body = h.body(&second, h.add(&new));
    body.proof = h.signed(&body);
    assert_eq!(h.push(&second, &body), Err(Bad::NotMember));
    assert_eq!(
        h.group.request(&second, h.add(&new), NOW).unwrap_err(),
        Bad::NotMember
    );
}

#[test]
fn a_changed_or_moved_entry_is_refused() {
    let mut h = Home::new();
    let (first, second, third) = (h.first.clone(), device(), device());
    h.allow(&first, h.add(&second)).unwrap();
    h.allow(&first, h.add(&third)).unwrap();
    let entries = h.group.entries().to_vec();
    for at in 0..entries.len() {
        let mut bytes = postcard::to_stdvec(&entries[at]).unwrap();
        let middle = bytes.len() / 2;
        bytes[middle] ^= 1;
        let mut list = entries.clone();
        list[at] = postcard::from_bytes(&bytes).unwrap();
        assert!(Group::read(list).is_err(), "entry {at}");
    }
    let mut padded: (Vec<u8>, Vec<u8>) = (body_of(&entries[0]), Vec::new());
    padded.0.push(0);
    padded.1 = first
        .signing
        .sign(&polycarp_sync::seal::hash(
            "polycarp-sync entry v1",
            &[&padded.0],
        ))
        .to_bytes()
        .to_vec();
    let padded: Entry = postcard::from_bytes(&postcard::to_stdvec(&padded).unwrap()).unwrap();
    assert_eq!(Group::read(vec![padded]).unwrap_err(), Bad::Malformed);
    assert!(Group::read(vec![entries[0].clone(), entries[2].clone()]).is_err());
    assert!(Group::read(vec![entries[1].clone()]).is_err());
    assert!(Group::read(vec![
        entries[0].clone(),
        entries[2].clone(),
        entries[1].clone()
    ])
    .is_err());
    assert_eq!(Group::read(Vec::new()).unwrap_err(), Bad::Malformed);
    // A second first entry.
    let twin = Group::create(
        &first,
        "Laptop",
        h.group.passkeys().to_vec(),
        &Key::random(),
        NOW,
    )
    .unwrap();
    assert!(h.group.extend(twin.entries().to_vec()).is_err());
    let Ok(Body { action: create, .. }) =
        postcard::from_bytes::<Body>(&body_of(&twin.entries()[0]))
    else {
        panic!()
    };
    let mut body = h.body(&first, create);
    body.proof = h.signed(&body);
    assert_eq!(h.push(&first, &body), Err(Bad::Chain));
}

#[test]
fn a_first_entry_must_be_its_own_devices_with_a_passkey() {
    let mut soft = Soft::new();
    let (a, b) = (device(), device());
    let key = Key::random();
    assert_eq!(
        Group::create(&a, "Laptop", Vec::new(), &key, NOW).unwrap_err(),
        Bad::NoProof
    );
    let good = Group::create(&a, "Laptop", vec![soft.register("Key")], &key, NOW).unwrap();
    let body: Body = postcard::from_bytes(&body_of(&good.entries()[0])).unwrap();
    assert_eq!(Group::read(vec![Entry::sign(&a, &body)]).unwrap(), good);
    let forged = Body {
        signer: b.bytes(),
        ..body.clone()
    };
    assert_eq!(
        Group::read(vec![Entry::sign(&b, &forged)]).unwrap_err(),
        Bad::NotMember
    );
    for odd in [
        Body {
            seq: 1,
            ..body.clone()
        },
        Body {
            prev: [1; 32],
            ..body.clone()
        },
        Body {
            group: [1; 32],
            ..body
        },
    ] {
        assert_eq!(
            Group::read(vec![Entry::sign(&a, &odd)]).unwrap_err(),
            Bad::Chain
        );
    }
}

#[test]
fn a_device_is_listed_once_ever() {
    let mut h = Home::new();
    let (first, second) = (h.first.clone(), device());
    h.allow(&first, h.add(&second)).unwrap();
    assert_eq!(h.allow(&first, h.add(&second)), Err(Bad::Known));
    h.allow(&first, h.remove(&second)).unwrap();
    assert_eq!(h.allow(&first, h.add(&second)), Err(Bad::Known));
    assert_eq!(h.allow(&first, h.remove(&second)), Err(Bad::UnknownDevice));
}

#[test]
fn a_device_does_not_remove_itself_or_the_last_one() {
    let mut h = Home::new();
    let (first, second) = (h.first.clone(), device());
    assert_eq!(h.allow(&first, h.remove(&first)), Err(Bad::LastDevice));
    h.allow(&first, h.add(&second)).unwrap();
    assert_eq!(h.allow(&first, h.remove(&first)), Err(Bad::OwnDevice));
}

#[test]
fn removing_a_device_takes_a_key_never_used_before() {
    let mut h = Home::new();
    let (first, second) = (h.first.clone(), device());
    h.allow(&first, h.add(&second)).unwrap();
    let old = *h.group.key().1;
    let same = Action::RemoveDevice {
        device: second.bytes(),
        key: old,
    };
    assert_eq!(h.allow(&first, same), Err(Bad::Chain));
    h.allow(&first, h.remove(&second)).unwrap();
    assert_ne!(*h.group.key().1, old);
}

#[test]
fn the_last_passkey_stays_and_none_removes_itself() {
    let mut h = Home::new();
    let first = h.first.clone();
    let one = h.group.passkeys()[0].id().unwrap();
    assert_eq!(
        h.allow(&first, Action::RemovePasskey { id: one.clone() }),
        Err(Bad::LastPasskey)
    );
    let mut stick = Soft::new();
    let two = stick.register("Security key");
    h.allow(
        &first,
        Action::AddPasskey {
            passkey: two.clone(),
        },
    )
    .unwrap();
    assert_eq!(
        h.allow(
            &first,
            Action::AddPasskey {
                passkey: two.clone()
            }
        ),
        Err(Bad::KnownPasskey)
    );
    let remove = Action::RemovePasskey { id: one.clone() };
    let request = h.group.request(&first, remove, NOW).unwrap();
    assert_eq!(request.passkeys(), std::slice::from_ref(&two));
    let itself = h.soft.sign(h.group.passkeys(), &request.challenge());
    assert_eq!(
        h.group.allow(&first, request, itself, NOW),
        Err(Bad::Passkey(Refused::Unknown))
    );
    let request = h
        .group
        .request(&first, Action::RemovePasskey { id: one.clone() }, NOW)
        .unwrap();
    let proof = stick.sign(request.passkeys(), &request.challenge());
    h.group.allow(&first, request, proof, NOW).unwrap();
    assert_eq!(h.group.passkeys(), [two]);
    // It allows nothing once it is out.
    let mut body = h.body(&first, h.add(&device()));
    body.proof = Some(h.soft.sign(&[h.soft_passkey(&one)], &body.challenge()));
    assert_eq!(h.push(&first, &body), Err(Bad::Passkey(Refused::Unknown)));
    assert_eq!(h.allow_unknown(&first), Err(Bad::UnknownPasskey));
}

impl Home {
    fn soft_passkey(&self, id: &[u8]) -> polycarp_sync::passkey::Passkey {
        let body: Body = postcard::from_bytes(&body_of(&self.group.entries()[0])).unwrap();
        let Action::Create { passkeys, .. } = body.action else {
            panic!()
        };
        passkeys
            .into_iter()
            .find(|p| p.id().unwrap() == id)
            .unwrap()
    }

    fn allow_unknown(&mut self, by: &Identity) -> Result<(), Bad> {
        self.group
            .request(by, Action::RemovePasskey { id: vec![9] }, NOW)
            .map(|_| ())
    }
}

#[test]
fn lists_changed_apart_are_a_fork() {
    let mut h = Home::new();
    let (first, second) = (h.first.clone(), device());
    h.allow(&first, h.add(&second)).unwrap();
    let shared = h.group.clone();
    h.allow(&first, h.add(&device())).unwrap();
    let ours = h.group.clone();
    h.group = shared.clone();
    h.allow(&second, h.add(&device())).unwrap();
    let theirs = h.group.clone();
    assert_eq!(ours.after(theirs.len(), &theirs.head()), Err(Bad::Fork));
    assert_eq!(
        ours.clone().extend(theirs.entries()[2..].to_vec()),
        Err(Bad::Chain)
    );
    assert_eq!(ours.after(shared.len(), &shared.head()).unwrap().len(), 1);
    assert_eq!(ours.after(0, &[0; 32]), Err(Bad::Fork));
    assert!(shared.after(ours.len(), &ours.head()).unwrap().is_empty());
}

#[test]
fn an_entry_fits_one_place_in_one_list() {
    let mut h = Home::new();
    let first = h.first.clone();
    let start = h.group.clone();
    h.allow(&first, h.add(&device())).unwrap();
    let ours = h.group.clone();
    h.group = start;
    h.allow(&first, h.add(&device())).unwrap();
    h.allow(&first, h.add(&device())).unwrap();
    let third = h.group.entries()[2].clone();
    assert_eq!(ours.clone().extend([third.clone()]), Err(Bad::Chain));
    // Nor does the passkey's leave for it move to the same place in the other list.
    let moved = Body {
        prev: ours.head(),
        ..postcard::from_bytes(&body_of(&third)).unwrap()
    };
    let moved = ours.clone().extend([Entry::sign(&first, &moved)]);
    assert_eq!(moved, Err(Bad::Passkey(Refused::Challenge)));
    let mut body = Body {
        seq: 99,
        ..h.body(&first, h.add(&device()))
    };
    body.proof = h.signed(&body);
    assert_eq!(h.push(&first, &body), Err(Bad::Chain));
}

#[test]
fn a_name_is_plain_text() {
    for good in [
        "Laptop",
        "Donna's Mac (work)",
        "R2-D2 & co.",
        "Büro",
        "書斎",
    ] {
        assert_eq!(check_name(good), Ok(()), "{good}");
    }
    let long = "x".repeat(65);
    for bad in [
        "",
        " Laptop",
        "a\nb",
        "a\u{1b}[2J",
        "a\u{202e}b",
        "<b>",
        "a\u{200b}b",
        &long,
    ] {
        assert_eq!(check_name(bad), Err(Bad::Name), "{bad:?}");
    }
    let mut h = Home::new();
    let first = h.first.clone();
    let action = Action::AddDevice {
        device: device().bytes(),
        name: "a\nb".into(),
    };
    let mut body = h.body(&first, action);
    body.proof = h.signed(&body);
    assert_eq!(h.push(&first, &body), Err(Bad::Name));
}

/// The signed bytes of an entry, as they go over the wire.
fn body_of(entry: &Entry) -> Vec<u8> {
    let bytes = postcard::to_stdvec(entry).unwrap();
    postcard::from_bytes::<(Vec<u8>, Vec<u8>)>(&bytes)
        .unwrap()
        .0
}
