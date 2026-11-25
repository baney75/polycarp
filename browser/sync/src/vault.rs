//! Everything one device knows: its group and key, its records, what it agrees to sync, and its peers.

use crate::group::{Action, Bad, Entry, Group, Id, Request};
use crate::hlc::Clock;
use crate::keys::Identity;
use crate::passkey::{Passkey, Proof};
use crate::policy::{record_movable, Settings, Skip};
use crate::record::{check_key, key_of, Kind, Record, Records, MAX_VALUE};
use crate::seal::Key;
use crate::secret::Secret;
use crate::store::{Store, StoreError};
use iroh_base::EndpointAddr;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;

#[derive(Debug)]
pub enum VaultError {
    Store(StoreError),
    Group(Bad),
    /// There is no group here yet.
    NoGroup,
    /// There is a group here already.
    HasGroup,
    /// This device was removed from its group.
    Removed,
    /// The group key given does not match the member list.
    WrongKey,
}

impl fmt::Display for VaultError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            VaultError::Store(e) => e.fmt(f),
            VaultError::Group(e) => e.fmt(f),
            VaultError::NoGroup => {
                f.write_str("this device is not in a group; create one or join one")
            }
            VaultError::HasGroup => {
                f.write_str("this device is already in a group; leave it first")
            }
            VaultError::Removed => {
                f.write_str("this device was removed from its group; leave, then join again")
            }
            VaultError::WrongKey => f.write_str("the group key does not match the device list"),
        }
    }
}

impl From<StoreError> for VaultError {
    fn from(e: StoreError) -> Self {
        VaultError::Store(e)
    }
}

impl From<Bad> for VaultError {
    fn from(e: Bad) -> Self {
        VaultError::Group(e)
    }
}

/// What this device remembers about another.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Peer {
    pub addr: Option<EndpointAddr>,
    /// What it last said it takes.
    pub takes: Option<Settings>,
    /// When the two last synced, in ms.
    pub synced: Option<u64>,
}

/// What the browser says: an item as it has it now, or the key of one it deleted.
pub enum Item {
    Now(Kind, Secret),
    Gone(Kind, String),
}

/// One page of changes for the browser.
pub struct Changes {
    pub records: Vec<Record>,
    /// Where the next page starts.
    pub next: u64,
    pub more: bool,
}

/// What came of taking records from another device.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Taken {
    pub changed: usize,
    /// Off here, excluded here, or against a rule.
    pub refused: usize,
}

pub struct Vault {
    pub identity: Identity,
    store: Store,
    group: Option<Group>,
    key: Option<Key>,
    settings: Settings,
    peers: BTreeMap<Id, Peer>,
    records: Records,
    clock: Clock,
    /// Counts every change to a record on this device, so the browser can ask for what is new.
    rev: u64,
    by_rev: BTreeMap<u64, (Kind, String)>,
    revs: BTreeMap<(Kind, String), u64>,
}

impl fmt::Debug for Vault {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Vault({})", self.identity.id().fmt_short())
    }
}

impl Vault {
    pub fn open(identity: Identity, store: Store) -> Result<Vault, VaultError> {
        let damaged = |_| StoreError::Sealed;
        let group = match store.get("group")? {
            Some(list) => Some(Group::read(
                postcard::from_bytes(list.expose()).map_err(damaged)?,
            )?),
            None => None,
        };
        let key = store.get("key")?.and_then(|k| Key::from_bytes(k.expose()));
        let settings = match store.get("settings")? {
            Some(s) => serde_json::from_slice(s.expose()).map_err(|_| StoreError::Sealed)?,
            None => Settings::default(),
        };
        let peers = match store.get("peers")? {
            Some(p) => postcard::from_bytes(p.expose()).map_err(damaged)?,
            None => BTreeMap::new(),
        };
        let mut vault = Vault {
            clock: Clock::new(identity.bytes()),
            identity,
            group,
            key,
            settings,
            peers,
            records: Records::new(),
            rev: 0,
            by_rev: BTreeMap::new(),
            revs: BTreeMap::new(),
            store,
        };
        for (rev, record) in vault.store.records()? {
            let _ = vault.clock.see(&record.stamp, u64::MAX);
            vault.index(rev, (record.kind, record.key.clone()));
            vault.records.merge(record);
        }
        Ok(vault)
    }

    // The group.

    pub fn group(&self) -> Option<&Group> {
        self.group.as_ref()
    }

    /// The group, while this device is in it.
    pub fn active(&self) -> Result<&Group, VaultError> {
        let group = self.group.as_ref().ok_or(VaultError::NoGroup)?;
        match group.member(&self.identity.bytes()) {
            Some(_) => Ok(group),
            None => Err(VaultError::Removed),
        }
    }

    /// The group key, if this device has the one in use.
    pub fn key(&self) -> Option<&Key> {
        let (_, commitment) = self.group.as_ref()?.key();
        self.key.as_ref().filter(|k| k.commitment() == *commitment)
    }

    pub fn is_member(&self, id: &Id) -> bool {
        self.active().is_ok_and(|g| g.member(id).is_some())
    }

    pub fn create(
        &mut self,
        name: &str,
        passkeys: Vec<Passkey>,
        now: u64,
    ) -> Result<(), VaultError> {
        if self.group.is_some() {
            return Err(VaultError::HasGroup);
        }
        let key = Key::random();
        let group = Group::create(&self.identity, name, passkeys, &key, now)?;
        self.keep(group, Some(key))
    }

    /// Joins the group another device added this one to.
    pub fn join(&mut self, group: Group, key: Key) -> Result<(), VaultError> {
        if self.group.is_some() {
            return Err(VaultError::HasGroup);
        }
        if group.member(&self.identity.bytes()).is_none() {
            return Err(VaultError::Removed);
        }
        if key.commitment() != *group.key().1 {
            return Err(VaultError::WrongKey);
        }
        self.keep(group, Some(key))
    }

    /// A change to ask a passkey for, with the new group key when the change brings one.
    pub fn request(&self, action: Action, now: u64) -> Result<Request, VaultError> {
        Ok(self.active()?.request(&self.identity, action, now)?)
    }

    /// The change a passkey allowed. `key` is the new group key when a device was removed.
    pub fn allow(
        &mut self,
        request: Request,
        proof: Proof,
        key: Option<Key>,
        now: u64,
    ) -> Result<(), VaultError> {
        let mut group = self.active()?.clone();
        group.allow(&self.identity, request, proof, now)?;
        let key = key.or_else(|| self.key.clone());
        if key
            .as_ref()
            .is_none_or(|k| k.commitment() != *group.key().1)
        {
            return Err(VaultError::WrongKey);
        }
        self.keep(group, key)
    }

    /// Entries from another member.
    pub fn extend(&mut self, entries: Vec<Entry>) -> Result<(), VaultError> {
        if entries.is_empty() {
            return Ok(());
        }
        let mut group = self.active()?.clone();
        group.extend(entries)?;
        let key = self.key.clone();
        self.keep(group, key)
    }

    /// The group key from another member, after the list that names it.
    pub fn take_key(&mut self, key: Key) -> Result<(), VaultError> {
        let group = self.active()?.clone();
        if key.commitment() != *group.key().1 {
            return Err(VaultError::WrongKey);
        }
        self.keep(group, Some(key))
    }

    fn keep(&mut self, group: Group, key: Option<Key>) -> Result<(), VaultError> {
        let list = postcard::to_stdvec(group.entries()).expect("a list is plain data");
        let mut both: Vec<(&str, &[u8])> = vec![("group", &list)];
        if let Some(key) = &key {
            both.push(("key", key.expose()));
        }
        self.store.put_all(&both)?;
        (self.group, self.key) = (Some(group), key);
        Ok(())
    }

    /// Leaves the group and forgets everything synced here. Other devices keep their copies.
    pub fn leave(&mut self) -> Result<(), VaultError> {
        self.store.wipe()?;
        (self.group, self.key) = (None, None);
        (self.settings, self.records) = (Settings::default(), Records::new());
        (self.peers, self.by_rev, self.revs) = Default::default();
        Ok(())
    }

    // Peers.

    pub fn peer(&self, id: &Id) -> Peer {
        self.peers.get(id).cloned().unwrap_or_default()
    }

    pub fn note_peer(&mut self, id: Id, change: impl FnOnce(&mut Peer)) -> Result<(), VaultError> {
        change(self.peers.entry(id).or_default());
        self.store.put(
            "peers",
            &postcard::to_stdvec(&self.peers).expect("peers are plain data"),
        )?;
        Ok(())
    }

    /// How many records of each type a device was sent or could have been sent by this one: what it keeps when it is
    /// removed. None when the two never synced, which says nothing about what others sent it.
    pub fn had(&self, id: &Id) -> Option<BTreeMap<Kind, usize>> {
        let peer = self.peers.get(id)?;
        let takes = peer.takes.as_ref()?;
        let mut had = BTreeMap::new();
        for record in self
            .records
            .iter()
            .filter(|r| r.value.is_some() && takes.allows(r).is_ok())
        {
            *had.entry(record.kind).or_default() += 1;
        }
        Some(had)
    }

    // What syncs here.

    pub fn settings(&self) -> &Settings {
        &self.settings
    }

    /// Turns a type on or off. Off also forgets this device's copies, and deletes nothing anywhere else.
    pub fn set_kind(&mut self, kind: Kind, on: bool) -> Result<(), VaultError> {
        let mut settings = self.settings.clone();
        if on {
            settings.on.insert(kind);
        } else {
            settings.on.remove(&kind);
        }
        self.set(settings)
    }

    /// Adds or takes away a site whose cookies stay out of it.
    pub fn exclude(&mut self, site: &str, excluded: bool) -> Result<bool, VaultError> {
        let mut settings = self.settings.clone();
        let mut named = Settings::default();
        if named.exclude_site(site).is_err() {
            return Ok(false);
        }
        for site in named.exclude {
            if excluded {
                settings.exclude.insert(site);
            } else {
                settings.exclude.remove(&site);
            }
        }
        self.set(settings)?;
        Ok(true)
    }

    fn set(&mut self, settings: Settings) -> Result<(), VaultError> {
        self.store.put(
            "settings",
            &serde_json::to_vec(&settings).expect("settings are plain data"),
        )?;
        self.settings = settings;
        let off = |r: &&Record| self.settings.allows(r).is_err();
        self.store.drop_records(self.records.iter().filter(off))?;
        let (settings, records) = (&self.settings, &mut self.records);
        records.retain(|r| settings.allows(r).is_ok());
        let kept = |at: &(Kind, String)| self.records.get(at.0, &at.1).is_some();
        self.by_rev.retain(|_, at| kept(at));
        self.revs.retain(|at, _| kept(at));
        Ok(())
    }

    // Records.

    pub fn records(&self) -> impl Iterator<Item = &Record> {
        self.records.iter()
    }

    pub fn get(&self, kind: Kind, key: &str) -> Option<&Record> {
        self.records.get(kind, key)
    }

    /// What the browser has to say, in one step. True for each that is news. `now` is this device's clock, in ms.
    pub fn put_all(
        &mut self,
        items: Vec<Item>,
        now: u64,
    ) -> Result<Vec<Result<bool, Skip>>, VaultError> {
        let mut news = Vec::new();
        let mut said = Vec::new();
        for item in items {
            let record = self.news(item, now);
            said.push(record.as_ref().map(Option::is_some).map_err(|why| *why));
            news.extend(record.ok().flatten());
        }
        self.merge(news)?;
        Ok(said)
    }

    pub fn put(
        &mut self,
        kind: Kind,
        json: &[u8],
        now: u64,
    ) -> Result<Result<bool, Skip>, VaultError> {
        let item = Item::Now(kind, Secret::new(json.to_vec()));
        Ok(self.put_all(vec![item], now)?.remove(0))
    }

    pub fn forget(
        &mut self,
        kind: Kind,
        key: &str,
        now: u64,
    ) -> Result<Result<bool, Skip>, VaultError> {
        let item = Item::Gone(kind, key.to_string());
        Ok(self.put_all(vec![item], now)?.remove(0))
    }

    /// The record an item makes, when it says something new. Deleting what was never synced says nothing.
    fn news(&mut self, item: Item, now: u64) -> Result<Option<Record>, Skip> {
        let (kind, key, value) = match item {
            Item::Now(_, json) if json.len() > MAX_VALUE => return Err(Skip::TooBig),
            Item::Now(kind, json) => {
                let key = key_of(kind, json.expose()).map_err(|_| Skip::Invalid)?;
                (kind, key, Some(json))
            }
            Item::Gone(kind, key) => {
                check_key(&key).map_err(|_| Skip::Invalid)?;
                (kind, key, None)
            }
        };
        match self.records.get(kind, &key) {
            Some(held) if held.value == value => return Ok(None),
            None if value.is_none() => return Ok(None),
            _ => {}
        }
        let record = Record {
            kind,
            key,
            stamp: self.clock.tick(now),
            value,
        };
        let seconds = now as f64 / 1000.0;
        if let Err(why) = self
            .settings
            .allows(&record)
            .and_then(|()| record_movable(&record, Some(seconds)))
        {
            return Ok(Err(why));
        }
        self.merge(vec![record])?;
        Ok(Ok(true))
    }

    /// Records from another member, each checked against this device's own rules whatever the sender's are.
    pub fn take(&mut self, records: Vec<Record>, now: u64) -> Result<Taken, VaultError> {
        let mut good = Vec::new();
        let mut taken = Taken::default();
        for record in records {
            let known = self
                .active()?
                .devices()
                .iter()
                .any(|d| d.id == record.stamp.device);
            let ok = known
                && record.check().is_ok()
                && self.settings.allows(&record).is_ok()
                && record_movable(&record, None).is_ok()
                && self.clock.see(&record.stamp, now).is_ok();
            match ok {
                true => good.push(record),
                false => taken.refused += 1,
            }
        }
        taken.changed = self.merge(good)?;
        Ok(taken)
    }

    fn merge(&mut self, records: Vec<Record>) -> Result<usize, VaultError> {
        let mut changed = Vec::new();
        for record in records {
            if self.records.merge(record.clone()) {
                self.rev += 1;
                self.index(self.rev, (record.kind, record.key.clone()));
                changed.push((self.rev, record));
            }
        }
        // Only the last version of a record that changed twice still has its number.
        changed.retain(|(rev, _)| self.by_rev.contains_key(rev));
        self.store
            .put_records(changed.iter().map(|(rev, r)| (*rev, r)))?;
        Ok(changed.len())
    }

    fn index(&mut self, rev: u64, at: (Kind, String)) {
        if let Some(old) = self.revs.insert(at.clone(), rev) {
            self.by_rev.remove(&old);
        }
        self.by_rev.insert(rev, at);
        self.rev = self.rev.max(rev);
    }

    /// What changed here after `since`, up to about `limit` bytes of values.
    pub fn changes(&self, since: u64, limit: usize) -> Changes {
        let mut page = Changes {
            records: Vec::new(),
            next: since,
            more: false,
        };
        let mut size = 0;
        for (rev, (kind, key)) in self.by_rev.range(since.saturating_add(1)..) {
            let Some(record) = self.records.get(*kind, key) else {
                continue;
            };
            size += record.key.len() + record.value.as_ref().map_or(0, Secret::len) + 200;
            if size > limit && !page.records.is_empty() {
                page.more = true;
                break;
            }
            page.records.push(record.clone());
            page.next = *rev;
        }
        page
    }
}

/// What a device sends and takes, for one other: a type must be on at both and a site excluded at neither.
pub fn both_allow(ours: &Settings, theirs: &Settings, record: &Record) -> bool {
    ours.allows(record).is_ok() && theirs.allows(record).is_ok()
}
