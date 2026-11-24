/* Polycarp feed filters: what a filter rule says and how a post is matched against it. Plain functions, so the content
   script, the service worker, the Settings page and the Node tests share one definition.

   A rule: { id, enabled, sites, words, patterns, accounts, kinds, hide }.
   - sites: host names ("x.com" covers its subdomains); empty means every site.
   - words: whole words or phrases, any case, at word edges ("ai" does not hit "said"; "machine learning" hits
     "Machine   Learning"). A combining mark is part of its word, so "राम" does not hit "रामायण". Scripts written
     without spaces between words (Chinese, Japanese, Thai and their neighbors) have no word edges, so a side of a word
     in one of them matches anywhere: "比特币" hits "今天比特币大涨". Words and posts are compared in NFC.
   - patterns: regular expression sources, any case, read against a post's first 2,000 characters. One that could
     freeze the page is refused, and one that still runs slow on a post is switched off for that page.
   - accounts: the post's author ("@Name", "u/name", a profile link and "name" are one account; "r/name" is a
     subreddit).
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
  const PATTERN_TEXT = 2000;            // a pattern reads this much of a post
  const PATTERN_WAYS = 5 * PATTERN_TEXT; // at most this many ways to try a pattern from one place in a post
  const MAX_COUNT = 20;                 // the largest count a pattern may write, as in {2,20}
  const SLOW_MS = 50;                   // a pattern slower than this on one post is switched off for the page

  // A combining mark is part of the word it sits on: "राम" + "ा" is a longer word, not "राम" and a symbol.
  const IS_WORD_CHAR = /[\p{L}\p{M}\p{N}_]/u;
  // Scripts that put no spaces between words. Hangul is spaced, but by phrase, with particles written onto the word
  // ("비트코인이"), so it is here too. Script extensions, not scripts: the long-vowel mark that ends "サッカー" is Common by
  // script but Hiragana and Katakana by extension.
  const UNSPACED_CLASS = ["Han", "Hiragana", "Katakana", "Thai", "Lao", "Khmer", "Myanmar", "Hangul"]
    .map((s) => "\\p{Script_Extensions=" + s + "}").join("");
  const UNSPACED = new RegExp("[" + UNSPACED_CLASS + "]", "u");
  // A letter, digit or _ that makes a word edge: one in an unspaced script does not ("发布了AI芯片" writes AI against Han).
  const EDGE_CHAR = "(?![" + UNSPACED_CLASS + "])[\\p{L}\\p{M}\\p{N}_]";
  const IS_EDGE_CHAR = new RegExp("^" + EDGE_CHAR + "$", "u");

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

  // The quantifier that starts at source[i], if one does: its length (with a lazy ? after it), its least and most
  // count (Infinity: no end) and whether it has no end. ?, *, + and {n}, {n,} or {n,m}; a brace that is not a count
  // is a literal, and {0000001,} is {1,}.
  function quantifierAt(source, i) {
    const c = source[i];
    let q = null;
    if (c === "*") q = { length: 1, min: 0, max: Infinity };
    else if (c === "+") q = { length: 1, min: 1, max: Infinity };
    else if (c === "?") q = { length: 1, min: 0, max: 1 };
    else if (c === "{") {
      const brace = /\{(\d+)(,(\d*))?\}/y;
      brace.lastIndex = i;
      const m = brace.exec(source);
      if (m) q = { length: m[0].length, min: Number(m[1]), max: !m[2] ? Number(m[1]) : m[3] ? Number(m[3]) : Infinity };
    }
    if (!q) return null;
    if (source[i + q.length] === "?") q.length++;
    q.unbounded = q.max === Infinity;
    return q;
  }

  // Why a pattern could take far too long on a post, or "" when it cannot. A backtracking matcher may try every way
  // the pattern fits the text from each place in it, so the pattern is read as a tree and those ways are counted:
  // a run of parts multiplies them, a choice adds them, x? doubles them, x{0,9} makes ten, and a repeat with no end
  // (*, + or {n,}) makes as many as a post has characters. Refused:
  // - a group repeated without end that holds a repeat of varying length, like (a+)+, (\d\d?)+ or (x{2,})*, or a
  //   choice, like (a|b)+ or ((cat|dog)s)+: the ways grow exponentially with the post. A choice is refused even when
  //   its sides could never overlap, because telling those apart is beyond this check; [ab]+ or a list of words works;
  // - a count above 20, like {0,99}: write fewer, or a repeat with no end;
  // - more ways than PATTERN_WAYS from one place, like .*.*z, (a?){14} or four \w{0,20} in a row. One repeat with no
  //   end is fine, and so is one with a few small choices beside it, like https?://\S+;
  // - back-references (\1, \k<name>) and lookbehind ((?<= and (?<!), which this count cannot bound.
  // Escapes and character classes are read whole: [a*+] holds characters, not repeats.
  function riskyPattern(source) {
    const src = String(source);
    let i = 0;
    const refuse = (why) => { throw { why }; };
    // A choice up to the closing ")" or the end: the sum of its sides.
    function choice() {
      let ways = 0, varies = false, sides = 0, inner = false;
      for (;;) {
        const s = run();
        ways += s.ways; varies = varies || s.varies; inner = inner || s.choice; sides++;
        if (src[i] !== "|") return { ways, varies, choice: inner || sides > 1 };
        i++;
      }
    }
    // A run of parts up to "|", ")" or the end: the product of their ways.
    function run() {
      let ways = 1, varies = false, holdsChoice = false;
      while (i < src.length && src[i] !== "|" && src[i] !== ")") {
        let part = { ways: 1, varies: false, choice: false };
        const c = src[i];
        if (c === "\\") {
          const d = src[i + 1];
          if (/[1-9]/.test(d || "") || (d === "k" && src[i + 2] === "<")) refuse("refers back to a group (\\1 or \\k<name>)");
          if (/[pPu]/.test(d || "") && src[i + 2] === "{") { const e = src.indexOf("}", i); i = e < 0 ? src.length : e + 1; }
          else i += 2;
        } else if (c === "[") {
          for (i++; i < src.length && src[i] !== "]"; i++) if (src[i] === "\\") i++;
          i++;
        } else if (c === "(") {
          i++;
          if (src[i] === "?") {
            if (src[i + 1] === "<" && (src[i + 2] === "=" || src[i + 2] === "!")) refuse("looks behind ((?<= or (?<!)");
            const stop = src[i + 1] === "<" ? ">" : /[=!:]/.test(src[i + 1] || "") ? src[i + 1] : ":";
            const e = src.indexOf(stop, i + 1);
            i = e < 0 ? src.length : e + 1;
          }
          part = choice();
          if (src[i] === ")") i++;
        } else {
          i++;
        }
        const q = quantifierAt(src, i);
        if (q) {
          i += q.length;
          if (q.min > MAX_COUNT || (!q.unbounded && q.max > MAX_COUNT)) refuse("has a count above " + MAX_COUNT + ", like {0,99}");
          if (q.unbounded && part.varies) refuse("nests one repeat inside another, like (a+)+ or (\\d\\d?)+");
          if (q.unbounded && part.choice) refuse("repeats a group that holds a choice, like (a|b)+ or ((cat|dog)s)+");
          let w = 0;
          if (q.unbounded) w = PATTERN_TEXT; // each pass is one fixed width, so the ways are how many passes
          else for (let k = q.min; k <= q.max; k++) w += Math.pow(part.ways, k);
          part = { ways: w, varies: part.varies || q.min !== q.max, choice: part.choice };
        }
        ways *= part.ways; varies = varies || part.varies; holdsChoice = holdsChoice || part.choice;
      }
      return { ways, varies, choice: holdsChoice };
    }
    try {
      let ways = 1;
      while (i < src.length) { ways *= choice().ways; if (src[i] === ")") i++; } // a stray ")" is the browser's to refuse
      return ways > PATTERN_WAYS ? "has too many ways to match from one place, like .*.*z or (a?){14}" : "";
    } catch (e) {
      if (e && typeof e.why === "string") return e.why;
      throw e;
    }
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

  // "@Name", "u/Name", "/user/name", "https://x.com/Name?s=21", "https://x.com/Name/with_replies" and "name" are all
  // "name"; "r/Name" and "https://reddit.com/r/Name/comments/..." are "r/name". A link keeps only the path segment that
  // names the account: the query, the fragment and any tab after it go.
  const ACCOUNT_PREFIX = new Set(["u", "user", "users", "in", "channel", "profile"]);
  function normalizeHandle(raw) {
    let h = String(raw == null ? "" : raw).trim().toLowerCase().normalize("NFC");
    h = h.replace(/^https?:\/\/[^/?#]+/, "").replace(/[?#].*$/, "");
    const parts = h.split("/").filter(Boolean);
    if (parts.length > 1 && parts[0] === "r") return "r/" + parts[1];
    h = (parts.length > 1 && ACCOUNT_PREFIX.has(parts[0]) ? parts[1] : parts[0]) || "";
    return h.replace(/^@/, "");
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

  // A list of strings: one string alone is a list of one, and anything else that is not a list is none.
  const strings = (v, max, fn) => {
    const out = [];
    for (const x of Array.isArray(v) ? v : typeof v === "string" ? [v] : []) {
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
      enabled: !(r.enabled === false || r.enabled === 0 || r.enabled === "false"),
      source: source || (r.source === "app" ? "app" : "local"),
      sites,
      words: strings(r.words, MAX_TERMS, (x) => x.normalize("NFC").trim().slice(0, MAX_TERM)),
      patterns: strings(r.patterns, MAX_TERMS, (x) => x),
      accounts: strings(r.accounts, MAX_TERMS, normalizeHandle),
      kinds: strings(r.kinds, MAX_TERMS, (x) => x.trim().toLowerCase()).filter((k) => KINDS.includes(k)),
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

  // The first `max` characters of a post. A spaced-script word the cut runs through is dropped whole, since its front
  // alone would read as a word: "bit" is not in "...bitcoin" cut after "bit".
  function clip(s, max) {
    if (s.length <= max) return s;
    let end = max;
    if (/[\uD800-\uDBFF]/.test(s[end - 1])) end--; // never split a surrogate pair
    const edgeAt = (k) => IS_EDGE_CHAR.test(String.fromCodePoint(s.codePointAt(k)));
    if (!edgeAt(end)) return s.slice(0, end);
    while (end > 0) {
      const k = end > 1 && /[\uDC00-\uDFFF]/.test(s[end - 1]) ? end - 2 : end - 1;
      if (!edgeAt(k)) break;
      end = k;
    }
    return s.slice(0, end);
  }

  // The rules that are on and cover `hostname`, compiled once. `test(post)` answers null or { rule, reason }.
  // post: { text, accounts(): string[], kinds(): string[] }; accounts and kinds are asked for only when a rule needs them.
  // A pattern slower than SLOW_MS on one post is switched off for the rest of this compile and added to `refused`.
  // opts: { checkSelector(sel): boolean, now(): ms } (now is for tests; it defaults to performance.now).
  function compile(rules, hostname, opts) {
    const checkSelector = opts && opts.checkSelector;
    const now = (opts && opts.now) || (() => (globalThis.performance ? globalThis.performance.now() : Date.now()));
    const refused = [];
    const compiled = [];
    const hide = [];
    for (const raw of rules || []) {
      const rule = normalizeRule(raw);
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
      const text = clip(String(post.text || "").slice(0, MAX_TEXT + MAX_TERM).normalize("NFC"), MAX_TEXT);
      const wordHit = any ? any.test(text) : false;
      let accounts = null, kinds = null, short = null;
      for (const c of compiled) {
        if (wordHit) for (const x of c.words) if (x.re.test(text)) return { rule: c.rule, reason: x.w };
        for (const x of c.pats) {
          if (x.off) continue;
          if (short == null) short = clip(text, PATTERN_TEXT);
          const t0 = now();
          const hit = x.re.test(short);
          const ms = now() - t0;
          if (ms > SLOW_MS) {
            x.off = true;
            refused.push({ rule: c.rule.id, source: c.rule.source, what: "pattern", value: x.p, why: "took " + Math.round(ms) + " ms on one post, so it is off on this page" });
          }
          if (hit) return { rule: c.rule, reason: "/" + x.p + "/" };
        }
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

  // Every part of these rules that is refused, on any site and whether the rule is on or off, with the reason: for the
  // Settings page, so a rule switched on later holds no surprise.
  function refusals(rules, opts) {
    const all = (Array.isArray(rules) ? rules : []).map((r) => Object.assign(normalizeRule(r), { enabled: true }));
    return compile(all, null, opts).refused;
  }

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
    LOCAL_KEY, APP_KEY, KINDS, KIND_LABEL, MAX_TERMS, MAX_TERM, MAX_TEXT, PATTERN_TEXT, PATTERN_WAYS, MAX_COUNT, SLOW_MS,
    wordSource, riskyPattern, quantifierAt, compilePattern, clip, normalizeHandle, normalizeSite, normalizeRule,
    onSite, merge, compile, refusals, summary
  };
})();
