//! The launcher's model, apart from its window: what it can find (apps from the Start menu, your windows and
//! workspaces from the daemon's feed, a few commands), the rows it shows for what was typed (`spec/launcher.md`,
//! scored by `baneyspaces_core::launcher`), the keys it takes and where each thing is drawn, in device-independent
//! pixels. The Windows code turns the ops into Direct2D calls and runs the actions; tests read both directly.

use super::bar::{app_name, Align, Face, Ink, Op, Rect};
use super::theme::Theme;
use baneyspaces_core::launcher::{Entry, EntryKind, LauncherIndex};
use baneyspaces_core::shell::ShellState;

/// The rows the launcher shows at most.
pub const MAX_ROWS: usize = 8;
/// The panel's width.
pub const WIDTH: f32 = 640.0;

/// An app from the Start menu: its name and what starts it (`shell:AppsFolder\<target>`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct App {
    pub name: String,
    pub target: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Command {
    AgentWorkspace,
    QuitBar,
}

const COMMANDS: [(Command, &str); 2] =
    [(Command::AgentWorkspace, "Show or Hide the Agent Workspace"), (Command::QuitBar, "Quit the Bar and Launcher")];

/// What picking a row does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action {
    Launch(String),
    /// Go to the window's workspace and bring it to the front.
    Window {
        id: String,
        workspace: u8,
    },
    Switch(u8),
    Command(Command),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Row {
    pub kind: EntryKind,
    pub title: String,
    pub detail: String,
    pub action: Action,
    /// The best match across every kind (R-L11), shown first under "Top Hit".
    pub top: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
    Char(char),
    Back,
    /// Ctrl+Backspace: everything typed goes.
    Clear,
    Up,
    Down,
    Enter,
    Esc,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Nothing changed.
    Same,
    Redraw,
    Close,
    Run(Action),
}

#[derive(Default)]
pub struct Launcher {
    index: LauncherIndex,
    /// What each entry is, by the entry's id (its place here).
    items: Vec<(String, String, Action)>,
    windows: Vec<usize>,
    pub query: String,
    pub selected: usize,
    pub rows: Vec<Row>,
}

impl Launcher {
    /// Prepares every name once (R-L12): call it when the apps or the daemon's state change, never per key.
    pub fn set_sources(&mut self, apps: &[App], state: &ShellState) {
        let mut entries = vec![];
        self.items.clear();
        self.windows.clear();
        for a in apps {
            let name = a.name.clone();
            entries.push(Entry::app(self.items.len().to_string(), &name));
            self.items.push((name, "App".into(), Action::Launch(a.target.clone())));
        }
        for w in &state.windows {
            let app = app_name(&w.app);
            self.windows.push(self.items.len());
            entries.push(Entry::window(self.items.len().to_string(), &w.title, &app, ""));
            let detail = format!("{app}, workspace {}", w.workspace);
            self.items.push((w.title.clone(), detail, Action::Window { id: w.id.clone(), workspace: w.workspace }));
        }
        for n in 1..=9u8 {
            let mut apps: Vec<String> = vec![];
            for w in state.windows.iter().filter(|w| w.workspace == n) {
                let name = app_name(&w.app);
                if !apps.contains(&name) {
                    apps.push(name);
                }
            }
            let refs: Vec<&str> = apps.iter().map(String::as_str).collect();
            entries.push(Entry::workspace(self.items.len().to_string(), u32::from(n), &refs));
            let detail = if apps.is_empty() { "Empty".to_string() } else { apps.join(", ") };
            self.items.push((format!("Workspace {n}"), detail, Action::Switch(n)));
        }
        for (c, title) in COMMANDS {
            entries.push(Entry::command(self.items.len().to_string(), title));
            self.items.push((title.into(), "Command".into(), Action::Command(c)));
        }
        self.index = LauncherIndex::new(entries);
        self.refresh();
    }

    /// The rows for what is typed now. With nothing typed, your windows in the feed's order (R-L10: the launcher's
    /// own fixed list). Otherwise the best entry first as the Top Hit, then each kind in section order (R-L11).
    fn refresh(&mut self) {
        let row = |l: &Launcher, i: usize, kind: EntryKind, top: bool| {
            let (title, detail, action) = l.items[i].clone();
            Row { kind, title, detail, action, top }
        };
        self.rows = if self.query.trim().is_empty() {
            self.windows.iter().take(MAX_ROWS).map(|&i| row(self, i, EntryKind::Window, false)).collect()
        } else {
            let hits = self.index.search(&self.query, None, MAX_ROWS, |_| 0);
            let mut rows: Vec<Row> = hits.iter().enumerate().map(|(n, h)| row(self, h.id.parse().unwrap_or(0), h.kind, n == 0)).collect();
            // Stable: within a section the order stays by score.
            let first = rows.len().min(1);
            rows[first..].sort_by_key(|r| r.kind);
            rows
        };
        self.selected = self.selected.min(self.rows.len().saturating_sub(1));
    }

    pub fn reset(&mut self) {
        self.query.clear();
        self.selected = 0;
        self.refresh();
    }

    pub fn key(&mut self, k: Key) -> Outcome {
        match k {
            Key::Char(c) if !c.is_control() => {
                self.query.push(c);
                self.selected = 0;
                self.refresh();
                Outcome::Redraw
            }
            Key::Char(_) => Outcome::Same,
            Key::Back | Key::Clear if self.query.is_empty() => Outcome::Same,
            Key::Back => {
                self.query.pop();
                self.selected = 0;
                self.refresh();
                Outcome::Redraw
            }
            Key::Clear => {
                self.reset();
                Outcome::Redraw
            }
            Key::Up | Key::Down if self.rows.is_empty() => Outcome::Same,
            Key::Up => {
                self.selected = (self.selected + self.rows.len() - 1) % self.rows.len();
                Outcome::Redraw
            }
            Key::Down => {
                self.selected = (self.selected + 1) % self.rows.len();
                Outcome::Redraw
            }
            Key::Enter => self.rows.get(self.selected).map_or(Outcome::Same, |r| Outcome::Run(r.action.clone())),
            Key::Esc => Outcome::Close,
        }
    }
}

/// A section's title above its first row.
pub fn section(row: &Row) -> &'static str {
    if row.top {
        return "Top Hit";
    }
    match row.kind {
        EntryKind::App => "Apps",
        EntryKind::Window => "Windows",
        EntryKind::Workspace => "Workspaces",
        EntryKind::Command => "Commands",
        EntryKind::Menu => "Menus",
    }
}

pub struct Layout {
    pub ops: Vec<Op>,
    /// Where a click picks row `i`.
    pub hits: Vec<(Rect, usize)>,
}

/// Section titles at most: Top Hit, Apps, Windows, Workspaces, Commands (Windows has no menus to search).
const SECTIONS: f32 = 5.0;

/// The panel's height: the search line and room for every row and every section title.
pub fn height(theme: &Theme) -> f32 {
    let d = theme.density.scale();
    field_h(theme) + MAX_ROWS as f32 * row_h(theme) + SECTIONS * head_h(theme) + 16.0 * d
}

fn field_h(theme: &Theme) -> f32 {
    (theme.size * 3.5 * theme.density.scale()).round()
}
fn row_h(theme: &Theme) -> f32 {
    (theme.size * 2.5 * theme.density.scale()).round()
}
fn head_h(theme: &Theme) -> f32 {
    (theme.size * 1.75 * theme.density.scale()).round()
}

pub fn layout(l: &Launcher, theme: &Theme) -> Layout {
    let (w, h) = (WIDTH, height(theme));
    let pad = (12.0 * theme.density.scale()).round();
    let mut ops = vec![Op::Fill { r: Rect { x: 0.0, y: 0.0, w, h }, radius: 0.0, ink: Ink::Surface }];
    if theme.border_width > 0.0 {
        ops.push(Op::Stroke { r: Rect { x: 0.0, y: 0.0, w, h }, radius: 0.0, ink: Ink::Border, width: theme.border_width });
    }
    let field = Rect { x: pad + 4.0, y: 0.0, w: w - 2.0 * pad - 8.0, h: field_h(theme) };
    let (text, ink) = if l.query.is_empty() {
        ("Search apps, windows and workspaces".to_string(), Ink::Muted)
    } else {
        // A bar after the text stands in for the caret.
        (format!("{}\u{258f}", l.query), Ink::Strong)
    };
    ops.push(Op::Text { r: field, text, face: Face::UiStrong, ink, align: Align::Start });
    ops.push(Op::Fill { r: Rect { x: 0.0, y: field.h, w, h: theme.border_width.max(1.0) }, radius: 0.0, ink: Ink::Border });
    let mut hits = vec![];
    let mut y = field.h + 8.0 * theme.density.scale();
    let mut last: Option<&str> = None;
    for (i, row) in l.rows.iter().enumerate() {
        let s = section(row);
        if last != Some(s) {
            if y + head_h(theme) + row_h(theme) > h {
                break;
            }
            let r = Rect { x: pad + 8.0, y, w: w - 2.0 * pad - 16.0, h: head_h(theme) };
            ops.push(Op::Text { r, text: s.into(), face: Face::Ui, ink: Ink::Muted, align: Align::Start });
            y += head_h(theme);
            last = Some(s);
        }
        if y + row_h(theme) > h {
            break;
        }
        let r = Rect { x: pad, y, w: w - 2.0 * pad, h: row_h(theme) };
        let picked = i == l.selected;
        if picked {
            ops.push(Op::Fill { r, radius: theme.radius_small, ink: Ink::Accent });
        }
        let inner = Rect { x: r.x + 8.0, y: r.y, w: r.w - 16.0, h: r.h };
        let title = Rect { w: inner.w * 0.62, ..inner };
        let detail = Rect { x: inner.x + inner.w * 0.64, w: inner.w * 0.36, ..inner };
        let (fg, dim) = if picked { (Ink::OnAccent, Ink::OnAccent) } else { (Ink::Foreground, Ink::Muted) };
        ops.push(Op::Text { r: title, text: row.title.clone(), face: Face::Ui, ink: fg, align: Align::Start });
        ops.push(Op::Text { r: detail, text: row.detail.clone(), face: Face::Ui, ink: dim, align: Align::End });
        hits.push((r, i));
        y += row_h(theme);
    }
    if l.rows.is_empty() && !l.query.trim().is_empty() {
        let r = Rect { x: pad + 8.0, y, w: w - 2.0 * pad - 16.0, h: row_h(theme) };
        ops.push(Op::Text { r, text: "Nothing matches".into(), face: Face::Ui, ink: Ink::Muted, align: Align::Start });
    }
    Layout { ops, hits }
}

#[cfg(test)]
mod tests {
    use super::*;
    use baneyspaces_core::shell::WindowView;

    fn apps() -> Vec<App> {
        ["Notepad", "Calculator", "Calendar", "Microsoft Edge", "Windows Terminal", "Paint", "Settings"]
            .iter()
            .map(|n| App { name: n.to_string(), target: format!("target:{n}") })
            .collect()
    }

    fn state() -> ShellState {
        let w = |id: &str, app: &str, title: &str, n: u8| WindowView { id: id.into(), app: app.into(), title: title.into(), workspace: n };
        ShellState {
            windows: vec![w("w-11", "notepad.exe", "notes.txt - Notepad", 1), w("w-12", "msedge.exe", "Inbox - Proton Mail", 2)],
            occupied: vec![1, 2],
            ..Default::default()
        }
    }

    fn launcher() -> Launcher {
        let mut l = Launcher::default();
        l.set_sources(&apps(), &state());
        l
    }

    fn typed(l: &mut Launcher, s: &str) {
        for c in s.chars() {
            l.key(Key::Char(c));
        }
    }

    #[test]
    fn typing_finds_the_app_and_enter_starts_it() {
        let mut l = launcher();
        typed(&mut l, "notepad");
        assert!(l.rows[0].top);
        assert_eq!(l.rows[0].title, "Notepad");
        assert_eq!(l.key(Key::Enter), Outcome::Run(Action::Launch("target:Notepad".into())));
    }

    #[test]
    fn the_top_hit_comes_first_then_each_kind_in_section_order() {
        let mut l = launcher();
        typed(&mut l, "note");
        let order: Vec<(&str, bool)> = l.rows.iter().map(|r| (section(r), r.top)).collect();
        assert_eq!(order[0], ("Top Hit", true));
        let kinds: Vec<EntryKind> = l.rows[1..].iter().map(|r| r.kind).collect();
        let mut sorted = kinds.clone();
        sorted.sort();
        assert_eq!(kinds, sorted, "sections after the top hit go app, window, workspace, command");
        // The window and the workspace it is on are found by the app's name too.
        assert!(l.rows.iter().any(|r| r.action == Action::Window { id: "w-11".into(), workspace: 1 }));
        assert!(l.rows.iter().any(|r| r.action == Action::Switch(1)));
    }

    #[test]
    fn a_window_is_found_by_its_title_and_picking_it_goes_to_its_workspace() {
        let mut l = launcher();
        typed(&mut l, "inbox");
        assert_eq!(l.key(Key::Enter), Outcome::Run(Action::Window { id: "w-12".into(), workspace: 2 }));
    }

    #[test]
    fn workspaces_and_commands_are_found() {
        let mut l = launcher();
        typed(&mut l, "ws 2");
        assert_eq!(l.rows[0].action, Action::Switch(2));
        l.key(Key::Clear);
        typed(&mut l, "agent");
        assert_eq!(l.rows[0].action, Action::Command(Command::AgentWorkspace));
    }

    #[test]
    fn nothing_typed_lists_your_windows() {
        let l = launcher();
        let titles: Vec<&str> = l.rows.iter().map(|r| r.title.as_str()).collect();
        assert_eq!(titles, ["notes.txt - Notepad", "Inbox - Proton Mail"]);
    }

    #[test]
    fn arrows_wrap_backspace_edits_and_esc_closes() {
        let mut l = launcher();
        typed(&mut l, "cal");
        let n = l.rows.len();
        assert!(n >= 2);
        assert_eq!(l.key(Key::Up), Outcome::Redraw);
        assert_eq!(l.selected, n - 1);
        l.key(Key::Down);
        assert_eq!(l.selected, 0);
        l.key(Key::Back);
        assert_eq!(l.query, "ca");
        assert_eq!(l.key(Key::Char('\u{8}')), Outcome::Same);
        assert_eq!(l.key(Key::Esc), Outcome::Close);
    }

    #[test]
    fn new_sources_keep_what_was_typed() {
        let mut l = launcher();
        typed(&mut l, "inbox");
        let mut st = state();
        st.windows.retain(|w| w.id != "w-12");
        l.set_sources(&apps(), &st);
        assert_eq!(l.query, "inbox");
        assert!(l.rows.iter().all(|r| !matches!(r.action, Action::Window { .. })));
    }

    #[test]
    fn the_layout_marks_the_selected_row_and_puts_section_titles_over_rows() {
        let theme = Theme::default_theme();
        let mut l = launcher();
        typed(&mut l, "note");
        let lay = layout(&l, &theme);
        let texts: Vec<&str> =
            lay.ops.iter().filter_map(|o| if let Op::Text { text, .. } = o { Some(text.as_str()) } else { None }).collect();
        assert_eq!(texts[0], "note\u{258f}");
        assert_eq!(texts[1], "Top Hit");
        let accents = lay.ops.iter().filter(|o| matches!(o, Op::Fill { ink: Ink::Accent, .. })).count();
        assert_eq!(accents, 1);
        // Every row drawn can be clicked, and every one fits in the panel.
        assert_eq!(lay.hits.len(), l.rows.len());
        assert!(lay.hits.iter().all(|(r, _)| r.y + r.h <= height(&theme)));
        typed(&mut l, "zzzz");
        let lay = layout(&l, &theme);
        assert!(lay.ops.iter().any(|o| matches!(o, Op::Text { text, .. } if text == "Nothing matches")));
    }
}
