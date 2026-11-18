//! Where a Win+drag puts a window (spec/keymap.md, "Dragging"). Pure geometry; `drag.rs` feeds it the pointer.
//!
//! Every rect is left, top, right, bottom in screen pixels, and means the frame you see (DWM's extended frame
//! bounds), not `GetWindowRect`, which on Windows 10 and 11 holds an invisible resize border of about 7 px.

pub type Rect = [i32; 4];

/// The pointer within this many pixels of a work area's edge snaps on release.
pub const EDGE: i32 = 12;
/// Within this many pixels of a corner along both edges, the snap is that corner's quarter.
pub const CORNER: i32 = 96;
/// A resize never makes a window smaller than this either way.
pub const MIN: i32 = 100;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Move,
    /// Resize from one corner: `left` and `top` say which.
    Resize {
        left: bool,
        top: bool,
    },
}

/// Win + right drag: the corner of `r` nearest the press.
pub fn corner(r: Rect, x: i32, y: i32) -> Kind {
    Kind::Resize {
        left: x < (r[0] + r[2]) / 2,
        top: y < (r[1] + r[3]) / 2,
    }
}

/// The frame while the pointer is `dx`, `dy` from where the drag began on a window whose frame was `start`.
pub fn dragged(kind: Kind, start: Rect, dx: i32, dy: i32) -> Rect {
    match kind {
        Kind::Move => [start[0] + dx, start[1] + dy, start[2] + dx, start[3] + dy],
        Kind::Resize { left, top } => {
            let mut r = start;
            if left {
                r[0] = (start[0] + dx).min(start[2] - MIN);
            } else {
                r[2] = (start[2] + dx).max(start[0] + MIN);
            }
            if top {
                r[1] = (start[1] + dy).min(start[3] - MIN);
            } else {
                r[3] = (start[3] + dy).max(start[1] + MIN);
            }
            r
        }
    }
}

/// A filled window `filled` dragged from `x`, `y` comes out at its normal size `w` by `h`, under the pointer at the
/// same share of its width.
pub fn restored(filled: Rect, w: i32, h: i32, x: i32, _y: i32) -> Rect {
    let share = |p: i32, a: i32, b: i32, n: i32| {
        p - ((p - a) as i64 * n as i64 / (b - a).max(1) as i64) as i32
    };
    let left = share(x, filled[0], filled[2], w);
    [left, filled[1], left + w, filled[1] + h]
}

/// The snap a move would end in with the pointer at `x`, `y`, given every display's work area: its name and frame.
/// Left and right edges give halves, the top edge the whole work area, the bottom edge the lower half, and the
/// corners quarters. A pointer off every work area (over the taskbar) counts with the nearest one.
pub fn snap(x: i32, y: i32, areas: &[Rect]) -> Option<(&'static str, Rect)> {
    let gap =
        |a: &Rect| (a[0] - x).max(x - (a[2] - 1)).max(0) + (a[1] - y).max(y - (a[3] - 1)).max(0);
    let a = *areas.iter().min_by_key(|a| gap(a))?;
    let (x, y) = (x.clamp(a[0], a[2] - 1), y.clamp(a[1], a[3] - 1));
    let [l, t, r, b] = a;
    let (mx, my) = (l + (r - l) / 2, t + (b - t) / 2);
    let near = [x < l + EDGE, y < t + EDGE, x >= r - EDGE, y >= b - EDGE];
    if !near.iter().any(|n| *n) {
        return None;
    }
    let (zl, zt, zr, zb) = (
        x < l + CORNER,
        y < t + CORNER,
        x >= r - CORNER,
        y >= b - CORNER,
    );
    Some(match () {
        _ if zl && zt => ("top-left", [l, t, mx, my]),
        _ if zr && zt => ("top-right", [mx, t, r, my]),
        _ if zl && zb => ("bottom-left", [l, my, mx, b]),
        _ if zr && zb => ("bottom-right", [mx, my, r, b]),
        _ if near[0] => ("left", [l, t, mx, b]),
        _ if near[2] => ("right", [mx, t, r, b]),
        _ if near[1] => ("top", a),
        _ => ("bottom", [l, my, r, b]),
    })
}

/// The `GetWindowRect` that shows the frame `seen`, for a window whose invisible border is `window` minus `frame`.
pub fn to_window(seen: Rect, window: Rect, frame: Rect) -> Rect {
    [
        seen[0] - (frame[0] - window[0]),
        seen[1] - (frame[1] - window[1]),
        seen[2] + (window[2] - frame[2]),
        seen[3] + (window[3] - frame[3]),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    const SCREEN: Rect = [0, 0, 1024, 728];

    #[test]
    fn a_move_follows_the_pointer_and_a_resize_moves_only_the_nearest_corner() {
        let r = [100, 100, 500, 400];
        assert_eq!(dragged(Kind::Move, r, 30, -20), [130, 80, 530, 380]);
        assert_eq!(
            corner(r, 450, 350),
            Kind::Resize {
                left: false,
                top: false
            }
        );
        assert_eq!(
            corner(r, 120, 110),
            Kind::Resize {
                left: true,
                top: true
            }
        );
        assert_eq!(
            dragged(corner(r, 450, 350), r, 60, 40),
            [100, 100, 560, 440]
        );
        assert_eq!(
            dragged(corner(r, 120, 110), r, -50, -30),
            [50, 70, 500, 400]
        );
        // Never under 100 x 100, and the far edges stay put.
        assert_eq!(
            dragged(corner(r, 450, 350), r, -900, -900),
            [100, 100, 200, 200]
        );
        assert_eq!(
            dragged(corner(r, 120, 110), r, 900, 900),
            [400, 300, 500, 400]
        );
    }

    #[test]
    fn each_edge_and_corner_snaps_to_its_part_of_the_work_area() {
        let s = |x, y| snap(x, y, &[SCREEN]);
        assert_eq!(s(0, 364), Some(("left", [0, 0, 512, 728])));
        assert_eq!(s(1023, 364), Some(("right", [512, 0, 1024, 728])));
        assert_eq!(s(512, 0), Some(("top", SCREEN)));
        assert_eq!(s(512, 727), Some(("bottom", [0, 364, 1024, 728])));
        assert_eq!(s(0, 0), Some(("top-left", [0, 0, 512, 364])));
        assert_eq!(s(1023, 0), Some(("top-right", [512, 0, 1024, 364])));
        assert_eq!(s(0, 727), Some(("bottom-left", [0, 364, 512, 728])));
        assert_eq!(s(1023, 727), Some(("bottom-right", [512, 364, 1024, 728])));
        // Along an edge but within CORNER of the next one: still the corner.
        assert_eq!(s(50, 0).map(|t| t.0), Some("top-left"));
        assert_eq!(s(0, 700).map(|t| t.0), Some("bottom-left"));
        // Away from every edge: no snap.
        assert_eq!(s(EDGE, 364), None);
        assert_eq!(s(512, 364), None);
    }

    #[test]
    fn the_taskbar_counts_with_the_display_above_it_and_each_display_snaps_on_its_own() {
        // The pointer over a bottom taskbar (below the work area) is at that display's bottom edge.
        assert_eq!(snap(512, 760, &[SCREEN]).map(|t| t.0), Some("bottom"));
        let two = [SCREEN, [1024, 0, 2944, 1040]];
        assert_eq!(snap(1023, 364, &two), Some(("right", [512, 0, 1024, 728])));
        assert_eq!(snap(1024, 500, &two), Some(("left", [1024, 0, 1984, 1040])));
        assert_eq!(snap(2000, 0, &two), Some(("top", [1024, 0, 2944, 1040])));
    }

    #[test]
    fn the_window_rect_keeps_the_invisible_border_around_the_frame_you_see() {
        // A Windows 11 window: 7 px of invisible border left, right and bottom, none on top.
        let window = [93, 100, 507, 407];
        let frame = [100, 100, 500, 400];
        assert_eq!(
            to_window([0, 0, 512, 728], window, frame),
            [-7, 0, 519, 735]
        );
        assert_eq!(to_window(frame, window, frame), window);
    }

    #[test]
    fn a_filled_window_comes_out_under_the_press_at_the_same_share_of_its_size() {
        // Review of #475: a 1920x1040 work area, normal size 800x500, pressed low at y 700.
        let filled = [0, 0, 1920, 1040];
        for (x, y) in [(960, 700), (100, 1000), (1900, 20), (480, 260)] {
            let r = restored(filled, 800, 500, x, y);
            assert_eq!((r[2] - r[0], r[3] - r[1]), (800, 500), "{x},{y}: {r:?}");
            assert!(
                r[0] <= x && x < r[2] && r[1] <= y && y < r[3],
                "{x},{y} is outside {r:?}"
            );
            let share = |p: i32, a: i32, b: i32| (p - a) as f64 / (b - a) as f64;
            assert!(
                (share(x, r[0], r[2]) - share(x, 0, 1920)).abs() < 0.01,
                "{x},{y}: {r:?}"
            );
            assert!(
                (share(y, r[1], r[3]) - share(y, 0, 1040)).abs() < 0.01,
                "{x},{y}: {r:?}"
            );
        }
    }
}
