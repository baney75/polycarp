# Sync engine

Reference for `cli/src/sync/`, the engine behind device sync (plan PR 4). It is the engine only: no category syncs yet.
Nothing in it reads files, opens sockets, signs, encrypts or reads the clock. Callers pass time in as integer
milliseconds. It uses nothing platform-specific and runs the same in the helper on the Mac, Linux (Omarchy) and
Windows.

## Pieces

| File | What it holds |
|---|---|
| `canonical.ts` | Canonical JSON: keys sorted by UTF-16 code unit, safe integers only (a fraction or a larger number is refused, -0 is 0), `JSON.stringify` string escapes, no whitespace. |
| `hlc.ts` | Hybrid logical clock: `hlcSend`, `hlcReceive`, `compareStamp` (wall, then count, then device id), `isTooFarAhead` (more than 5 minutes). |
| `op.ts` | The op envelope and its strict parser, op ids (`<author>:<seq>`), `canonicalOpBytes` (what a signature will cover). |
| `merge-types.ts` | The three merge types, each with `apply(state, op)`, `merge(a, b)` and `view(state)`. |
| `vv.ts` | Version vectors: per author, the highest sequence held without a gap. |
| `registry.ts` | The category registry and its safety rules. |
| `replica.ts` | One device's replica: log, local ops, receive, delta, acks, held ops, compaction and rejoin. |

## Ops

```
{ v: 1, category, schema, author, seq, at: {wall, count}, kind, key, value?, obs?, sig? }
```

`author` is a device id and `seq` counts that device's ops from 1. `obs` lists the op ids an op observed. `sig` is
carried and relayed but not checked: the engine trusts `author` as given until PR 5 adds signatures over
`canonicalOpBytes(op)` and the signed roster. Until then no untrusted source may feed `receiveOps`.

## Merge types

| Type | Used by | Kinds | Rule |
|---|---|---|---|
| `lww` | settings, themes, skills, site permissions | `set`, `del` | Greater stamp wins; device id breaks a clock tie. |
| `awset` | dictionary, library | `add`, `remove` | Add-wins observed-remove set. A remove tombstones only the adds it saw, so a concurrent add survives. An element's value is its newest live add. |
| `log` | history, threads | `append`, `delete`, `clear` | Append-only per stream. Delete wins for good; `clear` hides every entry stamped before it. Threads are single-writer: a stream key starts with its author's id, and only that author appends, deletes or clears in it. |

Apply commutes, so replicas holding the same ops hold byte-identical canonical state whatever the order.

## Rules

- **Clock.** An op more than 5 minutes ahead of the local wall clock is held: not applied, logged, acked or relayed,
  and it does not move the clock. It is admitted once the clock catches up (`releaseHeld`, and every `receiveOps`).
- **Narrow only.** Permission-like categories (`site-permissions`) take only removals from other devices. A remote
  `set` is refused, changes nothing, and is listed by `suggestions()` for a local click (PR 7). A later local allow
  beats an older revoke by its clock. A narrow-only category must be `lww`. Its ops never fold into
  `snapshot.states`: compaction keeps them in `snapshot.kept`, and a device adopting a snapshot ignores any narrow entry
  in `states` and rebuilds the category from those ops for itself, so a peer's allow arrives as a suggestion.
- **Never synced.** `createRegistry` throws `NeverSyncedError` for a category named for secrets, tokens, passwords,
  keys, cookies, OAuth or sign-ins, Full Access, lends, scopes, subscriptions, permission mode, sandbox or hooks.
  Settings maps (`guardKeys`) also refuse op keys with those words.
- **Unknown or newer.** An op for a category this build lacks, or a schema newer than it reads, is stored, acked and
  relayed but not applied. Compaction keeps it in `snapshot.kept`; after an upgrade it applies.
- **Compaction.** `compact` folds an op into the snapshot once every current member has acked it. A member unseen for
  90 days is not current and stops blocking. A folded tombstone drops 90 days after it folded, once every member's own
  ops up to its ack at fold time are folded too. A device with no current member folds nothing.
- **Rejoin.** A peer behind the snapshot gets the snapshot (`delta` returns `kind: "snapshot"`). `adoptSnapshot` keeps
  the device's own unsent ops and replays its offline `lww` edits and set adds as new ops with a fresh clock, so they
  hold. Only edits that still stand are replayed: an add whose tag is still live and the device's last edit per
  key, so a word it removed offline stays removed. Narrow-only edits are not replayed, so an old offline allow never
  beats a newer revoke. Snapshot ops stamped too far ahead are held. Deleted items may reappear; the UI is to say so.

## Categories

| Category | Merge | Default | Direction |
|---|---|---|---|
| `settings-sidepanel`, `settings-silas`, `settings-spaces` | lww | on | both |
| `themes`, `skills` | lww | on | both |
| `dictionary`, `library` | awset | on | both |
| `history` | log | off | both |
| `threads` | log, single writer | off | both |
| `site-permissions` | lww | on | narrow |

## Never syncs

Provider keys and custom providers, subscriptions, `tokens.json`, OAuth and hub files, the link secret, cookies,
release keys, permission mode, Full Access, lends, computer scopes, sandbox and hook settings, site scripts, models and
costs.

## Later PRs

- PR 5: device keys, signatures on ops, the signed roster (members), sealed batches, the hub mailbox, the signed hello
  that picks the lowest common schema.
- PR 6 to 8: adapters for themes, library, skills, extension settings, site permissions, threads, Silas and Spaces, and
  `sync status|on|off|now`. Category on/off switches and size bounds live there.
- PR 9: direct tailnet transport.

## Tests

`cli/test/sync-property.test.mjs` (500 seeds, 3 replicas, random delivery, duplication, loss, delay and fast clocks;
prints the failing seed, rerun one with `SYNC_SEED=<n>`), `sync-rules.test.mjs`, `sync-compaction.test.mjs` and
`sync-vectors.test.mjs`. The vectors in `cli/test/fixtures/sync-vectors.json` are for a Rust or Swift port; regenerate
them with `SYNC_VECTORS_WRITE=1` only for an intended format change.
