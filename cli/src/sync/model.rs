//! What sync moves and how two copies become one, as pure functions: no file, clock or network here.
//!
//! A bundle holds the items of one kind (settings, bookmarks, cookies, prefs, extensions), each keyed by a stable id
//! with its value, the time it last changed and the device that changed it. A delete is a tombstone (no value), kept
//! for 90 days so a device that was away still hears of it. Two copies merge item by item: the newer time wins, and on
//! the same time the greater device id wins, so every device reaches the same answer in any order.

use serde::{Deserialize, Serialize};
use serde_json::Value as Json;
use std::collections::BTreeMap;

/// How long a tombstone is kept, in milliseconds: 90 days.
pub const TOMBSTONE_MS: u64 = 90 * 24 * 60 * 60 * 1000;

/// The kinds of bundle. Each is its own encrypted file on the relay.
pub const KINDS: [&str; 5] = ["settings", "bookmarks", "cookies", "prefs", "extensions"];

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Item {
    /// The value, or None for a tombstone. On the wire a tombstone has no `value` key, so a JSON null is a value.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub value: Option<Json>,
    /// Milliseconds since 1970 when this value was made.
    pub updated: u64,
    /// The id of the device that made it.
    pub device: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Bundle {
    pub kind: String,
    pub items: BTreeMap<String, Item>,
}

fn present<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Json>, D::Error> {
    Json::deserialize(d).map(Some)
}

/// True when `a` beats `b`: newer, or the same time from a greater device id. Two devices that share an id (a cloned
/// disk) can still make the same stamp with different values, so the value's text decides last, and a tombstone loses.
pub fn wins(a: &Item, b: &Item) -> bool {
    let text = |i: &Item| i.value.as_ref().map(Json::to_string);
    (a.updated, a.device.as_str(), text(a)) > (b.updated, b.device.as_str(), text(b))
}

/// One bundle from two, item by item. Pure, and the same answer whichever side comes first.
pub fn merge(a: &Bundle, b: &Bundle) -> Bundle {
    let mut items = a.items.clone();
    for (id, theirs) in &b.items {
        match items.get(id) {
            Some(ours) if !wins(theirs, ours) => {}
            _ => {
                items.insert(id.clone(), theirs.clone());
            }
        }
    }
    Bundle {
        kind: a.kind.clone(),
        items,
    }
}

/// Drops tombstones older than 90 days at `now`.
pub fn prune(b: &mut Bundle, now: u64) {
    b.items
        .retain(|_, it| it.value.is_some() || now.saturating_sub(it.updated) < TOMBSTONE_MS);
}

/// What this device holds now, stamped against what it held after the last sync (`last`). A value that is the same
/// keeps its old stamp; a new or changed value is stamped `now` by `device`; an id that was there and is gone becomes
/// a tombstone. A stamp never goes back past the one it replaces, so a clock set back can't lose a local edit.
pub fn observe(last: &Bundle, local: &BTreeMap<String, Json>, now: u64, device: &str) -> Bundle {
    let stamp = |prev: Option<&Item>| Item {
        value: None,
        updated: prev.map_or(now, |p| now.max(p.updated + 1)),
        device: device.to_string(),
    };
    let mut items = BTreeMap::new();
    for (id, v) in local {
        let prev = last.items.get(id);
        let item = match prev {
            Some(p) if p.value.as_ref() == Some(v) => p.clone(),
            _ => Item {
                value: Some(v.clone()),
                ..stamp(prev)
            },
        };
        items.insert(id.clone(), item);
    }
    for (id, p) in &last.items {
        if items.contains_key(id) {
            continue;
        }
        let item = if p.value.is_some() {
            stamp(Some(p))
        } else {
            p.clone()
        };
        items.insert(id.clone(), item);
    }
    Bundle {
        kind: last.kind.clone(),
        items,
    }
}

/// The live values of a bundle, tombstones left out.
pub fn values(b: &Bundle) -> BTreeMap<String, Json> {
    b.items
        .iter()
        .filter_map(|(id, it)| it.value.clone().map(|v| (id.clone(), v)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn item(v: Option<Json>, t: u64, d: &str) -> Item {
        Item {
            value: v,
            updated: t,
            device: d.into(),
        }
    }
    fn bundle(items: &[(&str, Item)]) -> Bundle {
        Bundle {
            kind: "settings".into(),
            items: items
                .iter()
                .map(|(k, v)| (k.to_string(), v.clone()))
                .collect(),
        }
    }
    fn local(pairs: &[(&str, Json)]) -> BTreeMap<String, Json> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect()
    }

    /// The design's case table, at the level of one merge.
    #[test]
    fn the_merge_case_table() {
        struct Case {
            name: &'static str,
            a: Bundle,
            b: Bundle,
            want: Bundle,
        }
        let cases = [
            Case {
                name: "two devices edit different settings: both edits on both",
                a: bundle(&[("x", item(Some(json!(1)), 10, "A"))]),
                b: bundle(&[("y", item(Some(json!(2)), 11, "B"))]),
                want: bundle(&[
                    ("x", item(Some(json!(1)), 10, "A")),
                    ("y", item(Some(json!(2)), 11, "B")),
                ]),
            },
            Case {
                name: "two devices edit the same setting: newest wins",
                a: bundle(&[("x", item(Some(json!(1)), 10, "A"))]),
                b: bundle(&[("x", item(Some(json!(2)), 11, "B"))]),
                want: bundle(&[("x", item(Some(json!(2)), 11, "B"))]),
            },
            Case {
                name: "the same time: the greater device id breaks the tie",
                a: bundle(&[("x", item(Some(json!(1)), 10, "B"))]),
                b: bundle(&[("x", item(Some(json!(2)), 10, "A"))]),
                want: bundle(&[("x", item(Some(json!(1)), 10, "B"))]),
            },
            Case {
                name: "deleted on A after B's value: the tombstone wins",
                a: bundle(&[("c", item(None, 20, "A"))]),
                b: bundle(&[("c", item(Some(json!("v")), 10, "B"))]),
                want: bundle(&[("c", item(None, 20, "A"))]),
            },
            Case {
                name: "set again after a delete: the newer value wins",
                a: bundle(&[("c", item(None, 20, "A"))]),
                b: bundle(&[("c", item(Some(json!("v")), 30, "B"))]),
                want: bundle(&[("c", item(Some(json!("v")), 30, "B"))]),
            },
        ];
        for c in cases {
            assert_eq!(merge(&c.a, &c.b), c.want, "{}", c.name);
            assert_eq!(merge(&c.b, &c.a), c.want, "{} (other order)", c.name);
        }
    }

    #[test]
    fn a_null_value_is_not_a_tombstone_on_the_wire() {
        let b = bundle(&[
            ("null", item(Some(Json::Null), 1, "A")),
            ("dead", item(None, 1, "A")),
        ]);
        let wire = serde_json::to_string(&b).unwrap();
        assert_eq!(serde_json::from_str::<Bundle>(&wire).unwrap(), b);
    }

    #[test]
    fn one_stamp_with_two_values_merges_the_same_either_way() {
        let a = bundle(&[("x", item(Some(json!(1)), 10, "A"))]);
        let b = bundle(&[("x", item(Some(json!(2)), 10, "A"))]);
        let c = bundle(&[("x", item(None, 10, "A"))]);
        assert_eq!(merge(&a, &b), merge(&b, &a));
        assert_eq!(merge(&a, &c), merge(&c, &a));
        assert_eq!(merge(&a, &c), a);
    }

    #[test]
    fn merging_is_idempotent_and_associative() {
        let a = bundle(&[("x", item(Some(json!(1)), 10, "A"))]);
        let b = bundle(&[("x", item(Some(json!(2)), 12, "B"))]);
        let c = bundle(&[("x", item(None, 11, "C")), ("y", item(None, 1, "C"))]);
        assert_eq!(merge(&a, &a), a);
        assert_eq!(merge(&merge(&a, &b), &c), merge(&a, &merge(&b, &c)));
    }

    #[test]
    fn observe_stamps_only_what_changed() {
        let last = bundle(&[
            ("same", item(Some(json!(1)), 5, "B")),
            ("edit", item(Some(json!(1)), 5, "B")),
            ("gone", item(Some(json!(1)), 5, "B")),
            ("dead", item(None, 4, "B")),
        ]);
        let got = observe(
            &last,
            &local(&[("same", json!(1)), ("edit", json!(2)), ("new", json!(3))]),
            100,
            "A",
        );
        assert_eq!(got.items["same"], item(Some(json!(1)), 5, "B"));
        assert_eq!(got.items["edit"], item(Some(json!(2)), 100, "A"));
        assert_eq!(got.items["new"], item(Some(json!(3)), 100, "A"));
        assert_eq!(got.items["gone"], item(None, 100, "A"));
        assert_eq!(got.items["dead"], item(None, 4, "B"));
    }

    #[test]
    fn a_clock_set_back_still_moves_a_local_edit_forward() {
        let last = bundle(&[("x", item(Some(json!(1)), 500, "B"))]);
        let got = observe(&last, &local(&[("x", json!(2))]), 100, "A");
        assert_eq!(got.items["x"].updated, 501);
        assert!(wins(&got.items["x"], &last.items["x"]));
    }

    #[test]
    fn tombstones_last_ninety_days() {
        let mut b = bundle(&[
            ("old", item(None, 0, "A")),
            ("young", item(None, 1, "A")),
            ("value", item(Some(json!(1)), 0, "A")),
        ]);
        prune(&mut b, TOMBSTONE_MS);
        assert!(!b.items.contains_key("old"));
        assert!(b.items.contains_key("young"));
        assert!(b.items.contains_key("value"));
    }
}
