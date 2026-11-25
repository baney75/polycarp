//! Hybrid logical clock: wall time that never runs backwards and still orders two edits in the same millisecond.

use serde::{Deserialize, Serialize};

/// A stamp further ahead of this device's clock than this is refused, so a device with a wrong clock can't win every
/// merge from then on.
pub const MAX_AHEAD_MS: u64 = 10 * 60 * 1000;

/// When a record was written and where. The order of the fields is the order of stamps.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct Stamp {
    pub ms: u64,
    pub count: u32,
    pub device: [u8; 32],
}

/// The stamp is from a clock too far ahead of this one.
#[derive(Debug, PartialEq, Eq)]
pub struct Ahead;

#[derive(Clone, Debug)]
pub struct Clock {
    device: [u8; 32],
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

    /// A stamp later than every stamp this clock gave or saw.
    pub fn tick(&mut self, wall_ms: u64) -> Stamp {
        if wall_ms > self.ms {
            (self.ms, self.count) = (wall_ms, 0);
        } else if self.count == u32::MAX {
            (self.ms, self.count) = (self.ms + 1, 0);
        } else {
            self.count += 1;
        }
        Stamp {
            ms: self.ms,
            count: self.count,
            device: self.device,
        }
    }

    /// Takes a stamp from another device into account.
    pub fn see(&mut self, stamp: &Stamp, wall_ms: u64) -> Result<(), Ahead> {
        if stamp.ms > wall_ms.saturating_add(MAX_AHEAD_MS) {
            return Err(Ahead);
        }
        if (stamp.ms, stamp.count) > (self.ms, self.count) {
            (self.ms, self.count) = (stamp.ms, stamp.count);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ticks_only_go_up_even_when_the_wall_clock_goes_back() {
        let mut c = Clock::new([1; 32]);
        let a = c.tick(1000);
        let b = c.tick(1000);
        let d = c.tick(5);
        assert!(a < b && b < d);
        c.count = u32::MAX;
        let e = c.tick(5);
        assert!(d < e && e < c.tick(5));
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
        assert!(c.tick(1000) > theirs);
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
        assert_eq!(c.tick(1000).ms, 1000);
        assert_eq!(c.see(&at(1000 + MAX_AHEAD_MS), 1000), Ok(()));
    }
}
