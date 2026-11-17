//! The desktop shell for Windows: one themed top bar per display, fed live by the daemon (`spec/shell.md`) and
//! restyled when the theme changes. This is its look and layout, plain Rust tested on any system; the window that
//! draws it comes next.
#![allow(dead_code)] // the bar that draws this comes in the next change

pub mod bar;
pub mod theme;

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
