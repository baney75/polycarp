//! The top bar's layout, apart from drawing: what goes where for one display, in device-independent pixels, from the
//! daemon's state and the theme. The Windows code turns these ops into Direct2D calls; tests read them directly.
//!
//! Left: the workspaces (1 to 5 always, then any other that holds a window or is shown), the one this display shows
//! marked in the theme's indicator style. Middle: the app in front and its title. Right: the agent workspace when it
//! is showing, and the clock.

use super::theme::{ease, Indicator, Theme};
use baneyspaces_core::shell::ShellState;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl Rect {
    pub fn contains(&self, x: f32, y: f32) -> bool {
        x >= self.x && x < self.x + self.w && y >= self.y && y < self.y + self.h
    }
    fn lerp(a: Rect, b: Rect, t: f32) -> Rect {
        let m = |p: f32, q: f32| p + (q - p) * t;
        Rect { x: m(a.x, b.x), y: m(a.y, b.y), w: m(a.w, b.w), h: m(a.h, b.h) }
    }
}

/// A theme color, by role.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ink {
    Surface,
    Border,
    Accent,
    OnAccent,
    Foreground,
    Strong,
    Muted,
    Working,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Align {
    Start,
    Center,
    End,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Face {
    Ui,
    UiStrong,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Op {
    Fill { r: Rect, radius: f32, ink: Ink },
    Stroke { r: Rect, radius: f32, ink: Ink, width: f32 },
    Text { r: Rect, text: String, face: Face, ink: Ink, align: Align },
}

/// A place a click does something: go to workspace `n`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Hit {
    pub r: Rect,
    pub n: u8,
}

/// The marker's slide from one workspace to another: `from` and the time fraction gone (0 to 1).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Slide {
    pub from: u8,
    pub t: f32,
}

/// The bar's height: two lines of the theme's text size, scaled by its density, never under 24.
pub fn height(theme: &Theme) -> f32 {
    (theme.size * 2.0 * theme.density.scale()).round().max(24.0)
}

/// Text size in the bar: a little under the theme's base, as Windows 11's taskbar sets its clock.
pub fn text_size(theme: &Theme) -> f32 {
    (theme.size * 0.8125).round().max(10.0)
}

/// Which workspaces the bar lists.
pub fn listed(state: &ShellState) -> Vec<u8> {
    (1..=9u8).filter(|n| *n <= 5 || state.occupied.contains(n) || state.monitors.iter().any(|m| m.current == *n)).collect()
}

pub struct Layout {
    pub ops: Vec<Op>,
    pub hits: Vec<Hit>,
}

pub fn layout(state: &ShellState, monitor: &str, theme: &Theme, width: f32, clock: &str, slide: Option<Slide>) -> Layout {
    let h = height(theme);
    let pad = (12.0 * theme.density.scale()).round();
    let mut ops = vec![Op::Fill { r: Rect { x: 0.0, y: 0.0, w: width, h }, radius: 0.0, ink: Ink::Surface }];
    if theme.border_width > 0.0 {
        ops.push(Op::Fill {
            r: Rect { x: 0.0, y: h - theme.border_width, w: width, h: theme.border_width },
            radius: 0.0,
            ink: Ink::Border,
        });
    }
    let current = state.current_on(monitor).unwrap_or(0);
    let tile = (h - 8.0).max(16.0);
    let tile_at = |i: usize| Rect { x: pad + i as f32 * (tile + 2.0), y: (h - tile) / 2.0, w: tile, h: tile };
    let shown = listed(state);
    let mut hits = Vec::new();
    // The marker first, so the number draws over it.
    let pos = |n: u8| shown.iter().position(|s| *s == n);
    if let Some(i) = pos(current) {
        let to = tile_at(i);
        let at = match slide.and_then(|s| pos(s.from).map(|j| (j, s.t))) {
            Some((j, t)) if t < 1.0 => Rect::lerp(tile_at(j), to, ease(theme.easing, t)),
            _ => to,
        };
        ops.push(marker(theme, at));
    }
    for (i, n) in shown.iter().copied().enumerate() {
        let r = tile_at(i);
        let elsewhere = n != current && state.monitors.iter().any(|m| m.current == n);
        if elsewhere {
            ops.push(Op::Stroke { r, radius: theme.radius_small, ink: Ink::Border, width: theme.border_width.max(1.0) });
        }
        let ink = if n == current {
            if theme.indicator == Indicator::NumberBlock {
                Ink::OnAccent
            } else {
                Ink::Strong
            }
        } else if state.occupied.contains(&n) || elsewhere {
            Ink::Foreground
        } else {
            Ink::Muted
        };
        let face = if n == current { Face::UiStrong } else { Face::Ui };
        ops.push(Op::Text { r, text: n.to_string(), face, ink, align: Align::Center });
        hits.push(Hit { r, n });
    }
    let left_end = pad + shown.len() as f32 * (tile + 2.0) + pad;
    // Right: the clock, and the agent workspace when it shows.
    let clock_w = 200.0f32.min(width / 4.0);
    let clock_r = Rect { x: width - pad - clock_w, y: 0.0, w: clock_w, h };
    ops.push(Op::Text { r: clock_r, text: clock.to_string(), face: Face::Ui, ink: Ink::Foreground, align: Align::End });
    let mut right_start = clock_r.x;
    if state.agent_shown {
        let w = 132.0;
        let r = Rect { x: right_start - w - pad, y: (h - tile) / 2.0, w, h: tile };
        ops.push(Op::Fill { r, radius: theme.radius_small, ink: Ink::Working });
        ops.push(Op::Text { r, text: "Agent workspace".into(), face: Face::UiStrong, ink: Ink::OnAccent, align: Align::Center });
        right_start = r.x;
    }
    // Middle: the app in front, centered on the display while it fits between the two sides.
    if let Some(a) = &state.active {
        let span = (right_start - pad - left_end).max(0.0);
        let want = (width * 0.5).min(span);
        let x = ((width - want) / 2.0).clamp(left_end, (right_start - pad - want).max(left_end));
        let title = if a.title.is_empty() || a.title == app_name(&a.app) {
            app_name(&a.app)
        } else {
            format!("{}  ·  {}", app_name(&a.app), a.title)
        };
        ops.push(Op::Text { r: Rect { x, y: 0.0, w: want, h }, text: title, face: Face::Ui, ink: Ink::Foreground, align: Align::Center });
    }
    Layout { ops, hits }
}

fn marker(theme: &Theme, tile: Rect) -> Op {
    match theme.indicator {
        Indicator::NumberBlock => Op::Fill { r: tile, radius: theme.radius_small, ink: Ink::Accent },
        Indicator::Bar => {
            let w = tile.w * 0.6;
            let th = theme.border_width.max(2.0);
            Op::Fill { r: Rect { x: tile.x + (tile.w - w) / 2.0, y: tile.y + tile.h - th, w, h: th }, radius: th / 2.0, ink: Ink::Accent }
        }
        Indicator::Dot => {
            let d = 4.0;
            Op::Fill { r: Rect { x: tile.x + (tile.w - d) / 2.0, y: tile.y + tile.h - d, w: d, h: d }, radius: d / 2.0, ink: Ink::Accent }
        }
    }
}

/// The name shown for a process: `notepad.exe` reads as `Notepad`.
pub fn app_name(process: &str) -> String {
    let stem = process.strip_suffix(".exe").or_else(|| process.strip_suffix(".EXE")).unwrap_or(process);
    let mut c = stem.chars();
    c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shell::theme::Theme;
    use baneyspaces_core::shell::{MonitorView, WindowView};

    const D1: &str = "\\\\.\\DISPLAY1";

    fn state(current: u8) -> ShellState {
        ShellState {
            monitors: vec![MonitorView { id: D1.into(), current }, MonitorView { id: "\\\\.\\DISPLAY2".into(), current: 7 }],
            focused_monitor: Some(D1.into()),
            occupied: vec![1, 2, 8],
            active: Some(WindowView {
                id: "w-1".into(),
                app: "notepad.exe".into(),
                title: "notes.txt - Notepad".into(),
                workspace: current,
            }),
            windows: vec![],
            agent_shown: false,
        }
    }

    fn texts(l: &Layout) -> Vec<(String, Ink)> {
        l.ops.iter().filter_map(|o| if let Op::Text { text, ink, .. } = o { Some((text.clone(), *ink)) } else { None }).collect()
    }

    fn accent_fills(l: &Layout) -> Vec<Rect> {
        l.ops.iter().filter_map(|o| if let Op::Fill { r, ink: Ink::Accent, .. } = o { Some(*r) } else { None }).collect()
    }

    #[test]
    fn lists_one_to_five_then_occupied_and_shown_workspaces() {
        assert_eq!(listed(&state(2)), vec![1, 2, 3, 4, 5, 7, 8]);
    }

    #[test]
    fn the_current_workspace_is_marked_under_its_number_and_a_click_goes_there() {
        let t = Theme::default_theme();
        let l = layout(&state(2), D1, &t, 1280.0, "Tue 3:42 PM", None);
        let two = l.hits.iter().find(|h| h.n == 2).unwrap().r;
        let marks = accent_fills(&l);
        assert_eq!(marks.len(), 1);
        assert!(marks[0].x > two.x && marks[0].x + marks[0].w < two.x + two.w, "the dot sits inside tile 2");
        assert!(texts(&l).contains(&("2".into(), Ink::Strong)));
        assert!(texts(&l).contains(&("3".into(), Ink::Muted)), "an empty workspace is quiet");
        assert!(texts(&l).contains(&("Notepad  ·  notes.txt - Notepad".into(), Ink::Foreground)));
        let hit = l.hits.iter().find(|h| h.r.contains(two.x + 1.0, two.y + 1.0)).unwrap();
        assert_eq!(hit.n, 2);
    }

    #[test]
    fn a_switch_moves_the_mark() {
        let t = Theme::default_theme();
        let a = accent_fills(&layout(&state(2), D1, &t, 1280.0, "", None));
        let b = accent_fills(&layout(&state(5), D1, &t, 1280.0, "", None));
        assert!(b[0].x > a[0].x);
    }

    #[test]
    fn number_block_fills_the_tile_and_flips_the_number_to_on_accent() {
        let mut t = Theme::default_theme();
        t.indicator = Indicator::NumberBlock;
        let l = layout(&state(2), D1, &t, 1280.0, "", None);
        let two = l.hits.iter().find(|h| h.n == 2).unwrap().r;
        assert_eq!(accent_fills(&l), vec![two]);
        assert!(texts(&l).contains(&("2".into(), Ink::OnAccent)));
    }

    #[test]
    fn a_workspace_shown_on_another_display_is_outlined() {
        let l = layout(&state(2), D1, &Theme::default_theme(), 1280.0, "", None);
        let seven = l.hits.iter().find(|h| h.n == 7).unwrap().r;
        assert!(l.ops.iter().any(|o| matches!(o, Op::Stroke { r, .. } if *r == seven)));
    }

    #[test]
    fn the_slide_starts_at_the_old_workspace_and_ends_at_the_new() {
        let t = Theme::default_theme();
        let at = |s| accent_fills(&layout(&state(5), D1, &t, 1280.0, "", s))[0].x;
        let (from, to) = (accent_fills(&layout(&state(1), D1, &t, 1280.0, "", None))[0].x, at(None));
        assert!((at(Some(Slide { from: 1, t: 0.0 })) - from).abs() < 0.01);
        let mid = at(Some(Slide { from: 1, t: 0.5 }));
        assert!(mid > from && mid < to);
        assert_eq!(at(Some(Slide { from: 1, t: 1.0 })), to);
    }

    #[test]
    fn the_agent_workspace_shows_when_it_is_on_screen() {
        let mut s = state(2);
        s.agent_shown = true;
        let l = layout(&s, D1, &Theme::default_theme(), 1280.0, "", None);
        assert!(texts(&l).iter().any(|(t, _)| t == "Agent workspace"));
    }

    #[test]
    fn height_follows_text_size_and_density() {
        let mut t = Theme::default_theme();
        assert_eq!(height(&t), 32.0);
        t.density = crate::shell::theme::Density::Compact;
        assert_eq!(height(&t), 24.0);
        assert_eq!(app_name("explorer.exe"), "Explorer");
    }
}
