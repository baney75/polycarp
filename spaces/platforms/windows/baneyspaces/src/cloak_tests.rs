//! The hiding decisions against a fake desk: the refusals and races Windows can't be made to give on demand.

use super::*;
use crate::desk::fake::{h, Fake, Win};

fn app(rect: [i32; 4]) -> Win {
    Win {
        rect,
        ex_style: 0x100,
        on_taskbar: true,
        title: "Notes".into(),
        class: "Notepad".into(),
        pid: 40,
        ..Win::default()
    }
}

fn entry(id: isize, how: How, rect: Option<[i32; 4]>) -> Hidden {
    Hidden {
        rect,
        ..Hidden::base(id as i64, 40, 7, how)
    }
}

#[test]
fn a_cloak_the_shell_takes_leaves_the_window_where_it_is() {
    let d = Fake::with(&[(1, app([10, 20, 410, 320]))]);
    assert_eq!(hide_user_on(&d, h(1)), How::Cloak);
    assert_eq!(d.win(1).cloaked, 2);
    assert_eq!(
        d.win(1).rect,
        [10, 20, 410, 320],
        "a cloaked window is never moved"
    );
    assert!(still_hidden_on(&d, &entry(1, How::Cloak, None)));
}

#[test]
fn a_refused_cloak_parks_the_window_and_keeps_its_size() {
    let d = Fake {
        cloak_refused: true,
        ..Fake::with(&[(1, app([10, 20, 410, 320]))])
    };
    assert_eq!(hide_user_on(&d, h(1)), How::Park);
    assert_eq!(d.win(1).rect, [PARK, PARK, PARK + 400, PARK + 300]);
    assert!(still_hidden_on(&d, &entry(1, How::Park, None)));
}

#[test]
fn a_cloak_that_does_not_take_is_not_trusted() {
    // The shell said yes and DWM still draws the window: park it rather than believe the call.
    let d = Fake {
        cloak_ignored: true,
        ..Fake::with(&[(1, app([10, 20, 410, 320]))])
    };
    assert_eq!(hide_user_on(&d, h(1)), How::Park);
    assert_eq!(d.win(1).rect[0], PARK);
}

#[test]
fn showing_a_parked_window_puts_it_back_where_it_was() {
    let d = Fake {
        cloak_refused: true,
        ..Fake::with(&[(1, app([10, 20, 410, 320]))])
    };
    hide_user_on(&d, h(1));
    assert!(show_on(&d, &entry(1, How::Park, Some([10, 20, 410, 320]))));
    assert_eq!(d.win(1).rect, [10, 20, 410, 320]);
    assert!(!still_hidden_on(&d, &entry(1, How::Park, None)));
}

#[test]
fn showing_a_cloaked_window_uncloaks_it_and_also_undoes_a_park() {
    // An entry written just before a crash may say cloak while the window was parked: both are undone.
    let d = Fake::with(&[(
        1,
        Win {
            cloaked: 2,
            ..app([PARK, PARK, PARK + 400, PARK + 300])
        },
    )]);
    assert!(show_on(&d, &entry(1, How::Cloak, Some([10, 20, 410, 320]))));
    assert_eq!(d.win(1).cloaked, 0);
    assert_eq!(d.win(1).rect, [10, 20, 410, 320]);
}

#[test]
fn a_minimized_window_is_not_unparked() {
    // Windows itself keeps a minimized window at (-32000, -32000); moving it would un-minimize it on screen.
    let d = Fake::with(&[(
        1,
        Win {
            iconic: true,
            ..app([PARK, PARK, PARK + 160, PARK + 28])
        },
    )]);
    assert!(
        still_hidden_on(&d, &entry(1, How::Park, None)),
        "minimized counts as still out of sight"
    );
    assert!(show_on(&d, &entry(1, How::Park, Some([10, 20, 410, 320]))));
    assert_eq!(d.win(1).rect[0], PARK);
    assert!(!d.calls.borrow().iter().any(|c| c.starts_with("pos")));
}

#[test]
fn showing_a_window_that_is_gone_is_done() {
    let d = Fake::default();
    assert!(show_on(&d, &entry(9, How::Cloak, None)));
    assert!(
        d.calls.borrow().is_empty(),
        "nothing is asked of a window that no longer exists"
    );
}

#[test]
fn a_cloak_dropped_from_outside_reads_as_not_hidden() {
    let d = Fake::with(&[(1, app([10, 20, 410, 320]))]);
    hide_user_on(&d, h(1));
    d.wins.borrow_mut().get_mut(&1).unwrap().cloaked = 0;
    assert!(!still_hidden_on(&d, &entry(1, How::Cloak, None)));
}

#[test]
fn a_ghost_is_layered_transparent_and_off_the_taskbar_and_comes_back_exactly() {
    let d = Fake::with(&[(1, app([10, 20, 410, 320]))]);
    let undo = ghost_on(&d, h(1)).expect("an ordinary window takes the ghost");
    assert_eq!(
        undo,
        GhostUndo {
            ex_style: 0x100,
            alpha: None
        }
    );
    let w = d.win(1);
    assert_eq!(w.ex_style & GHOST, GHOST);
    assert_eq!(w.alpha, Some(0));
    assert!(!w.on_taskbar);
    assert_eq!(
        w.rect,
        [10, 20, 410, 320],
        "a ghost stays on screen where it is"
    );
    let e = Hidden {
        ex_style: Some(undo.ex_style),
        alpha: undo.alpha,
        ..entry(1, How::Ghost, None)
    };
    assert!(still_hidden_on(&d, &e));
    assert!(show_on(&d, &e));
    let w = d.win(1);
    assert_eq!(w.ex_style, 0x100);
    assert_eq!(
        w.alpha, None,
        "a window that was not layered has no alpha left"
    );
    assert!(w.on_taskbar);
}

#[test]
fn a_window_already_layered_gets_its_own_alpha_back() {
    let layered = Win {
        ex_style: 0x100 | WS_EX_LAYERED as i64,
        alpha: Some(200),
        ..app([10, 20, 410, 320])
    };
    let d = Fake::with(&[(1, layered)]);
    let undo = ghost_on(&d, h(1)).unwrap();
    assert_eq!(undo.alpha, Some(200));
    let e = Hidden {
        ex_style: Some(undo.ex_style),
        alpha: undo.alpha,
        ..entry(1, How::Ghost, None)
    };
    assert!(show_on(&d, &e));
    assert_eq!(d.win(1).alpha, Some(200));
    assert_eq!(d.win(1).ex_style, 0x100 | WS_EX_LAYERED as i64);
}

#[test]
fn a_window_that_refuses_the_alpha_is_left_as_it_was() {
    let d = Fake {
        alpha_refused: true,
        ..Fake::with(&[(1, app([10, 20, 410, 320]))])
    };
    assert!(ghost_on(&d, h(1)).is_none());
    let w = d.win(1);
    assert_eq!(
        w.ex_style, 0x100,
        "the styles are put back for the caller to park it instead"
    );
    assert!(w.on_taskbar);
}

#[test]
fn a_ghost_whose_alpha_was_reset_reads_as_not_hidden() {
    let d = Fake::with(&[(1, app([10, 20, 410, 320]))]);
    let undo = ghost_on(&d, h(1)).unwrap();
    d.wins.borrow_mut().get_mut(&1).unwrap().alpha = Some(255);
    let e = Hidden {
        ex_style: Some(undo.ex_style),
        ..entry(1, How::Ghost, None)
    };
    assert!(!still_hidden_on(&d, &e));
}

#[test]
fn a_ghost_that_was_also_parked_is_unparked_when_shown() {
    let d = Fake::with(&[(1, app([PARK, PARK, PARK + 400, PARK + 300]))]);
    let undo = ghost_on(&d, h(1)).unwrap();
    let e = Hidden {
        ex_style: Some(undo.ex_style),
        ..entry(1, How::Ghost, Some([10, 20, 410, 320]))
    };
    assert!(show_on(&d, &e));
    assert_eq!(d.win(1).rect, [10, 20, 410, 320]);
}

#[test]
fn a_reused_handle_is_never_taken_for_the_window_recorded() {
    let mut d = Fake::with(&[(1, app([0, 0, 10, 10]))]);
    d.starts.insert(40, 7);
    let mine = Hidden {
        class: "Notepad".into(),
        owner_pid: 40,
        owner_start: 7,
        ..entry(1, How::Cloak, None)
    };
    assert!(identity_ok_on(&d, &mine));
    assert!(
        !identity_ok_on(
            &d,
            &Hidden {
                class: "Other".into(),
                ..mine.clone()
            }
        ),
        "another class"
    );
    assert!(
        !identity_ok_on(
            &d,
            &Hidden {
                owner_pid: 41,
                ..mine.clone()
            }
        ),
        "another process"
    );
    assert!(
        !identity_ok_on(
            &d,
            &Hidden {
                owner_start: 8,
                ..mine.clone()
            }
        ),
        "the pid reused by a new process"
    );
    assert!(
        !identity_ok_on(
            &d,
            &Hidden {
                hwnd: 2,
                ..mine.clone()
            }
        ),
        "a window that is gone"
    );
    assert!(
        identity_ok_on(&d, &entry(1, How::Cloak, None)),
        "an entry from an older build is trusted"
    );
}
