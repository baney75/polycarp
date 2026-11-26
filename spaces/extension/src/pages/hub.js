/* Polycarp Mail: the list, the open conversation, the keys and the command bar, over the Hub's local store. Mail text
   reaches the page only through textContent; HTML mail is shown as its text here (the sanitized view comes later). */
(function () {
  "use strict";
  const S = globalThis.PolycarpHubStore;
  const A = globalThis.PolycarpHubAdapter;
  const O = globalThis.PolycarpHubOrganize;
  const I = globalThis.PolycarpIcons;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  const PAGE = 200;
  const MADE_UP = "made-up";
  const VIEWS = {
    inbox: { name: "Inbox", folder: "inbox", fold: true },
    archive: { name: "Archive", folder: "archive" },
    sent: { name: "Sent", folder: "sent" },
    drafts: { name: "Drafts", drafts: true }
  };
  for (const b of O.BUNDLES) VIEWS[b.id] = { name: b.name, folder: "inbox", bundle: b.id };

  const st = { view: "inbox", account: "", threads: [], more: false, opts: [], sel: -1, open: "", openSummary: null, loaded: 0, accounts: new Map(), undo: null };

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
  const who = (t) => (t.people && t.people.length ? t.people.map((p) => p.name || p.addr).join(", ") : (t.from && (t.from.name || t.from.addr)) || "Me");

  // Drafts list like threads: who they go to, the subject and the start of the text.
  const draftRow = (d) => ({ id: d.id, draft: true, by: d.by, account: d.account, subject: d.subject, people: d.to, lastDate: d.updated, snippet: d.text.slice(0, 160), unread: 0, count: 1 });

  async function load() {
    const v = VIEWS[st.view];
    if (v.drafts) {
      st.threads = (await S.drafts(st.account || undefined)).map(draftRow);
      st.more = false;
      return;
    }
    // A refresh keeps every page already shown.
    const q = { folder: v.folder, limit: Math.max(PAGE, st.loaded || 0) };
    if (st.account) q.account = st.account;
    let list = await S.threads(q);
    st.more = list.length === q.limit;
    st.loaded = list.length;
    if (v.bundle) list = list.filter((t) => O.bundleOf(t) === v.bundle);
    st.threads = list;
  }
  async function loadMore() {
    const last = st.threads[st.threads.length - 1];
    if (!last) return;
    const v = VIEWS[st.view];
    const q = { folder: v.folder, limit: PAGE, before: S.after(last, v.folder === "sent") };
    if (st.account) q.account = st.account;
    let list = await S.threads(q);
    st.more = list.length === PAGE;
    st.loaded = (st.loaded || 0) + list.length;
    if (v.bundle) list = list.filter((t) => O.bundleOf(t) === v.bundle);
    st.threads = st.threads.concat(list);
    render();
  }

  function row(t) {
    const o = el("div", "row" + (t.unread ? " unread" : ""));
    o.id = "t-" + t.id;
    o.setAttribute("role", "option");
    if (t.draft) o.dataset.draft = t.id; else o.dataset.thread = t.id;
    const name = t.draft ? (t.people.length ? "To " + who(t) : "No one yet") : who(t);
    o.setAttribute("aria-label", [t.draft ? (t.by ? "Draft by an agent" : "Draft") : "", t.unread ? "Unread" : "", name, t.subject || "(no subject)", t.flagged ? "flagged" : "", t.count > 1 ? t.count + " messages" : "", when(t.lastDate)].filter(Boolean).join(", "));
    o.append(el("span", "dot"));
    const b = el("b", "", name + (t.count > 1 ? " (" + t.count + ")" : ""));
    o.append(b, el("span", "when", when(t.lastDate)));
    const s = el("span", "s", t.subject || "(no subject)");
    if (t.snippet) s.append(el("span", "muted", t.snippet));
    if (t.flagged) { const f = el("span", "flag"); f.innerHTML = I.icon("flag"); s.prepend(f); }
    if (t.draft) s.prepend(el("span", "tag", t.by ? "Agent's draft" : "Draft"));
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
    $("where").textContent = v.name;
    $("up").hidden = st.view === "inbox";
    const rows = $("rows");
    const keep = st.opts[st.sel] && st.opts[st.sel].id;
    rows.replaceChildren();
    const gs = O.groups(st.threads, Date.now(), !!v.fold);
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
      ? (st.view === "inbox" ? "Nothing new. Everything here is read and put away." : "Nothing in " + v.name + ".")
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

  async function refresh() {
    await load();
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
      sec.append(el("div", "body", bodyText(m)));
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

  // ---------- The command bar ----------

  const cmd = { items: [], sel: 0 };
  function commands() {
    const list = [
      { label: "Go to the inbox", key: "G I", run: () => go("inbox") },
      { label: "Go to Archive", key: "G A", run: () => go("archive") },
      { label: "Go to Sent", key: "G S", run: () => go("sent") },
      { label: "Go to Drafts", key: "G D", run: () => go("drafts") },
      { label: "Write a message", key: "C", run: write },
      { label: "Reply", key: "R", run: () => { const t = current(); if (t) reply(t); } },
      ...O.BUNDLES.map((b) => ({ label: "Open " + b.name, key: "", run: () => go(b.id) })),
      { label: "Check for new mail", key: "", run: () => pullAll().then(refresh) },
      { label: "Move down, move up", key: "J K", run: () => {} },
      { label: "Open the conversation", key: "Return", run: () => {} },
      { label: "Archive", key: "E", run: () => { const t = current(); if (t) archive(t); } },
      { label: "Flag", key: "S", run: () => { const t = current(); if (t) flag(t); } },
      { label: "Mark read or unread", key: "U", run: () => { const t = current(); if (t) unread(t); } },
      { label: "Undo", key: "Z", run: undo }
    ];
    if (!st.accounts.has(MADE_UP)) list.push({ label: "Try it with made-up mail", key: "", run: tryMadeUp });
    else list.push({ label: "Remove the made-up mail", key: "", run: () => S.removeAccount(MADE_UP).then(loadAccounts).then(() => { closeThread(true); return refresh(); }) });
    return list;
  }
  async function search(q) {
    const needle = q.toLowerCase();
    const all = await S.allThreads();
    return all
      .filter((t) => (t.subject + " " + who(t) + " " + (t.snippet || "")).toLowerCase().includes(needle))
      .sort((a, b) => b.lastDate - a.lastDate)
      .slice(0, 20)
      .map((t) => ({ label: who(t) + ": " + (t.subject || "(no subject)"), key: when(t.lastDate), run: () => openThread(t.id) }));
  }
  // Commands show at once; search results follow, and are dropped if the text changed while they were found.
  let asked = 0;
  async function fillCmd() {
    const q = $("cmdIn").value.trim();
    const n = ++asked;
    const cs = commands().filter((c) => !q || c.label.toLowerCase().includes(q.toLowerCase()));
    showCmd(cs);
    if (!q) return;
    const found = await search(q);
    if (n === asked) showCmd(cs.concat(found), true);
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
    if ($("cmd").open || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return;
    const k = e.key;
    if (gPending) {
      clearTimeout(gPending);
      gPending = 0;
      const to = { i: "inbox", a: "archive", s: "sent", d: "drafts" }[k];
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
        case "e": if (t && t.folder === "inbox") archive(t); return !!t;
        case "i": if (t && t.folder !== "inbox") moveTo(t, "inbox"); return !!t;
        case "s": if (t) flag(t); return !!t;
        case "u": if (t) unread(t); return !!t;
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
    let pending = 0;
    S.onChange(() => { clearTimeout(pending); pending = setTimeout(refresh, 120); });
  }

  async function start() {
    if (history.state?.t) history.replaceState(null, "", location.pathname);
    wire();
    await S.open();
    await loadAccounts();
    await refresh();
    await pullAll();
    $("rows").focus({ preventScroll: true });
    setInterval(() => { if (!document.hidden) pullAll(); }, 60000);
  }
  start().catch((e) => toast("The mail store didn't open: " + e.message));
})();
