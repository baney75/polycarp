/**
 * A prompt the user pastes into their own agent (Claude Code, Codex, pi, OMP, OpenCode,
 * Cursor, ...). The agent installs the CLI, connects the MCP server and installs the skills.
 * Plain steps only: no piped installers, and nothing that asks for a key or password.
 */
export function agentSetupPrompt(version: string): string {
	// Without the version the clone can't be pinned, so refuse rather than copy a broken prompt.
	if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`No extension version to pin the CLI to (got "${version}").`);
	return `Set up Tabkyra (https://github.com/baney75/tabkyra) so you can use my browser. The Tabkyra extension ${version} is already loaded in my browser. Run each step yourself and show me any output you can't fix.

1. Note the directory you started in, then check that Node 20+ and git are installed: pwd && node -v && git --version
   Remember the directory pwd printed: it is my project.
2. Install the CLI that matches the extension.
   - First, if ~/tabkyra-src/tabkyra exists and git status there lists AGENTS.md as the only changed file, run git diff AGENTS.md there. If the diff only adds lines, starting with a "## Browser: Tabkyra" section an earlier Tabkyra setup appended, show me that diff and offer to undo it:
     (cd ~/tabkyra-src/tabkyra && git restore AGENTS.md)
     Run it only if I say yes.
   - If tabkyra is on PATH and tabkyra doctor reports no problems with the CLI or the build, skip the rest of this step and go to step 3. Otherwise:
   - If ~/tabkyra-src/tabkyra exists: cd into it. If git status shows any local change, stop and ask me. With a clean checkout, run git fetch --tags && git checkout v${version}.
   - If it doesn't exist: mkdir -p ~/tabkyra-src && cd ~/tabkyra-src && git clone --depth 1 --branch v${version} https://github.com/baney75/tabkyra && cd tabkyra
   - If the tag v${version} doesn't exist, use the default branch instead and tell me you did.
   - Then: (cd cli && npm ci && npm run build && npm link)
   If npm link fails with a permissions error, use "node ~/tabkyra-src/tabkyra/cli/dist/index.js" wherever these steps say "tabkyra".
3. Run: tabkyra setup --yes
   It registers the browser connection and adds the MCP server to Claude Code and Codex.
4. Connect this harness, even if Tabkyra already works in another one:
   - Any MCP client: a stdio server named "tabkyra" that runs ~/.config/tabkyra/tabkyra with the argument "mcp". JSON configs need the full path, not ~.
   - pi has no MCP client: run tabkyra pi-extension instead.
5. Install the skills: tabkyra skill install
   If this harness reads AGENTS.md instead of skill folders: cd back to the directory step 1 printed (my project, not the Tabkyra clone); if you aren't sure it's my project's root, ask me. If its AGENTS.md already has a "## Browser: Tabkyra" section, leave it as it is. Otherwise run tabkyra skill print >> AGENTS.md
6. Run tabkyra doctor and fix anything it reports with the command it prints.
7. Restart or reload MCP servers if this harness needs it, then call the tabkyra status tool. Tell me whether it says connected.

Don't ask me for API keys or passwords. Tabkyra doesn't need them for this.`;
}

const CLOSING = "Don't ask me for API keys or passwords. Tabkyra doesn't need them for this.";

/**
 * A prompt for an agent on the computer that should be reachable from claude.ai, ChatGPT or
 * grok.com: set up the public route, then print a one-time approval code. It never asks the agent
 * to repeat the passcode (setup prints it once) and it pipes nothing into a shell.
 */
export function remoteSetupPrompt(version: string): string {
	if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`No extension version to pin the CLI to (got "${version}").`);
	return `Set up Tabkyra (https://github.com/baney75/tabkyra) so claude.ai, ChatGPT or grok.com can use my browser through my own computer. The Tabkyra extension ${version} is already loaded in my browser. Run each step yourself and show me any output you can't fix. Nothing here costs money or goes through anyone else's server.

1. Run: tabkyra doctor
   If tabkyra isn't installed, stop and tell me to copy the setup prompt from Tabkyra's Settings > Agents tab and run that first.
2. Pick the route. If it isn't clear from what I told you, ask me which one:
   - One computer with Tailscale installed and signed in: tabkyra remote setup
   - Several computers behind one address, on an always-on machine with an HTTPS address I already own: tabkyra hub setup --public-url https://ADDRESS (with my address in place of ADDRESS)
   If a command stops and names a reason, show me the reason and the fix it names. Don't work around it.
3. Setup prints an approval passcode once. Don't repeat it, write it to a file or put it in a message. Tell me a passcode was created, and that I can choose my own with tabkyra token passcode in my own terminal.
4. Run: tabkyra token approval-code
   Show me the code and the connector URL it prints (the URL ends in /mcp). The code works once, for 10 minutes.
5. Run tabkyra remote status (tabkyra hub status on a hub) and tell me what each line says.
6. Tell me to add the connector URL as a custom connector in claude.ai (Settings > Connectors), ChatGPT (Settings > Apps & Connectors) or grok.com (grok.com/connectors), and to type the code on Tabkyra's approval page when it asks.

${CLOSING}`;
}

/** The hub origin and code a device prompt may carry; anything else would let a stray string become a command. */
const HUB_ORIGIN = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/;
const CONNECT_CODE = /^TK-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

/** A prompt for an agent on another device: link it to this hub with a one-time connect code. */
export function deviceSetupPrompt(version: string, hubUrl: string, code: string): string {
	if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`No extension version to pin the CLI to (got "${version}").`);
	if (!HUB_ORIGIN.test(hubUrl)) throw new Error("The hub address must be an origin like https://hub.example.com.");
	if (!CONNECT_CODE.test(code)) throw new Error("The connect code must look like TK-XXXX-XXXX.");
	return `Connect this computer's browser to my Tabkyra hub at ${hubUrl}, so claude.ai, ChatGPT or grok.com can use it through my one connector. The Tabkyra extension ${version} should already be loaded in my browser on this computer. Run each step yourself and show me any output you can't fix.

1. Run: tabkyra doctor
   If tabkyra isn't installed, stop and tell me to copy the setup prompt from Tabkyra's Settings > Agents tab and run that first.
2. Run: tabkyra link ${hubUrl} --code ${code}
   The code works once and expires 10 minutes after I copied this prompt. If the hub refuses it, tell me to get a new one in Settings > Connect > Add a device.
3. Run: tabkyra link status
   Tell me whether it says connected.

${CLOSING}`;
}
