/** The two names a person types for this program: the one the app's helper answers to, and the one an npm link or checkout has. */
const COMMANDS = ["polycarp browser", "tabkyra"];

/**
 * A prompt the user pastes into their own agent (Claude Code, Codex, pi, OMP, OpenCode,
 * Cursor, ...). The agent installs the CLI, connects the MCP server and installs the skills.
 * Plain steps only: no piped installers, and nothing that asks for a key or password.
 */
export function agentSetupPrompt(version: string, command = "tabkyra"): string {
	if (!COMMANDS.includes(command)) throw new Error(`Unknown command name "${command}".`);
	// Without the version the clone can't be pinned, so refuse rather than copy a broken prompt.
	if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`No extension version to pin the CLI to (got "${version}").`);
	return `Set up Polycarp (https://github.com/baney75/polycarp) so you can use my browser. The Polycarp extension ${version} is already loaded in my browser. Run each step yourself and show me any output you can't fix.

1. Note the directory you started in, then check that Node 20+ and git are installed: pwd && node -v && git --version
   Remember the directory pwd printed: it is my project.
2. Install the CLI that matches the extension.
   - If ${command} --version prints ${version} and ${command} doctor reports no problems with the CLI or the build, skip the rest of this step and go to step 3. Otherwise:
   - If ~/polycarp-src/polycarp exists: cd into it. If git status shows any local change, stop and ask me. With a clean checkout, run git fetch --depth 1 origin tag browser-v${version} && git checkout --detach browser-v${version}. If that tag doesn't exist, run git fetch --depth 1 origin HEAD && git checkout --detach FETCH_HEAD and tell me you used the newest code.
   - If it doesn't exist: mkdir -p ~/polycarp-src && cd ~/polycarp-src && git clone --depth 1 --branch browser-v${version} https://github.com/baney75/polycarp && cd polycarp
     If that tag doesn't exist, run the same clone without --branch browser-v${version} and tell me you used the newest code.
   - Then: (cd browser/cli && npm ci && npm run build && npm link)
   The npm link gives the command the name tabkyra.${command === "tabkyra" ? "" : ` Once it succeeds, run "tabkyra" in place of "${command}" in every command below, whichever name this prompt started with.`} If npm link fails with a permissions error, run "node ~/polycarp-src/polycarp/browser/cli/dist/index.js" in place of "${command}" in every command below.
3. Run: ${command} setup --yes
   It registers the browser connection and adds the MCP server to Claude Code and Codex.
4. Connect this harness, even if Polycarp already works in another one:
   - Any MCP client: a stdio server named "tabkyra" that runs ~/.config/tabkyra/tabkyra with the argument "mcp". JSON configs need the full path, not ~.
   - pi has no MCP client: run ${command} pi-extension instead.
5. Install the skills: ${command} skill install
   If this harness reads AGENTS.md instead of skill folders: cd back to the directory step 1 printed (my project, not the Polycarp clone); if you aren't sure it's my project's root, ask me. If its AGENTS.md already has a "## Browser: Polycarp" or "## Browser: Tabkyra" section (the same section under its earlier name), leave it as it is. Otherwise run ${command} skill print >> AGENTS.md
6. Run ${command} doctor and fix anything it reports with the command it prints.
7. Restart or reload MCP servers if this harness needs it, then call the status tool of the MCP server named tabkyra. Tell me whether it says connected.

Don't ask me for API keys or passwords. Polycarp doesn't need them for this.`;
}

const CLOSING = "Don't ask me for API keys or passwords. Polycarp doesn't need them for this.";

/**
 * A prompt for an agent on the computer that should be reachable from claude.ai, ChatGPT or
 * grok.com: set up the public route, then print a one-time approval code. Setup runs with
 * --no-passcode, so no long-lived passcode is made or printed into the agent's output, and the
 * prompt pipes nothing into a shell.
 */
export function remoteSetupPrompt(version: string, command = "tabkyra"): string {
	if (!COMMANDS.includes(command)) throw new Error(`Unknown command name "${command}".`);
	if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`No extension version to pin the CLI to (got "${version}").`);
	return `Set up Polycarp (https://github.com/baney75/polycarp) so claude.ai, ChatGPT or grok.com can use my browser through my own computer. The Polycarp extension ${version} is already loaded in my browser. Run each step yourself and show me any output you can't fix. Nothing here costs money or goes through anyone else's server.

1. Run: ${command} doctor
   If ${command} isn't installed, stop and tell me to copy the setup prompt from Polycarp's Settings > Agents tab and run that first.
2. Pick the route. If it isn't clear from what I told you, ask me which one:
   - One computer with Tailscale installed and signed in: ${command} remote setup --no-passcode
   - Several computers behind one address, on an always-on machine with an HTTPS address I already own: ${command} hub setup --public-url https://ADDRESS --no-passcode (with my address in place of ADDRESS)
   If a command stops and names a reason, show me the reason and the fix it names. Don't work around it.
3. --no-passcode makes no long-lived passcode, so setup prints none. Don't run ${command} token passcode yourself. If a passcode shows up in any output anyway, don't repeat it, write it to a file or put it in a message: tell me, and I will replace it with ${command} token passcode in my own terminal. I can also choose a passcode there later; the one-time code in step 4 is enough for now.
4. Run: ${command} token approval-code
   Show me the code and the connector URL it prints (the URL ends in /mcp). The code works once, for 10 minutes.
5. Run ${command} remote status (${command} hub status on a hub) and tell me what each line says.
6. Tell me to add the connector URL as a custom connector in claude.ai (Settings > Connectors), ChatGPT (Settings > Apps & Connectors) or grok.com (grok.com/connectors), and to type the code on Polycarp's approval page when it asks.

${CLOSING}`;
}

/** The hub origin and code a device prompt may carry; anything else would let a stray string become a command. */
export const HUB_ORIGIN = /^https?:\/\/(?:[A-Za-z0-9.-]+|\[::1\])(?::\d{1,5})?$/;
export const CONNECT_CODE = /^TK-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

/**
 * A prompt for an agent on another device: link it to this hub with a one-time connect code. That device may have
 * `polycarp browser` (the app) or only `tabkyra` (an npm link or checkout), so the prompt does not carry this
 * helper's name: the agent finds out which one runs there and uses it for every later step.
 */
export function deviceSetupPrompt(version: string, hubUrl: string, code: string): string {
	if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`No extension version to pin the CLI to (got "${version}").`);
	if (!HUB_ORIGIN.test(hubUrl)) throw new Error("The hub address must be an origin like https://hub.example.com.");
	if (!CONNECT_CODE.test(code)) throw new Error("The connect code must look like TK-XXXX-XXXX.");
	return `Connect this computer's browser to my Polycarp hub at ${hubUrl}, so claude.ai, ChatGPT or grok.com can use it through my one connector. The Polycarp extension ${version} should already be loaded in my browser on this computer. Run each step yourself and show me any output you can't fix.

1. Find the command that runs Polycarp's helper on this computer. Run: polycarp browser doctor
   If that says the command isn't found, run: tabkyra doctor
   Use whichever of the two runs, and write it as HELPER in every step below: HELPER is "polycarp browser" or "tabkyra", never both. If neither runs, stop and tell me to copy the setup prompt from Polycarp's Settings > Agents tab and run that first.
2. Run: HELPER link ${hubUrl} --code ${code}
   The code works once and expires 10 minutes after I copied this prompt. If the hub refuses it, tell me to get a new one in Settings > Connect > Add a device.
3. Run: HELPER link status
   Tell me whether it says connected.

${CLOSING}`;
}
