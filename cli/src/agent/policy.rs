//! The routes an agent can reach this gateway by (docs/agents.md). Every install has all of them:
//!
//! - local MCP (stdio and loopback HTTP);
//! - the tailnet;
//! - its own tunnel: a Cloudflare named tunnel on the person's own account, or Tailscale Serve or Funnel.
//!
//! Nothing hosted.

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
}

impl Route {
    pub fn name(self) -> &'static str {
        match self {
            Route::Local => "local",
            Route::Tailnet => "tailnet",
            Route::Cloudflare => "cloudflare",
            Route::TailscaleServe => "tailscale",
            Route::TailscaleFunnel => "funnel",
        }
    }
}
