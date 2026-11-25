//! Merging is commutative, associative and idempotent, whatever the records are.

use polycarp_sync::hlc::{Clock, Stamp};
use polycarp_sync::record::{Kind, Record, Records};
use polycarp_sync::secret::Secret;
use proptest::prelude::*;

/// Few keys, few stamps and few values, so clashes and exact ties are common.
fn record() -> impl Strategy<Value = Record> {
    let kind = prop::sample::select(Kind::ALL.to_vec());
    (
        kind,
        0..3u8,
        0..4u64,
        0..2u32,
        0..3u8,
        prop::option::of(0..3u8),
    )
        .prop_map(|(kind, key, ms, count, dev, v)| Record {
            kind,
            key: format!("k{key}"),
            stamp: Stamp {
                ms,
                count,
                device: [dev; 32],
            },
            value: v.map(|v| Secret::new(vec![v])),
        })
}

fn records() -> impl Strategy<Value = Vec<Record>> {
    prop::collection::vec(record(), 0..40)
}

fn join<'a>(sets: impl IntoIterator<Item = &'a Vec<Record>>) -> Records {
    let mut all = Records::new();
    for r in sets.into_iter().flatten() {
        all.merge(r.clone());
    }
    all
}

fn both(a: &Records, b: &Records) -> Records {
    let mut out = a.clone();
    for r in b.iter() {
        out.merge(r.clone());
    }
    out
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(2000))]

    #[test]
    fn commutative(a in records(), b in records()) {
        let (a, b) = (join([&a]), join([&b]));
        prop_assert_eq!(both(&a, &b), both(&b, &a));
    }

    #[test]
    fn associative(a in records(), b in records(), c in records()) {
        let (a, b, c) = (join([&a]), join([&b]), join([&c]));
        prop_assert_eq!(both(&both(&a, &b), &c), both(&a, &both(&b, &c)));
    }

    #[test]
    fn idempotent(a in records()) {
        let a = join([&a]);
        prop_assert_eq!(both(&a, &a), a.clone());
        let mut again = a.clone();
        for r in a.iter() {
            prop_assert!(!again.merge(r.clone()), "a record already held changed something");
        }
    }

    #[test]
    fn any_order_gives_the_same_set(a in records().prop_shuffle(), seed in any::<u64>()) {
        let mut b = a.clone();
        let n = b.len().max(1);
        b.rotate_left(seed as usize % n);
        b.reverse();
        prop_assert_eq!(join([&a]), join([&b]));
    }

    /// The newest write stays, and a deletion is a write: an older value never brings a deleted thing back.
    #[test]
    fn the_last_write_wins(a in records()) {
        let set = join([&a]);
        for r in &a {
            prop_assert!(set.get(r.kind, &r.key).unwrap().stamp >= r.stamp);
        }
    }
}

#[test]
fn a_deletion_beats_the_older_value_and_loses_to_a_newer_one() {
    let mut clock = Clock::new([1; 32]);
    let mut at = |value: Option<&[u8]>| Record {
        kind: Kind::Bookmark,
        key: "b".into(),
        stamp: clock.tick(5).unwrap(),
        value: value.map(|v| Secret::new(v.to_vec())),
    };
    let (first, gone, back) = (at(Some(b"1")), at(None), at(Some(b"2")));
    let mut set = Records::new();
    set.merge(gone.clone());
    assert!(
        !set.merge(first.clone()),
        "the older value came back after its deletion"
    );
    assert!(set.get(Kind::Bookmark, "b").unwrap().value.is_none());
    assert!(set.merge(back.clone()));
    assert!(!set.merge(gone));
    assert_eq!(set.get(Kind::Bookmark, "b").unwrap().value, back.value);
}

/// The wall clock was a year ahead for one edit, then right again, with and without a restart between.
#[test]
fn a_clock_that_was_wrong_once_is_not_wrong_for_good() {
    let (now, year) = (1_000_000_000_000, 365 * 86_400_000);
    let record = |key: &str, stamp| Record {
        kind: Kind::Setting,
        key: key.into(),
        stamp,
        value: None,
    };
    for restart in [false, true] {
        let mut clock = Clock::new([1; 32]);
        let mut set = Records::new();
        set.merge(record("before", clock.tick(now + 1000).unwrap()));
        set.merge(record("wrong", clock.tick(now + year).unwrap()));
        if restart {
            clock = Clock::new([1; 32]);
            set.iter().for_each(|r| clock.restore(&r.stamp));
        }
        assert!(clock.tick(now).is_err());
        // With another device's stamp ahead too, the wall clock may be behind: nothing changes.
        let theirs = Clock::new([2; 32]).tick(now + year).unwrap();
        let (mut both, mut held) = (set.clone(), clock.clone());
        both.merge(record("theirs", theirs));
        let before = both.clone();
        assert!(both.restamp(&mut held, now).is_err() && held.tick(now).is_err());
        assert_eq!(both, before);
        let again = set.restamp(&mut clock, now).unwrap();
        assert_eq!(set.get(Kind::Setting, "wrong"), again.first());
        // Another device takes it all, and this one can write over it all.
        for r in set.clone().iter() {
            Clock::new([2; 32]).see(&r.stamp, now).unwrap();
            assert!(set.merge(record(&r.key, clock.tick(now).unwrap())));
        }
    }
}
