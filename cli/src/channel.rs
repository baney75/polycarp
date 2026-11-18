//! Release channels (docs/releases.md): stable, nightly and dev. A Mac app install asks the app to follow one
//! (`polycarp-spaces update --channel`); a source install builds the commit the channel names.

/// Which builds `polycarp update` follows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    /// Each promoted release, from the `stable` branch.
    Stable,
    /// main, once a day it changed: the commit the rolling `nightly` tag names.
    Nightly,
    /// Every main commit: origin/main itself. What a source install has always built.
    Dev,
}

impl Channel {
    /// "preview", the one channel before these, is nightly now.
    pub fn parse(name: &str) -> Option<Channel> {
        match name {
            "stable" => Some(Channel::Stable),
            "nightly" | "preview" => Some(Channel::Nightly),
            "dev" => Some(Channel::Dev),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Channel::Stable => "stable",
            Channel::Nightly => "nightly",
            Channel::Dev => "dev",
        }
    }

    /// The channel's latest.json, as the app reads it.
    pub fn feed_url(self) -> String {
        const RELEASES: &str = "https://github.com/baney75/polycarp/releases";
        match self {
            Channel::Stable => format!("{RELEASES}/latest/download/latest.json"),
            Channel::Nightly | Channel::Dev => {
                format!("{RELEASES}/download/{}/latest.json", self.name())
            }
        }
    }

    /// The ref a source install builds.
    pub fn target(self) -> &'static str {
        match self {
            Channel::Stable => "refs/remotes/origin/stable",
            Channel::Nightly => "refs/tags/nightly",
            Channel::Dev => "refs/remotes/origin/main",
        }
    }

    /// The fetch refspec that moves `target`, spelled out so it moves even in a checkout that tracks one
    /// branch, and forced: the nightly tag moves every night.
    pub fn refspec(self) -> &'static str {
        match self {
            Channel::Stable => "+refs/heads/stable:refs/remotes/origin/stable",
            Channel::Nightly => "+refs/tags/nightly:refs/tags/nightly",
            Channel::Dev => "+refs/heads/main:refs/remotes/origin/main",
        }
    }

    /// How messages name `target`.
    pub fn target_name(self) -> &'static str {
        match self {
            Channel::Stable => "origin/stable",
            Channel::Nightly => "nightly",
            Channel::Dev => "origin/main",
        }
    }
}

/// How messages name the ref `update --is-current` was given: a channel's target by its name, anything else
/// (the clean copy's HEAD, at the end of an update) as origin/main, which is what it was until channels.
pub fn name_of(rev: &str) -> &'static str {
    [Channel::Stable, Channel::Nightly, Channel::Dev]
        .into_iter()
        .find(|c| c.target() == rev)
        .map_or("origin/main", Channel::target_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_channel_has_its_own_feed() {
        assert_eq!(
            Channel::Stable.feed_url(),
            "https://github.com/baney75/polycarp/releases/latest/download/latest.json"
        );
        assert_eq!(
            Channel::Nightly.feed_url(),
            "https://github.com/baney75/polycarp/releases/download/nightly/latest.json"
        );
        assert_eq!(
            Channel::Dev.feed_url(),
            "https://github.com/baney75/polycarp/releases/download/dev/latest.json"
        );
    }

    #[test]
    fn preview_is_nightly_and_nothing_else_is_a_channel() {
        assert_eq!(Channel::parse("preview"), Some(Channel::Nightly));
        for c in [Channel::Stable, Channel::Nightly, Channel::Dev] {
            assert_eq!(Channel::parse(c.name()), Some(c));
        }
        for bad in ["", "main", "Stable", "local", "nightly-20261118070000"] {
            assert_eq!(Channel::parse(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_source_install_builds_the_ref_its_channel_names() {
        // Each refspec moves exactly the ref the channel builds.
        for c in [Channel::Stable, Channel::Nightly, Channel::Dev] {
            let (from, to) = c.refspec().trim_start_matches('+').split_once(':').unwrap();
            assert_eq!(to, c.target(), "{c:?}");
            assert!(c.refspec().starts_with('+'), "{c:?} must be forced");
            assert!(from.starts_with("refs/"), "{c:?}");
        }
        assert_eq!(Channel::Dev.target(), "refs/remotes/origin/main");
        assert_eq!(name_of("refs/tags/nightly"), "nightly");
        assert_eq!(name_of("HEAD"), "origin/main");
    }
}
