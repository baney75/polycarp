// Long tasks for the compaction eval: several big pages each, so the chat passes the compaction point mid-task.
// Each mount keeps its state in localStorage, so it adds up across the task's pages, and counts `repeats`: a done step
// done again. The runner checks `state` (the task finished) and `check` (checks.mjs).
import { compactionCheck } from "../checks.mjs";

const report = `<script>setInterval(() => { try { const j = JSON.stringify(window.__state); if (j && j !== window.__sent) { window.__sent = j; fetch("/" + location.pathname.split("/")[1] + "/__state", { method: "POST", body: j, keepalive: true }); } } catch {} }, 150);</script>`;
/** A page whose window.__state is the mount's shared state, saved with save(). */
const page = (title, init) =>
	`<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{font:15px system-ui;margin:24px;max-width:820px}</style>${report}<script>const K = "cmp-" + location.pathname.split("/")[1]; const load = () => (window.__state = JSON.parse(localStorage.getItem(K) || ${JSON.stringify(JSON.stringify(init))})); load(); const save = () => localStorage.setItem(K, JSON.stringify(window.__state)); addEventListener("storage", load);</script>`;

const words = "sealed bearing housing rated for continuous duty with a cast frame, replaceable gasket kit, corrosion coating and a two year service plan covering parts and labor at any regional depot".split(" ");
/** About `n` words of filler that differs by seed, so a page is long and no two rows read alike. */
const filler = (seed, n) => Array.from({ length: n }, (_, i) => words[(seed * 7 + i * 3) % words.length]).join(" ");

// ---------- inventory audit: four long aisle pages, flags that toggle, one submit ----------
const AISLES = [1, 2, 3, 4];
const items = (a) =>
	Array.from({ length: 36 }, (_, i) => {
		const low = (i * 5 + a * 3) % 17 === 0;
		return { name: `${["Valve", "Bracket", "Hose", "Gasket", "Filter", "Coupler"][i % 6]} ${a}${String(i + 1).padStart(2, "0")}`, count: low ? 2 + (i % 3) : 12 + ((i * 7) % 20), min: 6 + (i % 4) };
	});
const lowItems = AISLES.flatMap((a) => items(a).filter((it) => it.count < it.min).map((it) => it.name)).sort();
const aislePage = (a) => `${page(`Aisle ${a}`, { flags: {}, submits: 0, repeats: 0 })}
<h1>Aisle ${a}</h1><p><a href="./">All aisles</a></p><table border="1" cellpadding="4"><tr><th>Item</th><th>On hand</th><th>Minimum</th><th>Notes</th><th>Recount</th></tr>
${items(a).map((it, i) => `<tr><td>${it.name}</td><td>${it.count}</td><td>${it.min}</td><td>${filler(a * 40 + i, 34)}</td><td><label><input type="checkbox" data-item="${it.name}"> Flag ${it.name} for recount</label></td></tr>`).join("\n")}
</table>
<script>for (const b of document.querySelectorAll("input[data-item]")) { const n = b.dataset.item; b.checked = !!window.__state.flags[n];
  b.onchange = () => { load(); if (!b.checked && window.__state.flags[n]) window.__state.repeats++; if (b.checked) window.__state.flags[n] = true; else delete window.__state.flags[n]; save(); }; }</script>`;

// ---------- supplier quote: three catalogs in their own tabs, then back to the form ----------
const SUPPLIERS = { a: ["Northwind Pumps", "$412.00"], b: ["Harbor Industrial", "$389.50"], c: ["Cedar Flow Supply", "$405.75"] };
const catalog = (k) => `${page(SUPPLIERS[k][0], { submits: 0, repeats: 0 })}<h1>${SUPPLIERS[k][0]} catalog</h1><ul>
${Array.from({ length: 60 }, (_, i) => (i === 41 ? `<li><b>K-7 circulation pump</b>: ${SUPPLIERS[k][1]}. ${filler(i + 3, 30)}</li>` : `<li><b>K-${i + 10} ${["impeller", "seal kit", "flange", "motor mount"][i % 4]}</b>: $${(30 + ((i * 13 + k.charCodeAt(0)) % 300)).toFixed(2)}. ${filler(i + k.charCodeAt(0), 30)}</li>`)).join("\n")}</ul>`;
const hub = `${page("Quotes", { submits: 0, repeats: 0 })}<h1>Request a quote</h1><p>Supplier catalogs (each opens in a new tab):</p><ul>
${Object.entries(SUPPLIERS).map(([k, [n]]) => `<li><a href="supplier-${k}" target="_blank">${n}</a></li>`).join("")}</ul>
<form id="f"><label>Supplier <select id="s"><option value="">Choose</option>${Object.values(SUPPLIERS).map(([n]) => `<option>${n}</option>`).join("")}</select></label>
<label>Unit price <input id="p"></label><button>Request quote</button></form><p id="done" role="status"></p>
<script>document.getElementById("f").onsubmit = (e) => { e.preventDefault(); const st = load(); st.submits++; if (st.submits > 1) st.repeats++;
  st.quote = { supplier: document.getElementById("s").value, price: document.getElementById("p").value.trim() }; save(); document.getElementById("done").textContent = "Quote requested."; };</script>`;

// ---------- onboarding: five long policy steps, one field each, one submit ----------
const STEPS = [
	["Full name", "Rosa Delgado"],
	["Employee ID", "E-55210"],
	["Department", "Field Service"],
	["Start date", "2027-02-01"],
	["Laptop", "14-inch"],
];
const step = (n) => `${page(`Onboarding ${n}`, { values: {}, submits: 0, repeats: 0 })}<h1>Onboarding, step ${n} of 5</h1>
${Array.from({ length: 9 }, (_, i) => `<p>Policy ${n}.${i + 1}: ${filler(n * 20 + i, 60)}</p>`).join("\n")}
<label>${STEPS[n - 1][0]} <input id="v"></label> <button id="go">${n < 5 ? "Save and continue" : "Submit application"}</button><p id="msg" role="status"></p>
<script>const v = document.getElementById("v"); v.value = window.__state.values[${n}] ?? "";
document.getElementById("go").onclick = () => { const st = load(); st.values[${n}] = v.value.trim(); save();
  if (${n} < 5) { location.href = "step-${n + 1}"; return; } st.submits++; if (st.submits > 1) st.repeats++; st.sent = { ...st.values }; save(); document.getElementById("msg").textContent = "Application submitted."; };</script>`;

export const compactionTasks = [
	{
		id: "inventory-audit",
		kind: "browser",
		pages: {
			"/": `${page("Warehouse", { flags: {}, submits: 0, repeats: 0 })}<h1>Warehouse</h1><ul>${AISLES.map((a) => `<li><a href="aisle-${a}">Aisle ${a}</a></li>`).join("")}<li><a href="summary">Recount summary</a></li></ul>`,
			...Object.fromEntries(AISLES.map((a) => [`/aisle-${a}`, aislePage(a)])),
			"/summary": `${page("Summary", { flags: {}, submits: 0, repeats: 0 })}<h1>Recount summary</h1><p id="n"></p><button id="send">Send recount request</button><p id="msg" role="status"></p>
<script>document.getElementById("n").textContent = Object.keys(window.__state.flags).length + " items flagged.";
document.getElementById("send").onclick = () => { const st = load(); st.submits++; if (st.submits > 1) st.repeats++; st.sent = Object.keys(st.flags).sort(); save(); document.getElementById("msg").textContent = "Recount request sent."; };</script>`,
		},
		prompt: (url) =>
			`At ${url} go through all four aisles. In each one, flag for recount every item whose on-hand count is below its minimum, and nothing else. When all four aisles are done, open the recount summary and send the recount request once. Then tell me how many items you flagged.`,
		state: `JSON.stringify(window.__state.sent) === ${JSON.stringify(JSON.stringify(lowItems))}`,
		check: compactionCheck,
	},
	{
		id: "supplier-quote",
		kind: "browser",
		pages: { "/": hub, "/supplier-a": catalog("a"), "/supplier-b": catalog("b"), "/supplier-c": catalog("c") },
		prompt: (url) =>
			`On ${url} open each of the three supplier catalogs in its own tab and leave them open. Find what each charges for the K-7 circulation pump. Then go back to the quote form and request a quote from the cheapest supplier at its price, once. Tell me all three prices.`,
		state: `(() => { const q = window.__state.quote; return !!q && q.supplier === "Harbor Industrial" && /^\\$?389\\.50$/.test(q.price); })()`,
		answer: /389\.50/,
		answerAlso: /412/,
		check: compactionCheck,
	},
	{
		id: "onboarding",
		kind: "browser",
		pages: Object.fromEntries([["/", `${page("Onboarding", { values: {}, submits: 0, repeats: 0 })}<h1>New hire onboarding</h1><p><a href="step-1">Start</a></p>`], ...STEPS.map((_, i) => [`/step-${i + 1}`, step(i + 1)])]),
		prompt: (url) =>
			`Fill in the new hire onboarding at ${url} for Rosa Delgado, employee ID E-55210, department Field Service, start date 2027-02-01, laptop 14-inch. Read each step's policy before you fill it in, and submit the application once at the end.`,
		state: `JSON.stringify(window.__state.sent) === ${JSON.stringify(JSON.stringify(Object.fromEntries(STEPS.map(([, v], i) => [i + 1, v]))))}`,
		check: compactionCheck,
	},
];
