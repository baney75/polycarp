/* Polycarp Hub accounts: the one interface every account route implements, a check that an adapter has it, and the
   pull that brings an account's changes into the store. Classic script; needs store.js. */
(function () {
  "use strict";

  // Every adapter answers these, each async. `remoteIds` are the account's own message ids.
  //   info()                      -> {kind, label, address, route}
  //   list()                      -> [{id, name, role}] folders or labels; role is one of the model's FOLDERS or ""
  //   threads({folder, limit})    -> raw messages, newest first
  //   read(remoteId)              -> one raw message with text, html and attachments
  //   search(query)               -> remoteIds the account itself finds
  //   send(draft)                 -> {remoteId}; the draft is {to, cc, bcc, subject, text, html, inReplyTo, references}
  //   reply(remoteId, draft)      -> {remoteId}
  //   archive(remoteIds), move(remoteIds, folderId), flag(remoteIds, on), markRead(remoteIds, on) -> true
  //   attachment(remoteId, attachmentId) -> {name, type, bytes: Uint8Array}
  //   changesSince(cursor)        -> {messages: [raw], removed: [remoteId], cursor}; a null cursor is the first pull
  // A site route (the signed-in page itself) can't send or change anything: it says so in `info().can`.
  const METHODS = ["info", "list", "threads", "read", "search", "send", "reply", "archive", "move", "flag", "markRead", "attachment", "changesSince"];

  function check(adapter) {
    const missing = METHODS.filter((m) => !adapter || typeof adapter[m] !== "function");
    if (missing.length) throw new Error("adapter is missing " + missing.join(", "));
    return adapter;
  }

  // One pull: asks the account what changed since the stored cursor, stores it, then moves the cursor. The cursor
  // moves only after the messages are stored, so a pull that fails part way is asked again from the same point.
  async function pull(accountId, adapter, store) {
    const S = store || globalThis.PolycarpHubStore;
    check(adapter);
    const since = (await S.cursor(accountId)) ?? null;
    const r = await adapter.changesSince(since);
    if (!r || !Array.isArray(r.messages) || !Array.isArray(r.removed)) throw new Error("changesSince answered with no messages or removed list");
    const touched = r.messages.length ? await S.upsert(accountId, r.messages) : [];
    if (r.removed.length) await S.remove(r.removed.map((id) => accountId + ":" + id));
    await S.setCursor(accountId, r.cursor);
    return { added: r.messages.length, removed: r.removed.length, threads: touched };
  }

  // A change made here goes to the store first, so the screen answers at once, then to the account. If the account
  // refuses, the store goes back to what it was and the error is passed on.
  async function act(accountId, adapter, store, remoteIds, patch, call) {
    const S = store || globalThis.PolycarpHubStore;
    const { before } = await S.update(remoteIds.map((id) => accountId + ":" + id), patch);
    try {
      await call(adapter, remoteIds);
    } catch (e) {
      await S.restore(before, Object.keys(patch));
      throw e;
    }
  }

  const actions = {
    archive: (a, ad, s, ids) => act(a, ad, s, ids, { folder: "archive" }, (x, r) => x.archive(r)),
    move: (a, ad, s, ids, folder) => act(a, ad, s, ids, { folder }, (x, r) => x.move(r, folder)),
    flag: (a, ad, s, ids, on) => act(a, ad, s, ids, { flagged: !!on }, (x, r) => x.flag(r, !!on)),
    markRead: (a, ad, s, ids, on) => act(a, ad, s, ids, { unread: !on }, (x, r) => x.markRead(r, !!on))
  };

  globalThis.PolycarpHubAdapter = { METHODS, check, pull, actions };
})();
