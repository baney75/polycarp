/* Polycarp Hub outbox: undo send. A send waits `delay` ms before it goes to the account; until then it can be taken
   back and the draft is untouched. When it goes is written on the draft, so a page closed or reloaded during the wait
   finishes the send when Mail opens again (`resume`), and two open pages send it once: each send runs under a lock
   and goes only if the draft still says it should. The draft is deleted only after the account takes the message,
   so a refusal leaves it a draft, with no send waiting. Nothing here sends on its own: every send starts from the
   person's own Send. Classic script for extension pages and Node tests. */
(function () {
  "use strict";

  function create(o) {
    const locks = globalThis.navigator && globalThis.navigator.locks;
    const opts = Object.assign({
      delay: 10000, now: () => Date.now(), setTimer: (f, ms) => setTimeout(f, ms), clearTimer: (t) => clearTimeout(t),
      lock: locks ? (name, fn) => locks.request(name, fn) : (name, fn) => fn()
    }, o);
    const S = opts.store || globalThis.PolycarpHubStore;
    const A = globalThis.PolycarpHubAdapter;
    const pending = new Map();

    function problem(d) {
      if (!d) return "That draft is gone.";
      if (!d.to.length && !d.cc.length && !d.bcc.length) return "Add someone to send it to.";
      if (!opts.adapterFor(d.account)) return "That account can't send from here yet.";
      return "";
    }

    // Starts the wait. Answers {ok, sendAt} or {ok: false, why}.
    async function send(id) {
      if (pending.has(id)) return { ok: false, why: "It's already on its way." };
      const d = await S.draft(id);
      const why = problem(d);
      if (why) return { ok: false, why };
      const sendAt = opts.now() + opts.delay;
      await S.setSendAt(id, sendAt);
      arm(id, opts.delay);
      return { ok: true, sendAt };
    }
    const arm = (id, ms) => pending.set(id, opts.setTimer(() => fire(id), Math.max(0, ms)));

    async function fire(id) {
      if (!pending.has(id)) return;
      pending.delete(id);
      await go(id);
    }
    // Sends it if the draft still says to: taken back, changed or sent by another page, it says 0 or is gone.
    function go(id) {
      return opts.lock("polycarp-hub-send:" + id, async () => {
        const d = await S.draft(id);
        if (!d || !(d.sendAt > 0)) return false;
        const ad = opts.adapterFor(d.account);
        try {
          if (!ad) throw new Error(problem(d) || "no account");
          const body = { to: d.to, cc: d.cc, bcc: d.bcc, subject: d.subject, text: d.text };
          const r = d.replyTo ? await ad.reply(d.replyTo, body) : await ad.send(body);
          await S.deleteDraft(id);
          try { await A.pull(d.account, ad, S); } catch (e) { /* the next pull brings the sent copy */ }
          if (opts.onSent) opts.onSent(d, r);
          return true;
        } catch (e) {
          await S.setSendAt(id, 0);
          if (opts.onFail) opts.onFail(d, e);
          return false;
        }
      });
    }

    // Takes a waiting send back. True when it was still waiting here.
    function undo(id) {
      if (!pending.has(id)) return false;
      opts.clearTimer(pending.get(id));
      pending.delete(id);
      S.setSendAt(id, 0);
      return true;
    }

    // Sends left waiting by a page that closed: those whose time has passed go now, the rest wait out what is left.
    // Answers {sent: [ids sent now], waiting: [ids still waiting]}.
    async function resume() {
      const now = opts.now();
      const due = [];
      const waiting = [];
      for (const d of await S.drafts()) {
        if (!(d.sendAt > 0) || pending.has(d.id)) continue;
        if (d.sendAt <= now) due.push(d.id);
        else { arm(d.id, d.sendAt - now); waiting.push(d.id); }
      }
      const sent = [];
      for (const id of due) if (await go(id)) sent.push(id);
      return { sent, waiting };
    }

    return { send, undo, resume, waiting: (id) => pending.has(id), get size() { return pending.size; } };
  }

  globalThis.PolycarpHubOutbox = { create };
})();
