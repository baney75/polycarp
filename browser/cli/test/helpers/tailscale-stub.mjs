// A stub `tailscale` for the remote tests. It never touches a real Tailscale: it logs its arguments and answers from files in the
// scenario's temp dir. `funnel --bg` acts the way Tailscale's own CLI does (tailscale/tailscale cmd/tailscale/cli: serve_v2.go:458,
// funnel.go:139-162, serve_legacy.go:797-870 enableFeatureInteractive):
//   enabled   Funnel is allowed: it turns Funnel on and exits 0.
//   wait      Funnel isn't enabled and the control server says wait: it prints the login.tailscale.com page and blocks (serve_legacy.go:836+).
//   exit0url  Funnel isn't enabled and the control server says don't wait: it prints the page and exits 0 with nothing changed (:829-835).
//   fail      it prints `funnelText` and exits 1 (the CheckFunnelAccess fallback prints a tailscale.com/s/... link; other failures print anything).
//   hang      it prints a line and never finishes, with no page on the output.
//   silent0   it exits 0 without turning Funnel on and without printing anything.
// (The tests run it with a PATH that has no system dirs, so it uses shell builtins and absolute paths.)
// `funnel --https=8443 off` turns Funnel off (or fails when funnelOffFails). `serve status --json` shows AllowFunnel while it is on.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const ENABLE_URL = "https://login.tailscale.com/f/funnel?node=n123abc";

/** Writes the stub at `file`. `dir` holds its state (funnel-on, funnel.pid). */
export function writeTailscaleStub(file, { dir, log, dns, lock = "Tailnet lock is NOT enabled.", status, serveStatus = "{}", funnel = "enabled", funnelText = "", funnelOffFails = false }) {
	let on = serveStatus;
	try {
		on = JSON.stringify({ ...JSON.parse(serveStatus), AllowFunnel: { [`${dns}:8443`]: true } });
	} catch {
		/* an unreadable status stays unreadable */
	}
	const page = `\\nFunnel is not enabled on your tailnet.\\nTo enable, visit:\\n\\n         ${ENABLE_URL}\\n\\n`;
	const funnelBody = {
		enabled: `echo "Available on the internet:"; echo on > ${dir}/funnel-on; exit 0`,
		wait: `printf '${page}'; /bin/sleep 300; echo on > ${dir}/funnel-on; exit 0`,
		exit0url: `printf '${page}'; exit 0`,
		fail: `echo '${funnelText}'; exit 1`,
		hang: `echo "starting"; /bin/sleep 300; exit 0`,
		silent0: "exit 0",
	}[funnel];
	if (funnelBody === undefined) throw new Error(`unknown funnel mode ${funnel}`);
	const off = funnelOffFails ? "echo 'boom' >&2; exit 1" : `/bin/rm -f ${dir}/funnel-on; exit 0`;
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(
		file,
		`#!/bin/sh
echo "tailscale $*" >> ${log}
case "$1 $2" in
"lock status") echo '${lock}' ;;
"status --json") echo '${status ?? `{"Self":{"DNSName":"${dns}."}}`}' ;;
"serve status") if [ -f ${dir}/funnel-on ]; then echo '${on}'; else echo '${serveStatus}'; fi ;;
"funnel --bg") echo $$ > ${dir}/funnel.pid; ${funnelBody} ;;
"funnel --https=8443") ${off} ;;
esac
`,
	);
	chmodSync(file, 0o755);
	return { stateFile: join(dir, "funnel-on"), pidFile: join(dir, "funnel.pid") };
}
