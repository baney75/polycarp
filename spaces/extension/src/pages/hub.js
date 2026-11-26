/* Polycarp Mail: the list, the open conversation, the keys and the command bar, over the Hub's local store. Mail text
   reaches the page only through textContent; HTML mail is shown as its text here (the sanitized view comes later). */
(function () {
  "use strict";
  const S = globalThis.PolycarpHubStore;
  const A = globalThis.PolycarpHubAdapter;
  const O = globalThis.PolycarpHubOrganize;
  const L = globalThis.PolycarpHubLater;
  const I = globalThis.PolycarpIcons;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  const PAGE = 200;
  const MADE_UP = "made-up";
  const VIEWS = {
    inbox: { name: "Inbox", folder: "inbox", fold: true },
    archive: { name: "Archive", folder: "archive" },
    sent: { name: "Sent", folder: "sent" },
    drafts: { name: "Drafts", drafts: true },
    search: { name: "Search", search: true },
    snoozed: { name: "Snoozed", snoozed: true }
  };
  for (const b of O.BUNDLES) VIEWS[b.id] = { name: b.name, folder: "inbox", bundle: b.id };

  const finder = globalThis.PolycarpHubSearch.live(S);
  const st = { view: "inbox", q: "", account: "", threads: [], more: false, opts: [], back: [], sel: -1, open: "", openSummary: null, loaded: 0, accounts: new Map(), undo: null };

  // ---------- Accounts ----------

  // Each stored account gets its adapter back from what it saved. Only the made-up account exists in this piece; real
  // ones arrive with their helpers.
  function adapterFor(rec) {
    if (rec.kind === "fake") return globalThis.PolycarpHubFake.create(Object.assign({ label: rec.label, address: rec.address }, rec.options));
    return null;
  }
  async function loadAccounts() {
    const list = await S.accounts();
    const keep = new Map();
    for (const rec of list) {
      const had = st.accounts.get(rec.id);
      keep.set(rec.id, had && had.rec.kind === rec.kind ? { rec, adapter: had.adapter } : { rec, adapter: adapterFor(rec) });
    }
    st.accounts = keep;
    if (st.account && !keep.has(st.account)) st.account = "";
  }
  async function pullAll() {
    for (const [id, a] of st.accounts) {
      if (!a.adapter) continue;
      try { await A.pull(id, a.adapter, S); } catch (e) { toast(a.rec.label + " didn't answer: " + e.message); }
    }
  }
  async function tryMadeUp() {
    await S.putAccount({ id: MADE_UP, kind: "fake", label: "Made-up mail", address: "me@home.example", route: "fake", options: { seed: 7, size: 240, now: Date.now() } });
    await loadAccounts();
    await pullAll();
    await refresh();
  }

  // ---------- The list ----------

  function when(ms) {
    const d = new Date(ms), now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: "short", day: "numeric" });
    return d.toLocaleDateString([], { year: "2-digit", month: "numeric", day: "numeric" });
  }
  // A time ahead, said in full: "Wed, Nov 26, 8:00 AM".
  const soon = (ms) => new Date(ms).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const who = (t) => (t.people && t.people.length ? t.people.map((p) => p.name || p.addr).join(", ") : (t.from && (t.from.name || t.from.addr)) || "Me");

  // Drafts list like threads: who they go to, the subject and the start of the text.
  const draftRow = (d) => ({ id: d.id, draft: true, by: d.by, account: d.account, subject: d.subject, people: d.to, lastDate: d.updated, snippet: d.text.slice(0, 160), unread: 0, count: 1 });

  const mine = (t) => !st.account || t.account === st.account;
  // What the current view shows, worked out without touching the page; refresh applies it only if nothing newer began.
  async function load() {
    const v = VIEWS[st.view];
    const now = Date.now();
    const one = (threads) => ({ threads, more: false, back: [] });
    if (v.snoozed) return one((await found("is:snoozed", 500)).filter((t) => L.sleeping(t, now) && mine(t)));
    if (v.drafts) return one((await S.drafts(st.account || undefined)).map(draftRow));
    if (v.search) return one(await found(st.q, 500));
    // A refresh keeps every page already shown.
    const q = { folder: v.folder, limit: Math.max(PAGE, st.loaded || 0) };
    if (st.account) q.account = st.account;
    let list = await S.threads(q);
    const more = list.length === q.limit;
    const loaded = list.length;
    if (v.bundle) list = list.filter((t) => O.bundleOf(t, decide) === v.bundle);
    // Snoozed mail is out of the inbox; what is back (a snooze over, a reply that never came) leads the inbox.
    const back = v.fold ? (await found("is:due", 200)).filter((t) => L.back(t, now) && mine(t)) : [];
    return { threads: back.concat(list.filter((t) => keepIn(v, t, now, back))), more, loaded, back };
  }
  const keepIn = (v, t, now, back) => !(v.folder === "inbox" && L.sleeping(t, now)) && !back.some((b) => b.id === t.id);
  async function loadMore() {
    const last = st.threads[st.threads.length - 1];
    if (!last) return;
    const v = VIEWS[st.view];
    const q = { folder: v.folder, limit: PAGE, before: S.after(last, v.folder === "sent") };
    if (st.account) q.account = st.account;
    let list = await S.threads(q);
    st.more = list.length === PAGE;
    st.loaded = (st.loaded || 0) + list.length;
    if (v.bundle) list = list.filter((t) => O.bundleOf(t, decide) === v.bundle);
    const now = Date.now();
    st.threads = st.threads.concat(list.filter((t) => keepIn(v, t, now, st.back)));
    render();
  }

  function row(t) {
    const o = el("div", "row" + (t.unread ? " unread" : ""));
    o.id = "t-" + t.id;
    o.setAttribute("role", "option");
    if (t.draft) o.dataset.draft = t.id; else o.dataset.thread = t.id;
    const name = t.draft ? (t.people.length ? "To " + who(t) : "No one yet") : who(t);
    const now = Date.now();
    const note = t.draft ? "" : L.back(t, now) ? L.why(t, now, when)
      : L.sleeping(t, now) ? "Until " + soon(t.snoozeUntil) : t.remindAt > now && L.yoursLast(t) ? "Back " + soon(t.remindAt) + " if no reply" : "";
    o.setAttribute("aria-label", [t.draft ? (t.by ? "Draft by an agent" : "Draft") : "", note, t.unread ? "Unread" : "", name, t.subject || "(no subject)", t.flagged ? "flagged" : "", t.count > 1 ? t.count + " messages" : "", when(t.lastDate)].filter(Boolean).join(", "));
    o.append(el("span", "dot"));
    const b = el("b", "", name + (t.count > 1 ? " (" + t.count + ")" : ""));
    o.append(b, el("span", "when", when(t.lastDate)));
    const s = el("span", "s", t.subject || "(no subject)");
    if (t.snippet) s.append(el("span", "muted", t.snippet));
    if (t.flagged) { const f = el("span", "flag"); f.innerHTML = I.icon("flag"); s.prepend(f); }
    if (t.draft) s.prepend(el("span", "tag", t.by ? "Agent's draft" : "Draft"));
    if (note) s.prepend(el("span", "tag", note));
    o.append(s);
    return o;
  }
  function bundleLine(list, group) {
    const line = el("div", "bundles");
    line.setAttribute("role", "presentation");
    for (const b of list) {
      const o = el("button");
      o.type = "button";
      o.id = "b-" + group + "-" + b.id;
      o.tabIndex = -1;
      o.setAttribute("role", "option");
      o.dataset.bundle = b.id;
      o.setAttribute("aria-label", b.name + ", " + b.count + (b.unread ? ", " + b.unread + " unread" : ""));
      o.append(b.name + " ", el("b", "", String(b.count)));
      line.append(o);
    }
    return line;
  }

  function render() {
    const v = VIEWS[st.view];
    $("where").textContent = v.search ? "Search: " + st.q : v.name;
    $("up").hidden = st.view === "inbox";
    const rows = $("rows");
    const keep = st.opts[st.sel] && st.opts[st.sel].id;
    rows.replaceChildren();
    const gs = O.groups(st.threads.slice(st.back.length), Date.now(), !!v.fold, decide);
    if (st.back.length) gs.unshift({ name: "Back now", threads: st.back, bundles: [] });
    gs.forEach((g, i) => {
      const grp = el("div");
      grp.setAttribute("role", "group");
      const h = el("div", "group", g.name);
      h.id = "g-" + i;
      grp.setAttribute("aria-labelledby", h.id);
      grp.append(h, ...g.threads.map(row));
      if (g.bundles.length) grp.append(bundleLine(g.bundles, i));
      rows.append(grp);
    });
    $("more").hidden = !st.more;
    st.opts = Array.from(rows.querySelectorAll('[role="option"]'));
    const at = keep ? st.opts.findIndex((o) => o.id === keep) : -1;
    select(at >= 0 ? at : Math.min(Math.max(st.sel, 0), st.opts.length - 1), false);
    const none = st.opts.length === 0;
    $("empty").hidden = !none;
    rows.hidden = none;
    $("tryFake").hidden = st.accounts.size > 0;
    $("emptyText").textContent = st.accounts.size
      ? (st.view === "inbox" ? "Nothing new. Everything here is read and put away." : v.search ? "No mail matches " + st.q + "." : v.snoozed ? "Nothing is snoozed." : "Nothing in " + v.name + ".")
      : "Accounts you add show their mail here, in one inbox, with people first.";
    renderAccounts();
  }

  function renderAccounts() {
    const box = $("accounts");
    box.hidden = st.accounts.size < 2;
    if (box.hidden) return;
    box.replaceChildren();
    const chip = (id, label) => {
      const b = el("button", "", label);
      b.type = "button";
      b.setAttribute("aria-pressed", String(st.account === id));
      b.addEventListener("click", () => { st.account = id; refresh(); });
      box.append(b);
    };
    chip("", "All");
    for (const [id, a] of st.accounts) chip(id, a.rec.label);
  }

  function select(i, scroll) {
    st.opts.forEach((o) => { o.classList.remove("sel"); o.setAttribute("aria-selected", "false"); });
    st.sel = st.opts.length ? Math.max(0, Math.min(i, st.opts.length - 1)) : -1;
    const o = st.opts[st.sel];
    if (!o) { $("rows").removeAttribute("aria-activedescendant"); return; }
    o.classList.add("sel");
    o.setAttribute("aria-selected", "true");
    $("rows").setAttribute("aria-activedescendant", o.id);
    if (scroll !== false) o.scrollIntoView({ block: "nearest" });
  }
  const selectedThread = () => { const o = st.opts[st.sel]; return o && o.dataset.thread ? st.threads.find((t) => t.id === o.dataset.thread) : null; };

  // A slow load begun before a view switch must not draw the old view under the new name, so only the newest counts.
  let loads = 0;
  async function refresh() {
    const n = ++loads;
    const got = await load();
    if (n !== loads) return;
    Object.assign(st, got);
    render();
    if (st.open && !compose.isOpen) {
      const got = await S.thread(st.open);
      if (got) paint(got); else closeThread(true);
    }
  }

  function go(view) {
    if (!VIEWS[view]) return;
    st.view = view;
    st.sel = 0;
    st.loaded = 0;
    refresh().then(() => $("rows").focus({ preventScroll: true }));
  }

  // ---------- A conversation ----------

  // HTML-only mail shows as plain text: DOMParser builds an inert document (no scripts run, nothing loads). Code and
  // styles are dropped, and blocks and line breaks become new lines.
  const BLOCK = /^(P|DIV|BR|LI|TR|H[1-6]|BLOCKQUOTE|PRE|TABLE|UL|OL|HR|SECTION|ARTICLE|HEADER|FOOTER)$/;
  function bodyText(m) {
    if (m.text) return m.text;
    if (!m.html) return "";
    const doc = new DOMParser().parseFromString(m.html, "text/html");
    doc.querySelectorAll("script,style,template,noscript,title,head").forEach((n) => n.remove());
    let out = "";
    const walk = (n) => {
      if (n.nodeType === 3) { out += n.nodeValue.replace(/\s+/g, " "); return; }
      if (n.nodeType !== 1) return;
      for (const c of n.childNodes) walk(c);
      if (BLOCK.test(n.tagName)) out += "\n";
    };
    walk(doc.body);
    return out.replace(/[ \t]*\n[ \t]*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  // HTML mail behind both walls of safe-html.js, with what was left out said plainly and a switch to its plain text.
  function htmlBody(m) {
    let shown;
    try { shown = globalThis.PolycarpHubSafeHtml.frame(m.html, "Message from " + (m.from.name || m.from.addr)); }
    catch (e) { return el("div", "body", bodyText(m)); }
    const box = el("div", "html");
    const bar = el("div", "hbar");
    const n = shown.blocked;
    bar.append(el("span", "", n ? (n === 1 ? "1 picture or style from the web was left out." : n + " pictures or styles from the web were left out.") : ""));
    const flip = el("button", "btn quiet", "Show as plain text");
    flip.type = "button";
    flip.addEventListener("click", () => {
      const plain = box.querySelector(".body");
      if (plain) { plain.remove(); shown.frame.hidden = false; flip.textContent = "Show as plain text"; return; }
      shown.frame.hidden = true;
      box.append(el("div", "body", bodyText(m)));
      flip.textContent = "Show it formatted";
    });
    bar.append(flip);
    box.append(bar);
    // Links whose text names one site but go to another, said here on the page, where the mail's CSS can't hide it.
    if (shown.misleading.length) {
      const warn = el("ul", "hwarn");
      warn.setAttribute("aria-label", "Links that go somewhere other than they say");
      for (const x of shown.misleading) warn.append(el("li", "", "A link that says " + x.named + " goes to " + x.real + "."));
      box.append(warn);
    }
    box.append(shown.frame);
    return box;
  }
  const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : n >= 1024 ? Math.round(n / 1024) + " KB" : n + " bytes");

  function paint(got) {
    const { summary: t, messages } = got;
    st.openSummary = t;
    const pane = $("pane");
    const wrap = el("article", "thread");
    wrap.setAttribute("aria-labelledby", "subject");
    const back = el("button", "back pane");
    back.type = "button";
    back.setAttribute("aria-label", "Back to " + VIEWS[st.view].name);
    back.innerHTML = I.icon("back");
    back.addEventListener("click", () => closeThread());
    const head = el("div", "th");
    const h = el("h2", "", t.subject || "(no subject)");
    h.id = "subject";
    h.tabIndex = -1;
    const acts = el("div", "acts");
    acts.setAttribute("role", "toolbar");
    acts.setAttribute("aria-label", "Conversation");
    const act = (icon, label, key, fn, pressed) => {
      const b = el("button");
      b.type = "button";
      b.innerHTML = I.icon(icon);
      b.setAttribute("aria-label", label);
      b.setAttribute("aria-keyshortcuts", key);
      b.title = label + " (" + key + ")";
      if (pressed != null) b.setAttribute("aria-pressed", String(pressed));
      b.addEventListener("click", fn);
      acts.append(b);
    };
    if (t.folder === "inbox") act("archive", "Archive", "E", () => archive(t));
    else if (t.folder !== "sent") act("mail", "Move to the inbox", "I", () => moveTo(t, "inbox"));
    act("flag", "Flag", "S", () => flag(t), !!t.flagged);
    if (t.folder === "inbox") act("clock", "Snooze", "H", () => openLater("snooze", t));
    if (L.yoursLast(t)) act("rotate", "Remind me if no reply", "W", () => openLater("remind", t));
    act("mail", t.unread ? "Mark read" : "Mark unread", "U", () => unread(t));
    head.append(h, acts);
    wrap.append(back, head);
    for (const m of messages) {
      const sec = el("section", "msg");
      const mh = el("div", "mh");
      const from = el("div");
      from.append(el("b", "", m.from.name || m.from.addr));
      if (m.from.name) from.append(" ", el("span", "addr", m.from.addr));
      const d = new Date(m.date);
      const time = el("time", "", d.toLocaleString([], d.getFullYear() === new Date().getFullYear()
        ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
        : { year: "numeric", month: "short", day: "numeric" }));
      time.dateTime = new Date(m.date).toISOString();
      mh.append(from, time);
      sec.append(mh);
      const to = (m.to || []).map((x) => x.name || x.addr).join(", ");
      if (to) sec.append(el("p", "to", "To " + to));
      sec.append(m.html ? htmlBody(m) : el("div", "body", bodyText(m)));
      if (m.attachments && m.attachments.length) {
        const files = el("div", "files");
        for (const f of m.attachments) {
          const b = el("button");
          b.type = "button";
          b.innerHTML = I.icon("download");
          b.append(" " + f.name + " (" + fmtSize(f.size || 0) + ")");
          b.setAttribute("aria-label", "Save " + f.name);
          b.addEventListener("click", () => save(m, f));
          files.append(b);
        }
        sec.append(files);
      }
      wrap.append(sec);
    }
    const rb = el("button", "btn primary reply");
    rb.type = "button";
    rb.innerHTML = I.icon("reply");
    rb.append(" Reply ", el("kbd", "", "R"));
    rb.setAttribute("aria-keyshortcuts", "R");
    rb.addEventListener("click", () => reply(t, messages));
    wrap.append(rb);
    pane.replaceChildren(wrap);
  }

  async function openThread(id, push) {
    const got = await S.thread(id);
    if (!got) return;
    st.open = id;
    paint(got);
    document.body.classList.add("reading");
    // History holds at most one conversation above the list, so Back always lands on the list.
    if (push !== false && history.state?.t !== id) {
      if (history.state?.t) history.replaceState({ t: id }, "", "#" + id); else history.pushState({ t: id }, "", "#" + id);
      st.pushed = true;
    }
    const narrow = matchMedia("(max-width: 760px)").matches;
    if (narrow) $("subject").focus();
    // Opening what came back is seeing it: it leaves Back now.
    if (L.back(got.summary, Date.now())) clearLater(got.messages);
    if (got.summary.unread) {
      const a = st.accounts.get(got.summary.account);
      const ids = got.messages.filter((m) => m.unread).map((m) => m.remoteId);
      if (a && a.adapter && ids.length) A.actions.markRead(a.rec.id, a.adapter, S, ids, true).catch((e) => toast("Couldn't mark it read: " + e.message));
    }
  }
  const hint = () => $("pane").replaceChildren(el("p", "hint", "Pick a conversation, or press J and K to move and Return to open."));
  function closeThread(quiet) {
    if (compose.isOpen) compose.close();
    st.open = "";
    document.body.classList.remove("reading");
    hint();
    if (!quiet && history.state?.t) {
      if (st.pushed) history.back(); else history.replaceState(null, "", location.pathname);
    }
    st.pushed = false;
    $("rows").focus({ preventScroll: true });
  }

  // ---------- Writing ----------

  // A reply goes to whoever wrote last, or, when that was you, to the people you wrote to. A draft already started
  // for this conversation opens again instead of a new one.
  async function reply(t, messages) {
    if (!messages) { const got = await S.thread(t.id); if (!got) return; messages = got.messages; }
    if (st.open !== t.id) await openThread(t.id);
    const box = document.querySelector("#pane .thread");
    if (!box) return;
    const old = (await S.drafts(t.account)).find((d) => d.threadId === t.id);
    if (old) return compose.open({ id: old.id }, box);
    const me = st.accounts.get(t.account)?.rec.address || "";
    const last = messages[messages.length - 1];
    const mine = last.folder === "sent" || last.from.addr === me;
    const to = mine ? last.to : (last.replyTo && last.replyTo.length ? last.replyTo : [last.from]);
    compose.open({ account: t.account, to, subject: /^re:/i.test(last.subject) ? last.subject : "Re: " + last.subject, replyTo: last.remoteId, threadId: t.id }, box);
  }
  function write() {
    const first = st.account || st.accounts.keys().next().value;
    if (!first) return toast("Add an account first, or try it with made-up mail.");
    if (st.open) closeThread(true);
    document.body.classList.add("reading");
    compose.open({ account: first }, $("pane"));
  }
  async function resume(id) {
    const d = await S.draft(id);
    if (!d) return;
    if (d.threadId && (await S.thread(d.threadId))) {
      await openThread(d.threadId);
      return compose.open({ id }, document.querySelector("#pane .thread"));
    }
    if (st.open) closeThread(true);
    document.body.classList.add("reading");
    compose.open({ id }, $("pane"));
  }
  function activate(o) {
    if (o.dataset.bundle) go(o.dataset.bundle);
    else if (o.dataset.draft) resume(o.dataset.draft);
    else openThread(o.dataset.thread);
  }

  const SEND_DELAY = 10000;
  const outbox = globalThis.PolycarpHubOutbox.create({
    delay: SEND_DELAY,
    adapterFor: (id) => st.accounts.get(id)?.adapter || null,
    onSent: () => { toast("Sent"); refresh(); },
    onFail: (d, e) => { toast("It didn't send, and it's still in Drafts: " + e.message); refresh(); }
  });
  const compose = globalThis.PolycarpMailCompose.init({
    accounts: () => st.accounts,
    toast,
    async send(id) {
      const r = await outbox.send(id);
      if (r.ok) {
        st.undo = async () => { if (outbox.undo(id)) await resume(id); else toast("It already went."); };
        toast("Sending in " + SEND_DELAY / 1000 + " seconds", true, SEND_DELAY);
      }
      return r;
    },
    closed() {
      if (!st.open) { document.body.classList.remove("reading"); hint(); $("rows").focus({ preventScroll: true }); }
      refresh();
    }
  });

  async function save(m, f) {
    const a = st.accounts.get(m.account);
    if (!a || !a.adapter) return;
    try {
      const got = await a.adapter.attachment(m.remoteId, f.id);
      const url = URL.createObjectURL(new Blob([got.bytes], { type: got.type || "application/octet-stream" }));
      const link = el("a");
      link.href = url;
      link.download = got.name || f.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) { toast("Couldn't save " + f.name + ": " + e.message); }
  }

  // ---------- Changes, each with an undo ----------

  async function idsIn(t, pick) {
    const got = await S.thread(t.id);
    return got ? got.messages.filter(pick).map((m) => m.remoteId) : [];
  }
  async function run(t, fn, done, undo) {
    const a = st.accounts.get(t.account);
    if (!a || !a.adapter) return toast("That account can't be changed from here yet.");
    try {
      await fn(a);
      st.undo = undo ? () => undo(a) : null;
      toast(done, !!undo);
    } catch (e) { toast("The account refused: " + e.message); }
    await refresh();
  }
  async function archive(t) {
    // Archiving what came back is done with it; one that only waited for a reply (in Sent) just leaves Back now.
    if (L.back(t, Date.now())) {
      const got = await S.thread(t.id);
      const r = got && (await clearLater(got.messages));
      if (r && t.folder !== "inbox") {
        if (st.open === t.id) closeThread();
        st.undo = () => S.restore(r.before, ["snoozeUntil", "remindAt"]);
        return toast("Done with it", true);
      }
    }
    const ids = await idsIn(t, (m) => m.folder === "inbox");
    if (!ids.length) return;
    if (st.open === t.id) closeThread();
    await run(t, (a) => A.actions.archive(a.rec.id, a.adapter, S, ids), "Archived", (a) => A.actions.move(a.rec.id, a.adapter, S, ids, "inbox"));
  }
  async function moveTo(t, folder) {
    // Only mail from others moves: your own stays in Sent.
    const ids = await idsIn(t, (m) => m.folder === t.folder && m.folder !== "sent" && m.folder !== folder);
    if (!ids.length) return;
    const from = t.folder;
    await run(t, (a) => A.actions.move(a.rec.id, a.adapter, S, ids, folder), "Moved to the inbox", (a) => A.actions.move(a.rec.id, a.adapter, S, ids, from));
  }
  async function flag(t) {
    const ids = await idsIn(t, () => true);
    const on = !t.flagged;
    await run(t, (a) => A.actions.flag(a.rec.id, a.adapter, S, ids, on), on ? "Flagged" : "Flag removed", (a) => A.actions.flag(a.rec.id, a.adapter, S, ids, !on));
  }
  async function unread(t) {
    const on = !t.unread;
    // Marking unread marks the newest message from someone else, or the newest at all when every one is yours.
    let ids = await idsIn(t, (m) => (on ? m.folder !== "sent" : m.unread));
    if (on && !ids.length) ids = await idsIn(t, () => true);
    await run(t, (a) => A.actions.markRead(a.rec.id, a.adapter, S, on ? ids.slice(-1) : ids, !on), on ? "Marked unread" : "Marked read", null);
  }
  async function undo() {
    const fn = st.undo;
    if (!fn) return;
    st.undo = null;
    try { await fn(); toast("Undone"); } catch (e) { toast("Couldn't undo: " + e.message); }
    await refresh();
  }

  // ---------- Later: snooze, and back if no one replies ----------

  const clearLater = (messages) => S.update(messages.map((m) => m.id), { snoozeUntil: 0, remindAt: 0 });
  async function later(t, kind, at) {
    const got = await S.thread(t.id);
    if (!got) return;
    const field = kind === "snooze" ? "snoozeUntil" : "remindAt";
    const r = await S.update(got.messages.map((m) => m.id), { [field]: at });
    if (kind === "snooze" && st.open === t.id) closeThread();
    st.undo = () => S.restore(r.before, [field]);
    toast(kind === "snooze" ? "Snoozed until " + soon(at) : "Back " + soon(at) + " if no one replies", true);
  }
  const pad = (n) => String(n).padStart(2, "0");
  const localValue = (ms) => { const d = new Date(ms); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()); };
  let laterFor = null;
  function openLater(kind, t) {
    if (!t || t.draft) return;
    if (kind === "snooze" && t.folder !== "inbox") return toast("Only mail in the inbox can be snoozed.");
    if (kind === "remind" && !L.yoursLast(t)) return toast("A reminder is for a conversation where you wrote last.");
    const now = Date.now();
    laterFor = { kind, t };
    $("laterTitle").textContent = kind === "snooze" ? "Snooze until" : "Remind me if no one replies";
    $("laterHelp").textContent = kind === "snooze"
      ? "It leaves the inbox and comes back at the top, under Back now. New mail in it brings it back sooner."
      : "If no one has answered by then, it comes back to the top of the inbox, under Back now.";
    const cs = kind === "snooze" ? L.snoozeChoices(now) : L.remindChoices(now);
    $("laterChoices").replaceChildren(...cs.map((c, i) => {
      const b = el("button", "btn");
      b.type = "button";
      b.setAttribute("aria-keyshortcuts", String(i + 1));
      b.append(el("kbd", "", String(i + 1)), " " + c.label + " ", el("span", "muted", soon(c.at)));
      b.addEventListener("click", () => pickLater(c.at));
      return b;
    }));
    $("laterAt").value = "";
    $("laterAt").min = localValue(now);
    $("laterAt").removeAttribute("aria-invalid");
    $("laterErr").textContent = "";
    $("later").showModal();
    $("laterChoices").firstChild.focus();
  }
  function pickLater(at) {
    const f = laterFor;
    laterFor = null;
    $("later").close();
    if (f) later(f.t, f.kind, at);
  }
  function setLater(e) {
    e.preventDefault();
    const at = L.picked($("laterAt").value, Date.now());
    if (at) return pickLater(at);
    $("laterErr").textContent = "Pick a day and time after now.";
    $("laterAt").setAttribute("aria-invalid", "true");
    $("laterAt").focus();
  }
  // Each minute: when something has come back since the list was drawn, draw it again.
  async function wake() {
    if (!VIEWS[st.view].fold) return;
    const now = Date.now();
    const ids = (list) => list.map((t) => t.id).sort().join();
    if (ids((await found("is:due", 200)).filter((t) => L.back(t, now) && mine(t))) !== ids(st.back)) refresh();
  }

  let toastTimer = 0;
  function toast(text, canUndo, ms) {
    $("toastText").textContent = text;
    $("toastUndo").hidden = !canUndo;
    $("toast").hidden = false;
    // An undo lasts only while it is offered on screen.
    if (!canUndo) st.undo = null;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $("toast").hidden = true; st.undo = null; }, ms || (canUndo ? 8000 : 4000));
  }

  // ---------- Rules ----------

  const R = globalThis.PolycarpHubRules;
  const rules = { text: "", saved: 0, list: [] };
  const decide = (t) => R.bundleFor(rules.list, t);
  async function loadRules() {
    const r = await S.getMeta("rules");
    rules.text = r ? r.text : "";
    rules.saved = r ? r.saved : 0;
    rules.list = R.parse(rules.text).rules;
  }
  // Mark read, flag and archive, for mail that arrived after the rules were saved, through the account like a key press.
  // Arrival is a pull past an account's cursor: its first pull brings mail that was already there, and is skipped.
  const DOES = [["read", "mark it read", (ad, id, a, ids) => A.actions.markRead(id, ad, S, ids, true)],
    ["flag", "flag it", (ad, id, a, ids) => A.actions.flag(id, ad, S, ids, true)],
    ["archive", "archive it", (ad, id, a, ids) => A.actions.archive(id, ad, S, ids)]];
  async function applyRules(ids) {
    await loadRules(); // another page may have saved newer rules
    const plan = new Map();
    for (const id of ids) {
      const m = await S.message(id);
      if (!m || m.folder === "sent") continue;
      const does = R.actionsFor(rules.list, m);
      for (const [kind] of DOES) {
        if (!does[kind] || (kind === "archive" && m.folder !== "inbox") || (kind === "read" && !m.unread) || (kind === "flag" && m.flagged)) continue;
        const key = m.account + "\n" + kind;
        if (!plan.has(key)) plan.set(key, []);
        plan.get(key).push(m.remoteId);
      }
    }
    for (const [kind, words, fn] of DOES) {
      for (const [key, remote] of plan) {
        const [account, k] = key.split("\n");
        const a = st.accounts.get(account);
        if (k !== kind || !a || !a.adapter) continue;
        try { await fn(a.adapter, account, a, remote); } catch (e) { toast("A rule couldn't " + words + ": " + e.message); }
      }
    }
  }
  function showRuleErrors() {
    const { errors } = R.parse($("rulesText").value);
    $("rulesErr").replaceChildren(...errors.map((e) => el("li", "", "Line " + e.line + ": " + e.why + ".")));
    $("rulesText").setAttribute("aria-invalid", String(errors.length > 0));
    return errors;
  }
  function openRules() {
    $("rulesText").value = rules.text || R.EXAMPLE;
    showRuleErrors();
    $("rules").showModal();
    $("rulesText").focus();
  }
  async function saveRules(e) {
    e.preventDefault();
    if (showRuleErrors().length) { $("rulesText").focus(); return; }
    const text = $("rulesText").value;
    await S.setMeta("rules", { text, saved: Date.now() });
    await loadRules();
    $("rules").close();
    toast(rules.list.length === 1 ? "1 rule saved" : rules.list.length + " rules saved");
    await refresh();
  }

  // ---------- The command bar ----------

  const cmd = { items: [], sel: 0 };
  function commands() {
    const list = [
      { label: "Go to the inbox", key: "G I", run: () => go("inbox") },
      { label: "Go to Archive", key: "G A", run: () => go("archive") },
      { label: "Go to Sent", key: "G S", run: () => go("sent") },
      { label: "Go to Drafts", key: "G D", run: () => go("drafts") },
      { label: "Go to Snoozed", key: "G H", run: () => go("snoozed") },
      { label: "Write a message", key: "C", run: write },
      { label: "Reply", key: "R", run: () => { const t = current(); if (t) reply(t); } },
      ...O.BUNDLES.map((b) => ({ label: "Open " + b.name, key: "", run: () => go(b.id) })),
      { label: "Check for new mail", key: "", run: () => pullAll().then(refresh) },
      { label: "Edit rules", key: "", run: openRules },
      { label: "Move down, move up", key: "J K", run: () => {} },
      { label: "Open the conversation", key: "Return", run: () => {} },
      { label: "Archive", key: "E", run: () => { const t = current(); if (t) archive(t); } },
      { label: "Flag", key: "S", run: () => { const t = current(); if (t) flag(t); } },
      { label: "Mark read or unread", key: "U", run: () => { const t = current(); if (t) unread(t); } },
      { label: "Snooze", key: "H", run: () => openLater("snooze", current()) },
      { label: "Remind me if no reply", key: "W", run: () => openLater("remind", current()) },
      { label: "Undo", key: "Z", run: undo }
    ];
    if (!st.accounts.has(MADE_UP)) list.push({ label: "Try it with made-up mail", key: "", run: tryMadeUp });
    else list.push({ label: "Remove the made-up mail", key: "", run: () => S.removeAccount(MADE_UP).then(loadAccounts).then(() => { closeThread(true); return refresh(); }) });
    return list;
  }
  // Threads that match a search, newest first, from the index over every message.
  async function found(q, limit) {
    const hits = await finder.query(q, { limit });
    return (await Promise.all(hits.map((h) => S.summary(h.threadId)))).filter(Boolean);
  }
  function searchFor(q) {
    st.q = q;
    if (st.open) closeThread(true);
    if (st.view === "search") { st.sel = 0; refresh(); } else go("search");
  }
  async function search(q) {
    const list = await found(q, 8);
    const rows = list.map((t) => ({ label: who(t) + ": " + (t.subject || "(no subject)"), key: when(t.lastDate), run: () => openThread(t.id) }));
    return [{ label: list.length ? "Show every match for " + q : "No mail matches " + q, key: "", run: () => searchFor(q) }].concat(rows);
  }
  // Commands show at once; search results follow, and are dropped if the text changed while they were found.
  let asked = 0;
  async function fillCmd() {
    const q = $("cmdIn").value.trim();
    const n = ++asked;
    const cs = commands().filter((c) => !q || c.label.toLowerCase().includes(q.toLowerCase()));
    showCmd(cs);
    if (!q) return;
    if (finder.building) showCmd(cs.concat([{ label: "Search is still reading your mail. Matches follow in a moment.", key: "", run: () => {} }]), true);
    const hits = await search(q);
    if (n === asked) showCmd(cs.concat(hits), true);
  }
  function showCmd(items, keep) {
    cmd.items = items;
    if (!keep) cmd.sel = 0;
    const ul = $("cmdList");
    ul.replaceChildren();
    cmd.items.forEach((c, i) => {
      const li = el("li");
      li.id = "c-" + i;
      li.setAttribute("role", "option");
      li.append(el("span", "", c.label));
      if (c.key) li.append(el("small", "", c.key));
      li.addEventListener("click", () => pick(i));
      ul.append(li);
    });
    markCmd();
  }
  function markCmd() {
    const lis = $("cmdList").children;
    for (let i = 0; i < lis.length; i++) lis[i].setAttribute("aria-selected", String(i === cmd.sel));
    if (lis[cmd.sel]) { $("cmdIn").setAttribute("aria-activedescendant", lis[cmd.sel].id); lis[cmd.sel].scrollIntoView({ block: "nearest" }); }
    else $("cmdIn").removeAttribute("aria-activedescendant");
  }
  function pick(i) {
    const c = cmd.items[i];
    $("cmd").close();
    if (c) c.run();
  }
  function openCmd(text) {
    $("cmdIn").value = text || "";
    $("cmd").showModal();
    fillCmd();
  }

  // ---------- Keys ----------

  // The open conversation when one is open (even one found by search outside this list), else the highlighted row.
  const current = () => (st.open ? (st.openSummary && st.openSummary.id === st.open ? st.openSummary : null) : selectedThread());
  let gPending = 0;
  function onKey(e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openCmd(); return; }
    if ($("cmd").open || $("rules").open || $("later").open || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return;
    const k = e.key;
    if (gPending) {
      clearTimeout(gPending);
      gPending = 0;
      const to = { i: "inbox", a: "archive", s: "sent", d: "drafts", h: "snoozed" }[k];
      if (to) { e.preventDefault(); go(to); }
      return;
    }
    const t = current();
    const handled = (() => {
      switch (k) {
        case "j": case "ArrowDown": select(st.sel + 1); return true;
        case "k": case "ArrowUp": select(st.sel - 1); return true;
        case "Home": select(0); return true;
        case "End": select(st.opts.length - 1); return true;
        case "Enter": case "o": {
          if (e.target.tagName === "BUTTON") return false;
          const o = st.opts[st.sel];
          if (!o) return false;
          activate(o);
          return true;
        }
        case "r": if (t && !t.draft) reply(t); return !!t;
        case "c": write(); return true;
        case "e": if (t && (t.folder === "inbox" || L.back(t, Date.now()))) archive(t); return !!t;
        case "i": if (t && t.folder !== "inbox") moveTo(t, "inbox"); return !!t;
        case "s": if (t) flag(t); return !!t;
        case "u": if (t) unread(t); return !!t;
        case "h": openLater("snooze", t); return !!t;
        case "w": openLater("remind", t); return !!t;
        case "z": undo(); return true;
        case "g": gPending = setTimeout(() => { gPending = 0; }, 1200); return true;
        case "/": openCmd(); return true;
        case "?": openCmd(""); return true;
        case "Escape":
          if (st.open) { closeThread(); return true; }
          if (st.view !== "inbox") { go("inbox"); return true; }
          return false;
        default: return false;
      }
    })();
    if (handled) e.preventDefault();
  }

  // ---------- Wiring ----------

  function wire() {
    $("boxIcon").innerHTML = I.icon("search");
    $("up").innerHTML = I.icon("back");
    $("up").addEventListener("click", () => go("inbox"));
    $("openCmd").addEventListener("click", () => openCmd());
    $("write").innerHTML = I.icon("pen") + "<span>Write</span>";
    $("write").addEventListener("click", write);
    $("tryFake").addEventListener("click", tryMadeUp);
    $("more").addEventListener("click", loadMore);
    $("toastUndo").addEventListener("click", undo);
    $("rows").addEventListener("click", (e) => {
      const o = e.target.closest('[role="option"]');
      if (!o) return;
      select(st.opts.indexOf(o), false);
      activate(o);
    });
    $("cmdIn").addEventListener("input", fillCmd);
    $("cmdIn").addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { cmd.sel = Math.min(cmd.sel + 1, cmd.items.length - 1); markCmd(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { cmd.sel = Math.max(cmd.sel - 1, 0); markCmd(); e.preventDefault(); }
      else if (e.key === "Enter") { e.preventDefault(); pick(cmd.sel); }
    });
    $("cmd").addEventListener("click", (e) => { if (e.target === $("cmd")) $("cmd").close(); });
    document.addEventListener("keydown", onKey);
    addEventListener("popstate", (e) => {
      if (e.state && e.state.t) openThread(e.state.t, false); else if (st.open) closeThread(true);
    });
    $("rulesForm").addEventListener("submit", saveRules);
    $("rulesText").addEventListener("input", showRuleErrors);
    $("rulesText").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveRules(e); });
    $("rulesCancel").addEventListener("click", () => $("rules").close());
    $("laterForm").addEventListener("submit", setLater);
    $("laterCancel").addEventListener("click", () => $("later").close());
    $("later").addEventListener("close", () => { laterFor = null; });
    $("later").addEventListener("keydown", (e) => {
      const b = /^[1-9]$/.test(e.key) && e.target.tagName !== "INPUT" && $("laterChoices").children[+e.key - 1];
      if (b) { e.preventDefault(); b.click(); }
    });
    let pending = 0;
    S.onChange((ev) => {
      // Only the page whose pull stored the mail acts on it, so two open pages don't both change the account.
      if (ev && ev.local && !ev.first && ev.added && ev.added.length) applyRules(ev.added);
      clearTimeout(pending);
      pending = setTimeout(refresh, 120);
    });
    // Closing the page during the wait asks first; if it closes anyway, the send finishes when Mail opens again.
    addEventListener("beforeunload", (e) => { if (outbox.size) { e.preventDefault(); e.returnValue = ""; } });
  }

  async function start() {
    if (history.state?.t) history.replaceState(null, "", location.pathname);
    wire();
    await S.open();
    await loadAccounts();
    await loadRules();
    await refresh();
    // The search index builds now, a chunk at a time, so the first search doesn't wait to read every message.
    finder.warm().catch(() => {});
    // A send that was waiting when the page last closed goes now, or waits out what is left of its 10 seconds.
    const left = await outbox.resume();
    if (left.waiting.length) {
      const id = left.waiting[0];
      st.undo = async () => { if (outbox.undo(id)) await resume(id); else toast("It already went."); };
      toast(left.waiting.length === 1 ? "A message you sent is still waiting to go" : left.waiting.length + " messages you sent are still waiting to go", true, SEND_DELAY);
    } else if (left.sent.length) {
      toast(left.sent.length === 1 ? "A message you sent before the page closed has gone" : left.sent.length + " messages you sent before the page closed have gone");
    }
    await pullAll();
    $("rows").focus({ preventScroll: true });
    setInterval(() => { if (!document.hidden) pullAll().then(wake); }, 60000);
  }
  start().catch((e) => toast("The mail store didn't open: " + e.message));
})();
