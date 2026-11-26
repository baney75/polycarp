/* Polycarp Hub later: snooze a conversation until a time, or ask for it back when no one has answered yours. Both
   live only in this profile's store; the account never hears of them. Pure functions over thread summaries.
   Classic script for extension pages and Node tests. */
(function () {
  "use strict";

  const HOUR = 36e5;
  const DAY = 864e5;
  // Local time on a day `days` after `now`, at `hour`, so a change of clocks doesn't move it.
  const on = (now, days, hour) => { const d = new Date(now); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, hour).getTime(); };

  // Where a snooze can end, from now: later today while it is still today, tomorrow morning, Saturday, Monday.
  function snoozeChoices(now) {
    const day = new Date(now).getDay();
    const out = [];
    const later = now + 3 * HOUR;
    if (new Date(later).toDateString() === new Date(now).toDateString()) out.push({ id: "later", label: "Later today", at: later });
    out.push({ id: "tomorrow", label: "Tomorrow morning", at: on(now, 1, 8) });
    out.push({ id: "weekend", label: day === 6 || day === 0 ? "Next weekend" : "This weekend", at: on(now, (6 - day + 7) % 7 || 7, 8) });
    out.push({ id: "week", label: "Next week", at: on(now, (1 - day + 7) % 7 || 7, 8) });
    return out;
  }
  // How long to wait for an answer before the conversation comes back.
  function remindChoices(now) {
    return [
      { id: "1", label: "In a day", at: now + DAY },
      { id: "3", label: "In three days", at: now + 3 * DAY },
      { id: "7", label: "In a week", at: now + 7 * DAY }
    ];
  }
  // The value of a datetime-local box as a time, or 0 when it is empty, unreadable or not in the future.
  function picked(value, now) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(value || ""));
    if (!m) return 0;
    const at = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
    return at > now ? at : 0;
  }

  // Snoozed: out of the inbox until the time comes. New mail in it wakes it (the newest message carries no snooze).
  const sleeping = (t, now) => t.snoozeUntil > now;
  const woke = (t, now) => t.snoozeUntil > 0 && t.snoozeUntil <= now && t.folder === "inbox";
  // No reply: you wrote last, asked to hear back, and the time came with nothing newer than yours.
  const unanswered = (t, now) => t.remindAt > 0 && t.remindAt <= now && t.sentAt > 0 && t.lastDate <= t.sentAt;
  const back = (t, now) => woke(t, now) || unanswered(t, now);
  // You wrote last in it, so asking for a reminder makes sense.
  const yoursLast = (t) => t.sentAt > 0 && t.lastDate <= t.sentAt;

  // Why a conversation is back, in words for its row.
  function why(t, now, fmt) {
    if (unanswered(t, now)) return "No reply since " + fmt(t.sentAt);
    if (woke(t, now)) return "Snoozed until " + fmt(t.snoozeUntil);
    return "";
  }

  globalThis.PolycarpHubLater = { snoozeChoices, remindChoices, picked, sleeping, woke, unanswered, back, yoursLast, why };
})();
