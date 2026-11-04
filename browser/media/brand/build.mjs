// Draws the Tabkyra helm from its geometry and exports every brand asset:
//   media/brand/{mark,mark-brass,icon,icon-16}.svg
//   static/icon-{16,32,48,128}.png        extension icons
//   src/components/helm-svg.ts            the same SVGs for the side panel
//   media/brand/hero.png, hero-light.png   README hero for dark and light themes
//   media/brand/social.png                 GitHub social preview (1280x640)
//   site/src/frontend/public/img/og.png    the site's social card
// Run after changing the geometry or the palette: node media/brand/build.mjs
// Rendering uses the CLI's Playwright Chromium, headless, with a mock keychain.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "../../cli/node_modules/playwright-core/index.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");

export const PALETTE = { ink: "#0F1B24", brass: "#E3A93B", tide: "#43B3A0", paper: "#F6F2EA", slate: "#6B7A86" };
const { ink, brass } = PALETTE;

const f = (n) => +n.toFixed(2);

/** n tapered pegs from radius r0 (half-width a) to r1 (half-width b), rounded at the grip. */
function pegs(cx, cy, r0, r1, n, a, b, color) {
	let out = "";
	for (let i = 0; i < n; i++) {
		const t = ((-90 + (360 / n) * i) * Math.PI) / 180;
		const ux = Math.cos(t);
		const uy = Math.sin(t);
		const p = (r, w) => `${f(cx + r * ux - w * uy)} ${f(cy + r * uy + w * ux)}`;
		out += `<path d="M${p(r0, a)} L${p(r1, b)} A${b} ${b} 0 0 0 ${p(r1, -b)} L${p(r0, -a)} Z" fill="${color}"/>`;
	}
	return out;
}

/** The pointer that sits on the hub: the user's hand on the wheel. */
const pointer = (color) =>
	`<path d="M0 0 L0 15 L4.2 11 L7.2 17.6 L10 16.3 L7.1 9.9 L12.6 9.9 Z" fill="${color}" stroke="${color}" stroke-width="1.4" stroke-linejoin="round" transform="translate(28 23.4)"/>`;

/** The helm on a 64 grid: rim, eight turned pegs, pointer hub. */
const helm = (color) =>
	`<circle cx="32" cy="32" r="15" fill="none" stroke="${color}" stroke-width="5"/>${pegs(32, 32, 15, 25.5, 8, 1.7, 3.3, color)}${pointer(color)}`;

const svg = (viewBox, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>\n`;

export const SVG = {
	mark: svg("0 0 64 64", helm(ink)),
	"mark-brass": svg("0 0 64 64", helm(brass)),
	icon: svg("0 0 64 64", `<rect width="64" height="64" rx="15" fill="${brass}"/>${helm(ink)}`),
	// 16 px is drawn on its own grid: six pegs and a solid hub, because eight pegs and a
	// pointer blur together at that size.
	"icon-16": svg(
		"0 0 16 16",
		`<rect width="16" height="16" rx="3.75" fill="${brass}"/><circle cx="8" cy="8" r="3.3" fill="none" stroke="${ink}" stroke-width="1.7"/>${pegs(8, 8, 3.3, 6.2, 6, 0.7, 1.3, ink)}<circle cx="8" cy="8" r="1.3" fill="${ink}"/>`,
	),
};

const fonts = join(repo, "site", "node_modules", "@fontsource");
/** Fonts inlined as data URLs: a page from setContent cannot read file:// URLs. */
const font = (pkg, file) =>
	`url(data:font/woff2;base64,${readFileSync(join(fonts, pkg, "files", file)).toString("base64")})`;
const fontFaces = `
@font-face { font-family: "Instrument Sans"; font-weight: 400; src: ${font("instrument-sans", "instrument-sans-latin-400-normal.woff2")}; }
@font-face { font-family: "Instrument Sans"; font-weight: 600; src: ${font("instrument-sans", "instrument-sans-latin-600-normal.woff2")}; }
@font-face { font-family: "Instrument Serif"; font-style: italic; src: ${font("instrument-serif", "instrument-serif-latin-400-italic.woff2")}; }
@font-face { font-family: "JetBrains Mono"; src: ${font("jetbrains-mono", "jetbrains-mono-latin-400-normal.woff2")}; }`;

const dataUrl = (body) => `data:image/svg+xml;base64,${Buffer.from(body).toString("base64")}`;

/** The harnesses named on the hero; the social card drops the last item to fit its footer. */
const HARNESS_NAMES = "Claude Code · Codex · pi · OMP · OpenCode · Cursor";
const HARNESSES = `${HARNESS_NAMES} · any MCP client`;

/**
 * Colors per theme. Dark is the brand default (ink surface). Light sets the line in brass
 * deep, because brass is never text on a light surface (BRAND.md).
 */
const THEMES = {
	dark: { surface: ink, word: PALETTE.paper, line: brass, sub: "#9FB0BC" },
	light: { surface: PALETTE.paper, word: ink, line: "#A8761C", sub: PALETTE.slate },
};

/** README hero: helm, wordmark, the line, the harnesses. */
function banner(width, height, theme = "dark") {
	const t = THEMES[theme];
	return `<!doctype html><html><head><style>${fontFaces}
	html, body { margin: 0; }
	.card { width: ${width}px; height: ${height}px; box-sizing: border-box; background: ${t.surface}; color: ${t.word};
		display: flex; align-items: center; gap: 56px; padding: 0 88px; font-family: "Instrument Sans", sans-serif; position: relative; overflow: hidden; }
	.wake { position: absolute; right: -${Math.round(height * 0.55)}px; top: 50%; width: ${Math.round(height * 1.7)}px; height: ${Math.round(height * 1.7)}px;
		transform: translateY(-50%) rotate(11deg); opacity: ${theme === "dark" ? 0.07 : 0.14}; }
	.mark { width: ${Math.round(height * 0.46)}px; height: ${Math.round(height * 0.46)}px; flex: none; }
	.word { font-family: "Instrument Sans"; font-weight: 600; font-size: ${Math.round(height * 0.2)}px; letter-spacing: -0.035em; line-height: 1; }
	.line { font-family: "Instrument Serif"; font-style: italic; font-size: ${Math.round(height * 0.092)}px; color: ${t.line}; margin-top: 18px; }
	.sub { font-family: "JetBrains Mono"; font-size: ${Math.round(height * 0.036)}px; color: ${t.sub}; margin-top: 26px; letter-spacing: 0.01em; }
	</style></head><body><div class="card">
	<img class="wake" src="${dataUrl(SVG["mark-brass"])}">
	<img class="mark" src="${dataUrl(SVG.icon)}">
	<div><div class="word">Tabkyra</div>
	<div class="line">You steer. Your agents work the tabs.</div>
	<div class="sub">${HARNESSES}</div></div>
	</div></body></html>`;
}

/**
 * Social cards: GitHub's preview (1280x640) and the site's og.png (1200x630). A shared link
 * shows the card alone, so it says what Tabkyra is in one sentence.
 */
function socialCard(width, height) {
	const t = THEMES.dark;
	return `<!doctype html><html><head><style>${fontFaces}
	html, body { margin: 0; }
	.card { width: ${width}px; height: ${height}px; box-sizing: border-box; background: ${t.surface}; color: ${t.word};
		padding: 84px 96px 72px; font-family: "Instrument Sans", sans-serif; position: relative; overflow: hidden;
		display: flex; flex-direction: column; }
	.wake { position: absolute; right: -230px; top: 50%; width: 760px; height: 760px; transform: translateY(-50%) rotate(11deg); opacity: 0.07; }
	.head { display: flex; align-items: center; gap: 34px; }
	.mark { width: 124px; height: 124px; flex: none; }
	.word { font-weight: 600; font-size: 112px; letter-spacing: -0.035em; line-height: 1; }
	.line { font-family: "Instrument Serif"; font-style: italic; font-size: 60px; color: ${t.line}; margin-top: 44px; line-height: 1.1; }
	.what { font-weight: 400; font-size: 31px; line-height: 1.4; color: ${t.word}; opacity: 0.86; margin-top: 22px; max-width: 900px; }
	.foot { margin-top: auto; display: flex; justify-content: space-between; align-items: baseline;
		font-family: "JetBrains Mono"; font-size: 21px; color: ${t.sub}; letter-spacing: 0.01em; white-space: nowrap; position: relative; }
	</style></head><body><div class="card">
	<img class="wake" src="${dataUrl(SVG["mark-brass"])}">
	<div class="head"><img class="mark" src="${dataUrl(SVG.icon)}"><div class="word">Tabkyra</div></div>
	<div class="line">You steer. Your agents work the tabs.</div>
	<div class="what">Coding agents drive your real browser through MCP, in their own tab group, and ask before they open a new site.</div>
	<div class="foot"><span>${HARNESS_NAMES}</span><span>github.com/baney75/tabkyra</span></div>
	</div></body></html>`;
}

async function main() {
	for (const [name, body] of Object.entries(SVG)) writeFileSync(join(here, `${name}.svg`), body);
	// Written the way Biome formats it, so `./check.sh` leaves the file alone.
	const constant = (name, body) => `export const ${name} =\n\t'${body.trim()}';\n`;
	writeFileSync(
		join(repo, "src", "components", "helm-svg.ts"),
		"// Generated by media/brand/build.mjs. Edit the geometry there, not here.\n" +
			constant("HELM_ICON", SVG.icon) +
			constant("HELM_ICON_16", SVG["icon-16"]) +
			constant("HELM_MARK", SVG.mark.replaceAll(PALETTE.ink, "currentColor")),
	);

	const browser = await chromium.launch({ headless: true, args: ["--use-mock-keychain", "--password-store=basic"] });
	try {
		const shoot = async (html, width, height, scale, out, transparent) => {
			const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
			await page.setContent(html);
			await page.evaluate(() => document.fonts.ready);
			mkdirSync(dirname(out), { recursive: true });
			await page.screenshot({ path: out, omitBackground: transparent });
			await page.close();
		};
		const iconPage = (body, size) =>
			`<!doctype html><html><body style="margin:0"><img style="display:block" width="${size}" height="${size}" src="${dataUrl(body)}"></body></html>`;
		for (const size of [16, 32, 48, 128]) {
			const body = size === 16 ? SVG["icon-16"] : SVG.icon;
			await shoot(iconPage(body, size), size, size, 1, join(repo, "static", `icon-${size}.png`), true);
		}
		await shoot(banner(1280, 400), 1280, 400, 2, join(here, "hero.png"), false);
		await shoot(banner(1280, 400, "light"), 1280, 400, 2, join(here, "hero-light.png"), false);
		await shoot(socialCard(1280, 640), 1280, 640, 1, join(here, "social.png"), false);
		await shoot(socialCard(1200, 630), 1200, 630, 1, join(repo, "site", "src", "frontend", "public", "img", "og.png"), false);
	} finally {
		await browser.close();
	}
}

// Importing this module for PALETTE or SVG must not re-render every asset.
const entry = process.argv[1] ? realpathSync(process.argv[1]) : undefined;
if (entry === realpathSync(fileURLToPath(import.meta.url))) await main();
