/* Polycarp Mail composer: new mail in the conversation pane, a reply under its conversation. Every keystroke is kept
   as a draft in the Hub's store; Send starts the outbox's wait, so the toast can take it back. A draft an agent wrote
   says so above the text, and only the person's own Send sends it. */
(function () {
  "use strict";
  const S = globalThis.PolycarpHubStore;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const list = (as) => (as || []).map((a) => (a.name ? '"' + a.name.replace(/"/g, "") + '" <' + a.addr + ">" : a.addr)).join(", ");
  let n = 0;

  // ctx: { accounts() -> Map(id -> {rec}), send(draftId) -> Promise, toast(text), closed() }
  function init(ctx) {
    let live = null;

    function field(form, label, name, value, type) {
      const id = "cf-" + name + "-" + (++n);
      const row = el("div", "cf");
      const l = el("label", "", label);
      l.htmlFor = id;
      const inp = el(type === "area" ? "textarea" : "input");
      inp.id = id;
      inp.name = name;
      if (type !== "area") inp.type = "text";
      inp.value = value || "";
      inp.autocomplete = "off";
      row.append(l, inp);
      form.append(row);
      return inp;
    }

    // Opens a draft: {id} to resume one, or {account, to, subject, text, replyTo, threadId} to start one. `into` is the
    // element the form goes in; a reply passes its conversation, new mail passes the pane.
    async function open(start, into) {
      close(true);
      const d = start.id ? await S.draft(start.id) : await S.saveDraft(start);
      if (!d) return ctx.toast("That draft is gone.");
      const accounts = ctx.accounts();
      const form = el("form", "compose");
      form.setAttribute("aria-label", d.replyTo ? "Reply" : "New message");
      form.noValidate = true;
      if (!d.replyTo) form.append(el("h2", "", "New message"));
      if (d.by) {
        const note = el("p", "agent", "An agent wrote this draft. Read it all before you send it.");
        note.setAttribute("role", "note");
        form.append(note);
      }
      let from = null;
      if (!d.replyTo && accounts.size > 1) {
        const row = el("div", "cf");
        const l = el("label", "", "From");
        from = el("select");
        from.id = l.htmlFor = "cf-from-" + (++n);
        for (const [id, a] of accounts) { const o = el("option", "", a.rec.label + (a.rec.address ? " (" + a.rec.address + ")" : "")); o.value = id; from.append(o); }
        from.value = d.account;
        row.append(l, from);
        form.append(row);
      }
      const to = field(form, "To", "to", list(d.to));
      const cc = field(form, "Cc", "cc", list(d.cc));
      const subject = field(form, "Subject", "subject", d.subject);
      if (d.replyTo) subject.closest(".cf").hidden = true;
      const text = field(form, d.replyTo ? "Your reply" : "Message", "text", d.text, "area");
      text.rows = d.replyTo ? 6 : 12;
      const bar = el("div", "cbar");
      const send = el("button", "btn primary", "Send");
      send.type = "submit";
      send.setAttribute("aria-keyshortcuts", "Meta+Enter Control+Enter");
      send.title = "Send (Command Return)";
      const drop = el("button", "btn quiet", "Discard");
      drop.type = "button";
      const saved = el("span", "saved");
      saved.setAttribute("role", "status");
      bar.append(send, drop, saved);
      form.append(bar);

      let timer = 0;
      const keep = () => S.saveDraft({ id: d.id, account: from ? from.value : d.account, to: to.value, cc: cc.value, subject: subject.value, text: text.value, replyTo: d.replyTo, threadId: d.threadId })
        .then(() => { saved.textContent = "Draft saved"; });
      form.addEventListener("input", () => { saved.textContent = ""; clearTimeout(timer); timer = setTimeout(keep, 500); });
      form.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); form.requestSubmit(); }
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
      });
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        clearTimeout(timer);
        await keep();
        const r = await ctx.send(d.id);
        if (r && r.ok) close(true);
        else { ctx.toast((r && r.why) || "It didn't send."); to.focus(); }
      });
      drop.addEventListener("click", async () => { clearTimeout(timer); await S.deleteDraft(d.id); close(true); ctx.toast("Draft discarded"); });

      if (into.classList.contains("thread")) into.append(form); else into.replaceChildren(form);
      live = { form, flush: () => { clearTimeout(timer); return keep(); } };
      (d.replyTo || to.value ? text : to).focus();
      form.scrollIntoView({ block: "nearest" });
    }

    // Closes the open form; the draft stays unless `sent` (it was sent or discarded).
    function close(sent) {
      if (!live) return;
      const was = live;
      live = null;
      if (!sent) was.flush();
      was.form.remove();
      ctx.closed(!!sent);
    }

    return { open, close, get isOpen() { return !!live; } };
  }

  globalThis.PolycarpMailCompose = { init };
})();
