//! The macOS app's `LauncherMatch` scoring tests (`spec/launcher.md`), as Rust tests.

use super::*;

#[test]
fn letters_out_of_order_or_missing_do_not_match() {
    assert_eq!(score("zzz", "Safari"), None);
    assert_eq!(score("ab", "ba"), None);
    // A typo is forgiven only in a word of four letters or more.
    assert_eq!(score("sfx", "Safari"), None);
    assert!(score("safxri", "Safari").is_some());
    // Two typos are too many.
    assert_eq!(score("sxfxri", "Safari"), None);
    assert_eq!(score("", "Anything"), Some(0));
}

#[test]
fn case_and_accents_do_not_matter() {
    let plain = score("cafe", "Café Notes").unwrap();
    assert_eq!(score("CAFÉ", "café notes"), Some(plain));
    assert!(score("uber", "Über").is_some());
    // An accent typed as its own combining mark folds the same as the precomposed letter.
    assert_eq!(score("cafe", "Cafe\u{301} Notes"), Some(plain));
    assert!(score("strasse", "Straße").is_some());
}

#[test]
fn a_better_placement_wins() {
    let s = |q, n| score(q, n).unwrap();
    // Start of the name over the start of a later word over the middle of a word.
    assert!(s("co", "Code") > s("co", "Visual Studio Code"));
    assert!(s("co", "Visual Studio Code") > s("co", "Xcode"));
    // Initials beat the same letters run together inside a word.
    assert!(s("vsc", "Visual Studio Code") > s("vsc", "Ovscan"));
    // A typo scores under a clean match of the same word.
    assert!(s("safar", "Safari") > s("safaru", "Safari"));
    // camelCase and digits start words too.
    assert!(s("hd", "GitHubDesktop") > s("hd", "Shadow"));
}

#[test]
fn scores_follow_the_spec_numbers() {
    // R-L4, R-L5, R-L6: "s" at the start of "Safari": 16 + 10 x 2 - 0, then a run of "a" (bonus 0, run keeps
    // 10): 16 + 10, then "f": 16 + 10. 88, less 6 / 2 for the length.
    assert_eq!(score("saf", "Safari"), Some(16 + 20 + 26 + 26 - 3));
    // The whole name typed adds 40.
    assert_eq!(score("zoom", "Zoom"), Some(16 + 20 + 26 * 3 + 40 - 2));
    // A word matched only by a typo scores 16 x (letters - 1) - 8.
    assert_eq!(score("safaru", "Safari"), Some(16 * 5 - 8 - 3));
}
