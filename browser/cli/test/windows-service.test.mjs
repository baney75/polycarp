// Remote access on Windows, proved on any computer: the Task Scheduler task (exact schtasks arguments, the task XML and the
// batch script it runs), the tailscale.exe and cloudflared.exe lookup order, and the Windows cloudflared asset. A stand-in
// replaces schtasks, launchctl and systemctl, so nothing here makes a task, a service or a tunnel. The Mac and Linux files are
// checked against exact text, so this change provably leaves them as they were.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { loadTs } from "./helpers/bundle-ts.mjs";

const root = mkdtempSync(join(tmpdir(), "polycarp-winsvc-"));
after(() => rmSync(root, { recursive: true, force: true }));

const mod = await loadTs(`
export { recordServicePid, installService, removeService, serviceFile, serviceLogHint, setServiceSeamForTests, plistText, unitText, windowsTaskXml, windowsScriptText, schtasksPath, SERVE_SERVICE, HUB_SERVICE, LINK_SERVICE } from "@src/service.ts";
export { CLOUDFLARE_SERVICE, cloudflaredBinary } from "@src/cloudflare.ts";
export { tailscaleBinary } from "@src/remote-setup.ts";
export { windowsInstallPaths, windowsTool } from "@src/tool-paths.ts";
export { cloudflaredAsset, downloadCloudflared, downloadedCloudflared, CLOUDFLARED_VERSION } from "@src/cloudflared-download.ts";
`);
const { recordServicePid, installService, removeService, serviceFile, serviceLogHint, setServiceSeamForTests, plistText, unitText, windowsTaskXml, windowsScriptText, schtasksPath, SERVE_SERVICE, HUB_SERVICE, LINK_SERVICE, CLOUDFLARE_SERVICE, cloudflaredBinary, tailscaleBinary, windowsInstallPaths, windowsTool, cloudflaredAsset, downloadCloudflared, downloadedCloudflared, CLOUDFLARED_VERSION } = mod;

const SCHTASKS = "C:\\Windows\\System32\\schtasks.exe";
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

/** A config folder whose path has spaces and an ampersand, a HOME of its own, and SystemRoot as Windows sets it. */
function inConfig(name, fn, folder = "Polycarp Config & More") {
	const dir = join(root, name, folder);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const keys = ["POLYCARP_BROWSER_CONFIG_DIR", "TABKYRA_CONFIG_DIR", "HOME", "SystemRoot"];
	const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
	process.env.POLYCARP_BROWSER_CONFIG_DIR = dir;
	delete process.env.TABKYRA_CONFIG_DIR;
	process.env.HOME = join(root, name, "home");
	mkdirSync(process.env.HOME, { recursive: true });
	process.env.SystemRoot = "C:\\Windows";
	const restore = () => {
		for (const k of keys) {
			if (before[k] === undefined) delete process.env[k];
			else process.env[k] = before[k];
		}
	};
	return Promise.resolve()
		.then(() => fn(dir))
		.finally(restore);
}

/** Records every command; `answer` decides each exit code. The task file is read when /Create runs, since install deletes it after. */
function fakeExec(answer = () => ({ code: 0, out: "" })) {
	const calls = [];
	const xmlSeen = [];
	const exec = (cmd, args) => {
		calls.push([cmd, ...args]);
		const at = args.indexOf("/XML");
		if (at >= 0) xmlSeen.push(readFileSync(args[at + 1]));
		return answer(cmd, args);
	};
	return { exec, calls, xmlSeen };
}

afterEach(() => setServiceSeamForTests({}));

/** Act as Windows, with the polycarp.cmd launcher `install` writes there unless a test names another. */
const winSeam = (o) => setServiceSeamForTests({ platform: "win32", launcher: join(process.env.POLYCARP_BROWSER_CONFIG_DIR, "polycarp.cmd"), ...o });

// ---------- Mac and Linux are unchanged ----------

test("the launchd plist is byte for byte what it was", () => {
	const text = plistText("/Users/x/.config/polycarp/browser/polycarp", { POLYCARP_BROWSER_CONFIG_DIR: "/Users/x/a&b", TABKYRA_CONFIG_DIR: "/Users/x/a&b" }, "/Users/x/Library/Logs/polycarp-serve.log", SERVE_SERVICE);
	assert.equal(
		text,
		`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.polycarp.serve</string>
	<key>ProgramArguments</key>
	<array>
		<string>/Users/x/.config/polycarp/browser/polycarp</string>
		<string>serve</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>POLYCARP_BROWSER_CONFIG_DIR</key>
		<string>/Users/x/a&#38;b</string>
		<key>TABKYRA_CONFIG_DIR</key>
		<string>/Users/x/a&#38;b</string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>10</integer>
	<key>StandardOutPath</key>
	<string>/Users/x/Library/Logs/polycarp-serve.log</string>
	<key>StandardErrorPath</key>
	<string>/Users/x/Library/Logs/polycarp-serve.log</string>
</dict>
</plist>
`,
	);
});

test("the systemd unit is byte for byte what it was", () => {
	const text = unitText("/home/x/my dir/polycarp", { POLYCARP_BROWSER_CONFIG_DIR: "/home/x/50%" }, HUB_SERVICE);
	assert.equal(
		text,
		`[Unit]
Description=Polycarp hub (one connector URL for many devices)

[Service]
ExecStart="/home/x/my dir/polycarp" hub serve
Environment="POLYCARP_BROWSER_CONFIG_DIR=/home/x/50%%"
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`,
	);
});

test("Linux install still runs the same systemctl steps and writes the unit where it did", async () => {
	await inConfig("linux", async () => {
		const fake = fakeExec();
		setServiceSeamForTests({ platform: "linux", exec: fake.exec });
		const r = await installService(SERVE_SERVICE);
		assert.equal(r.ok, true, r.message);
		assert.deepEqual(fake.calls, [
			["systemctl", "--user", "daemon-reload"],
			["systemctl", "--user", "enable", "polycarp-serve.service"],
			["systemctl", "--user", "restart", "polycarp-serve.service"],
		]);
		assert.equal(r.file, join(process.env.HOME, ".config", "systemd", "user", "polycarp-serve.service"));
		assert.equal(serviceLogHint(SERVE_SERVICE), "journalctl --user -u polycarp-serve.service");
		assert.ok(!fake.calls.some(([cmd]) => /schtasks/.test(cmd)));
	});
});

test("macOS install still writes the plist under LaunchAgents and its log under Library/Logs", async () => {
	await inConfig("mac", async () => {
		const fake = fakeExec((cmd, args) => (args[0] === "print" ? { code: 113, out: "not found" } : { code: 0, out: "" }));
		setServiceSeamForTests({ platform: "darwin", exec: fake.exec });
		const r = await installService(SERVE_SERVICE);
		assert.equal(r.ok, true, r.message);
		assert.equal(r.file, join(process.env.HOME, "Library", "LaunchAgents", "com.polycarp.serve.plist"));
		assert.deepEqual(
			fake.calls.map(([cmd, verb]) => `${cmd} ${verb}`),
			["launchctl bootout", "launchctl print", "launchctl bootstrap"],
		);
		assert.equal(serviceLogHint(SERVE_SERVICE), join(process.env.HOME, "Library", "Logs", "polycarp-serve.log"));
	});
});

// ---------- Windows: the Task Scheduler task ----------

test("a fresh Windows install makes the task from XML and runs it once, with exact schtasks arguments and no /End between", async () => {
	await inConfig("win-install", async (dir) => {
		const fake = fakeExec();
		winSeam({ exec: fake.exec, windowsUser: "DESKTOP-1\\Jane Doe", launcher: join(dir, "polycarp.cmd") });
		const r = await installService(SERVE_SERVICE);
		assert.equal(r.ok, true, r.message);
		const script = join(dir, "services", "com.polycarp.serve.cmd");
		const xmlFile = join(dir, "services", "com.polycarp.serve.xml");
		assert.equal(schtasksPath(), SCHTASKS);
		assert.deepEqual(fake.calls, [
			[SCHTASKS, "/Create", "/TN", "com.polycarp.serve", "/XML", xmlFile, "/F"],
			[SCHTASKS, "/Run", "/TN", "com.polycarp.serve"],
		]);
		assert.equal(r.file, script);
		assert.equal(serviceFile(SERVE_SERVICE), script);
		assert.equal(serviceLogHint(SERVE_SERVICE), join(dir, "logs", "polycarp-serve.log"));
		assert.match(r.message, /logs in .*polycarp-serve\.log/);
		// The task file is gone once Task Scheduler has it; the script stays for the task to run.
		assert.equal(existsSync(xmlFile), false);
		assert.ok(existsSync(script));
		assert.ok(existsSync(join(dir, "logs")));

		// UTF-16 LE with a byte order mark, as schtasks exports a task.
		const raw = fake.xmlSeen[0];
		assert.deepEqual([...raw.subarray(0, 2)], [0xff, 0xfe]);
		const xml = raw.subarray(2).toString("utf16le");
		assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-16"?>\r\n'));
		assert.match(xml, /<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>DESKTOP-1\\Jane Doe<\/UserId>\s*<\/LogonTrigger>/);
		assert.match(xml, /<Principal id="Author">\s*<UserId>DESKTOP-1\\Jane Doe<\/UserId>\s*<LogonType>InteractiveToken<\/LogonType>\s*<RunLevel>LeastPrivilege<\/RunLevel>/);
		assert.match(xml, /<RestartOnFailure>\s*<Interval>PT1M<\/Interval>\s*<Count>255<\/Count>\s*<\/RestartOnFailure>/);
		assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
		assert.match(xml, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/);
		assert.doesNotMatch(xml, /HighestAvailable|<Password>|S4U/);
		// cmd /s /c ""<script>"": the outer quotes are stripped, the inner pair keeps the spaces and & as part of the path.
		assert.ok(xml.includes("<Command>C:\\Windows\\System32\\cmd.exe</Command>"));
		const scriptXml = script.replace(/&/g, "&#38;");
		assert.ok(xml.includes(`<Arguments>/d /s /c &#34;&#34;${scriptXml}&#34;&#34;</Arguments>`), xml);
	});
});

test("the batch script sets the folders, logs to the file, restarts after 10 seconds, and names no path of this computer", async () => {
	await inConfig("win-script", async (dir) => {
		winSeam({ exec: fakeExec().exec, windowsUser: "PC\\x", launcher: join(dir, "polycarp.cmd") });
		const r = await installService(CLOUDFLARE_SERVICE);
		assert.equal(r.ok, true, r.message);
		const text = readFileSync(join(dir, "services", "com.polycarp.cloudflared.cmd"), "utf8");
		const lines = text.split("\r\n");
		assert.ok(!/[^\r]\n/.test(text), "every line ends in CRLF");
		assert.ok(!text.includes(dir) && !text.includes("Config & More"), "no folder of this computer is written in");
		assert.equal(lines[0], "@echo off");
		assert.ok(lines.includes("setlocal DisableDelayedExpansion"));
		assert.ok(lines.includes("title com.polycarp.cloudflared (Polycarp; closing this window stops it until you log on again)"));
		assert.ok(lines.includes('set "POLYCARP_BROWSER_CONFIG_DIR=%POLYCARP_HOME%"'));
		assert.ok(lines.includes('set "POLYCARP_LOG=%POLYCARP_HOME%\\logs\\polycarp-cloudflared.log"'));
		assert.ok(lines.includes('\tcall "%POLYCARP_HOME%\\polycarp.cmd" remote cloudflare run'), text);
		assert.ok(lines.includes('"%SystemRoot%\\System32\\ping.exe" -n 11 127.0.0.1 >nul'));
		assert.deepEqual(lines.slice(-2), ["goto run", ""]);
		assert.ok(lines.indexOf(":run") < lines.indexOf("goto run"));
	});
});

test("windowsScriptText refuses names and values cmd would misread", () => {
	const ok = windowsScriptText("polycarp.cmd", { POLYCARP_BROWSER_CONFIG_DIR: "C:\\anything", POLYCARP_SOCKET_DIR: "C:\\pipes" }, LINK_SERVICE);
	assert.ok(ok.includes('set "POLYCARP_SOCKET_DIR=C:\\pipes"\r\n'));
	assert.ok(ok.includes('\tcall "%POLYCARP_HOME%\\polycarp.cmd" link run\r\n'));
	assert.ok(!ok.includes("C:\\anything"));
	for (const bad of ['a"b.cmd', "a%b.cmd", "a^b.cmd", "a b.cmd", "a&b.cmd"]) assert.throws(() => windowsScriptText(bad, {}, LINK_SERVICE), /launcher name/, bad);
	assert.throws(() => windowsScriptText("p.cmd", { "BAD NAME": "x" }), /variable name/);
	for (const v of ['a"b', "50%", "a^b", "a\r\nb"]) assert.throws(() => windowsScriptText("p.cmd", { X: v }), /plain ASCII/, JSON.stringify(v));
});

test("the task XML escapes the user and the script path", () => {
	const xml = windowsTaskXml("C:\\Users\\A&B <x>\\s.cmd", "PC\\A&B", SERVE_SERVICE);
	assert.ok(xml.includes("<UserId>PC\\A&#38;B</UserId>"));
	assert.ok(xml.includes("/d /s /c &#34;&#34;C:\\Users\\A&#38;B &#60;x&#62;\\s.cmd&#34;&#34;"));
});

test("a config folder with % refuses before anything is written or run", async () => {
	await inConfig("win-percent", async () => {
		const dir = join(root, "win-percent", "100%");
		mkdirSync(dir, { recursive: true });
		process.env.POLYCARP_BROWSER_CONFIG_DIR = dir;
		const fake = fakeExec();
		winSeam({ exec: fake.exec, windowsUser: "PC\\x" });
		const r = await installService(SERVE_SERVICE);
		assert.equal(r.ok, false);
		assert.match(r.message, /no task was made/);
		assert.deepEqual(fake.calls, []);
		assert.equal(existsSync(join(dir, "services")), false);
	});
});

test("Access is denied fails with one sentence that says what to do, and never asks for elevation", async () => {
	await inConfig("win-denied", async () => {
		const fake = fakeExec((cmd, args) => (args[0] === "/Create" ? { code: 1, out: "ERROR: Access is denied." } : { code: 0, out: "" }));
		winSeam({ exec: fake.exec, windowsUser: "CORP\\x" });
		const r = await installService(SERVE_SERVICE);
		assert.equal(r.ok, false);
		assert.match(r.message, /^Windows refused to make a scheduled task for CORP\\x \(ERROR: Access is denied\.\); Polycarp never asks for administrator rights, so .* ask its admin to allow them, or keep it running yourself: .* serve\.$/);
		assert.equal(r.message.split(/\.\s+[A-Z]/).length, 1, "one sentence");
		assert.deepEqual(fake.calls.map((c) => c[1]), ["/Create"]);
		assert.ok(!fake.calls.flat().some((a) => /runas|\/RL|HIGHEST|Start-Process/i.test(a)));
	});
});

test("an account Windows doesn't name makes no task", async () => {
	await inConfig("win-nouser", async () => {
		const fake = fakeExec();
		winSeam({ exec: fake.exec, windowsUser: "" });
		const r = await installService(SERVE_SERVICE);
		assert.equal(r.ok, false);
		assert.match(r.message, /no task was made/);
		assert.deepEqual(fake.calls, []);
	});
});

test("Windows uninstall ends and deletes the task, removes the script, and keeps the log", async () => {
	await inConfig("win-remove", async (dir) => {
		winSeam({ exec: fakeExec().exec, windowsUser: "PC\\x" });
		assert.equal((await installService(SERVE_SERVICE)).ok, true);
		const fake = fakeExec((cmd, args) => (args[0] === "/End" ? { code: 1, out: "ERROR: The task is not running." } : { code: 0, out: "" }));
		winSeam({ exec: fake.exec, windowsUser: "PC\\x" });
		const r = removeService(SERVE_SERVICE);
		assert.equal(r.ok, true, r.failure);
		assert.deepEqual(fake.calls, [
			[SCHTASKS, "/End", "/TN", "com.polycarp.serve"],
			[SCHTASKS, "/Delete", "/TN", "com.polycarp.serve", "/F"],
		]);
		assert.equal(existsSync(join(dir, "services", "com.polycarp.serve.cmd")), false);
		assert.match(r.notes.join(" "), /log stays at .*polycarp-serve\.log/);
		// Nothing installed: nothing to run.
		const again = fakeExec();
		winSeam({ exec: again.exec, windowsUser: "PC\\x" });
		assert.deepEqual(removeService(SERVE_SERVICE), { ok: true, notes: [] });
		assert.deepEqual(again.calls, []);
	});
});

test("a failed delete keeps the script when the task is still there, and counts as removed when it is gone", async () => {
	await inConfig("win-remove-fail", async (dir) => {
		const script = join(dir, "services", "com.polycarp.serve.cmd");
		winSeam({ exec: fakeExec().exec, windowsUser: "PC\\x" });
		await installService(SERVE_SERVICE);
		const stuck = fakeExec((cmd, args) => (args[0] === "/Delete" ? { code: 1, out: "ERROR: denied" } : { code: 0, out: "" }));
		winSeam({ exec: stuck.exec });
		const r = removeService(SERVE_SERVICE);
		assert.equal(r.ok, false);
		assert.match(r.failure, /schtasks \/Delete \/TN com\.polycarp\.serve failed: ERROR: denied\. The task is still there and remote\.json is kept\./);
		assert.ok(existsSync(script));
		assert.deepEqual(stuck.calls.at(-1), [SCHTASKS, "/Query", "/TN", "com.polycarp.serve"]);
		const gone = fakeExec((cmd, args) => (args[0] === "/Delete" || args[0] === "/Query" ? { code: 1, out: "ERROR: The system cannot find the file specified." } : { code: 0, out: "" }));
		winSeam({ exec: gone.exec });
		assert.equal(removeService(SERVE_SERVICE).ok, true);
		assert.equal(existsSync(script), false);
	});
});

test("a task that won't start right away says it starts at the next logon", async () => {
	await inConfig("win-run-fail", async () => {
		winSeam({ exec: fakeExec((cmd, args) => (args[0] === "/Run" ? { code: 1, out: "ERROR: x" } : { code: 0, out: "" })).exec, windowsUser: "PC\\x" });
		const r = await installService(HUB_SERVICE);
		assert.equal(r.ok, false);
		assert.match(r.message, /schtasks \/Run \/TN com\.polycarp\.hub failed: ERROR: x\. The task is made and starts at your next logon\./);
	});
});

// ---------- Windows: finding tailscale.exe and cloudflared.exe ----------

const winEnv = { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)" };

test("the Windows install folders are Tailscale's and cloudflared's own, in order", () => {
	assert.deepEqual(windowsInstallPaths("tailscale", winEnv), ["C:\\Program Files\\Tailscale\\tailscale.exe"]);
	assert.deepEqual(windowsInstallPaths("cloudflared", winEnv), ["C:\\Program Files\\cloudflared\\cloudflared.exe", "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe"]);
	assert.deepEqual(windowsInstallPaths("tailscale", { ProgramFiles: "D:\\Apps" }), ["D:\\Apps\\Tailscale\\tailscale.exe"]);
});

test("tailscale.exe on PATH wins, then the installer's folder, then nothing", () => {
	const asked = [];
	const which = (found) => (name) => (asked.push(name), found);
	assert.equal(tailscaleBinary({ platform: "win32", env: winEnv, which: which("C:\\bin\\tailscale.exe"), exists: () => true }), "C:\\bin\\tailscale.exe");
	assert.deepEqual(asked, ["tailscale.exe"]);
	assert.equal(tailscaleBinary({ platform: "win32", env: winEnv, which: which(undefined), exists: (p) => p === "C:\\Program Files\\Tailscale\\tailscale.exe" }), "C:\\Program Files\\Tailscale\\tailscale.exe");
	assert.equal(tailscaleBinary({ platform: "win32", env: winEnv, which: which(undefined), exists: () => false }), undefined);
});

test("cloudflared.exe on PATH wins, then Program Files, then Program Files (x86), then Polycarp's own download", async () => {
	await inConfig("win-lookup", async (dir) => {
		const own = join(dir, "bin", "cloudflared.exe");
		assert.equal(downloadedCloudflared("win32"), own);
		const seen = new Set();
		const lookup = (onPath, present) => ({ platform: "win32", env: winEnv, which: () => onPath, exists: (p) => (seen.add(p), present.includes(p)) });
		const all = ["C:\\Program Files\\cloudflared\\cloudflared.exe", "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe", own];
		assert.equal(cloudflaredBinary(lookup("C:\\tools\\cloudflared.exe", all)), "C:\\tools\\cloudflared.exe");
		assert.equal(cloudflaredBinary(lookup(undefined, all)), all[0]);
		assert.equal(cloudflaredBinary(lookup(undefined, all.slice(1))), all[1]);
		assert.equal(cloudflaredBinary(lookup(undefined, [own])), own);
		assert.equal(cloudflaredBinary(lookup(undefined, [])), undefined);
		// No Homebrew folder, no file without .exe.
		assert.ok(![...seen].some((p) => /homebrew|\/usr\/local|cloudflared$/.test(p)), [...seen].join(" "));
		assert.equal(windowsTool("cloudflared", lookup(undefined, [])), undefined);
	});
});

// ---------- Windows: Polycarp's own cloudflared ----------

async function serve(body) {
	const server = createServer((_req, res) => res.end(body));
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { url: `http://127.0.0.1:${server.address().port}`, stop: () => server.close() };
}

test("Windows x64 gets the pinned release's .exe with GitHub's digest; Windows on Arm gets none", () => {
	assert.equal(CLOUDFLARED_VERSION, "2026.10.7");
	assert.deepEqual(cloudflaredAsset("win32", "x64"), { name: "cloudflared-windows-amd64.exe", sha256: "2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343", archive: false });
	assert.equal(cloudflaredAsset("win32", "arm64"), undefined);
	assert.equal(cloudflaredAsset("win32", "ia32"), undefined);
});

test("on Windows the download is checked before it becomes cloudflared.exe, and a wrong digest leaves nothing", async () => {
	await inConfig("win-download", async (dir) => {
		const body = Buffer.from("MZ fake windows program");
		const server = await serve(body);
		try {
			const name = cloudflaredAsset("win32", "x64").name;
			const bad = await downloadCloudflared({ platform: "win32", baseUrl: server.url, asset: { name, sha256: sha(Buffer.from("other")), archive: false } });
			assert.equal(bad.ok, false);
			assert.match(bad.message, /checksum/);
			assert.deepEqual(readdirSync(join(dir, "bin")), []);
			const good = await downloadCloudflared({ platform: "win32", baseUrl: server.url, asset: { name, sha256: sha(body), archive: false } });
			assert.deepEqual(good, { ok: true, path: join(dir, "bin", "cloudflared.exe") });
			assert.deepEqual(readFileSync(good.path), body);
			assert.deepEqual(readdirSync(join(dir, "bin")), ["cloudflared.exe"]);
		} finally {
			server.stop();
		}
	});
});

test("a non-ASCII profile folder is never written into the script: it is plain ASCII and finds its folders from %~dp0", async () => {
	await inConfig(
		"win-unicode",
		async (dir) => {
			winSeam({ exec: fakeExec().exec, windowsUser: "PC\\Jos\u00e9", launcher: join(dir, "polycarp.cmd") });
			const r = await installService(SERVE_SERVICE);
			assert.equal(r.ok, true, r.message);
			const bytes = readFileSync(join(dir, "services", "com.polycarp.serve.cmd"));
			assert.ok(bytes.every((b) => b < 0x80), "every byte cmd reads is ASCII, whatever its code page");
			const lines = bytes.toString("latin1").split("\r\n");
			assert.ok(!lines.some((l) => l.includes("Jos")), lines.join("\n"));
			assert.ok(lines.indexOf("chcp 65001 >nul") > 0 && lines.indexOf("chcp 65001 >nul") < lines.indexOf(":run"));
			assert.ok(lines.includes('for %%I in ("%~dp0..") do set "POLYCARP_HOME=%%~fI"'));
			assert.ok(lines.includes('set "POLYCARP_BROWSER_CONFIG_DIR=%POLYCARP_HOME%"'));
			assert.ok(lines.includes('set "TABKYRA_CONFIG_DIR=%POLYCARP_HOME%"'));
			assert.ok(lines.includes('set "POLYCARP_LOG=%POLYCARP_HOME%\\logs\\polycarp-serve.log"'));
			assert.ok(lines.includes('>>"%POLYCARP_LOG%" 2>&1 ('));
			assert.ok(lines.includes('\tcall "%POLYCARP_HOME%\\polycarp.cmd" serve'));
		},
		"Jos\u00e9 M\u00fcller",
	);
});

test("a launcher outside the config folder, or a folder variable with a non-ASCII value, makes no task", async () => {
	await inConfig("win-outside", async (dir) => {
		const fake = fakeExec();
		winSeam({ exec: fake.exec, windowsUser: "PC\\x", launcher: "C:\\elsewhere\\polycarp.cmd" });
		const r = await installService(SERVE_SERVICE);
		assert.equal(r.ok, false);
		assert.match(r.message, /isn't in the config folder/);
		assert.deepEqual(fake.calls, []);
	});
	assert.throws(() => windowsScriptText("polycarp.cmd", { POLYCARP_SOCKET_DIR: "C:\\Jos\u00e9\\s" }, SERVE_SERVICE), /plain ASCII/);
});

test("Windows runs only a launcher it can execute: .exe, .cmd or .bat, never the extensionless POSIX one", async () => {
	await inConfig("win-launcher-ext", async (dir) => {
		for (const name of ["polycarp", "polycarp.sh", "polycarp.ps1"]) {
			const fake = fakeExec();
			winSeam({ exec: fake.exec, windowsUser: "PC\\x", launcher: join(dir, name) });
			const r = await installService(SERVE_SERVICE);
			assert.equal(r.ok, false, name);
			assert.match(r.message, /Windows can't run it/, name);
			assert.deepEqual(fake.calls, [], name);
		}
		for (const name of ["polycarp.cmd", "polycarp-browser.exe", "polycarp.bat"]) {
			winSeam({ exec: fakeExec().exec, windowsUser: "PC\\x", launcher: join(dir, name) });
			const r = await installService(SERVE_SERVICE);
			assert.equal(r.ok, true, `${name}: ${r.message}`);
		}
	});
});

// ---------- Windows: the program the task started is really stopped ----------

const TASKLIST = "C:\\Windows\\System32\\tasklist.exe";
const TASKKILL = "C:\\Windows\\System32\\taskkill.exe";

/** A stand-in Windows where process `pid` (`image`) runs until taskkill /T ends it, or never if `stubborn`. */
function windowsWith(pid, image, { stubborn = false, onKill } = {}) {
	let alive = true;
	return fakeExec((cmd, args) => {
		if (cmd === TASKLIST) {
			const row = `"${image}","${pid}","Console","1","40,000 K"`;
			return { code: 0, out: alive ? row : "INFO: No tasks are running which match the specified criteria." };
		}
		if (cmd === TASKKILL) {
			onKill?.();
			if (!stubborn) alive = false;
			return { code: 0, out: "" };
		}
		return { code: 0, out: "" };
	});
}

test("the service's helper records its pid and image for the task, and its children don't inherit the variable", async () => {
	await inConfig("win-pid", async (dir) => {
		const file = join(dir, "services", "com.polycarp.serve.pid");
		mkdirSync(join(dir, "services"), { recursive: true });
		const env = { POLYCARP_SERVICE_PID_FILE: file };
		recordServicePid(env, 4242, "C:\\Program Files\\nodejs\\node.exe", "win32");
		assert.equal(readFileSync(file, "utf8"), "4242\nnode.exe\n");
		assert.equal(env.POLYCARP_SERVICE_PID_FILE, undefined);
		const mac = { POLYCARP_SERVICE_PID_FILE: join(dir, "x.pid") };
		recordServicePid(mac, 1, "/usr/bin/node", "darwin");
		assert.equal(existsSync(join(dir, "x.pid")), false);
	});
});

test("the script tells the helper where to record its pid", async () => {
	const text = windowsScriptText("polycarp.cmd", {}, SERVE_SERVICE);
	assert.ok(text.includes('set "POLYCARP_SERVICE_PID_FILE=%POLYCARP_HOME%\\services\\com.polycarp.serve.pid"\r\n'));
});

test("the task replaces a running copy itself (StopExisting), so /Run can't be ignored while the old one is ending", () => {
	const xml = windowsTaskXml("C:\\s.cmd", "PC\\x", SERVE_SERVICE);
	assert.ok(xml.includes("<MultipleInstancesPolicy>StopExisting</MultipleInstancesPolicy>"));
	assert.ok(!xml.includes("IgnoreNew"));
});

test("reinstalling stops the running program tree and confirms it is gone before the script is rewritten, then runs once", async () => {
	await inConfig("win-reinstall", async (dir) => {
		const script = join(dir, "services", "com.polycarp.serve.cmd");
		const pidFile = join(dir, "services", "com.polycarp.serve.pid");
		mkdirSync(join(dir, "services"), { recursive: true });
		writeFileSync(script, "OLD SCRIPT");
		writeFileSync(pidFile, "777\nnode.exe\n");
		let scriptAtKill;
		const fake = windowsWith(777, "node.exe", { onKill: () => (scriptAtKill = readFileSync(script, "utf8")) });
		winSeam({ exec: fake.exec, windowsUser: "PC\\x" });
		const r = await installService(SERVE_SERVICE);
		assert.equal(r.ok, true, r.message);
		assert.equal(scriptAtKill, "OLD SCRIPT", "the old program is stopped before its script changes");
		const verbs = fake.calls.map(([cmd, ...a]) => (cmd === SCHTASKS ? a[0] : cmd === TASKKILL ? `taskkill ${a.join(" ")}` : "tasklist"));
		assert.deepEqual(verbs, ["/End", "tasklist", "taskkill /PID 777 /T /F", "tasklist", "/Create", "/Run"]);
		assert.deepEqual(fake.calls[1], [TASKLIST, "/FI", "PID eq 777", "/FO", "CSV", "/NH"]);
		assert.equal(existsSync(pidFile), false);
		assert.notEqual(readFileSync(script, "utf8"), "OLD SCRIPT");
	});
});

test("a program that survives taskkill fails stop and uninstall, keeps the script and the task, and says what to do", async () => {
	await inConfig("win-stubborn", async (dir) => {
		winSeam({ exec: fakeExec().exec, windowsUser: "PC\\x", stopWaitMs: 50 });
		assert.equal((await installService(SERVE_SERVICE)).ok, true);
		writeFileSync(join(dir, "services", "com.polycarp.serve.pid"), "888\npolycarp-browser.exe\n");
		const fake = windowsWith(888, "polycarp-browser.exe", { stubborn: true });
		winSeam({ exec: fake.exec, windowsUser: "PC\\x", stopWaitMs: 50 });
		const r = removeService(SERVE_SERVICE);
		assert.equal(r.ok, false);
		assert.match(r.failure, /polycarp-browser\.exe \(pid 888\) is still running/);
		assert.match(r.failure, /taskkill \/PID 888 \/T \/F/);
		assert.ok(existsSync(join(dir, "services", "com.polycarp.serve.cmd")));
		assert.ok(!fake.calls.some(([cmd, verb]) => cmd === SCHTASKS && verb === "/Delete"));
		const again = await installService(SERVE_SERVICE);
		assert.equal(again.ok, false);
		assert.match(again.message, /is still running/);
	});
});

test("uninstall kills the recorded tree, confirms it, then deletes the task; a pid now used by another program is left alone", async () => {
	await inConfig("win-remove-tree", async (dir) => {
		winSeam({ exec: fakeExec().exec, windowsUser: "PC\\x" });
		assert.equal((await installService(SERVE_SERVICE)).ok, true);
		writeFileSync(join(dir, "services", "com.polycarp.serve.pid"), "999\nnode.exe\n");
		const fake = windowsWith(999, "node.exe");
		winSeam({ exec: fake.exec });
		assert.equal(removeService(SERVE_SERVICE).ok, true);
		const verbs = fake.calls.map(([cmd, ...a]) => (cmd === SCHTASKS ? a[0] : cmd === TASKKILL ? "taskkill" : "tasklist"));
		assert.deepEqual(verbs, ["/End", "tasklist", "taskkill", "tasklist", "/Delete"]);
		// Reused pid: another image now has it, so nothing is killed.
		winSeam({ exec: fakeExec().exec, windowsUser: "PC\\x" });
		await installService(SERVE_SERVICE);
		writeFileSync(join(dir, "services", "com.polycarp.serve.pid"), "555\nnode.exe\n");
		const other = windowsWith(555, "notepad.exe");
		winSeam({ exec: other.exec });
		assert.equal(removeService(SERVE_SERVICE).ok, true);
		assert.ok(!other.calls.some(([cmd]) => cmd === TASKKILL));
	});
});
