/* Polycarp Reader, learning layer.
   Evidence it leans on:
   - Advance organizers: a short preview of key ideas before reading (Ausubel 1960).
   - Pretesting: guessing before you learn improves later recall (Richland, Kornell and Kao 2009).
   - Retrieval practice: recalling beats rereading (Roediger and Karpicke 2006).
   - Generation effect: typing the answer beats recognizing it (Slamecka and Graf 1978).
   - Spaced review: cards go to the memory garden for later reviews (Cepeda et al. 2006).
   - Spatial memory: where on the page something was helps you find it in memory (Rothkopf 1971). */
(function () {
  "use strict";
  const R = globalThis.PolycarpReader;
  const M = globalThis.PolycarpMemory;
  const IC = globalThis.PolycarpIcons;
  const I = IC.icon;
  const esc = (s) => R.esc(s);
  const $ = (id) => document.getElementById(id);
  if (!M) return;

  let stats = null;
  const seen = new Set();
  let planted = 0;
  const statsFor = () => stats || (stats = M.docStats(R.rangeText(0, R.blocks.length - 1).slice(0, 400000)));
  const source = (b) => ({ title: R.doc.title, url: (R.doc.source && R.doc.source.url) || "", docKey: R.key, section: R.sections[R.sectionOf(b)] ? R.sections[R.sectionOf(b)].title : "" });

  const judge = globalThis.PolycarpFx.judge;
  const norm = globalThis.PolycarpFx.norm;
  R.judge = judge;

  // ---------- Key ideas and warm-up ----------
  async function renderIdeas() {
    const box = $("ideas");
    box.textContent = "";
    if (R.total < 600) return;
    const text = R.rangeText(0, R.blocks.length - 1);
    let ideas = null, src = "Picked from the text on this computer.";
    try { ideas = await M.ai.keyIdeas(text, 3); if (ideas) src = "Summarized by Chrome's built-in AI on this computer."; } catch (e) {}
    if (!ideas || !ideas.length) ideas = M.keySentences(text.slice(0, 200000), 3, statsFor()).sort((a, b) => a.index - b.index).map((s) => s.text);
    if (!ideas.length) return;
    const pre = pickPretest();
    const det = document.createElement("details");
    det.className = "ideas";
    det.open = !(R.extra && R.extra.ideasClosed) && R.doneWords === 0;
    det.innerHTML = "<summary>" + I("sparkle") + "<span>Before you start: " + ideas.length + " key ideas</span></summary>" +
      "<ol>" + ideas.map((t) => "<li>" + esc(t.length > 260 ? t.slice(0, 257) + "…" : t) + "</li>").join("") + "</ol>" +
      '<p class="src">' + esc(src) + "</p>" + (pre ? pretestHtml(pre) : "");
    det.addEventListener("toggle", () => { R.extra = Object.assign(R.extra || {}, { ideasClosed: !det.open }); R.saveProgress(); });
    box.appendChild(det);
    if (pre) bindPretest(det, pre);
  }
  function pickPretest() {
    if (!R.settings.reader.pretest) return null;
    if (R.extra && R.extra.pretest) return R.extra.pretest;
    if (R.doneWords > 0) return null;
    // A question from past the first quarter, so the answer is still ahead.
    const from = R.blocks.findIndex((_, i) => R.cum[i] >= R.total * 0.25);
    const picks = M.keySentences(R.rangeText(Math.max(0, from), R.blocks.length - 1).slice(0, 120000), 6, statsFor());
    for (const k of picks) {
      const cz = M.makeCloze(k.text, statsFor());
      if (!cz) continue;
      const b = findBlock(k.text, Math.max(0, from), R.blocks.length - 1);
      if (b < 0) continue;
      seen.add(M.normalize(cz.answer));
      return { prompt: cz.prompt, answer: cz.answer, hint: cz.hint, context: k.text, block: b, guess: null };
    }
    return null;
  }
  function pretestHtml(p) {
    const done = p.guess != null;
    return '<div class="q" data-pre>' +
      '<div class="hint"><b>Warm-up guess.</b> You have not read this yet, so just guess. Guessing first makes the real answer stick.</div>' +
      '<div class="prompt">' + blankHtml(p.prompt) + "</div>" +
      (done ? '<div class="hint">You guessed <b>' + esc(p.guess || "nothing") + "</b>. The answer is waiting in the text.</div>"
        : '<form class="row"><input class="field" placeholder="Your guess" aria-label="Your guess" autocomplete="off"><button class="btn">Lock it in</button></form>') +
      "</div>";
  }
  function bindPretest(root, p) {
    const form = root.querySelector("[data-pre] form");
    if (!form) return;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      p.guess = form.querySelector("input").value.trim();
      R.extra = Object.assign(R.extra || {}, { pretest: p });
      R.saveProgress();
      form.outerHTML = '<div class="hint">Locked in: <b>' + esc(p.guess || "no guess") + "</b>. Polycarp will show you when you reach the answer.</div>";
    });
  }
  R.on("done", (i) => {
    const p = R.extra && R.extra.pretest;
    if (!p || p.revealed || p.guess == null || i !== p.block) return;
    p.revealed = true;
    R.saveProgress();
    const right = judge(p.guess, p.answer) !== "missed";
    R.toast(right ? "Your warm-up guess was right" : "Warm-up answer: " + p.answer,
      right ? "You guessed " + p.guess + " before reading it." : p.guess ? "You guessed " + p.guess + ". Now you know the real one." : "Now you know.", IC.mascot(right ? "happy" : "wow"));
    if (right) R.chime("got");
  });

  // ---------- Recall checkpoints ----------
  function blankHtml(prompt) {
    return esc(prompt).replace(/_{3,}/, '<span class="blank" aria-label="blank">?</span>');
  }
  function findBlock(text, a, b) {
    const probe = String(text).replace(/\s+/g, " ").trim().slice(0, 48);
    for (let i = a; i <= b; i++) if (R.blockText(i).includes(probe)) return i;
    return -1;
  }
  function pagemap(r, hit) {
    const n = Math.min(12, r.end - r.start + 1);
    const per = (r.end - r.start + 1) / n;
    let out = '<span class="pagemap" aria-hidden="true">';
    for (let k = 0; k < n; k++) {
      const a = r.start + Math.floor(k * per), b = r.start + Math.floor((k + 1) * per) - 1;
      const w = 40 + ((a * 37) % 55);
      out += '<i style="width:' + w + '%"' + (hit >= a && hit <= Math.max(a, b) ? ' class="hit"' : "") + "></i>";
    }
    return out + "</span>";
  }
  let cpObserver = null;
  R.on("rounds", (rounds) => {
    if (cpObserver) cpObserver.disconnect();
    cpObserver = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { cpObserver.unobserve(e.target); fillCheckpoint(e.target); }
    }, { rootMargin: "900px 0px" });
    rounds.forEach((r) => { if (r.el) cpObserver.observe(r.el); });
  });

  function fillCheckpoint(el) {
    const r = R.rounds.find((x) => x.el === el);
    if (!r || el.dataset.filled) return;
    el.dataset.filled = "1";
    const text = R.rangeText(r.start, r.end);
    const cards = M.checkpoint(text, statsFor(), { max: R.settings.profile === "focus" ? 2 : 3, seen, source: source(r.end) });
    if (!cards.length) { el.remove(); return; }
    const mins = Math.max(1, Math.round(cards.length * 0.4));
    el.innerHTML = '<div class="cp-head">' + IC.mascot("look") +
      "<div><b>Quick recall</b><span>" + cards.length + " question" + (cards.length > 1 ? "s" : "") + ", about " + mins + " min. Typing the answer makes it stick.</span></div>" +
      '<button class="btn quiet" data-skip>Skip</button></div>' +
      cards.map((c, k) => questionHtml(c, k)).join("");
    el.querySelector("[data-skip]").addEventListener("click", () => finishCheckpoint(el, r, cards, true));
    cards.forEach((c, k) => bindQuestion(el, r, c, k, cards));
  }
  function questionHtml(c, k) {
    if (c.type === "gist") {
      return '<div class="q" data-k="' + k + '"><div class="prompt">' + esc(c.prompt) + "</div>" +
        '<form class="row"><textarea class="field" rows="2" placeholder="In your own words" aria-label="' + esc(c.prompt) + '"></textarea></form>' +
        '<div class="row"><button class="btn" data-check>Compare</button></div></div>';
    }
    return '<div class="q" data-k="' + k + '"><div class="prompt">' + blankHtml(c.prompt) + "</div>" +
      '<form class="row"><input class="field" placeholder="Type what is missing" aria-label="What is missing" autocomplete="off" spellcheck="false"><button class="btn">Check</button></form>' +
      '<div class="row"><button class="btn quiet" data-hint>Hint</button><button class="btn quiet" data-giveup>Show the answer</button></div></div>';
  }
  function bindQuestion(el, r, card, k, cards) {
    const q = el.querySelector('.q[data-k="' + k + '"]');
    const src = findBlock(card.context, r.start, r.end);
    const form = q.querySelector("form");
    const verdict = (cls, title, body) => {
      const v = document.createElement("div");
      v.className = "verdict " + cls;
      v.innerHTML = pagemap(r, src) + "<div><b>" + title + "</b>" + body +
        (src >= 0 ? ' <button class="btn quiet" data-find style="min-height:28px;padding:0 6px">Find it</button>' : "") + "</div>";
      q.querySelectorAll(".row").forEach((x) => x.remove());
      q.appendChild(v);
      const f = v.querySelector("[data-find]");
      if (f) f.addEventListener("click", () => { R.go(src); flash(src); });
    };
    const settle = (result) => {
      card._result = result;
      if (cards.every((c) => c._result)) setTimeout(() => finishCheckpoint(el, r, cards, false), 500);
    };
    if (card.type === "gist") {
      const ask = () => {
        const mine = q.querySelector("textarea").value.trim();
        verdict("", "The text put it like this", "<br>" + esc(card.answer.length > 300 ? card.answer.slice(0, 297) + "…" : card.answer) +
          (mine ? '<br><span class="hint">You wrote: ' + esc(mine) + "</span>" : ""));
        const g = document.createElement("div");
        g.className = "grade";
        g.innerHTML = '<button class="btn" data-r="got">Got it</button><button class="btn" data-r="close">Partly</button><button class="btn" data-r="missed">Missed it</button>';
        q.appendChild(g);
        g.addEventListener("click", (e) => {
          const b = e.target.closest("[data-r]"); if (!b) return;
          g.remove();
          if (b.dataset.r === "got") R.chime("got");
          settle(b.dataset.r);
        });
      };
      q.querySelector("[data-check]").addEventListener("click", ask);
      return;
    }
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const guess = form.querySelector("input").value;
      if (!guess.trim()) return form.querySelector("input").focus();
      const res = judge(guess, card.answer);
      if (res === "got") { verdict("got", "Got it", norm(guess) === norm(card.answer) ? "" : " The text says <b>" + esc(card.answer) + "</b>."); R.chime("got"); }
      else if (res === "close") { verdict("", "Partly right", " The text says <b>" + esc(card.answer) + "</b>."); R.chime("close"); }
      else verdict("", "Not quite", " The text says <b>" + esc(card.answer) + "</b>. Polycarp will ask again soon.");
      settle(res);
    });
    q.querySelector("[data-hint]").addEventListener("click", (e) => {
      e.target.replaceWith(Object.assign(document.createElement("span"), { className: "hint", textContent: card.hint || "Starts with " + card.answer[0] }));
    });
    q.querySelector("[data-giveup]").addEventListener("click", () => {
      verdict("", "Here it is", " The text says <b>" + esc(card.answer) + "</b>. Polycarp will ask again soon.");
      settle("missed");
    });
    // Focus the first question once it reaches the reading band, not before.
  }
  async function finishCheckpoint(el, r, cards, skipped) {
    if (el.classList.contains("answered")) return;
    el.classList.add("answered");
    const now = Date.now();
    const keep = cards.map((c) => {
      const out = Object.assign({}, c);
      delete out._result;
      if (c._result === "missed") out.due = now + 10 * 60 * 1000;
      return out;
    });
    let added = [];
    try { added = await M.addMany(keep); } catch (e) {}
    planted += added.length;
    chrome.runtime.sendMessage({ type: "polycarp:refreshBadge" }).catch(() => {});
    const got = cards.filter((c) => c._result === "got").length;
    const row = document.createElement("div");
    row.className = "cp-done";
    row.innerHTML = IC.plant(1) + "<span>" + (skipped
      ? "Skipped. " + added.length + " idea" + (added.length === 1 ? "" : "s") + " still went to your memory garden for review tomorrow."
      : (got === cards.length ? "All " + got + " right. " : got ? got + " of " + cards.length + " right. " : "") + added.length + " seed" + (added.length === 1 ? "" : "s") + " planted. " +
        (cards.some((c) => c._result === "missed") ? "The ones you missed come back soon, the rest tomorrow." : "First review tomorrow.")) + "</span>";
    el.querySelectorAll(".q .row, .q .grade, [data-skip]").forEach((x) => x.remove());
    if (skipped) el.querySelectorAll(".q").forEach((x) => x.remove());
    el.appendChild(row);
    const pip = el.querySelector(".cp-head .pip");
    if (pip) pip.outerHTML = IC.mascot(got === cards.length && !skipped ? "happy" : "open");
    if (!skipped && got) R.chime("seed");
  }

  // ---------- Snap: keep any passage ----------
  // The selection bar holds Highlight and Note (reader-notes.js) and Remember (here).
  const snapBtn = $("selbar");
  $("snap").innerHTML = I("bookmark") + "<span>Remember</span>";
  function selectionInArticle() {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!$("article").contains(range.commonAncestorContainer)) return null;
    const text = sel.toString().replace(/\s+/g, " ").trim();
    return text.split(" ").length >= 3 ? { text, range } : null;
  }
  document.addEventListener("selectionchange", () => {
    const s = selectionInArticle();
    if (!s) { snapBtn.hidden = true; return; }
    const rect = s.range.getBoundingClientRect();
    snapBtn.hidden = false;
    const w = snapBtn.offsetWidth || 280;
    snapBtn.style.left = Math.max(8, Math.min(innerWidth - w - 8, rect.left + rect.width / 2 - w / 2)) + scrollX + "px";
    snapBtn.style.top = rect.bottom + scrollY + 10 + "px";
  });
  snapBtn.addEventListener("mousedown", (e) => e.preventDefault());
  $("snap").addEventListener("click", () => R.snap());
  R.selectionInArticle = selectionInArticle;
  R.snap = async function () {
    const s = selectionInArticle();
    let text, b;
    if (s) {
      text = s.text.slice(0, 600);
      const node = s.range.startContainer.nodeType === 1 ? s.range.startContainer : s.range.startContainer.parentElement;
      const blk = node && node.closest(".blk");
      b = blk ? Number(blk.dataset.b) : R.cur;
    } else { b = R.cur; text = R.blockText(b).slice(0, 600); }
    if (!text) return;
    const cz = M.makeCloze(M.sentences(text).sort((x, y) => y.length - x.length)[0] || text, statsFor());
    const card = cz
      ? M.newCard({ type: "cloze", prompt: cz.prompt, answer: cz.answer, hint: cz.hint, context: text, source: source(b) })
      : M.newCard({ type: "quote", prompt: "Recall this passage in your own words.", answer: text, context: text, source: source(b) });
    const added = await M.add(card).catch(() => null);
    getSelection().removeAllRanges();
    snapBtn.hidden = true;
    flash(b);
    if (added) { planted++; R.toast("Seed planted", "Polycarp will ask you about this tomorrow.", IC.plant(1)); R.chime("seed"); chrome.runtime.sendMessage({ type: "polycarp:refreshBadge" }).catch(() => {}); }
    else R.toast("Already planted", "This one is in your memory garden.", IC.plant(2));
  };
  function flash(b) {
    const el = R.blocks[b]; if (!el) return;
    el.classList.remove("snap"); void el.offsetWidth; el.classList.add("snap");
  }

  // ---------- Finish ----------
  async function renderFinish(celebrate) {
    const box = $("finish");
    let docCards = 0, due = 0;
    try {
      const cards = await M.load();
      docCards = cards.filter((c) => c.source && c.source.docKey === R.key).length;
      due = M.counts(cards, Date.now()).due;
    } catch (e) {}
    const p = R.extra && R.extra.pretest;
    box.innerHTML = '<div class="finish">' + IC.mascot("happy") +
      "<h2>You finished it</h2>" +
      "<p>" + R.total.toLocaleString() + " words of " + esc(R.doc.title) + ". " +
      (docCards ? docCards + " idea" + (docCards === 1 ? "" : "s") + " planted in your memory garden. Short reviews over the next few weeks help them last." : "Next time, select a passage and press S to remember it.") +
      (p && p.guess != null ? " Your warm-up guess was " + esc(p.guess || "blank") + "; the answer was " + esc(p.answer) + "." : "") + "</p>" +
      '<div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">' +
      (due ? '<a class="btn primary" href="../pages/review.html">' + I("layers") + "<span>Review " + due + " now</span></a>" : '<a class="btn primary" href="reader.html">' + I("book") + "<span>Read something else</span></a>") +
      '<button class="btn" data-print>' + I("printer") + "<span>Print with recall sheet</span></button></div></div>";
    box.querySelector("[data-print]").addEventListener("click", () => R.openPrint && R.openPrint());
    if (celebrate) { R.chime("finish"); R.party(); }
  }
  R.on("finished", () => renderFinish(true));

  R.on("rendered", () => {
    stats = null; seen.clear(); planted = 0;
    $("finish").textContent = "";
    const idle = window.requestIdleCallback || ((f) => setTimeout(f, 60));
    idle(() => { renderIdeas(); if (R.finished) renderFinish(false); });
  });
})();
