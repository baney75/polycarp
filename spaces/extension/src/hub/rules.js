/* Polycarp Hub rules: plain lines a person reads and edits, one rule a line, in the same words as search.
     list:almanac then bundle newsletters
     from:boss@work.example then flag
     from:receipts@shop.example then mark read, archive
     subject:"build failed" then keep with people
   Bundle rules decide where a thread shows and change nothing in the account. Mark read, flag and archive change
   mail that arrives after the rules were saved, through the account like a key press would. Lines starting with #
   are notes. Classic script; needs search.js and organize.js. */
(function () {
  "use strict";

  const X = globalThis.PolycarpHubSearch;
  const O = globalThis.PolycarpHubOrganize;
  const EXAMPLE = "# One rule a line: a search, then what to do.\n# list:almanac then bundle newsletters\n# from:boss@work.example then flag\n";

  // An action's words into {kind, bundle?}, or an error string.
  function action(s) {
    const w = s.trim().toLowerCase().replace(/\s+/g, " ");
    if (w === "archive") return { kind: "archive" };
    if (w === "mark read" || w === "read") return { kind: "read" };
    if (w === "flag" || w === "star") return { kind: "flag" };
    if (w === "keep with people" || w === "no bundle") return { kind: "bundle", bundle: "" };
    const b = w.match(/^bundle (?:as |in |into )?(\w+)$/);
    if (b) {
      const hit = O.BUNDLES.find((x) => x.id === b[1] || x.name.toLowerCase() === b[1] || x.id === b[1] + "s");
      return hit ? { kind: "bundle", bundle: hit.id } : "there is no bundle called " + b[1] + " (try " + O.BUNDLES.map((x) => x.id).join(", ") + ")";
    }
    return "\"" + s.trim() + "\" isn't something a rule can do (try archive, mark read, flag, bundle newsletters or keep with people)";
  }

  // Text into {rules: [{line, text, query, actions}], errors: [{line, why}]}. A line with an error is left out.
  function parse(text) {
    const rules = [];
    const errors = [];
    String(text || "").split("\n").forEach((raw, i) => {
      const line = i + 1;
      const s = raw.trim();
      if (!s || s.startsWith("#")) return;
      const m = s.match(/^(.*?)\s+then\s+(.+)$/i);
      if (!m) return errors.push({ line, why: "a rule needs a search, then \"then\", then what to do" });
      const query = X.parse(m[1] + " ");
      if (query.bad.length) return errors.push({ line, why: query.bad.join(", ") + " isn't a search word Polycarp knows" });
      if (!query.terms.length && !query.filters.length) return errors.push({ line, why: "the search before \"then\" is empty" });
      const actions = [];
      for (const part of m[2].split(/\s*(?:,|\band\b)\s*/i).filter(Boolean)) {
        const a = action(part);
        if (typeof a === "string") return errors.push({ line, why: a });
        actions.push(a);
      }
      rules.push({ line, text: s, query, actions });
    });
    return { rules, errors };
  }

  // The bundle the first matching bundle rule gives a thread summary: a bundle id, "" to keep it with people, or
  // undefined when no rule says, so the headers decide.
  function bundleFor(rules, t) {
    for (const r of rules) {
      const b = r.actions.find((a) => a.kind === "bundle");
      if (b && X.matches(r.query, t)) return b.bundle;
    }
    return undefined;
  }

  // What every matching rule does to a newly arrived message: {archive, read, flag}, each true or absent.
  function actionsFor(rules, m) {
    const out = {};
    for (const r of rules) {
      if (!X.matches(r.query, m)) continue;
      for (const a of r.actions) if (a.kind !== "bundle") out[a.kind] = true;
    }
    return out;
  }

  globalThis.PolycarpHubRules = { EXAMPLE, parse, bundleFor, actionsFor };
})();
