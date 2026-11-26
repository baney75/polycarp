/* Polycarp Hub outbox: undo send. A send waits `delay` ms before it goes to the account; until then it can be taken
   back and the draft is untouched. The draft is deleted only after the account takes the message, so a refusal or a
   closed page leaves it a draft. Nothing here sends on its own: every send starts from the person's own action.
   Classic script for extension pages and Node tests. */
(function () {
  "use strict";

  function create(o) {
    const opts = Object.assign({ delay: 10000, setTimer: (f, ms) => setTimeout(f, ms), clearTimer: (t) => clearTimeout(t) }, o);
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
      const sendAt = Date.now() + opts.delay;
      pending.set(id, opts.setTimer(() => fire(id), opts.delay));
      return { ok: true, sendAt };
    }

    async function fire(id) {
      if (!pending.has(id)) return;
      pending.delete(id);
      const d = await S.draft(id);
      const ad = d && opts.adapterFor(d.account);
      try {
        if (!ad) throw new Error(problem(d) || "no account");
        const body = { to: d.to, cc: d.cc, bcc: d.bcc, subject: d.subject, text: d.text };
        const r = d.replyTo ? await ad.reply(d.replyTo, body) : await ad.send(body);
        await S.deleteDraft(id);
        try { await A.pull(d.account, ad, S); } catch (e) { /* the next pull brings the sent copy */ }
        if (opts.onSent) opts.onSent(d, r);
      } catch (e) {
        if (opts.onFail) opts.onFail(d, e);
      }
    }

    // Takes a waiting send back. True when it was still waiting.
    function undo(id) {
      if (!pending.has(id)) return false;
      opts.clearTimer(pending.get(id));
      pending.delete(id);
      return true;
    }

    return { send, undo, waiting: (id) => pending.has(id), get size() { return pending.size; } };
  }

  globalThis.PolycarpHubOutbox = { create };
})();
