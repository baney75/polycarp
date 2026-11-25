// The Hub store on real IndexedDB in Chromium gives the same answers as the memory store the unit tests use, and
// keeps them across a reload. Run: node tests/hub-store.spec.mjs
import { loadPlaywright } from './pw.mjs';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, '..');
const ID = 'kdaddaaobomjfjcgjeabgbenfddkcfcl'; // fixed by the manifest key
const SCRIPTS = ['src/hub/model.js', 'src/hub/store.js', 'src/hub/adapter.js', 'src/hub/fake.js'];

const { chromium } = await loadPlaywright();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'polycarp-hub-'));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
});
let fails = 0;
const check = (ok, what, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : ' ' + JSON.stringify(detail)}`); if (!ok) fails++; };

async function page() {
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${ID}/src/pages/settings.html`);
  for (const s of SCRIPTS) await p.addScriptTag({ url: `chrome-extension://${ID}/${s}` });
  return p;
}

// One scenario, run on IndexedDB here and on the memory store in the same page, so the two must agree.
const scenario = async (memory) => {
  const S = globalThis.PolycarpHubStore, A = globalThis.PolycarpHubAdapter, F = globalThis.PolycarpHubFake;
  if (memory) S.useMemoryStore();
  await S.putAccount({ id: 'home', kind: 'fake' });
  await S.putAccount({ id: 'work', kind: 'fake' });
  await A.pull('home', F.create({ seed: 11, size: 300 }));
  await A.pull('work', F.create({ seed: 12, size: 120, address: 'me@work.example' }));
  const top = await S.threads({ limit: 25 });
  const older = await S.threads({ limit: 25, before: top[24].lastDate });
  const work = await S.threads({ account: 'work', limit: 30 });
  const sent = await S.threads({ folder: 'sent', limit: 500 });
  const t = await S.thread(top[0].id);
  const { before } = await S.update(t.messages.map((m) => m.id), { folder: 'archive' });
  const archived = (await S.threads({ limit: 1000 })).some((x) => x.id === top[0].id);
  await S.restore(before);
  const back = (await S.threads({ limit: 1 }))[0].id === top[0].id;
  await S.removeAccount('work');
  await S.upsert('ties', Array.from({ length: 7 }, (_, i) => ({ remoteId: 't' + i, messageId: `<t${i}@x>`, from: 'a@example.com', subject: 'Same ' + i, date: 4102444800000 })));
  const ties = [];
  let pg = await S.threads({ limit: 3 });
  while (pg.length && ties.length < 20) { ties.push(...pg.filter((x) => x.account === 'ties').map((x) => x.id)); if (ties.length >= 7) break; pg = await S.threads({ limit: 3, before: S.after(pg[pg.length - 1]) }); }
  await S.removeAccount('ties');
  return {
    ties: ties.length, tiesUnique: new Set(ties).size,
    top: top.map((x) => x.id), older: older.map((x) => x.id), work: work.map((x) => x.id), sent: sent.length,
    sorted: top.every((x, i) => i === 0 || top[i - 1].lastDate >= x.lastDate),
    workOnly: work.every((x) => x.account === 'work'), archived, back,
    left: (await S.allMessages()).every((m) => m.account === 'home'), cursor: await S.cursor('home')
  };
};

try {
  const p = await page();
  const idb = await p.evaluate(scenario, false);
  const mem = await p.evaluate(scenario, true);
  check(idb.top.length === 25 && idb.sorted, 'the inbox comes newest first, 25 to a page', idb);
  check(idb.older.length === 25 && !idb.older.some((id) => idb.top.includes(id)), 'the next page starts where the first ended', idb.older);
  check(idb.work.length > 0 && idb.workOnly, 'one account alone', idb.work);
  check(!idb.archived && idb.back, 'archive and its undo move the thread out and back', idb);
  check(idb.left, 'removing an account removes its mail', idb);
  check(idb.ties === 7 && idb.tiesUnique === 7, 'threads with the same date page without a gap or a repeat', idb);
  check(JSON.stringify(idb) === JSON.stringify(mem), 'IndexedDB and the memory store give the same answers', { idb, mem });
  await p.close();
  const again = await page();
  const kept = await again.evaluate(async () => ({ n: (await globalThis.PolycarpHubStore.allMessages()).length, cursor: await globalThis.PolycarpHubStore.cursor('home') }));
  check(kept.n === 300 && kept.cursor === idb.cursor, 'the mail and the cursor are still there after a reload', kept);
} catch (e) {
  check(false, 'the run finished', String(e && e.stack || e));
}
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
