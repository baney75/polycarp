/* Polycarp core: settings, profiles, migrations and reading stats.
   Classic script shared by the service worker, content script and extension pages. */
(function () {
  "use strict";

  const SCHEMA = 1;
  const SETTINGS_KEY = "polycarp.settings";
  const STATS_KEY = "polycarp.stats";

  const FONTS = {
    page: { label: "Page font", family: null },
    lexend: { label: "Lexend", family: "'Polycarp Lexend', 'Lexend', system-ui, sans-serif" },
    atkinson: { label: "Atkinson Hyperlegible", family: "'Polycarp Atkinson', 'Atkinson Hyperlegible', system-ui, sans-serif" },
    opendyslexic: { label: "OpenDyslexic", family: "'Polycarp OpenDyslexic', 'OpenDyslexic', system-ui, sans-serif" }
  };

  const FONT_FILES = [
    ["Polycarp Lexend", "lexend", 400], ["Polycarp Lexend", "lexend", 700],
    ["Polycarp Atkinson", "atkinson-hyperlegible", 400], ["Polycarp Atkinson", "atkinson-hyperlegible", 700],
    ["Polycarp OpenDyslexic", "opendyslexic", 400], ["Polycarp OpenDyslexic", "opendyslexic", 700]
  ];

  // Overlay tints. Applied with multiply blending, so they color the page like a filter sheet.
  const TINTS = {
    yellow: { label: "Yellow", color: "#F7D154" },
    amber: { label: "Amber", color: "#F2A541" },
    rose: { label: "Rose", color: "#EE8F9B" },
    aqua: { label: "Aqua", color: "#6FCFC4" },
    blue: { label: "Blue", color: "#7FA9EC" },
    lilac: { label: "Lilac", color: "#B39DEB" },
    gray: { label: "Gray", color: "#8F8F8F" }
  };

  const DEFAULTS = {
    schema: SCHEMA,
    enabled: true,
    matchTheme: true,
    autoApply: true,
    sites: {},
    pausedUntil: 0,
    helpers: { youtube: true, x: true, audible: true, kindle: true, web: true },
    profile: "everyday",
    bionic: { on: true, strength: 3, weight: 700, fade: 0.12, every: 1 },
    type: { font: "page", letter: 0, word: 0, line: 0 },
    tint: { on: false, color: "yellow", strength: 0.16 },
    ruler: { on: false, lines: 3 },
    calm: { still: false, soft: false },
    doneMarks: false,
    celebrate: "full",
    goal: 2000,
    reader: { size: 20, width: 66, theme: "auto", sprintWpm: 300, focus: false, rounds: "medium", sound: true, recall: true, unlock: true, voice: "kokoro:af_heart", dialogue: "auto", rate: 1, follow: true, pretest: true },
    force: { minSize: 0, contrast: false, unlockCopy: true, leftAlign: false, noItalic: false, frames: true }
  };

  // Each profile is a starting point; any change after picking one switches to "custom".
  const PROFILES = {
    everyday: {
      label: "Everyday", tag: "Anyone",
      blurb: "Light bold anchors and nothing else in the way. A good place to start.",
      apply: {
        bionic: { on: true, strength: 3, weight: 700, fade: 0.12, every: 1 },
        type: { font: "page", letter: 0, word: 0, line: 0 },
        tint: { on: false },
        ruler: { on: false, lines: 3 },
        calm: { still: false, soft: false },
        doneMarks: false, celebrate: "full",
        reader: { focus: false, rounds: "medium", sound: true },
        force: { leftAlign: false, noItalic: false, minSize: 0 }
      }
    },
    focus: {
      label: "Focus", tag: "ADHD",
      blurb: "A focus ruler, bold anchors and short recall breaks keep you on the line.",
      apply: {
        bionic: { on: true, strength: 3, weight: 700, fade: 0.12, every: 1 },
        type: { font: "page", letter: 0, word: 0, line: 0 },
        tint: { on: false },
        ruler: { on: true, lines: 3 },
        calm: { still: false, soft: false },
        doneMarks: false, celebrate: "full",
        reader: { focus: true, rounds: "short", sound: true },
        force: { leftAlign: false, noItalic: false, minSize: 0 }
      }
    },
    dyslexia: {
      label: "Clear", tag: "Dyslexia",
      blurb: "Lexend, wider letter and line spacing, and a soft cream sheet.",
      apply: {
        bionic: { on: true, strength: 2, weight: 600, fade: 0, every: 1 },
        type: { font: "lexend", letter: 0.08, word: 0.16, line: 1.8 },
        tint: { on: true, color: "yellow", strength: 0.1 },
        ruler: { on: false, lines: 3 },
        calm: { still: false, soft: false },
        doneMarks: false, celebrate: "full",
        reader: { focus: false, rounds: "medium", sound: true },
        force: { leftAlign: true, noItalic: true, minSize: 16 }
      }
    },
    calm: {
      label: "Calm", tag: "Visual snow",
      blurb: "A warm tint, softer contrast and nothing moving on the page.",
      apply: {
        bionic: { on: true, strength: 2, weight: 600, fade: 0, every: 1 },
        type: { font: "atkinson", letter: 0.04, word: 0.08, line: 1.7 },
        tint: { on: true, color: "amber", strength: 0.2 },
        ruler: { on: false, lines: 3 },
        calm: { still: true, soft: true },
        doneMarks: false, celebrate: "gentle",
        reader: { focus: false, rounds: "medium", sound: false, theme: "paper" },
        force: { leftAlign: false, noItalic: false, minSize: 0 }
      }
    },
    steady: {
      label: "Steady", tag: "OCD",
      blurb: "Marks each paragraph once you have read it, so you can move on.",
      apply: {
        bionic: { on: true, strength: 3, weight: 650, fade: 0, every: 1 },
        type: { font: "page", letter: 0.02, word: 0.04, line: 1.7 },
        tint: { on: false },
        ruler: { on: false, lines: 3 },
        calm: { still: true, soft: false },
        doneMarks: true, celebrate: "gentle",
        reader: { focus: false, rounds: "medium", sound: false },
        force: { leftAlign: false, noItalic: false, minSize: 0 }
      }
    }
  };

  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
  function merge(base, over) {
    const out = Array.isArray(base) ? base.slice() : { ...base };
    if (!isObj(over)) return out;
    for (const k of Object.keys(over)) {
      out[k] = isObj(base[k]) && isObj(over[k]) ? merge(base[k], over[k]) : over[k];
    }
    return out;
  }
  const clone = (v) => JSON.parse(JSON.stringify(v));

  // Settings migrations. Add one function per schema bump; each takes the old object and returns the next.
  const MIGRATIONS = {
    // 1: (s) => ({ ...s, schema: 2, newField: default })
  };
  function migrate(raw) {
    let s = isObj(raw) ? clone(raw) : {};
    let v = Number(s.schema) || SCHEMA;
    while (v < SCHEMA && MIGRATIONS[v]) { s = MIGRATIONS[v](s); v = s.schema; }
    s = merge(clone(DEFAULTS), s);
    s.schema = SCHEMA;
    return s;
  }

  function applyProfile(settings, id) {
    const p = PROFILES[id];
    if (!p) return { ...settings, profile: "custom" };
    const next = merge(settings, p.apply);
    next.profile = id;
    return next;
  }

  const store = () => (globalThis.chrome && chrome.storage ? chrome.storage.local : null);

  async function getSettings() {
    const s = store();
    if (!s) return clone(DEFAULTS);
    const got = await s.get(SETTINGS_KEY);
    return migrate(got[SETTINGS_KEY]);
  }
  async function setSettings(next) {
    const clean = migrate(next);
    await store().set({ [SETTINGS_KEY]: clean });
    return clean;
  }
  async function patchSettings(patch, opts) {
    const cur = await getSettings();
    let next = merge(cur, patch);
    if (!(opts && opts.keepProfile)) next.profile = "custom";
    return setSettings(next);
  }

  function hostOf(url) {
    try {
      const u = new URL(url);
      if (u.protocol === "file:") return "file";
      return u.hostname.replace(/^www\./, "");
    } catch (e) { return ""; }
  }
  function paused(settings, now) { return (settings.pausedUntil || 0) > (now || Date.now()); }
  function activeFor(settings, host) {
    if (!settings.enabled || paused(settings)) return false;
    const rule = settings.sites[host];
    if (rule === "on") return true;
    if (rule === "off") return false;
    return !!settings.autoApply;
  }

  // ---------- Reading stats ----------
  const LEVEL_TITLES = ["Spark", "Page", "Chapter", "Volume", "Scholar", "Librarian", "Archivist", "Sage", "Luminary"];
  function levelFor(xp) {
    const level = Math.floor(Math.sqrt(Math.max(0, xp) / 250)) + 1;
    const floor = 250 * (level - 1) * (level - 1);
    const ceil = 250 * level * level;
    const title = LEVEL_TITLES[Math.min(LEVEL_TITLES.length - 1, Math.floor((level - 1) / 3))];
    return { level, title, into: xp - floor, span: ceil - floor, toNext: ceil - xp };
  }

  const BADGES = [
    { id: "words-100", name: "First steps", desc: "Read 100 words with Polycarp", test: (s) => s.wordsTotal >= 100 },
    { id: "words-1k", name: "Warmed up", desc: "Read 1,000 words", test: (s) => s.wordsTotal >= 1000 },
    { id: "words-10k", name: "Bookworm", desc: "Read 10,000 words", test: (s) => s.wordsTotal >= 10000 },
    { id: "words-100k", name: "A novel's worth", desc: "Read 100,000 words, about a full novel", test: (s) => s.wordsTotal >= 100000 },
    { id: "words-1m", name: "Million words", desc: "Read 1,000,000 words", test: (s) => s.wordsTotal >= 1000000 },
    { id: "streak-3", name: "Three in a row", desc: "Read three days running", test: (s) => s.streak.best >= 3 },
    { id: "streak-7", name: "Full week", desc: "A seven day streak", test: (s) => s.streak.best >= 7 },
    { id: "streak-30", name: "Habit formed", desc: "A thirty day streak", test: (s) => s.streak.best >= 30 },
    { id: "goal-1", name: "Goal getter", desc: "Hit your daily goal", test: (s) => s.goalsHit >= 1 },
    { id: "goal-10", name: "Consistent", desc: "Hit your daily goal ten times", test: (s) => s.goalsHit >= 10 },
    { id: "pdf", name: "PDF reader", desc: "Read a PDF in the Polycarp Reader", test: (s) => s.kinds.pdf > 0 },
    { id: "ebook", name: "Ebook reader", desc: "Read an ebook in the Polycarp Reader", test: (s) => s.kinds.epub > 0 },
    { id: "sprint", name: "Sprinter", desc: "Sprint through 1,000 words", test: (s) => s.sprintWords >= 1000 },
    { id: "finish", name: "The end", desc: "Finish a whole document", test: (s) => s.finished >= 1 },
    { id: "night", name: "Night owl", desc: "Read after 11 PM", test: (s) => s.flags.night },
    { id: "early", name: "Early bird", desc: "Read before 7 AM", test: (s) => s.flags.early },
    { id: "print", name: "Hard copy", desc: "Print a Polycarp page", test: (s) => s.flags.print }
  ];

  const STATS_DEFAULTS = {
    schema: 1, xp: 0, wordsTotal: 0, days: {}, goalsHit: 0,
    streak: { count: 0, best: 0, last: null },
    badges: {}, kinds: {}, sprintWords: 0, finished: 0, flags: {}, docs: {}
  };

  function dayKey(d) {
    d = d || new Date();
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }
  function prevDay(key) {
    const [y, m, d] = key.split("-").map(Number);
    return dayKey(new Date(y, m - 1, d - 1));
  }
  const STREAK_MIN = 100; // words needed for a day to count toward the streak

  async function getStats() {
    const s = store();
    if (!s) return clone(STATS_DEFAULTS);
    const got = await s.get(STATS_KEY);
    const st = merge(clone(STATS_DEFAULTS), got[STATS_KEY] || {});
    // A streak is broken if the last counted day is older than yesterday.
    const today = dayKey();
    if (st.streak.last && st.streak.last !== today && st.streak.last !== prevDay(today)) st.streak.count = 0;
    return st;
  }

  // Pure update so it can be tested. Returns { stats, events }.
  function recordReading(stats, ev, goal, now) {
    now = now || new Date();
    const st = clone(stats);
    const events = [];
    const words = Math.max(0, Math.round(ev.words || 0));
    const today = dayKey(now);
    const before = st.days[today] || 0;
    if (words > 0) {
      st.days[today] = before + words;
      st.wordsTotal += words;
      st.xp += words;
      if (ev.kind) st.kinds[ev.kind] = (st.kinds[ev.kind] || 0) + words;
      if (ev.sprint) st.sprintWords += words;
      const h = now.getHours();
      if (h >= 23) st.flags.night = true;
      if (h < 7 && h >= 4) st.flags.early = true;
      if (before < STREAK_MIN && st.days[today] >= STREAK_MIN && st.streak.last !== today) {
        st.streak.count = st.streak.last === prevDay(today) ? st.streak.count + 1 : 1;
        st.streak.last = today;
        st.streak.best = Math.max(st.streak.best, st.streak.count);
        events.push({ type: "streak", count: st.streak.count });
      }
      if (goal > 0 && before < goal && st.days[today] >= goal) {
        st.goalsHit += 1;
        events.push({ type: "goal", goal });
      }
      const lvBefore = levelFor(st.xp - words).level;
      const lvAfter = levelFor(st.xp);
      if (lvAfter.level > lvBefore) events.push({ type: "level", level: lvAfter.level, title: lvAfter.title });
    }
    if (ev.finished) st.finished += 1;
    if (ev.print) st.flags.print = true;
    for (const b of BADGES) {
      if (!st.badges[b.id] && b.test(st)) {
        st.badges[b.id] = today;
        events.push({ type: "badge", id: b.id, name: b.name, desc: b.desc });
      }
    }
    // Keep 400 days of history at most.
    const keys = Object.keys(st.days).sort();
    while (keys.length > 400) delete st.days[keys.shift()];
    return { stats: st, events };
  }

  function summary(stats, goal) {
    const today = stats.days[dayKey()] || 0;
    const lv = levelFor(stats.xp);
    return {
      today, goal, goalPct: goal > 0 ? Math.min(1, today / goal) : 0,
      streak: stats.streak.count, best: stats.streak.best,
      level: lv, wordsTotal: stats.wordsTotal,
      badges: Object.keys(stats.badges).length, badgeTotal: BADGES.length
    };
  }

  // Word counter shared by every surface.
  const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
  function countWords(text) {
    const m = text && text.match(WORD_RE);
    return m ? m.length : 0;
  }

  function fontFaceCss(getURL) {
    return FONT_FILES.map(([family, file, weight]) =>
      "@font-face{font-family:'" + family + "';font-style:normal;font-weight:" + weight +
      ";font-display:swap;src:url('" + getURL("fonts/" + file + "-latin-" + weight + "-normal.woff2") + "') format('woff2');}"
    ).join("\n");
  }

  // ---------- Theme ----------
  // theme.css is the shipped Polycarp theme as `polycarp theme export css` writes it; extension pages link it. Where the
  // Polycarp app has a theme in force, its values (soundTheme) are kept in storage under THEME_KEY as {theme, stamp}, and
  // rules built here go after the shipped ones, unless the person switched that off (settings.matchTheme).
  const THEME_FILE = "src/shared/theme.css";
  const THEME_KEY = "polycarp.theme";
  const THEME_HOST = "com.polycarp.newtab";

  // What each value may be. A check gives the text to write, or null for a value to leave out; nothing else of what the
  // app sent reaches a stylesheet. `tests/theme-rules.test.mjs` holds these names to those in theme.css.
  const COLORS = ["background", "surface", "sunken", "foreground", "strong", "muted", "border", "accent", "on-accent", "selection", "urgent", "working", "done"];
  const color = (v) => (/^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : null);
  const amount = (unit, lo, hi) => (v) => {
    const m = /^(\d{1,4}(?:\.\d{1,4})?)(px|ms)?$/.exec(v);
    return m && (m[2] || "") === unit && Number(m[1]) >= lo && Number(m[1]) <= hi ? v : null;
  };
  const oneOf = (...words) => (v) => (words.includes(v) ? v : null);
  const easing = (v) => {
    if (oneOf("linear", "ease", "ease-in", "ease-out", "ease-in-out")(v)) return v;
    const m = /^cubic-bezier\(([^()]{1,60})\)$/.exec(v);
    const n = m ? m[1].split(",").map((x) => x.trim()) : [];
    if (n.length !== 4 || !n.every((x) => /^-?(?:\d{1,2}(?:\.\d{1,6})?|\.\d{1,6})$/.test(x))) return null;
    return [n[0], n[2]].every((x) => x >= 0 && x <= 1) ? "cubic-bezier(" + n.join(", ") + ")" : null;
  };
  // Family names with commas between: plain, or in quotes when they hold no character CSS gives a meaning to. A stack with
  // no generic name of its own gets one, so a font that isn't on this computer never falls to the browser's default.
  const FONT_PLAIN = /^-?[\p{L}_][\p{L}\p{N} _-]*$/u;
  const FONT_QUOTED = /^(["'])(?!\s*\1)[^"'\\<>;{}()\p{C}\p{Zl}\p{Zp}]+\1$/u;
  const FONT_GENERIC = /^(?:serif|sans-serif|monospace|system-ui|ui-(?:serif|sans-serif|monospace|rounded))$/i;
  const FONT_NOT = /^(?:inherit|initial|unset|revert|revert-layer|default|none)$/i;
  const stack = (generic) => (v) => {
    if (v.length > 300 || /\/\*/.test(v)) return null;
    const names = [];
    let rest = v;
    do {
      const m = /^\s*("[^"]*"|'[^']*'|[^,"']+?)\s*(,|$)/u.exec(rest);
      if (!m || !(FONT_QUOTED.test(m[1]) || (FONT_PLAIN.test(m[1]) && !FONT_NOT.test(m[1])))) return null;
      names.push(m[1]);
      rest = rest.slice(m[0].length);
      if (!rest && m[2]) return null;
    } while (rest);
    return names.concat(names.some((n) => FONT_GENERIC.test(n)) ? [] : generic).join(", ");
  };
  const SHARED = {
    "radius-small": amount("px", 0, 64), radius: amount("px", 0, 64), "radius-large": amount("px", 0, 64),
    "border-width": amount("px", 0, 8), blur: amount("px", 0, 80), shadow: amount("", 0, 1),
    density: oneOf("compact", "regular", "spacious"), indicator: oneOf("dot", "bar", "number-block"),
    "font-display": stack("serif"), "font-ui": stack(["system-ui", "sans-serif"]), "font-mono": stack(["ui-monospace", "monospace"]),
    "font-size": amount("px", 10, 24), "font-weight": amount("", 300, 800), "line-height": amount("", 1, 2),
    "motion-fast": amount("ms", 0, 1000), "motion-normal": amount("ms", 0, 1000), "motion-slow": amount("ms", 0, 1000),
    "motion-easing": easing, "motion-scale-from": amount("", 0.5, 1)
  };

  // The theme with only known names and checked values, or null. Colors come whole: a theme with one color missing or odd
  // in either mode would put some of its colors on some of the shipped ones, which nobody checked for contrast. Any
  // other value that fails is left out, so the shipped one stays.
  function soundTheme(theme) {
    if (!isObj(theme) || !["auto", "light", "dark"].includes(theme.mode)) return null;
    const take = (from, names, check) => {
      const out = {};
      if (!isObj(from)) return out;
      for (const n of names) {
        const raw = Object.prototype.hasOwnProperty.call(from, "--pc-" + n) ? from["--pc-" + n] : null;
        const v = typeof raw === "string" ? check(n)(raw) : null;
        if (v !== null) out["--pc-" + n] = v;
      }
      return out;
    };
    const t = { mode: theme.mode, shared: take(theme.shared, Object.keys(SHARED), (n) => SHARED[n]) };
    for (const mode of ["light", "dark"]) {
      t[mode] = take(theme[mode], COLORS, () => color);
      if (Object.keys(t[mode]).length !== COLORS.length) return null;
    }
    return t;
  }

  // The rules for such a theme, to go after the shipped ones: "" for anything that is no theme. A theme of one mode pins
  // it wherever nothing else picked one, over the shipped rule for a system in dark mode.
  function themeRules(theme) {
    const t = soundTheme(theme);
    if (!t) return "";
    const lines = (o) => Object.entries(o).map(([k, v]) => "  " + k + ": " + v + ";\n").join("");
    const block = (sel, mode, o) => sel + " {\n  color-scheme: " + mode + ";\n" + lines(o) + "}\n";
    const own = ["light", "dark"].map((m) => block(':root[data-theme-mode="' + m + '"]', m, t[m])).join("");
    if (t.mode !== "auto") return ":root {\n" + lines(t.shared) + "}\n" + block(":root:not([data-theme-mode])", t.mode, t[t.mode]) + own;
    return block(":root", "light dark", { ...t.shared, ...t.light }) + own +
      "@media (prefers-color-scheme: dark) {\n" + block(':root:not([data-theme-mode="light"])', "dark", t.dark) + "}\n";
  }
  // The mode a theme's rules pin, "light" or "dark", or "" when it follows the system.
  function themeMode(css) {
    const m = /:root:not\(\[data-theme-mode\]\)\s*\{\s*color-scheme:\s*(light|dark)\s*;/.exec(String(css || ""));
    return m ? m[1] : "";
  }
  // The class for a panel on a web page: the mode the theme pins, else `own`, what the panel would pick by itself.
  const themeClass = (css, own) => "pc-" + (themeMode(css) || own);
  const matches = (settings) => !(isObj(settings) && settings.matchTheme === false);

  // The rules for the theme in force from storage, "" when there is none or the person switched it off.
  async function liveTheme() {
    try {
      const got = await store().get([SETTINGS_KEY, THEME_KEY]);
      return matches(got[SETTINGS_KEY]) && isObj(got[THEME_KEY]) ? themeRules(got[THEME_KEY].theme) : "";
    } catch (e) { return ""; }
  }
  let themeText = null;
  async function shippedTheme() {
    if (themeText !== null) return themeText;
    try { themeText = await (await fetch(chrome.runtime.getURL(THEME_FILE))).text(); } catch (e) { themeText = ""; }
    return themeText;
  }
  const both = (shipped, live) => (live ? shipped + "\n" + live : shipped);
  // Every rule in force: the shipped theme, then the live one.
  async function themeCss() { return both(await shippedTheme(), await liveTheme()); }
  // Calls fn(css, live) now and whenever the theme in force changes. Returns a function that stops it.
  function watchTheme(fn) {
    let last = null, asked = 0, on = true;
    const look = async () => {
      const mine = ++asked;
      const live = await liveTheme(), css = both(await shippedTheme(), live);
      if (!on || mine !== asked || css === last) return;
      last = css;
      fn(css, live);
    };
    const changed = (ch, area) => { if (area === "local" && (ch[THEME_KEY] || ch[SETTINGS_KEY])) look(); };
    try { chrome.storage.onChanged.addListener(changed); } catch (e) { /* the extension was reloaded under this page */ }
    look();
    return () => { on = false; try { chrome.storage.onChanged.removeListener(changed); } catch (e) { /* gone */ } };
  }

  // Keeps the theme in the app's answer to `page` or `theme`. No app, an app from before this, and no theme in force all
  // leave the shipped one; an answer that broke keeps what there was. Written only when it changed.
  async function keepTheme(reply) {
    let next = null;
    if (reply && reply.ok === true) {
      const theme = soundTheme(reply.theme);
      if (theme) next = { theme, stamp: String(reply.stamp || "").slice(0, 64) };
    } else if (reply && !/not found|forbidden|no request called theme/i.test(String(reply.failed || reply.error || ""))) return;
    const cur = (await store().get(THEME_KEY))[THEME_KEY] || null;
    if (JSON.stringify(cur) === JSON.stringify(next)) return;
    await (next ? store().set({ [THEME_KEY]: next }) : store().remove(THEME_KEY));
  }
  // Asks the app for its theme, from the extension's own pages and its worker. With the connection not granted there is
  // nobody to ask, and no theme.
  async function askTheme() {
    if (!matches((await store().get(SETTINGS_KEY))[SETTINGS_KEY])) return;
    let may = false;
    try { may = !!chrome.runtime.sendNativeMessage && await chrome.permissions.contains({ permissions: ["nativeMessaging"] }); } catch (e) { /* no */ }
    if (!may) return keepTheme(null);
    return keepTheme(await new Promise((resolve) => {
      try {
        chrome.runtime.sendNativeMessage(THEME_HOST, { op: "theme" }, (reply) => {
          const err = chrome.runtime.lastError;
          resolve(err ? { failed: String(err.message || err) } : reply || { failed: "no answer" });
        });
      } catch (e) { resolve({ failed: String(e && e.message || e) }); }
    }));
  }

  // The values in force for one mode ("light" or "dark"): the shared values, then that mode's colors, the later block
  // over the earlier. Keys drop "--pc-".
  function themeVars(css, mode) {
    const out = {}, text = String(css || "");
    for (const sel of [":root", ':root\\[data-theme-mode="' + mode + '"\\]']) {
      for (const block of text.matchAll(new RegExp("(?:^|[\\s}])" + sel + "\\s*\\{([^}]*)\\}", "g"))) {
        for (const m of block[1].matchAll(/--pc-([a-z-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
      }
    }
    return out;
  }
  // The same rules for a shadow root on a web page: :host takes the page-wide values, and .pc-light or .pc-dark pins
  // one mode for a part that follows the page's own darkness rather than the system's.
  function shadowThemeCss(css) {
    return String(css || "")
      .replace(/:root\[data-theme-mode="(light|dark)"\]/g, ".pc-$1")
      .replace(/:root:not\(\[data-theme-mode(?:="light")?\]\)/g, ":host")
      .replace(/:root/g, ":host");
  }
  const ms = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? (/ms$/.test(v) ? n : n * 1000) : 0; };

  globalThis.Polycarp = Object.assign(globalThis.Polycarp || {}, {
    core: true,
    SCHEMA, SETTINGS_KEY, STATS_KEY, DEFAULTS, PROFILES, FONTS, TINTS, BADGES, LEVEL_TITLES,
    merge, clone, migrate, applyProfile, paused, getSettings, setSettings, patchSettings,
    hostOf, activeFor, levelFor, getStats, recordReading, summary, dayKey, prevDay,
    countWords, fontFaceCss, STATS_DEFAULTS, STREAK_MIN,
    THEME_FILE, THEME_KEY, soundTheme, themeRules, themeMode, themeClass, themeCss, watchTheme, keepTheme, askTheme, themeVars, shadowThemeCss, ms
  });
})();
