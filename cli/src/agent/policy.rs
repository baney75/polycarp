//! Which routes each release channel may use (the owner's policy, 2026-11-21; docs/agents.md):
//!
//! - Every channel: local MCP (stdio and loopback HTTP) and the tailnet.
//! - dev and nightly: bring your own tunnel, a Cloudflare named tunnel on the person's own account or Tailscale
//!   Serve/Funnel. Nothing hosted.
//! - stable: no own-tunnel setup. A hosted Polycarp tunnel instead, behind a waitlist because it may cost money; this
//!   command only joins the waitlist and stores an invite. With no invite it says so and offers local and tailnet.

use super::store::{self, INVITE_FILE};
use crate::channel::Channel;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

/// The waitlist page for the hosted tunnel.
pub const WAITLIST_URL: &str = "https://dbaney.com/polycarp/waitlist";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    /// stdio, and Streamable HTTP on loopback.
    Local,
    /// This device's Tailscale addresses, with whois.
    Tailnet,
    /// A named tunnel on the person's own Cloudflare account.
    Cloudflare,
    /// Tailscale Serve: HTTPS inside the tailnet.
    TailscaleServe,
    /// Tailscale Funnel: public HTTPS.
    TailscaleFunnel,
    /// The hosted Polycarp tunnel (stable, by invite).
    Hosted,
}

impl Route {
    pub fn name(self) -> &'static str {
        match self {
            Route::Local => "local",
            Route::Tailnet => "tailnet",
            Route::Cloudflare => "cloudflare",
            Route::TailscaleServe => "tailscale",
            Route::TailscaleFunnel => "funnel",
            Route::Hosted => "hosted",
        }
    }

    /// A tunnel the person runs on their own account.
    pub fn own_tunnel(self) -> bool {
        matches!(
            self,
            Route::Cloudflare | Route::TailscaleServe | Route::TailscaleFunnel
        )
    }
}

/// Why a route is refused, said plainly, with what works instead.
#[derive(Debug, Clone, PartialEq)]
pub struct Refusal {
    pub code: &'static str,
    pub message: String,
}

/// What stable says when someone asks for a tunnel: the hosted one is waitlisted, and local and tailnet work now.
pub fn waitlist_message() -> String {
    format!(
        "On the stable channel Polycarp does not set up your own tunnel. Its hosted tunnel is waitlisted, because \
it may cost money to run. Join the waitlist with `polycarp agent tunnel join` ({WAITLIST_URL}); when you get an \
invite, `polycarp agent tunnel redeem <invite>` stores it. Until then, local MCP works now (`polycarp agent connect \
claude-code` or `codex`), and so does your tailnet (`polycarp agent serve --tailnet`, then `polycarp agent connect \
grokbot`). The dev and nightly channels let you bring your own Cloudflare or Tailscale tunnel."
    )
}

/// The one gate every route passes.
pub fn check(channel: Channel, route: Route, invited: bool) -> Result<(), Refusal> {
    match (channel, route) {
        (_, Route::Local | Route::Tailnet) => Ok(()),
        (Channel::Dev | Channel::Nightly, r) if r.own_tunnel() => Ok(()),
        (Channel::Dev | Channel::Nightly, _) => Err(Refusal {
            code: "not_on_this_channel",
            message: format!(
                "The hosted Polycarp tunnel is for the stable channel only. On {} you bring your own tunnel: \
`polycarp agent tunnel cloudflare --hostname <name>` (your Cloudflare account) or `polycarp agent tunnel tailscale`.",
                channel.name()
            ),
        }),
        (Channel::Stable, Route::Hosted) if invited => Ok(()),
        (Channel::Stable, _) => Err(Refusal {
            code: "waitlisted",
            message: waitlist_message(),
        }),
    }
}

/// The channel this install follows: the Mac app's own (its Info.plist), else the one a source install was told
/// (`source.toml`), else dev, which is what a source install builds by default.
pub fn current_channel() -> Channel {
    if let Some(app) = crate::polycarp_app() {
        if let Ok(xml) = fs::read_to_string(app.join("Contents/Info.plist")) {
            if let Some(c) = crate::version::plist_string(&xml, "PolycarpChannel")
                .and_then(|s| Channel::parse(&s))
            {
                return c;
            }
        }
    }
    crate::theme::config_dir()
        .ok()
        .and_then(|d| crate::update::recorded_channel(&d))
        .unwrap_or(Channel::Dev)
}

/// An invite to the hosted tunnel, kept private (0600). It is presented to the hosted tunnel when that opens.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Invite {
    pub invite: String,
    pub redeemed: i64,
}

/// An invite looks like one: 8 to 200 letters, digits, dots, dashes or underscores. Anything else is a paste error.
pub fn invite_ok(s: &str) -> bool {
    (8..=200).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

pub fn load_invite(dir: &Path) -> Option<Invite> {
    store::read_json::<Option<Invite>>(&dir.join(INVITE_FILE))
        .ok()
        .flatten()
        .filter(|i| invite_ok(&i.invite))
}

/// Stores an invite. Only stable takes one: dev and nightly bring their own tunnel.
pub fn redeem(dir: &Path, channel: Channel, invite: &str, now: i64) -> Result<Invite, Refusal> {
    if channel != Channel::Stable {
        return Err(check(channel, Route::Hosted, true).unwrap_err());
    }
    let invite = invite.trim();
    if !invite_ok(invite) {
        return Err(Refusal {
            code: "invalid_args",
            message:
                "That doesn't look like an invite: paste the whole code from the invite email."
                    .into(),
        });
    }
    let i = Invite {
        invite: invite.to_string(),
        redeemed: now,
    };
    store::write_json(&dir.join(INVITE_FILE), &i).map_err(|e| Refusal {
        code: "io_error",
        message: e,
    })?;
    Ok(i)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [Route; 6] = [
        Route::Local,
        Route::Tailnet,
        Route::Cloudflare,
        Route::TailscaleServe,
        Route::TailscaleFunnel,
        Route::Hosted,
    ];

    #[test]
    fn every_channel_has_local_and_tailnet() {
        for c in [Channel::Stable, Channel::Nightly, Channel::Dev] {
            for invited in [false, true] {
                assert!(check(c, Route::Local, invited).is_ok(), "{c:?}");
                assert!(check(c, Route::Tailnet, invited).is_ok(), "{c:?}");
            }
        }
    }

    #[test]
    fn dev_and_nightly_bring_their_own_tunnel_and_nothing_hosted() {
        for c in [Channel::Nightly, Channel::Dev] {
            for r in [
                Route::Cloudflare,
                Route::TailscaleServe,
                Route::TailscaleFunnel,
            ] {
                assert!(check(c, r, false).is_ok(), "{c:?} {r:?}");
            }
            let e = check(c, Route::Hosted, true).unwrap_err();
            assert_eq!(e.code, "not_on_this_channel");
            assert!(e.message.contains("bring your own tunnel"), "{}", e.message);
        }
    }

    #[test]
    fn stable_refuses_every_own_tunnel_with_the_waitlist_and_offers_local_and_tailnet() {
        for r in ALL.into_iter().filter(|r| r.own_tunnel()) {
            for invited in [false, true] {
                let e = check(Channel::Stable, r, invited).unwrap_err();
                assert_eq!(e.code, "waitlisted", "{r:?}");
                assert!(e.message.contains(WAITLIST_URL), "{}", e.message);
                assert!(e.message.contains("local MCP works now"), "{}", e.message);
                assert!(e.message.contains("tailnet"), "{}", e.message);
            }
        }
        assert_eq!(
            check(Channel::Stable, Route::Hosted, false)
                .unwrap_err()
                .code,
            "waitlisted"
        );
        assert!(check(Channel::Stable, Route::Hosted, true).is_ok());
    }

    #[test]
    fn only_stable_stores_an_invite_and_only_a_plausible_one() {
        let d = std::env::temp_dir().join(format!("pc-agent-invite-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        assert!(redeem(&d, Channel::Dev, "abcdefgh123", 1).is_err());
        assert!(redeem(&d, Channel::Nightly, "abcdefgh123", 1).is_err());
        assert!(load_invite(&d).is_none());
        for bad in ["short", "has space in it", "<script>alert(1)</script>", ""] {
            assert_eq!(
                redeem(&d, Channel::Stable, bad, 1).unwrap_err().code,
                "invalid_args"
            );
        }
        let i = redeem(&d, Channel::Stable, "  pcinv_ABCdef-123.x  ", 7).unwrap();
        assert_eq!(i.invite, "pcinv_ABCdef-123.x");
        assert_eq!(load_invite(&d), Some(i));
        if cfg!(unix) {
            assert_eq!(store::mode(&d.join(INVITE_FILE)), Some(0o600));
        }
        let _ = std::fs::remove_dir_all(&d);
    }
}
