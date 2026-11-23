/* Polycarp review: short spaced sessions over the memory garden.
   Each idea is recalled from memory before the answer shows (retrieval practice), spaced further
   apart each time it is remembered (Cepeda et al. 2006), mixed across sources (interleaving), and a
   missed idea comes back later in the same session until it is remembered once (successive
   relearning, Rawson and Dunlosky 2011). */
(async function () {
  "use strict";
  const P = globalThis.Polycarp;
  const M = globalThis.PolycarpMemory;
  const FX = globalThis.PolycarpFx;
  const IC = globalThis.PolycarpIcons;
  const I = IC.icon;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const MAX = 20;
  const DAY = 864e5;

  $("navRead").innerHTML = I("book") + "<span>Reader</span>";

  $("navSearch").innerHTML = I("search") + "<span>Search</span>";
  $("navLib").innerHTML = I("library") + "<span>Library</span>";
  $("navReview").innerHTML = I("layers") + "<span>Review</span>";
  $("navSettings").innerHTML = I("sliders") + "<span>Settings</span>";

  const settings = await P.getSettings();
  let cards = await M.load();
  const stage = (t) => IC.GARDEN[Math.max(1, Math.min(6, t))].name;

  function when(ms) {
    if (ms <= 60e3) return "in a minute";
    const m = Math.round(ms / 60e3);
    if (m < 60) return "in " + m + " min";
    const h = Math.round(m / 60);
    if (h < 24) return "in " + h + " hour" + (h === 1 ? "" : "s");
    const d = Math.round(h / 24);
    return d === 1 ? "tomorrow" : "in " + d + " days";
  }
  function blank(prompt) { return esc(prompt).replace(/_{3,}/, '<span class="blank" aria-label="blank">?</span>'); }

  // ---------- Home ----------
  function renderHome() {
    const now = Date.now();
    const c = M.counts(cards, now);
    const reviewed = cards.filter((x) => x.reviews > 0);
    const reviews = reviewed.reduce((n, x) => n + x.reviews, 0);
    const lapses = reviewed.reduce((n, x) => n + (x.lapses || 0), 0);
    const next = M.nextDue(cards);
    $("pip").innerHTML = IC.mascot(!cards.length ? "look" : c.due ? "open" : "happy");
    $("headline").textContent = !cards.length ? "Your memory garden is empty" : c.due ? c.due + " idea" + (c.due === 1 ? " is" : "s are") + " ready to grow" : "All caught up";
    $("sub").textContent = !cards.length
      ? "Answer a recall break in the Reader, or select text on any page and choose Remember this with Polycarp. Each idea is a seed."
      : c.due ? "About " + Math.max(1, Math.round(Math.min(MAX, c.due) * 0.3)) + " min. Answer from memory before you look."
      : cards.length + " idea" + (cards.length === 1 ? "" : "s") + " planted.";
    const totals = cards.length ? cards.length + " idea" + (cards.length === 1 ? "" : "s") + " planted" + (reviews ? ", " + reviews + " review" + (reviews === 1 ? "" : "s") + " done, " + (reviews - lapses) + " recalled from memory" : "") + ". " : "";
    $("garden").innerHTML = M.TIERS.map((t) => {
      const n = c.byTier[t.tier] || 0;
      return '<button class="bed' + (n ? "" : " empty") + '" data-tier="' + t.tier + '" aria-pressed="' + (stageFilter === t.tier) + '"' + (n ? "" : " disabled") +
        ' aria-label="' + n + " " + esc(stage(t.tier)) + (n === 1 ? "" : "s") + ', show them">' + IC.plant(t.tier) + "<b>" + n + "</b><span>" + stage(t.tier) + "</span></button>";
    }).join("");
    const week = cards.filter((x) => x.due > now && x.due <= now + 7 * 864e5).length;
    $("gardenNote").textContent = cards.length
      ? totals + "Recall an idea and it grows a stage. Partly right holds it where it is; a miss sends it back two stages." + (week ? " " + week + " more " + (week === 1 ? "comes" : "come") + " up for review this week." : "")
      : "";
    const box = $("startBox");
    if (c.due) {
      const n = Math.min(MAX, c.due);
      box.innerHTML = '<button class="btn primary" id="go">' + I("play") + "<span>Start review" + (c.due > n ? " (" + n + " of " + c.due + ")" : "") + "</span></button>";
      const from = new Map();
      cards.filter((x) => x.due <= now).forEach((x) => { const t = (x.source && x.source.title) || "Your notes"; from.set(t, (from.get(t) || 0) + 1); });
      const top = [...from].sort((a, b) => b[1] - a[1]).slice(0, 3);
      if (top.length) {
        const ul = document.createElement("ul");
        ul.className = "from";
        ul.setAttribute("aria-label", "Where these ideas come from");
        for (const [t, k] of top) {
          const li = document.createElement("li");
          const b = document.createElement("b");
          b.textContent = k;
          li.append(b, " from ", t);
          ul.append(li);
        }
        if (from.size > 3) { const li = document.createElement("li"); li.textContent = "and " + (from.size - 3) + " more"; ul.append(li); }
        box.append(ul);
      }
      $("go").addEventListener("click", startSession);
    } else if (cards.length) {
      box.innerHTML = "<p><b>Nothing to review right now.</b> The next idea is ready " + when(next - now) + ". Spacing reviews out is what makes them last.</p>" +
        '<a class="btn" href="../reader/reader.html">' + I("book") + "<span>Read something</span></a>";
    } else {
      box.innerHTML = '<a class="btn primary" href="../reader/reader.html">' + I("book") + "<span>Open the Reader</span></a>";
    }
    $("allBox").hidden = !cards.length;
    $("allSum").textContent = stageFilter ? stage(stageFilter) + "s (" + (c.byTier[stageFilter] || 0) + ")" : "All ideas (" + cards.length + ")";
    renderList();
  }
  let stageFilter = 0;
  $("garden").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tier]"); if (!b) return;
    const t = Number(b.dataset.tier);
    stageFilter = stageFilter === t ? 0 : t;
    $("garden").querySelectorAll("[data-tier]").forEach((x) => x.setAttribute("aria-pressed", String(Number(x.dataset.tier) === stageFilter)));
    $("allBox").open = true;
    renderList();
    if (stageFilter) $("allBox").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  function renderList() {
    const q = $("filter").value.trim().toLowerCase();
    const list = cards.filter((c) => (!stageFilter || c.tier === stageFilter) && (!q || (c.prompt + " " + c.answer + " " + (c.source && c.source.title)).toLowerCase().includes(q)))
      .sort((a, b) => a.due - b.due).slice(0, 300);
    $("cards").innerHTML = list.map((c) =>
      "<li>" + IC.plant(c.tier) + "<div><p>" + (c.type === "cloze" ? blank(c.prompt).replace('<span class="blank" aria-label="blank">?</span>', "<b>" + esc(c.answer) + "</b>") : esc(c.answer.slice(0, 220))) + "</p>" +
      "<small>" + esc(stage(c.tier)) + " · " + (c.due <= Date.now() ? "ready now" : "next " + when(c.due - Date.now())) + (c.source && c.source.title ? " · " + esc(c.source.title) : "") + "</small></div>" +
      '<button class="btn icon quiet" data-del="' + esc(c.id) + '" aria-label="Delete this idea">' + I("x") + "</button></li>").join("");
  }
  $("filter").addEventListener("input", renderList);
  $("cards").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-del]"); if (!b) return;
    await M.remove(b.dataset.del);
    cards = await M.load();
    renderHome();
    chrome.runtime.sendMessage({ type: "polycarp:refreshBadge" }).catch(() => {});
  });

  // ---------- Session ----------
  let queue = [], pos = 0, total = 0, tally = { got: 0, close: 0, missed: 0 }, grew = 0;
  function interleave(list) {
    const by = new Map();
    for (const c of list) { const k = (c.source && c.source.docKey) || "?"; if (!by.has(k)) by.set(k, []); by.get(k).push(c); }
    const lanes = [...by.values()], out = [];
    while (out.length < list.length) for (const l of lanes) if (l.length) out.push(l.shift());
    return out;
  }
  function startSession() {
    queue = interleave(M.due(cards, Date.now()).slice(0, MAX)).map((c) => ({ card: c, tries: 0, saved: null }));
    total = queue.length; pos = 0; tally = { got: 0, close: 0, missed: 0 }; grew = 0;
    $("home").hidden = true; $("done").hidden = true; $("session").hidden = false;
    show();
  }
  $("sStop").addEventListener("click", finish);

  function source(c) {
    const s = c.source || {};
    const href = s.docKey ? "../reader/reader.html?lib=" + encodeURIComponent(s.docKey) : s.url;
    const t = s.title ? (href ? '<a href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(s.title) + "</a>" : esc(s.title)) : "";
    return '<div class="from">' + IC.plant(c.tier) + "<span>" + esc(stage(c.tier)) + (t ? " · from " + t : "") + (s.section && s.section !== s.title ? " · " + esc(s.section) : "") + "</span></div>";
  }
  function show() {
    const item = queue[pos];
    if (!item) return finish();
    const c = item.card;
    const done = Math.min(pos, total);
    $("sCount").textContent = (done + 1 > total ? total : done + 1) + " of " + total + (item.tries ? " · again" : "");
    $("sFill").style.width = (pos / queue.length) * 100 + "%";
    const card = $("card");
    if (c.type === "cloze") {
      card.innerHTML = source(c) + '<p class="prompt">' + blank(c.prompt) + "</p>" +
        '<form id="f"><input class="field" id="ans" autocomplete="off" spellcheck="false" placeholder="Type what is missing" aria-label="What is missing"><button class="btn">Check</button></form>' +
        '<div class="row2"><button class="btn quiet" id="hint">Hint</button><button class="btn quiet" id="give">Show the answer</button></div>';
      $("f").addEventListener("submit", (e) => {
        e.preventDefault();
        const g = $("ans").value;
        if (!g.trim()) return $("ans").focus();
        const r = FX.judge(g, c.answer);
        reveal(item, r, g);
      });
      $("hint").addEventListener("click", (e) => { e.target.replaceWith(Object.assign(document.createElement("span"), { className: "note", textContent: c.hint || "Starts with " + c.answer[0] })); $("ans").focus(); });
      $("give").addEventListener("click", () => reveal(item, "missed", ""));
      $("ans").focus();
    } else {
      const prompt = c.type === "quote" ? "What did this passage say? Recall it in your own words." : c.prompt;
      card.innerHTML = source(c) + '<p class="prompt">' + esc(prompt) + "</p>" +
        (c.type === "quote" && c.context ? '<p class="note">Cue: ' + esc(c.context.split(/\s+/).slice(0, 6).join(" ")) + "…</p>" : "") +
        '<form id="f"><textarea class="field" id="ans" placeholder="From memory first" aria-label="Your answer"></textarea></form>' +
        '<div class="row2"><button class="btn primary" id="rev">Show the answer</button></div>';
      $("rev").addEventListener("click", () => selfGrade(item));
      $("ans").focus();
    }
  }
  function selfGrade(item) {
    const c = item.card;
    $("card").querySelector(".row2").remove();
    const a = document.createElement("div");
    a.className = "answer";
    a.innerHTML = "<b>The text</b><q>" + esc(c.answer) + "</q>";
    $("card").appendChild(a);
    const g = document.createElement("div");
    g.className = "row2";
    g.innerHTML = '<button class="btn" data-r="got">Got it <kbd>1</kbd></button><button class="btn" data-r="close">Partly <kbd>2</kbd></button><button class="btn" data-r="missed">Missed it <kbd>3</kbd></button>';
    $("card").appendChild(g);
    g.addEventListener("click", (e) => { const b = e.target.closest("[data-r]"); if (b) { g.remove(); apply(item, b.dataset.r); } });
    // The answer is in: lock what was typed and hand the keys to the grade buttons, so 1, 2 and 3 grade.
    const ta = $("ans");
    if (ta) ta.readOnly = true;
    g.querySelector("[data-r]").focus();
  }
  function reveal(item, r, guess) {
    const c = item.card;
    $("card").querySelectorAll("form, .row2").forEach((x) => x.remove());
    const a = document.createElement("div");
    a.className = "answer" + (r === "got" ? " got" : "");
    const title = { got: "Got it", close: "Partly right", missed: guess ? "Not quite" : "Here it is" }[r];
    const exact = r === "got" && FX.norm(guess) === FX.norm(c.answer);
    a.innerHTML = "<b>" + title + "</b>" + (exact ? esc(c.context || "") : "The answer is <strong>" + esc(c.answer) + "</strong>" + (guess && r !== "got" ? ". You wrote " + esc(guess) + "." : "."));
    const gap = $("card").querySelector(".prompt .blank");
    if (gap) { gap.textContent = c.answer; gap.classList.add("filled"); gap.removeAttribute("aria-label"); }
    $("card").appendChild(a);
    if (r === "close") {
      const g = document.createElement("div");
      g.className = "row2";
      g.innerHTML = '<button class="btn" data-r="got">That is what I meant</button><button class="btn quiet" data-r="close">Count it as partly right</button>';
      $("card").appendChild(g);
      g.addEventListener("click", (e) => { const b = e.target.closest("[data-r]"); if (b) { g.remove(); apply(item, b.dataset.r); } });
      return;
    }
    apply(item, r);
  }
  // A card missed four or more times is usually a bad card, not a bad memory. Offer to reword it
  // or let it go, instead of drilling it forever.
  function leechBox(item, card) {
    const box = document.createElement("div");
    box.className = "leech";
    const p = document.createElement("p");
    p.textContent = "This one keeps slipping. Rewording it in your own words often fixes that.";
    const row = document.createElement("div");
    row.className = "row2";
    const edit = document.createElement("button");
    edit.className = "btn"; edit.type = "button"; edit.textContent = "Reword it";
    const drop = document.createElement("button");
    drop.className = "btn quiet"; drop.type = "button"; drop.textContent = "Let it go";
    row.append(edit, drop);
    box.append(p, row);
    $("card").appendChild(box);
    drop.addEventListener("click", async () => {
      await M.remove(card.id);
      queue = queue.filter((q, i) => i <= pos || q.card.id !== card.id);
      total = queue.length;
      p.textContent = "Let go. It won't come back.";
      row.remove();
    });
    edit.addEventListener("click", () => {
      row.remove();
      const f = document.createElement("form");
      f.className = "reword";
      const l1 = document.createElement("label"); l1.textContent = "Question or prompt";
      const q = document.createElement("textarea"); q.rows = 3; q.value = card.prompt;
      l1.appendChild(q);
      const l2 = document.createElement("label"); l2.textContent = "Answer";
      const an = document.createElement("input"); an.value = card.answer;
      l2.appendChild(an);
      const save = document.createElement("button"); save.className = "btn"; save.textContent = "Save the new wording";
      f.append(l1, l2, save);
      box.appendChild(f);
      q.focus();
      f.addEventListener("submit", async (e) => {
        e.preventDefault();
        const prompt = q.value.trim(), answer = an.value.trim();
        if (!prompt || !answer) return;
        const fresh = Object.assign({}, card, { prompt, answer, type: card.type === "cloze" && !/_____/.test(prompt) ? "qa" : card.type, leech: false, lapses: 0 });
        await M.update(fresh);
        queue.forEach((x) => { if (x.card.id === card.id) { x.card = fresh; x.saved = fresh; } });
        f.remove();
        p.textContent = "Saved. You'll see the new wording next time.";
      });
    });
  }

  async function apply(item, r) {
    const now = Date.now();
    const before = item.card.tier;
    let next;
    if (item.tries === 0) {
      tally[r]++;
      next = M.grade(item.card, r === "close" ? "fuzzy" : r, now);
      item.saved = next;
    } else {
      // Relearning: remembered later this session, so it waits a day instead of ten minutes.
      next = Object.assign({}, item.saved);
      if (r === "got") next.due = now + DAY;
    }
    await M.update(next);
    if (r === "missed" && item.tries < 2) queue.splice(Math.min(queue.length, pos + 4), 0, { card: next, tries: item.tries + 1, saved: next });
    if (next.tier > before) grew++;
    if (r === "got") FX.chime("got", settings); else if (r === "close") FX.chime("close", settings);
    const grow = document.createElement("div");
    grow.className = "grow";
    const msg = r === "missed" ? (item.tries < 2 ? (item.tries === 0 && before > next.tier ? stage(before) + " slipped to " + stage(next.tier) + ". " : "") + "It comes back in a few cards." : "It comes back soon.")
      : next.tier > before ? stage(before) + " grew into " + stage(next.tier) + ". Back " + when(next.due - now) + "."
        : "Still at " + stage(next.tier) + ". Back " + when(next.due - now) + ".";
    grow.innerHTML = (next.tier > before ? IC.plant(before) + I("next") + IC.plant(next.tier, "new") : IC.plant(next.tier)) + "<span>" + msg + "</span>";
    $("card").appendChild(grow);
    if (r === "missed" && next.leech && item.tries === 0) leechBox(item, next);
    const nb = document.createElement("div");
    nb.className = "row2";
    nb.innerHTML = '<button class="btn primary" id="next">Next <kbd>Enter</kbd></button>';
    $("card").appendChild(nb);
    $("next").addEventListener("click", () => { pos++; show(); });
    $("next").focus();
  }
  document.addEventListener("keydown", (e) => {
    if ($("session").hidden) return;
    const grade = $("card").querySelector("[data-r]");
    if (grade && ["1", "2", "3"].includes(e.key) && document.activeElement.tagName !== "TEXTAREA") {
      const btn = $("card").querySelectorAll("[data-r]")[Number(e.key) - 1];
      if (btn) { e.preventDefault(); btn.click(); }
    }
    if (e.key === "Enter" && !e.shiftKey && document.activeElement.id === "ans" && document.activeElement.tagName === "TEXTAREA") {
      e.preventDefault(); const rv = $("rev"); if (rv) rv.click();
    }
  });

  async function finish() {
    cards = await M.load();
    $("session").hidden = true;
    const n = tally.got + tally.close + tally.missed;
    if (!n) { $("home").hidden = false; renderHome(); return; }
    const all = tally.got === n;
    $("done").hidden = false;
    $("done").innerHTML = IC.mascot(all ? "happy" : "open") +
      "<h1>" + (all ? "Every one remembered" : "Session done") + "</h1>" +
      "<p>" + (grew ? grew + " idea" + (grew === 1 ? "" : "s") + " grew a stage. " : "") + "Each time you pull an idea back from memory, it lasts longer before it needs another review.</p>" +
      '<div class="stats3"><div><b>' + tally.got + "</b><span>Got it</span></div><div><b>" + tally.close + "</b><span>Partly</span></div><div><b>" + tally.missed + "</b><span>Missed</span></div></div>" +
      '<a class="btn primary" href="../reader/reader.html">' + I("book") + '<span>Back to reading</span></a> <button class="btn quiet" id="home2">See your garden</button>';
    $("home2").addEventListener("click", () => { $("done").hidden = true; $("home").hidden = false; renderHome(); });
    FX.chime("finish", settings);
    if (all && n >= 3) FX.party(settings);
    chrome.runtime.sendMessage({ type: "polycarp:refreshBadge" }).catch(() => {});
  }

  renderHome();
  if (new URLSearchParams(location.search).get("start") === "1" && M.counts(cards, Date.now()).due) startSession();
})();
