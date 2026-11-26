//! Hybrid logical clock: wall time that never runs backwards and still orders two edits in the same millisecond.

use serde::{Deserialize, Serialize};

/// A stamp further ahead of this device's wall clock than this is neither given nor taken, so a clock that was wrong
/// once can't win every merge from then on.
pub const MAX_AHEAD_MS: u64 = 10 * 60 * 1000;

/// When a record was written and where. The order of the fields is the order of stamps.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct Stamp {
    pub ms: u64,
    pub count: u32,
    pub device: [u8; 32],
}

impl Stamp {
    /// Whether it is further ahead of the wall clock than any stamp may be.
    pub fn too_far_ahead(&self, wall_ms: u64) -> bool {
        self.ms > wall_ms.saturating_add(MAX_AHEAD_MS)
    }

    /// The first stamp of `device` that orders after this one.
    pub fn next(&self, device: [u8; 32]) -> Option<Stamp> {
        let (ms, count) = match self.count.checked_add(1) {
            Some(count) => (self.ms, count),
            None => (self.ms.checked_add(1)?, 0),
        };
        Some(Stamp { ms, count, device })
    }
}

/// The stamp is too far ahead of the wall clock.
#[derive(Debug, PartialEq, Eq)]
pub struct Ahead;

#[derive(Clone, Debug)]
pub struct Clock {
    pub(crate) device: [u8; 32],
    ms: u64,
    count: u32,
}

impl Clock {
    pub fn new(device: [u8; 32]) -> Self {
        Clock {
            device,
            ms: 0,
            count: 0,
        }
    }

    /// A stamp later than every stamp this clock gave or saw. Refused when that would be too far ahead of the wall: the
    /// wall clock was wrong when this clock followed it, and `Records::restamp` puts it right.
    pub fn tick(&mut self, wall_ms: u64) -> Result<Stamp, Ahead> {
        let device = self.device;
        let (ms, count) = match self.count.checked_add(1) {
            _ if wall_ms > self.ms => (wall_ms, 0),
            Some(count) => (self.ms, count),
            None => (self.ms.checked_add(1).ok_or(Ahead)?, 0),
        };
        let stamp = Stamp { ms, count, device };
        self.see(&stamp, wall_ms)?;
        Ok(stamp)
    }

    /// Takes a stamp from another device into account.
    pub fn see(&mut self, stamp: &Stamp, wall_ms: u64) -> Result<(), Ahead> {
        if stamp.too_far_ahead(wall_ms) {
            return Err(Ahead);
        }
        self.restore(stamp);
        Ok(())
    }

    /// Takes a stamp this device already holds into account, whatever it says: a restarted clock goes on from there.
    pub fn restore(&mut self, stamp: &Stamp) {
        (self.ms, self.count) = (self.ms, self.count).max((stamp.ms, stamp.count));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ticks_only_go_up_even_when_the_wall_clock_goes_back() {
        let mut c = Clock::new([1; 32]);
        let a = c.tick(1000).unwrap();
        let b = c.tick(1000).unwrap();
        let d = c.tick(5).unwrap();
        assert!(a < b && b < d);
        c.count = u32::MAX;
        let e = c.tick(5).unwrap();
        assert!(d < e && e < c.tick(5).unwrap());
    }

    #[test]
    fn a_tick_follows_every_stamp_seen() {
        let mut c = Clock::new([1; 32]);
        let theirs = Stamp {
            ms: 2000,
            count: 7,
            device: [9; 32],
        };
        c.see(&theirs, 1000).unwrap();
        assert!(c.tick(1000).unwrap() > theirs);
    }

    #[test]
    fn no_stamp_is_given_too_far_ahead_or_past_the_end_of_time() {
        let mut c = Clock::new([1; 32]);
        let last = c.tick(5000 + MAX_AHEAD_MS).unwrap();
        assert!(c.tick(5000).unwrap() > last, "the bound itself is allowed");
        assert_eq!(c.tick(4999), Err(Ahead));
        c.restore(&Stamp {
            ms: u64::MAX,
            count: u32::MAX,
            device: [9; 32],
        });
        assert_eq!(c.tick(u64::MAX), Err(Ahead));
    }

    #[test]
    fn a_clock_far_ahead_is_refused_and_leaves_this_one_alone() {
        let mut c = Clock::new([1; 32]);
        let at = |ms| Stamp {
            ms,
            count: 0,
            device: [9; 32],
        };
        assert_eq!(c.see(&at(1000 + MAX_AHEAD_MS + 1), 1000), Err(Ahead));
        assert_eq!(c.tick(1000).unwrap().ms, 1000);
        assert_eq!(c.see(&at(1000 + MAX_AHEAD_MS), 1000), Ok(()));
    }
}
