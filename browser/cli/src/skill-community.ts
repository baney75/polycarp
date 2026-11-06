/**
 * Rules for community skills (docs/decisions.md D27, CONTRIBUTING-skills.md), on top of the
 * skill lint every skill passes (skill-lint.ts):
 *
 * - scope: a community skill names its sites in a `## Sites` section, and every link in it
 *   points at one of them, so a skill for one site can't steer an agent to another;
 * - page-script: no run_js and no page scripting, so a skill can't run code under the user's
 *   sign-in or send page data anywhere;
 * - credential-request: no step that asks for a password, a code, a key or a cookie;
 * - exfiltration: no step that sends page content or account data off the page;
 * - personal data (`scanPersonal`): no emails, phone numbers, home paths, private or
 *   signed-in URLs, account names, cookies or copied page text. Submission refuses a skill
 *   with any of these (D6); it never edits the skill behind the user's back.
 *
 * The same checks run in `tabkyra skill lint --community`, `skill test`, `skill submit`, CI,
 * and on every client before a synced skill is used.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { redactSecrets } from "../../src/privacy/bug-reports.ts";
import type { Finding } from "./skill-lint.ts";

/** At most this many sites per skill: a skill for "every site" isn't scoped. */
export const MAX_SITES = 10;

/** A hostname a skill may name: letters, digits and hyphens in dot-separated labels, with a real TLD. */
const HOST = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
const PRIVATE_HOST = /(^|\.)(localhost|local|internal|intranet|corp|lan|home|test|example|invalid|ts\.net)$/;
const URL_RE = /\bhttps?:\/\/[^\s)>\]"'`]+/gi;

/** The `## Sites` section's hostnames, or undefined when the skill has none. */
export function parseSites(text: string): { sites: string[]; line: number; problems: Array<{ line: number; message: string }> } | undefined {
	const lines = text.split("\n");
	const start = lines.findIndex((l) => /^## Sites\s*$/.test(l));
	if (start < 0) return undefined;
	const sites: string[] = [];
	const problems: Array<{ line: number; message: string }> = [];
	for (let i = start + 1; i < lines.length && !/^## /.test(lines[i]); i++) {
		const line = lines[i].trim();
		if (!line) continue;
		const m = /^[-*]\s+`?([^\s`]+)`?\s*$/.exec(line);
		if (!m) {
			problems.push({ line: i + 1, message: "Each line under ## Sites is one bullet with one hostname, like `- notion.so`." });
			continue;
		}
		const host = m[1].toLowerCase().replace(/\.$/, "");
		if (!HOST.test(host) || PRIVATE_HOST.test(host)) {
			problems.push({ line: i + 1, message: `"${m[1]}" is not a public hostname. Name the site, like notion.so: no scheme, path, port, wildcard, IP address or private name.` });
			continue;
		}
		if (!sites.includes(host)) sites.push(host);
	}
	return { sites, line: start + 1, problems };
}

/** Second-level labels that are part of a public suffix (bbc.co.uk names "bbc", not "co"). */
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "gov", "edu", "or", "ne", "go"]);

/** The word a person uses for a site: "notion" for notion.so, "google" for mail.google.com. */
export function siteWord(host: string): string {
	const labels = host.toLowerCase().split(".");
	let i = labels.length - 2;
	if (i > 0 && SECOND_LEVEL.has(labels[i]) && labels.length >= 3) i--;
	return labels[Math.max(0, i)] ?? host;
}

/** True when a task names one of `sites`: its word ("notion"), its host, or a link to it. */
export function namesSite(task: string, sites: readonly string[]): boolean {
	const t = task.toLowerCase();
	return sites.some((s) => {
		const word = siteWord(s);
		return t.includes(s) || (word.length >= 3 && new RegExp(`(^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`).test(t));
	});
}

/** True when `host` is one of `sites` or a subdomain of one. */
export function inScope(host: string, sites: readonly string[]): boolean {
	const h = host.toLowerCase().replace(/\.$/, "");
	return sites.some((s) => h === s || h.endsWith(`.${s}`));
}

/** A clause that starts with a prohibition ("Never type the password") is guidance, not a request. */
function negated(line: string): boolean {
	return /^\s*(?:[-*>]\s+|\d+\.\s+)?(?:\*\*)?\s*(?:never|don't|do not|must not|mustn't)\b/i.test(line);
}

const CREDENTIAL = "(?:passwords?|passcodes?|passphrases?|pins?|2fa|mfa|two-factor|one-time (?:codes?|passwords?)|otp|verification codes?|security codes?|recovery (?:codes?|phrases?)|seed phrases?|api ?keys?|access tokens?|auth(?:entication)? tokens?|session tokens?|tokens?|cookies?|credentials?|card numbers?|cvv|cvc|social security numbers?|ssn)";
const COMMUNITY_RULES: Array<{ rule: string; pattern: RegExp; message: string; negatable: boolean }> = [
	{
		rule: "page-script",
		pattern: /\brun_js\b|\bbrowserjs\b|\bfetch\s*\(|\bXMLHttpRequest\b|\bsendBeacon\b|\bWebSocket\b|\beval\s*\(|\bnew Function\b|\bdocument\.cookie\b|\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|\bjavascript:/i,
		message: "Community skills don't run page scripts. Use navigate, read_page, find, click, type and press.",
		negatable: false,
	},
	{
		rule: "credential-request",
		pattern: new RegExp(`\\b(ask|request|prompt|get|collect|obtain|need|have)\\b[^.\\n]{0,40}\\b(user|them|they|you|their)\\b[^.\\n]{0,40}\\b${CREDENTIAL}\\b|\\b(type|enter|fill|paste|input|provide|supply|give|read|copy|find|grab|extract)\\b[^.\\n]{0,40}\\b${CREDENTIAL}\\b`, "i"),
		message: "Asks for a password, code, key, token or cookie. Sign-in is the user's job: tell the agent to call tabs_show and ask the user to sign in.",
		negatable: true,
	},
	{
		rule: "exfiltration",
		pattern:
			/\b(send|post|upload|email|e-mail|forward|share|submit|paste|report|transmit|sync|mirror|export)\b[^.\n]{0,60}\b(to|into|with)\b[^.\n]{0,40}\b(webhooks?|pastebin|gists?|discord|telegram|slack|whatsapp|another (site|page|server|service|account)|external|third[- ]party|remote server|an? (url|endpoint|server|form)|my server|this server)\b/i,
		message: "Sends page content or account data off the page. A community skill only reads and navigates its own sites.",
		negatable: true,
	},
];

/** Lint the community rules for one SKILL.md. `bundled` names may not be reused. */
export function lintCommunity(file: string, text: string, options: { bundled?: ReadonlySet<string>; name?: string } = {}): Finding[] {
	const findings: Finding[] = [];
	const add = (line: number, rule: string, message: string) => findings.push({ file, line, rule, severity: "error", message });
	if (options.name && options.bundled?.has(options.name)) add(2, "community-name", `"${options.name}" is a built-in skill. A community skill takes a name of its own; changes to built-in skills go through a pull request to skills/.`);
	const parsed = parseSites(text);
	if (!parsed) add(1, "scope", 'A community skill needs a "## Sites" section listing the sites it works on, one hostname per bullet (- notion.so).');
	else {
		for (const p of parsed.problems) add(p.line, "scope", p.message);
		if (parsed.sites.length === 0 && parsed.problems.length === 0) add(parsed.line, "scope", "## Sites names no site.");
		if (parsed.sites.length > MAX_SITES) add(parsed.line, "scope", `${parsed.sites.length} sites; a community skill covers at most ${MAX_SITES}. Split it by site.`);
	}
	const sites = parsed?.sites ?? [];
	text.split("\n").forEach((line, i) => {
		const n = i + 1;
		for (const m of line.matchAll(URL_RE)) {
			let host = "";
			try {
				host = new URL(m[0]).hostname;
			} catch {
				add(n, "scope", `Not a valid link: ${m[0]}`);
				continue;
			}
			if (!m[0].toLowerCase().startsWith("https://")) add(n, "scope", `Use https: ${m[0]}`);
			else if (!inScope(host, sites)) add(n, "scope", `${host} is not one of the skill's sites (${sites.join(", ") || "none named"}). A community skill only sends the agent to the sites it names.`);
		}
		for (const r of COMMUNITY_RULES) {
			if (r.pattern.test(line) && !(r.negatable && negated(line))) add(n, r.rule, r.message);
		}
	});
	for (const p of scanPersonal(text)) add(p.line, "personal-data", `${p.kind}: ${p.match}. ${PERSONAL_FIX}`);
	return findings;
}

export const PERSONAL_FIX = "Community skills hold no personal data (decision D6): rewrite it in general terms.";

export interface PersonalFinding {
	line: number;
	kind: string;
	match: string;
}

/**
 * Names that identify this user: the OS account, git's user.name and user.email, the GitHub
 * login (when the caller knows it), and any names listed in ~/.config/tabkyra/private.json
 * ({"names": ["..."]}). Only names of 3 or more characters count, so a short one doesn't
 * match ordinary words.
 */
export function privateNames(extra: string[] = []): string[] {
	const names = new Set<string>();
	const add = (n: string | undefined) => {
		const t = n?.trim();
		if (t && t.length >= 3) names.add(t);
	};
	try {
		add(userInfo().username);
	} catch {
		/* no account name */
	}
	for (const key of ["user.name", "user.email"]) {
		const r = spawnSync("git", ["config", "--global", key], { encoding: "utf8", timeout: 3000 });
		if (r.status === 0) add(r.stdout);
	}
	const configDir = process.env.TABKYRA_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "tabkyra");
	const file = join(configDir, "private.json");
	if (existsSync(file)) {
		try {
			const data = JSON.parse(readFileSync(file, "utf8")) as { names?: unknown };
			if (Array.isArray(data.names)) for (const n of data.names) if (typeof n === "string") add(n);
		} catch {
			/* unreadable: no extra names */
		}
	}
	for (const n of extra) add(n);
	return [...names];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Personal data in skill text: refused, never rewritten. Each finding names the line and
 * what was found, with the match shortened so the report doesn't repeat a secret.
 */
export function scanPersonal(text: string, names: readonly string[] = []): PersonalFinding[] {
	const out: PersonalFinding[] = [];
	const seen = new Set<string>();
	const show = (s: string) => (s.length > 24 ? `${s.slice(0, 10)}...${s.slice(-6)}` : s);
	const push = (line: number, kind: string, match: string) => {
		const key = `${line}:${kind}`;
		if (seen.has(key)) return;
		seen.add(key);
		out.push({ line, kind, match: show(match) });
	};
	const nameRes = names.map((n) => ({ n, re: new RegExp(`(^|[^\\w])${escapeRe(n)}($|[^\\w])`, "i") }));
	text.split("\n").forEach((line, i) => {
		const n = i + 1;
		const email = /[\w.+-]+@[\w-]+(\.[\w-]+)+/.exec(line);
		if (email) push(n, "email address", email[0]);
		const phone = /(?<![\w.])(\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?![\w.])/.exec(line);
		if (phone) push(n, "phone number", phone[0]);
		const home = /(\/Users\/|\/home\/|[A-Z]:\\Users\\)[^/\\\s]+/.exec(line);
		if (home) push(n, "home folder path", home[0]);
		const ip = /\b(?:\d{1,3}\.){3}\d{1,3}\b/.exec(line);
		if (ip) push(n, "IP address", ip[0]);
		if (redactSecrets(line) !== line) push(n, "secret or token", line.trim());
		if (/\b(set-cookie|cookie:|sessionid=|session_id=|_session=|csrftoken=|auth_token=|sid=)/i.test(line)) push(n, "cookie", line.trim());
		for (const m of line.matchAll(URL_RE)) {
			let u: URL;
			try {
				u = new URL(m[0]);
			} catch {
				continue;
			}
			if (PRIVATE_HOST.test(u.hostname) || /^\d/.test(u.hostname)) push(n, "private address", m[0]);
			if (u.search || u.hash) push(n, "link with a query or fragment (it can carry account or session data)", m[0]);
			if (u.username || u.password) push(n, "link with a user name", m[0]);
			// Record ids in a path name one page in someone's account (a Notion page, a doc, a ticket).
			if (u.pathname.split("/").some((seg) => /[0-9a-f]{16,}/i.test(seg) || (/\d/.test(seg) && /[a-z]/i.test(seg) && seg.replace(/[^A-Za-z0-9]/g, "").length >= 20))) {
				push(n, "link to a specific page in an account", m[0]);
			}
		}
		const quote = /^\s*>\s?\S/.test(line) ? line : (/"[^"]{80,}"|“[^”]{80,}”/.exec(line)?.[0] ?? "");
		if (quote) push(n, "copied text (a block quote or a long quotation); describe what you saw in your own words", quote.trim());
		for (const { n: name, re } of nameRes) if (re.test(line)) push(n, "your name or account name", name);
	});
	return out;
}

/**
 * Text that leaves the machine with a submission (lint output, eval output, the pull request
 * body): secrets, home paths and the user's names are replaced. The skill text itself is
 * never rewritten; scanPersonal refuses it instead.
 */
export function scrubOutput(text: string, names: readonly string[] = []): string {
	let out = redactSecrets(text)
		.replace(/(\/Users\/|\/home\/)[^/\s]+/g, "~")
		.replace(/[A-Z]:\\Users\\[^\\\s]+/g, "~")
		.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]");
	const tmp = process.env.TMPDIR;
	if (tmp && tmp.length > 4) out = out.split(tmp).join("$TMPDIR/");
	for (const name of [...names].sort((a, b) => b.length - a.length)) out = out.replace(new RegExp(escapeRe(name), "gi"), "[you]");
	return out;
}
