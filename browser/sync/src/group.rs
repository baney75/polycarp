//! Which devices and passkeys belong together: a list that only grows, each entry signed by a device already in it and,
//! after the first, allowed by one of its passkeys. Every device checks every entry for itself.

use crate::keys::Identity;
use crate::passkey::{self, Passkey, Proof, Refused, EXPIRES_MS};
use crate::seal::{hash, random, Key};
use iroh_base::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;

pub type Id = [u8; 32];

const ENTRY: &str = "polycarp-sync entry v1";
const ALLOW: &str = "polycarp-sync allow v1";
const MAX_ENTRY: usize = 64 * 1024;
const MAX_ENTRIES: usize = 4096;
const MAX_PASSKEYS: usize = 16;
const MAX_NAME: usize = 64;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Bad {
    Passkey(Refused),
    /// No passkey answered for this change.
    NoProof,
    /// The answer came more than five minutes after the question.
    Expired,
    /// The device's signature on the entry is wrong.
    Signature,
    /// Signed by a device that is not in the group, or no longer is.
    NotMember,
    /// This device's key was in the list before. A device comes back with a new key.
    Known,
    /// Not the next entry of this list.
    Chain,
    /// Two devices changed the list apart from each other, so there are two lists.
    Fork,
    LastDevice,
    OwnDevice,
    LastPasskey,
    UnknownDevice,
    UnknownPasskey,
    KnownPasskey,
    Name,
    /// More than the list may hold.
    Full,
    Malformed,
}

impl fmt::Display for Bad {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Bad::Passkey(why) => return why.fmt(f),
            Bad::NoProof => "no passkey allowed this change",
            Bad::Expired => "the passkey answered too late; start again",
            Bad::Signature => "an entry in the device list has a wrong signature",
            Bad::NotMember => "that device is not in this group",
            Bad::Known => "that device was in this group before; it can come back only with a new key",
            Bad::Chain => "that is not the next entry of the device list",
            Bad::Fork => {
                "the device list was changed on two devices apart from each other; leave the group on one and join again"
            }
            Bad::LastDevice => "this is the only device left in the group",
            Bad::OwnDevice => "a device can't remove itself; use leave on it, or remove it from another device",
            Bad::LastPasskey => "the last passkey can't be removed; add another first",
            Bad::UnknownDevice => "no such device in this group",
            Bad::UnknownPasskey => "no such passkey in this group",
            Bad::KnownPasskey => "that passkey is already in this group",
            Bad::Name => "a name is 1 to 64 letters, digits, spaces and - _ . ' ( ) &",
            Bad::Full => "the group holds no more",
            Bad::Malformed => "that is not a device list",
        })
    }
}

impl From<Refused> for Bad {
    fn from(why: Refused) -> Bad {
        Bad::Passkey(why)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Action {
    /// The first entry. The salt makes every group's id its own.
    Create {
        device: Id,
        name: String,
        salt: [u8; 32],
        passkeys: Vec<Passkey>,
        key: [u8; 32],
    },
    AddDevice {
        device: Id,
        name: String,
    },
    /// Comes with a new group key, named by its commitment.
    RemoveDevice {
        device: Id,
        key: [u8; 32],
    },
    AddPasskey {
        passkey: Passkey,
    },
    RemovePasskey {
        id: Vec<u8>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Body {
    pub group: Id,
    pub seq: u32,
    /// Hash of the entry before. It is under the passkey's signature too, so an answer works at one place in one list.
    pub prev: [u8; 32],
    pub signer: Id,
    pub action: Action,
    pub nonce: [u8; 32],
    /// When the passkey was asked and when it had answered, by the signer's clock, in ms.
    pub asked: u64,
    pub at: u64,
    pub proof: Option<Proof>,
}

impl Body {
    /// What a passkey signs to allow this entry: the group, this place in its list, the device asking, what it asks
    /// for (a new device's public key is part of that) and a nonce.
    pub fn challenge(&self) -> [u8; 32] {
        let action = postcard::to_stdvec(&self.action).expect("an action is plain data");
        hash(
            ALLOW,
            &[
                &self.group,
                &self.seq.to_be_bytes(),
                &self.prev,
                &self.signer,
                &action,
                &self.nonce,
                &self.asked.to_be_bytes(),
            ],
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    body: Vec<u8>,
    signature: Vec<u8>,
}

impl Entry {
    pub fn sign(identity: &Identity, body: &Body) -> Entry {
        let body = postcard::to_stdvec(body).expect("a body is plain data");
        let signature = identity
            .signing
            .sign(&hash(ENTRY, &[&body]))
            .to_bytes()
            .to_vec();
        Entry { body, signature }
    }

    pub fn hash(&self) -> [u8; 32] {
        hash(ENTRY, &[&self.body])
    }

    /// The body, once its signature is checked.
    fn open(&self) -> Result<Body, Bad> {
        if self.body.len() > MAX_ENTRY {
            return Err(Bad::Full);
        }
        let (body, rest) =
            postcard::take_from_bytes::<Body>(&self.body).map_err(|_| Bad::Malformed)?;
        if !rest.is_empty() {
            return Err(Bad::Malformed);
        }
        let signer = PublicKey::from_bytes(&body.signer).map_err(|_| Bad::Signature)?;
        let signature: &[u8; 64] = self
            .signature
            .as_slice()
            .try_into()
            .map_err(|_| Bad::Signature)?;
        signer
            .verify(&self.hash(), &Signature::from_bytes(signature))
            .map_err(|_| Bad::Signature)?;
        Ok(body)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Device {
    pub id: Id,
    pub name: String,
    pub added_by: Id,
    pub at: u64,
    /// Who removed it, and when.
    pub removed: Option<(Id, u64)>,
}

/// What the entries add up to.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct State {
    id: Id,
    devices: Vec<Device>,
    passkeys: Vec<Passkey>,
    /// The highest counter seen from each passkey. A removed one's is kept, in case it comes back.
    counters: BTreeMap<Vec<u8>, u32>,
    /// A commitment to every group key so far; the last is the one in use.
    keys: Vec<[u8; 32]>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Group {
    entries: Vec<Entry>,
    state: State,
}

/// A change waiting for a passkey.
#[derive(Debug)]
pub struct Request {
    body: Body,
    passkeys: Vec<Passkey>,
}

impl Request {
    pub fn challenge(&self) -> [u8; 32] {
        self.body.challenge()
    }

    /// The passkeys that may allow it.
    pub fn passkeys(&self) -> &[Passkey] {
        &self.passkeys
    }
}

impl Group {
    /// A new group of this one device. The passkeys were just registered here.
    pub fn create(
        identity: &Identity,
        name: &str,
        passkeys: Vec<Passkey>,
        key: &Key,
        now: u64,
    ) -> Result<Group, Bad> {
        let body = Body {
            group: [0; 32],
            seq: 0,
            prev: [0; 32],
            signer: identity.bytes(),
            action: Action::Create {
                device: identity.bytes(),
                name: name.to_string(),
                salt: random(),
                passkeys,
                key: key.commitment(),
            },
            nonce: [0; 32],
            asked: now,
            at: now,
            proof: None,
        };
        Group::read(vec![Entry::sign(identity, &body)])
    }

    /// Reads a list from its first entry, checking every one.
    pub fn read(entries: Vec<Entry>) -> Result<Group, Bad> {
        let mut entries = entries.into_iter();
        let first = entries.next().ok_or(Bad::Malformed)?;
        let body = first.open()?;
        let mut group = Group {
            state: State::start(first.hash(), &body)?,
            entries: vec![first],
        };
        group.extend(entries)?;
        Ok(group)
    }

    /// Adds the entries that come next. None is added when any is refused.
    pub fn extend(&mut self, entries: impl IntoIterator<Item = Entry>) -> Result<(), Bad> {
        let mut next = self.clone();
        for entry in entries {
            let body = entry.open()?;
            if next.entries.len() >= MAX_ENTRIES {
                return Err(Bad::Full);
            }
            if body.seq as usize != next.entries.len() || body.prev != next.head() {
                return Err(Bad::Chain);
            }
            next.state.add(&body)?;
            next.entries.push(entry);
        }
        *self = next;
        Ok(())
    }

    /// Asks for a change by this device. A change the list would refuse is refused before the person is asked.
    pub fn request(&self, identity: &Identity, action: Action, now: u64) -> Result<Request, Bad> {
        let body = Body {
            group: self.id(),
            seq: self.len() as u32,
            prev: self.head(),
            signer: identity.bytes(),
            action,
            nonce: random(),
            asked: now,
            at: now,
            proof: None,
        };
        self.state.clone().change(&body)?;
        Ok(Request {
            passkeys: self.state.may_allow(&body.action),
            body,
        })
    }

    /// Adds the change a passkey just allowed.
    pub fn allow(
        &mut self,
        identity: &Identity,
        request: Request,
        proof: Proof,
        now: u64,
    ) -> Result<(), Bad> {
        let body = Body {
            at: now,
            proof: Some(proof),
            ..request.body
        };
        self.extend([Entry::sign(identity, &body)])
    }

    pub fn id(&self) -> Id {
        self.state.id
    }

    pub fn head(&self) -> [u8; 32] {
        self.entries
            .last()
            .expect("a group has its first entry")
            .hash()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        false
    }

    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    /// The entries a device that has `len` of them, ending in `head`, is missing. One that has more than this device
    /// gets none. Two lists that differ at the same place are a fork, and nothing passes between them.
    pub fn after(&self, len: usize, head: &[u8; 32]) -> Result<&[Entry], Bad> {
        match self.entries.get(..len) {
            None => Ok(&[]),
            Some([.., last]) if last.hash() == *head => Ok(&self.entries[len..]),
            _ => Err(Bad::Fork),
        }
    }

    pub fn devices(&self) -> &[Device] {
        &self.state.devices
    }

    pub fn member(&self, id: &Id) -> Option<&Device> {
        self.state.member(id)
    }

    pub fn passkeys(&self) -> &[Passkey] {
        &self.state.passkeys
    }

    /// How many times the group key has changed, and the commitment to the one in use.
    pub fn key(&self) -> (u32, &[u8; 32]) {
        let keys = &self.state.keys;
        (
            keys.len() as u32 - 1,
            keys.last().expect("a group has its first key"),
        )
    }
}

impl State {
    fn start(id: Id, body: &Body) -> Result<State, Bad> {
        let Action::Create {
            device,
            name,
            passkeys,
            key,
            ..
        } = &body.action
        else {
            return Err(Bad::Chain);
        };
        if body.seq != 0 || body.prev != [0; 32] || body.group != [0; 32] || body.proof.is_some() {
            return Err(Bad::Chain);
        }
        if body.signer != *device {
            return Err(Bad::NotMember);
        }
        if passkeys.is_empty() {
            return Err(Bad::NoProof);
        }
        let mut state = State {
            id,
            keys: vec![*key],
            ..State::default()
        };
        state.add_device(*device, name, body)?;
        for p in passkeys {
            state.add_passkey(p)?;
        }
        Ok(state)
    }

    /// One more entry: a member's, allowed by a passkey, for a change the list takes.
    fn add(&mut self, body: &Body) -> Result<(), Bad> {
        if body.group != self.id {
            return Err(Bad::Chain);
        }
        let allowing = self.may_allow(&body.action);
        let counters = self.counters.clone();
        self.change(body)?;
        let proof = body.proof.as_ref().ok_or(Bad::NoProof)?;
        if body
            .at
            .checked_sub(body.asked)
            .is_none_or(|took| took > EXPIRES_MS)
        {
            return Err(Bad::Expired);
        }
        let seen = |id: &[u8]| counters.get(id).copied().unwrap_or(0);
        let (id, counter) = passkey::verify(&allowing, seen, &body.challenge(), proof)?;
        self.counters.insert(id, counter);
        Ok(())
    }

    fn change(&mut self, body: &Body) -> Result<(), Bad> {
        if self.member(&body.signer).is_none() {
            return Err(Bad::NotMember);
        }
        match &body.action {
            Action::Create { .. } => Err(Bad::Chain),
            Action::AddDevice { device, name } => self.add_device(*device, name, body),
            Action::RemoveDevice { device, key } => {
                if *device == body.signer {
                    return Err(if self.active() == 1 {
                        Bad::LastDevice
                    } else {
                        Bad::OwnDevice
                    });
                }
                let gone = self
                    .devices
                    .iter_mut()
                    .find(|d| d.id == *device && d.removed.is_none());
                gone.ok_or(Bad::UnknownDevice)?.removed = Some((body.signer, body.at));
                if self.keys.contains(key) {
                    return Err(Bad::Chain);
                }
                self.keys.push(*key);
                Ok(())
            }
            Action::AddPasskey { passkey } => self.add_passkey(passkey),
            Action::RemovePasskey { id } => {
                let at = self
                    .passkeys
                    .iter()
                    .position(|p| p.id().as_deref() == Ok(id.as_slice()));
                let at = at.ok_or(Bad::UnknownPasskey)?;
                if self.passkeys.len() == 1 {
                    return Err(Bad::LastPasskey);
                }
                self.passkeys.remove(at);
                Ok(())
            }
        }
    }

    /// A passkey can't allow its own removal: whoever holds only that one is who it is removed against.
    fn may_allow(&self, action: &Action) -> Vec<Passkey> {
        let mut passkeys = self.passkeys.clone();
        if let Action::RemovePasskey { id } = action {
            passkeys.retain(|p| p.id().as_deref() != Ok(id.as_slice()));
        }
        passkeys
    }

    fn add_device(&mut self, device: Id, name: &str, body: &Body) -> Result<(), Bad> {
        if self.devices.iter().any(|d| d.id == device) {
            return Err(Bad::Known);
        }
        PublicKey::from_bytes(&device).map_err(|_| Bad::Malformed)?;
        check_name(name)?;
        self.devices.push(Device {
            id: device,
            name: name.to_string(),
            added_by: body.signer,
            at: body.at,
            removed: None,
        });
        Ok(())
    }

    fn add_passkey(&mut self, passkey: &Passkey) -> Result<(), Bad> {
        check_name(&passkey.label)?;
        passkey.usable()?;
        let id = passkey.id()?;
        if self.passkeys.len() >= MAX_PASSKEYS {
            return Err(Bad::Full);
        }
        if self.passkeys.iter().any(|p| p.id().as_ref() == Ok(&id)) {
            return Err(Bad::KnownPasskey);
        }
        self.passkeys.push(passkey.clone());
        Ok(())
    }

    fn member(&self, id: &Id) -> Option<&Device> {
        self.devices
            .iter()
            .find(|d| d.id == *id && d.removed.is_none())
    }

    fn active(&self) -> usize {
        self.devices.iter().filter(|d| d.removed.is_none()).count()
    }
}

/// Names are shown next to a code the person compares, so nothing in one may move or hide text.
pub fn check_name(name: &str) -> Result<(), Bad> {
    let plain = |c: char| c.is_alphanumeric() || " -_.'()&".contains(c);
    let ok = name.trim() == name
        && (1..=MAX_NAME).contains(&name.chars().count())
        && name.chars().all(plain);
    if ok {
        Ok(())
    } else {
        Err(Bad::Name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::Memory;
    use crate::support::Soft;

    /// The list's own memory of a counter, which no honest passkey lets a test reach from outside.
    #[test]
    fn a_passkeys_counter_must_go_up_along_the_list() {
        let me = Identity::load_or_create(&Memory::default()).unwrap();
        let mut soft = Soft::new();
        let passkey = soft.register("Key");
        let id = passkey.id().unwrap();
        let mut group = Group::create(&me, "Laptop", vec![passkey], &Key::random(), 1).unwrap();
        let mut allow = |group: &mut Group| {
            let new = Identity::load_or_create(&Memory::default()).unwrap();
            let action = Action::AddDevice {
                device: new.bytes(),
                name: "Desktop".into(),
            };
            let request = group.request(&me, action, 1).unwrap();
            let proof = soft.sign(request.passkeys(), &request.challenge());
            group.allow(&me, request, proof, 1)
        };
        allow(&mut group).unwrap();
        let seen = group.state.counters[&id];
        assert!(seen > 0);
        allow(&mut group).unwrap();
        assert!(group.state.counters[&id] > seen);
        group.state.counters.insert(id.clone(), 1000);
        assert_eq!(allow(&mut group), Err(Bad::Passkey(Refused::Counter)));
        assert_eq!(group.state.counters[&id], 1000);
    }
}
