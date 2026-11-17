//! `baneyspaces shell`: the desktop shell for Windows. One themed top bar per display, reserved as an AppBar so
//! maximized windows stop below it, fed live by the daemon (`spec/shell.md`) and restyled when the theme changes.
//! The layout and the theme are plain Rust and tested anywhere; drawing and the window are in `win.rs`.
#![cfg_attr(not(windows), allow(dead_code))]

pub mod bar;
pub mod theme;
#[cfg(windows)]
mod win;

const DAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/// The bar's clock: `Tue 3:42 PM`. `weekday` is 0 for Sunday, as `SYSTEMTIME.wDayOfWeek` gives it.
pub fn clock_text(weekday: u16, hour: u16, minute: u16) -> String {
    let h12 = match hour % 12 {
        0 => 12,
        h => h,
    };
    let half = if hour < 12 { "AM" } else { "PM" };
    format!("{} {h12}:{minute:02} {half}", DAYS[weekday as usize % 7])
}

/// Milliseconds until the clock next changes, a little after the minute turns.
pub fn until_next_minute(second: u16, millis: u16) -> u32 {
    (60 - u32::from(second.min(59))) * 1000 - u32::from(millis.min(999)) + 20
}

pub fn run(args: &[String]) -> i32 {
    #[cfg(windows)]
    {
        win::run(args)
    }
    #[cfg(not(windows))]
    {
        let _ = args;
        eprintln!("baneyspaces shell: this build is not for Windows");
        1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_clock_reads_like_the_taskbar() {
        assert_eq!(clock_text(2, 15, 42), "Tue 3:42 PM");
        assert_eq!(clock_text(0, 0, 5), "Sun 12:05 AM");
        assert_eq!(clock_text(6, 12, 0), "Sat 12:00 PM");
    }

    #[test]
    fn the_clock_wakes_just_after_the_minute() {
        assert_eq!(until_next_minute(0, 0), 60_020);
        assert_eq!(until_next_minute(59, 999), 21);
    }
}
