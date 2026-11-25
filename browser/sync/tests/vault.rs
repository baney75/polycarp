//! What one device keeps: its group and key, its records and its rules, across restarts.

mod support;

use polycarp_sync::group::{Action, Bad};
use polycarp_sync::hlc::{Stamp, MAX_AHEAD_MS};
use polycarp_sync::policy::Skip;
use polycarp_sync::record::{Kind, Record};
use polycarp_sync::seal::Key;
use polycarp_sync::secret::Secret;
use polycarp_sync::store::{Store, StoreError};
use polycarp_sync::vault::{both_allow, Taken, Vault, VaultError};
use support::vaults::{add, allow, cookie, device, first, page, remove, vault, visit};
use support::Soft;

const NOW: u64 = 1_800_000_000_000;

fn group_error(e: VaultError) -> Bad {
    match e {
        VaultError::Group(bad) => bad,
        e => panic!("{e:?}"),
    }
}

/// A record as another device would send it.
fn sent(by: &Vault, kind: Kind, key: &str, value: Option<&str>, ms: u64) -> Record {
    let stamp = Stamp {
        ms,
        count: 0,
        device: by.identity.bytes(),
    };
    let value = value.map(|v| Secret::new(v.into()));
    Record {
        kind,
        key: key.into(),
        stamp,
        value,
    }
}

fn temp() -> std::path::PathBuf {
    let name = polycarp_sync::seal::random::<8>().map(|b| format!("{b:02x}"));
    std::env::temp_dir().join(format!("polycarp-sync-vault-{}", name.concat()))
}

#[test]
fn all_of_it_is_there_after_a_restart() {
    let (dir, me, mut soft) = (temp(), device(), Soft::new());
    let file = dir.join("sync.db");
    let open = || Vault::open(me.clone(), Store::open(&file, &me.storage).unwrap()).unwrap();
    let mut v = open();
    v.create("Laptop", vec![soft.register("Pass manager")], NOW)
        .unwrap();
    v.set_kind(Kind::Tab, false).unwrap();
    v.exclude("Bank.example", true).unwrap();
    assert_eq!(visit(&mut v, 1, NOW), Ok(true));
    assert_eq!(visit(&mut v, 2, NOW), Ok(true));
    let gone = "https://site.example/1";
    assert!(v.forget(Kind::History, gone, NOW).unwrap().unwrap());
    let other = device().bytes();
    v.note_peer(other, |p| p.synced = Some(7)).unwrap();
    let (group, key) = (v.group().unwrap().clone(), *v.key().unwrap().expose());
    let records: Vec<Record> = v.records().cloned().collect();
    let last = v.changes(0, 10_000).next;
    drop(v);

    let mut v = open();
    assert_eq!(v.group(), Some(&group));
    assert_eq!(v.key().unwrap().expose(), &key);
    assert_eq!(v.records().cloned().collect::<Vec<_>>(), records);
    assert!(!v.settings().on.contains(&Kind::Tab));
    assert!(v.settings().exclude.contains("bank.example"));
    assert_eq!(v.peer(&other).synced, Some(7));
    // The count of changes goes on, and so does the clock, even with the wall clock set back.
    assert_eq!(visit(&mut v, 1, 5), Ok(true));
    let page = v.changes(last, 10_000);
    assert_eq!((page.records.len(), page.next), (1, last + 1));
    assert!(page.records[0].stamp.ms >= NOW);
    drop(v);
    let stranger = device();
    let store = Store::open(&file, &stranger.storage).unwrap();
    assert!(matches!(
        Vault::open(stranger, store),
        Err(VaultError::Store(StoreError::Sealed))
    ));
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn one_group_at_a_time_and_only_with_its_own_key() {
    let mut soft = Soft::new();
    let mut a = first(&mut soft, NOW);
    let pk = soft.register("Another");
    assert!(matches!(
        a.create("Laptop", vec![pk], NOW),
        Err(VaultError::HasGroup)
    ));
    let (group, key) = (a.group().unwrap().clone(), a.key().unwrap().clone());
    // Not in the list, then in it with another key.
    let mut b = vault();
    assert!(matches!(
        b.join(group.clone(), key.clone()),
        Err(VaultError::Removed)
    ));
    assert!(matches!(
        a.join(group, key.clone()),
        Err(VaultError::HasGroup)
    ));
    let (device, name) = (b.identity.bytes(), "Desktop".to_string());
    allow(
        &mut soft,
        &mut a,
        Action::AddDevice { device, name },
        None,
        NOW,
    )
    .unwrap();
    let group = a.group().unwrap().clone();
    assert!(matches!(
        b.join(group.clone(), Key::random()),
        Err(VaultError::WrongKey)
    ));
    assert!(b.group().is_none() && !b.is_member(&a.identity.bytes()));
    b.join(group, key).unwrap();
    assert!(b.is_member(&a.identity.bytes()) && a.is_member(&device));
    assert!(matches!(
        b.take_key(Key::random()),
        Err(VaultError::WrongKey)
    ));
}

#[test]
fn removing_a_device_changes_the_key_and_shuts_it_out() {
    let mut soft = Soft::new();
    let mut a = first(&mut soft, NOW);
    let (mut b, mut c) = (vault(), vault());
    add(&mut soft, &mut a, &mut b, "Desktop", NOW);
    add(&mut soft, &mut a, &mut c, "Phone", NOW);
    b.extend(a.group().unwrap().entries()[2..].to_vec())
        .unwrap();
    let old = a.key().unwrap().clone();
    // A removal without the new key, or with one the list does not name, changes nothing.
    let id = c.identity.bytes();
    let action = Action::RemoveDevice {
        device: id,
        key: Key::random().commitment(),
    };
    assert!(matches!(
        allow(&mut soft, &mut a, action, None, NOW),
        Err(VaultError::WrongKey)
    ));
    assert!(a.is_member(&id));
    remove(&mut soft, &mut a, id, NOW).unwrap();
    assert_ne!(a.key().unwrap().expose(), old.expose());
    assert!(!a.is_member(&id));

    // The others learn of it from the list and need the new key before they have one to use.
    let news = a.group().unwrap().entries()[3..].to_vec();
    b.extend(news.clone()).unwrap();
    assert!(b.key().is_none() && !b.is_member(&id));
    assert!(matches!(b.take_key(old), Err(VaultError::WrongKey)));
    b.take_key(a.key().unwrap().clone()).unwrap();
    assert_eq!(b.key().unwrap().expose(), a.key().unwrap().expose());

    // The removed one, once it hears, is in no group: it counts no one as a member and asks for nothing.
    c.extend(news).unwrap();
    assert!(matches!(c.active(), Err(VaultError::Removed)));
    assert!(!c.is_member(&a.identity.bytes()) && c.key().is_none());
    let more = Action::AddDevice {
        device: device().bytes(),
        name: "X".into(),
    };
    assert!(matches!(c.request(more, NOW), Err(VaultError::Removed)));
    c.leave().unwrap();
    assert!(c.group().is_none());
}

#[test]
fn a_bad_list_is_not_kept() {
    let mut soft = Soft::new();
    let (mut a, mut b) = (first(&mut soft, NOW), vault());
    add(&mut soft, &mut a, &mut b, "Desktop", NOW);
    let before = b.group().cloned();
    let again = a.group().unwrap().entries()[1..].to_vec();
    assert_eq!(group_error(b.extend(again).unwrap_err()), Bad::Chain);
    assert_eq!(b.group().cloned(), before);
}

#[test]
fn what_the_browser_hands_over_is_checked() {
    let mut v = vault();
    let put = |v: &mut Vault, kind, json: &str| v.put(kind, json.as_bytes(), NOW).unwrap();
    let sid = cookie("a.example", "v1", NOW);
    assert_eq!(put(&mut v, Kind::Cookie, &sid), Err(Skip::TypeOff));
    v.set_kind(Kind::Cookie, true).unwrap();
    v.exclude("bank.example", true).unwrap();
    assert_eq!(put(&mut v, Kind::Cookie, &sid), Ok(true));
    assert_eq!(put(&mut v, Kind::Cookie, &sid), Ok(false), "the same again");
    let bank = cookie(".www.bank.example", "v", NOW);
    assert_eq!(put(&mut v, Kind::Cookie, &bank), Err(Skip::ExcludedSite));
    let session = r#"{"domain":"a.example","path":"/","name":"s","value":"v"}"#;
    assert_eq!(put(&mut v, Kind::Cookie, session), Err(Skip::Session));
    let expired = r#"{"domain":"a.example","path":"/","name":"s","value":"v","expires":5}"#;
    assert_eq!(put(&mut v, Kind::Cookie, expired), Err(Skip::Expired));
    assert_eq!(put(&mut v, Kind::Cookie, "{}"), Err(Skip::Invalid));
    let big = format!(
        r#"{{"url":"https://a.example/","title":"{}"}}"#,
        "x".repeat(300_000)
    );
    assert_eq!(put(&mut v, Kind::History, &big), Err(Skip::TooBig));
    assert_eq!(v.records().count(), 1);
    assert!(!v.exclude("not a site", true).unwrap());
}

#[test]
fn a_deletion_travels_and_a_made_up_one_does_not() {
    let mut v = vault();
    let url = "https://site.example/1";
    assert_eq!(v.forget(Kind::History, url, NOW).unwrap(), Ok(false));
    visit(&mut v, 1, NOW).unwrap();
    assert_eq!(v.forget(Kind::History, url, NOW).unwrap(), Ok(true));
    assert_eq!(v.forget(Kind::History, url, NOW).unwrap(), Ok(false));
    assert!(v.get(Kind::History, url).unwrap().value.is_none());
    assert_eq!(
        v.forget(Kind::History, "a\nb", NOW).unwrap(),
        Err(Skip::Invalid)
    );
}

#[test]
fn turning_a_type_off_forgets_it_here_and_deletes_it_nowhere() {
    let mut v = vault();
    v.set_kind(Kind::Cookie, true).unwrap();
    for (domain, n) in [("a.example", 1), (".bank.example", 2)] {
        visit(&mut v, n, NOW).unwrap();
        v.put(Kind::Cookie, cookie(domain, "planted", NOW).as_bytes(), NOW)
            .unwrap()
            .unwrap();
    }
    let count = |v: &Vault, k| v.records().filter(|r| r.kind == k).count();
    v.exclude("bank.example", true).unwrap();
    assert_eq!(
        (count(&v, Kind::Cookie), count(&v, Kind::History)),
        (1, 2),
        "an excluded site's cookies go"
    );
    v.set_kind(Kind::Cookie, false).unwrap();
    assert_eq!(count(&v, Kind::Cookie), 0);
    // Forgotten, not deleted: no tombstone, and nothing for the browser to delete.
    let page = v.changes(0, 100_000);
    assert!(page.records.iter().all(|r| r.kind == Kind::History));
    v.exclude("bank.example", false).unwrap();
    assert!(v.settings().exclude.is_empty());
    // Back on, the same item is one change, not two.
    v.set_kind(Kind::Cookie, true).unwrap();
    let sid = cookie("a.example", "planted", NOW);
    assert_eq!(v.put(Kind::Cookie, sid.as_bytes(), NOW).unwrap(), Ok(true));
    let of_cookies = |r: &&Record| r.kind == Kind::Cookie;
    let page = v.changes(0, 100_000);
    assert_eq!(page.records.iter().filter(of_cookies).count(), 1);
}

#[test]
fn records_from_another_device_meet_this_ones_rules() {
    let mut soft = Soft::new();
    let (mut a, mut b) = (first(&mut soft, NOW), vault());
    add(&mut soft, &mut a, &mut b, "Desktop", NOW);
    let history = |ms| {
        sent(
            &b,
            Kind::History,
            "https://site.example/1",
            Some(&page(1)),
            ms,
        )
    };
    let refused = Taken {
        changed: 0,
        refused: 1,
    };
    let outsider = vault();
    let of_outsider = sent(
        &outsider,
        Kind::History,
        "https://site.example/1",
        Some(&page(1)),
        NOW,
    );
    let sid = cookie("a.example", "v", NOW);
    let a_cookie = sent(&b, Kind::Cookie, "a.example;/;sid", Some(&sid), NOW);
    let wrong_name = sent(
        &b,
        Kind::History,
        "https://other.example/",
        Some(&page(1)),
        NOW,
    );
    for (why, r) in [
        ("a device not in the list", of_outsider),
        ("a type that is off here", a_cookie.clone()),
        ("a key its value does not give", wrong_name),
        ("a clock far ahead", history(NOW + MAX_AHEAD_MS + 1)),
    ] {
        assert_eq!(a.take(vec![r], NOW).unwrap(), refused, "{why}");
    }
    a.set_kind(Kind::Cookie, true).unwrap();
    a.exclude("bank.example", true).unwrap();
    let session = r#"{"domain":"a.example","path":"/","name":"s","value":"v"}"#;
    let session = sent(&b, Kind::Cookie, "a.example;/;s", Some(session), NOW);
    let bank = cookie("bank.example", "v", NOW);
    let bank = sent(&b, Kind::Cookie, "bank.example;/;sid", Some(&bank), NOW);
    for (why, r) in [("a session cookie", session), ("an excluded site", bank)] {
        assert_eq!(a.take(vec![r], NOW).unwrap(), refused, "{why}");
    }
    assert_eq!(a.records().count(), 0);
    let taken = |changed| Taken {
        changed,
        refused: 0,
    };
    assert_eq!(a.take(vec![a_cookie, history(NOW)], NOW).unwrap(), taken(2));
    assert_eq!(a.take(vec![history(NOW)], NOW).unwrap(), taken(0));
    // This device's next write is later than all it took, whatever its own clock says.
    visit(&mut a, 1, 5).ok();
    assert!(a
        .forget(Kind::History, "https://site.example/1", 5)
        .unwrap()
        .unwrap());
    let held = a.get(Kind::History, "https://site.example/1").unwrap();
    assert!(held.value.is_none() && held.stamp > history(NOW).stamp);
}

#[test]
fn the_browser_gets_every_change_once_in_pages() {
    let mut v = vault();
    for n in 0..50 {
        visit(&mut v, n, NOW).unwrap();
    }
    let url = "https://site.example/3";
    v.forget(Kind::History, url, NOW).unwrap().unwrap();
    let (mut since, mut seen, mut pages) = (0, Vec::new(), 0);
    loop {
        let page = v.changes(since, 2_000);
        assert!(!page.records.is_empty() && page.next > since);
        seen.extend(page.records.iter().map(|r| r.key.clone()));
        (since, pages) = (page.next, pages + 1);
        if !page.more {
            break;
        }
    }
    assert!(pages > 2);
    let mut once = seen.clone();
    once.sort();
    once.dedup();
    assert_eq!((seen.len(), once.len()), (50, 50));
    assert_eq!(seen.last().unwrap(), url, "its last change, not its first");
    assert!(v.changes(since, 2_000).records.is_empty());
    // One record larger than a page still goes.
    assert_eq!(v.changes(0, 1).records.len(), 1);
    assert!(v.changes(u64::MAX, 1).records.is_empty());
}

#[test]
fn a_removed_device_leaves_with_what_it_takes() {
    let mut v = vault();
    visit(&mut v, 1, NOW).unwrap();
    visit(&mut v, 2, NOW).unwrap();
    v.forget(Kind::History, "https://site.example/2", NOW)
        .unwrap()
        .unwrap();
    let bookmark = br#"{"id":"b1","title":"One"}"#;
    v.put(Kind::Bookmark, bookmark, NOW).unwrap().unwrap();
    let id = device().bytes();
    assert_eq!(v.had(&id), None, "never synced from here");
    let mut takes = v.settings().clone();
    takes.on.remove(&Kind::Bookmark);
    v.note_peer(id, |p| p.takes = Some(takes)).unwrap();
    assert_eq!(
        v.had(&id).unwrap().into_iter().collect::<Vec<_>>(),
        [(Kind::History, 1)]
    );
}

#[test]
fn both_devices_must_want_a_record() {
    let v = vault();
    let on = v.settings().clone();
    let mut off = on.clone();
    off.on.remove(&Kind::History);
    let r = sent(
        &v,
        Kind::History,
        "https://site.example/1",
        Some(&page(1)),
        1,
    );
    assert!(both_allow(&on, &on, &r));
    assert!(!both_allow(&off, &on, &r) && !both_allow(&on, &off, &r));
}
