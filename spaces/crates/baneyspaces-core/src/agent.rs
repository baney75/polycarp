//! The agent action log: what agents asked Polycarp for.

use crate::envelope::Envelope;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One line of the action log. It never holds content: only who did what to which window and how it came out.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActionRecord {
    /// Seconds since the Unix epoch.
    pub at: u64,
    pub agent: String,
    pub verb: String,
    pub pid: Option<u32>,
    pub window: Option<String>,
    pub route: String,
    pub result: String,
    pub refusal: Option<String>,
}

/// The log keeps 30 days (`RETENTION_DAYS`).
pub const RETENTION_DAYS: u64 = 30;

#[derive(Clone, Debug, Default)]
pub struct ActionLog {
    pub records: Vec<ActionRecord>,
}

impl ActionLog {
    pub fn parse(text: &str) -> Self {
        Self { records: text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect() }
    }

    /// Drops records older than 30 days. Returns how many went.
    pub fn prune(&mut self, now: u64) -> usize {
        let cutoff = now.saturating_sub(RETENTION_DAYS * 86_400);
        let before = self.records.len();
        self.records.retain(|r| r.at >= cutoff);
        before - self.records.len()
    }

    pub fn render(&self) -> String {
        self.records.iter().filter_map(|r| serde_json::to_string(r).ok()).collect::<Vec<_>>().join("\n") + if self.records.is_empty() { "" } else { "\n" }
    }
}

/// Drops records older than 30 days from the text of an action log. `None` when nothing was old
/// enough, so the caller rewrites the file only when it must.
pub fn prune_text(text: &str, now: u64) -> Option<String> {
    let mut log = ActionLog::parse(text);
    (log.prune(now) > 0).then(|| log.render())
}

/// How often the append path looks for old records (at most once an hour).
pub const PRUNE_EVERY_SECS: u64 = 3600;

impl ActionRecord {
    pub fn to_line(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    /// Builds a record from an envelope result without ever copying `data`.
    pub fn from_result(at: u64, agent: &str, verb: &str, pid: Option<u32>, window: Option<&str>, route: &str, env: &Envelope) -> Self {
        let (result, refusal) = match (&env.ok, &env.error) {
            (true, _) => ("ok".to_string(), None),
            (false, Some(e)) => (e.code.clone(), if matches!(e.code.as_str(), "not_in_scope" | "in_use" | "not_supported" | "single_instance" | "needs_sandbox" | "agent_window") { Some(e.code.clone()) } else { None }),
            (false, None) => ("internal".into(), None),
        };
        Self { at, agent: agent.into(), verb: verb.into(), pid, window: window.map(String::from), route: route.into(), result, refusal }
    }
}

/// Fields a record may carry, for the test that keeps content out of the log.
pub const RECORD_FIELDS: &[&str] = &["at", "agent", "verb", "pid", "window", "route", "result", "refusal"];

/// True when a JSON value is a record with exactly the allowed fields.
pub fn is_content_free(v: &Value) -> bool {
    v.as_object().is_some_and(|o| o.keys().all(|k| RECORD_FIELDS.contains(&k.as_str())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envelope::Retry;
    use serde_json::json;

    #[test]
    fn refusals_include_the_ones_added_this_round() {
        for code in ["needs_sandbox", "agent_window", "single_instance"] {
            let env = Envelope::err(code, "m", Retry::Never, "s");
            let r = ActionRecord::from_result(1, "a", "open", None, None, "preflight", &env);
            assert_eq!(r.refusal.as_deref(), Some(code));
        }
        let env = Envelope::err("timeout", "m", Retry::Never, "s");
        assert_eq!(ActionRecord::from_result(1, "a", "x", None, None, "r", &env).refusal, None);
    }

    #[test]
    fn log_prunes_after_thirty_days_and_holds_no_content() {
        let day = 86_400;
        let rec = |at| ActionRecord { at, agent: "a".into(), verb: "open".into(), pid: Some(1), window: Some("w".into()), route: "createprocess".into(), result: "ok".into(), refusal: None };
        let mut log = ActionLog { records: vec![rec(0), rec(31 * day), rec(40 * day)] };
        assert_eq!(log.prune(40 * day), 1);
        assert_eq!(log.records.len(), 2);
        let again = ActionLog::parse(&log.render());
        assert_eq!(again.records, log.records);
        // A line an older build wrote, with fields that are gone.
        let old = rec(1).to_line().replacen('{', r#"{"ref":"@s1:e2","screen_changed":false,"#, 1);
        assert_eq!(ActionLog::parse(&old).records, [rec(1)]);
        let v: Value = serde_json::from_str(&rec(1).to_line()).unwrap();
        assert!(is_content_free(&v));
        let env = Envelope::ok(json!({"title": "SECRET TEXT"}));
        let r = ActionRecord::from_result(1, "a", "open", None, None, "createprocess", &env);
        assert!(!r.to_line().contains("SECRET"));
    }
}
