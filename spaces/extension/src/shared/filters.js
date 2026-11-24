/* Polycarp feed filters: what a filter rule says and how a post is matched against it. Plain functions, so the content
   script, the service worker, the Settings page and the Node tests share one definition.

   A rule: { id, enabled, sites, words, patterns, accounts, kinds, hide }.
   - sites: host names ("x.com" covers its subdomains); empty means every site.
   - words: whole words or phrases, any case, at word edges ("ai" does not hit "said"; "machine learning" hits
     "Machine   Learning"). Scripts written without spaces between words (Chinese, Japanese, Thai and their neighbors)
     have no word edges, so a side of a word in one of them matches anywhere: "比特币" hits "今天比特币大涨".
   - patterns: regular expression sources, any case. One that could freeze the page on a long post is refused.
   - accounts: the post's author ("@Name", "u/name" and "name" are one account; "r/name" is a subreddit).
   - kinds: what a post is rather than what it says: "shorts", "promoted", "reposts".
   - hide: CSS selectors hidden outright, only on the rule's own sites.
   Nothing here throws on a bad rule: a bad part is skipped and listed in `refused` with the reason. */
(function () {
  "use strict";

  const LOCAL_KEY = "polycarp.filters.local"; // the rules made in this browser
  const APP_KEY = "polycarp.filters.app";     // { rules, at, error } from the Polycarp app, kept by the service worker
  const KINDS = ["shorts", "promoted", "reposts"];
  const KIND_LABEL = { shorts: "Shorts", promoted: "Promoted", reposts: "Repost" };
  const MAX_TERMS = 100;
  const MAX_TERM = 200;
  const MAX_TEXT = 10000;

  const IS_WORD_CHAR = /[\p{L}\p{N}_]/u;
  // Scripts that put no spaces between words. Hangul is spaced, but by phrase, with particles written onto the word
  // ("비트코인이"), so it is here too. Script extensions, not scripts: the long-vowel mark that ends "サッカー" is Common by
  // script but Hiragana and Katakana by extension.
  const UNSPACED_CLASS = ["Han", "Hiragana", "Katakana", "Thai", "Lao", "Khmer", "Myanmar", "Hangul"]
    .map((s) => "\\p{Script_Extensions=" + s + "}").join("");
  const UNSPACED = new RegExp("[" + UNSPACED_CLASS + "]", "u");
  // A letter, digit or _ that makes a word edge: one in an unspaced script does not ("发布了AI芯片" writes AI against Han).
  const EDGE_CHAR = "(?![" + UNSPACED_CLASS + "])[\\p{L}\\p{N}_]";

  const escapeRegex = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // A plain word or phrase as a pattern: any run of spaces matches any run of spaces, and each side needs a word edge,
  // unless the character on that side is a symbol or sits in an unspaced script.
  function wordSource(term) {
    const t = String(term).trim();
    const chars = [...t];
    const edge = (c) => !!c && IS_WORD_CHAR.test(c) && !UNSPACED.test(c);
    const body = t.split(/\s+/).map(escapeRegex).join("\\s+");
    return (edge(chars[0]) ? "(?<!" + EDGE_CHAR + ")" : "") + body + (edge(chars[chars.length - 1]) ? "(?!" + EDGE_CHAR + ")" : "");
  }

  // The quantifier that starts at source[i], if one does: its length, and whether it repeats without end (*, +, {n,}).
  function quantifierAt(source, i) {
    const c = source[i];
    if (c === "*" || c === "+") return { length: 1, unbounded: true };
    if (c !== "{") return null;
    const brace = /\{\d+(,\d*)?\}/y; // the whole count, however long: {0000001,} is {1,}
    brace.lastIndex = i;
    const m = brace.exec(source);
    return m ? { length: m[0].length, unbounded: m[1] === "," } : null;
  }

  // Why a pattern could take far too long on a long post, or "" when it shows none of these shapes:
  // - a repeated group that holds a repeat, like (a+)+ or (\w*)*: exponential;
  // - a repeated group whose own level is a choice, like (a|a)+ or (a|aa){1,100}, or holds a group that is one, like
  //   ((a|a))+: overlapping alternatives try every split of the text, and a large count is no better than no end;
  // - more than one open-ended repeat, like .*.*.*z: each multiplies the work by the post's length. One is fine.
  // Escapes and character classes are skipped whole: [a*+] holds characters, not repeats.
  function riskyPattern(source) {
    const stack = [{ repeats: false, choice: false }];
    let unbounded = 0;
    for (let i = 0; i < source.length; i++) {
      const c = source[i];
      if (c === "\\") { i++; continue; }
      if (c === "[") { for (i++; i < source.length && source[i] !== "]"; i++) if (source[i] === "\\") i++; continue; }
      if (c === "(") { stack.push({ repeats: false, choice: false }); continue; }
      if (c === "|") { stack[stack.length - 1].choice = true; continue; }
      if (c === ")") {
        if (stack.length < 2) continue;
        const inner = stack.pop();
        const q = quantifierAt(source, i + 1);
        if (q && inner.repeats) return "nests one repeat inside another";
        if (q && inner.choice) return "repeats a choice, like (a|b)+ or (a|b){2,9}";
        if (q) { if (q.unbounded) unbounded++; i += q.length; }
        const top = stack[stack.length - 1];
        top.repeats = top.repeats || inner.repeats || !!q;
        if (!q) top.choice = top.choice || inner.choice; // ((a|b))+ repeats the choice inside
        continue;
      }
      const q = quantifierAt(source, i);
      if (q) { if (q.unbounded) unbounded++; stack[stack.length - 1].repeats = true; i += q.length - 1; }
    }
    return unbounded > 1 ? "has more than one open-ended repeat (*, + or {n,})" : "";
  }

  // A pattern as a RegExp, or the reason it is refused. Any case; Unicode mode when the source allows it.
  function compilePattern(source) {
    const src = String(source);
    if (!src.trim()) return { why: "is empty" };
    if (src.length > MAX_TERM) return { why: "is longer than " + MAX_TERM + " characters" };
    const risky = riskyPattern(src);
    if (risky) return { why: risky + ", which could freeze the page" };
    let err = null;
    for (const flags of ["iu", "i"]) { try { return { re: new RegExp(src, flags) }; } catch (e) { err = e; } }
    return { why: "is not a pattern the browser can read (" + err.message + ")" };
  }

  // "@Name", "u/Name", "/user/name", "https://x.com/Name" and "name" are all "name"; "r/Name" is "r/name".
  function normalizeHandle(raw) {
    let h = String(raw == null ? "" : raw).trim().toLowerCase();
    h = h.replace(/^https?:\/\/[^/]+/, "").replace(/^\/+/, "");
    h = h.replace(/^(u|user|users|in|channel)\//, "").replace(/^@/, "").replace(/\/+$/, "");
    return h;
  }
  // "https://www.X.com/home", "*.x.com" and "X.com" are all "x.com".
  function normalizeSite(raw) {
    let h = String(raw == null ? "" : raw).trim().toLowerCase();
    h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "");
    return h.replace(/^\*\./, "").replace(/^www\./, "").replace(/\.$/, "");
  }
  function onSite(rule, hostname) {
    if (!rule.sites.length) return true;
    const h = normalizeSite(hostname);
    return rule.sites.some((s) => h === s || h.endsWith("." + s));
  }

  const strings = (v, max, fn) => {
    const out = [];
    for (const x of Array.isArray(v) ? v : []) {
      if (typeof x !== "string") continue;
      const t = fn ? fn(x) : x.trim();
      if (t && !out.includes(t)) out.push(t);
      if (out.length >= max) break;
    }
    return out;
  };
  // A rule in one canonical shape, whatever arrived (the app, storage, a hand-edited backup). Never throws.
  function normalizeRule(raw, source) {
    const r = raw && typeof raw === "object" ? raw : {};
    const sites = strings(r.sites, MAX_TERMS, normalizeSite);
    return {
      id: typeof r.id === "string" && r.id ? r.id : "",
      enabled: r.enabled !== false,
      source: source || (r.source === "app" ? "app" : "local"),
      sites,
      words: strings(r.words, MAX_TERMS, (x) => x.trim().slice(0, MAX_TERM)),
      patterns: strings(r.patterns, MAX_TERMS, (x) => x),
      accounts: strings(r.accounts, MAX_TERMS, normalizeHandle),
      kinds: strings(r.kinds, KINDS.length, (x) => x.trim().toLowerCase()).filter((k) => KINDS.includes(k)),
      // A hide selector with no site would act on every page on the web: kept only with sites.
      hide: sites.length ? strings(r.hide, MAX_TERMS) : []
    };
  }

  // The app's rules first, then this browser's own; each carries where it came from.
  function merge(app, local) {
    const out = [];
    for (const r of Array.isArray(app) ? app : []) out.push(normalizeRule(r, "app"));
    for (const r of Array.isArray(local) ? local : []) out.push(normalizeRule(r, "local"));
    return out;
  }

  // A hide selector the page can take: it must parse (checkSelector, from a page with a DOM) and stay one selector list.
  function hideProblem(sel, checkSelector) {
    if (/[{};]|\/\*|<\//.test(sel)) return "holds characters a selector never needs ({, }, ; or a comment)";
    if (checkSelector && !checkSelector(sel)) return "is not a CSS selector this browser can read";
    return "";
  }

  // The rules that are on and cover `hostname`, compiled once. `test(post)` answers null or { rule, reason }.
  // post: { text, accounts(): string[], kinds(): string[] }; accounts and kinds are asked for only when a rule needs them.
  function compile(rules, hostname, opts) {
    const checkSelector = opts && opts.checkSelector;
    const refused = [];
    const compiled = [];
    const hide = [];
    for (const raw of rules || []) {
      const rule = raw && raw.sites && raw.words ? raw : normalizeRule(raw);
      if (!rule.enabled || (hostname != null && !onSite(rule, hostname))) continue;
      const words = rule.words.map((w) => ({ w, re: new RegExp(wordSource(w), "iu") }));
      const pats = [];
      for (const p of rule.patterns) {
        const c = compilePattern(p);
        if (c.re) pats.push({ p, re: c.re });
        else refused.push({ rule: rule.id, source: rule.source, what: "pattern", value: p, why: c.why });
      }
      for (const sel of rule.hide) {
        const why = hideProblem(sel, checkSelector);
        if (why) refused.push({ rule: rule.id, source: rule.source, what: "hide", value: sel, why });
        else hide.push(sel);
      }
      if (words.length || pats.length || rule.accounts.length || rule.kinds.length) {
        compiled.push({ rule, words, pats, accounts: new Set(rule.accounts), kinds: new Set(rule.kinds) });
      }
    }
    // One scan across every plain word on the page: most posts match nothing, and this rejects them at once.
    const all = compiled.flatMap((c) => c.words.map((x) => wordSource(x.w)));
    const any = all.length ? new RegExp(all.join("|"), "iu") : null;
    const needAccounts = compiled.some((c) => c.accounts.size);
    const needKinds = compiled.some((c) => c.kinds.size);
    function test(post) {
      const text = String(post.text || "").slice(0, MAX_TEXT);
      const wordHit = any ? any.test(text) : false;
      let accounts = null, kinds = null;
      for (const c of compiled) {
        if (wordHit) for (const x of c.words) if (x.re.test(text)) return { rule: c.rule, reason: x.w };
        for (const x of c.pats) if (x.re.test(text)) return { rule: c.rule, reason: "/" + x.p + "/" };
        if (c.accounts.size) {
          if (!accounts) accounts = (post.accounts ? post.accounts() : []).map(normalizeHandle).filter(Boolean);
          for (const a of accounts) if (c.accounts.has(a)) return { rule: c.rule, reason: "@" + a };
        }
        if (c.kinds.size) {
          if (!kinds) kinds = post.kinds ? post.kinds() : [];
          for (const k of kinds) if (c.kinds.has(k)) return { rule: c.rule, reason: KIND_LABEL[k] || k };
        }
      }
      return null;
    }
    return { test, refused, hide, size: compiled.length, needAccounts, needKinds, kinds: [...new Set(compiled.flatMap((c) => [...c.kinds]))] };
  }

  // Every part of these rules that is refused, on any site, with the reason: for the Settings page.
  function refusals(rules, opts) { return compile(rules, null, opts).refused; }

  // One line for a person: what a rule hides and where.
  function summary(rule) {
    const parts = [];
    if (rule.words.length) parts.push("Words: " + rule.words.join(", "));
    if (rule.patterns.length) parts.push("Patterns: " + rule.patterns.map((p) => "/" + p + "/").join(", "));
    if (rule.accounts.length) parts.push("Accounts: " + rule.accounts.map((a) => "@" + a).join(", "));
    if (rule.kinds.length) parts.push("Kinds: " + rule.kinds.map((k) => KIND_LABEL[k]).join(", "));
    if (rule.hide.length) parts.push("Hide: " + rule.hide.join(", "));
    return parts.join(" · ") || "Nothing yet";
  }

  globalThis.PolycarpFilters = {
    LOCAL_KEY, APP_KEY, KINDS, KIND_LABEL, MAX_TERMS, MAX_TERM, MAX_TEXT,
    wordSource, riskyPattern, quantifierAt, compilePattern, normalizeHandle, normalizeSite, normalizeRule,
    onSite, merge, compile, refusals, summary
  };
})();
