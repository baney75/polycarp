//! The key map from `spec/keys.json`.

use serde_json::Value;

pub const KEYS_JSON: &str = include_str!("../../../spec/keys.json");

pub fn keys() -> Value {
    serde_json::from_str(KEYS_JSON).expect("spec/keys.json is valid JSON")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_platform_has_the_same_actions() {
        let k = keys();
        let actions: Vec<_> = k["actions"].as_object().unwrap().keys().cloned().collect();
        for p in ["macos", "linux", "windows"] {
            for a in &actions {
                assert!(!k["platforms"][p][a].is_null(), "{p} lacks {a}");
            }
        }
    }
}
