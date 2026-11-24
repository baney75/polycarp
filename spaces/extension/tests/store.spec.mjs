// The Chrome Web Store copy (scripts/stage.sh --store): no fixed key, no new tab override, nativeMessaging only as an
// optional permission, no update controls (the store updates it), and the NAS refuses plain http to public hosts.
// A store install's manifest carries an update_url; this test adds one so the unpacked copy behaves like a store install.
import { loadPlaywright } from './pw.mjs';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'polycarp-store-')), 'extension');
execFileSync('sh', [path.join(root, 'scripts/stage.sh'), '--store', dir], { stdio: 'inherit' });
const listing = execFileSync('find', ['.', '-type', 'f'], { cwd: dir, encoding: 'utf8' }).split('\n').filter(Boolean).map((f) => f.slice(2));
const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
ok(!('key' in m), 'no fixed key: the store assigns the ID');
ok(!m.chrome_url_overrides && !listing.some((f) => f.startsWith('newtab/')), 'no new tab override and no new tab files');
ok(!m.permissions.includes('nativeMessaging') && (m.optional_permissions || []).includes('nativeMessaging'), 'nativeMessaging is optional only');
ok(!m.permissions.includes('activeTab'), 'no activeTab (host permissions already cover it)');
ok(!/new tab/i.test(m.description) && m.description.length <= 132 && /, and /.test(m.description), `description reads well: ${m.description}`);
ok(!listing.some((f) => /(^|\/)\./.test(f)), 'no hidden files');
const zipBytes = Number(execFileSync('sh', ['-c', `cd "${dir}" && zip -qr - . | wc -c`], { encoding: 'utf8' }).trim());
ok(zipBytes < 100 * 1024 * 1024, `zip is ${(zipBytes / 1048576).toFixed(1)} MB`);

fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ ...m, update_url: 'https://clients2.google.com/service/update2/crx' }, null, 2));
const { chromium } = await loadPlaywright();
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'polycarp-storep-')), {
  channel: 'chromium', headless: true, args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`]
});
const errors = [];
try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 10000 });
  const id = sw.url().split('/')[2];
  await new Promise((r) => setTimeout(r, 500));
  ok(!(await sw.evaluate(() => chrome.alarms.get('polycarp-update'))), 'no disk update alarm on a store install');
  for (const p of ['src/pages/library.html', 'src/pages/review.html', 'src/pages/search.html', 'src/pages/welcome.html', 'src/reader/reader.html', 'src/popup/popup.html']) {
    const pg = await ctx.newPage();
    pg.on('pageerror', (e) => errors.push(p + ': ' + e));
    pg.on('console', (c) => { if (c.type() === 'error') errors.push(p + ' console: ' + c.text()); });
    await pg.goto(`chrome-extension://${id}/${p}`);
    await pg.waitForTimeout(500);
    ok(await pg.evaluate(() => document.body.innerText.trim().length > 20), `${p} renders`);
    if (p.endsWith('welcome.html')) {
      ok(/Chrome Web Store keeps/.test(await pg.textContent('#newNote')) && await pg.isHidden('#newOne'), 'welcome says the store updates it and drops the new tab note');
    }
    await pg.close();
  }
  const st = await ctx.newPage();
  st.on('pageerror', (e) => errors.push('settings: ' + e));
  await st.goto(`chrome-extension://${id}/src/pages/settings.html`);
  await st.waitForTimeout(600);
  ok(/Chrome Web Store keeps/.test(await st.textContent('#updText')) && await st.isHidden('#checkUpd'), 'settings: no Check for updates on a store install');
  ok(await st.isVisible('#appRow') && await st.isVisible('#appConnect'), 'settings: Connect to the Polycarp app is offered');
  const nas = await st.evaluate(async () => {
    const out = {};
    for (const u of ['http://nas.example.com:5005', 'nas.example.com:5006', 'http://192.168.1.20:5005']) {
      try { await PolycarpNAS.setConfig({ url: u }); out[u] = (await chrome.storage.local.get(null)); out[u] = 'ok'; } catch (e) { out[u] = e.code; }
    }
    return out;
  });
  ok(nas['http://nas.example.com:5005'] === 'insecure', 'NAS: plain http to a public host is refused ' + JSON.stringify(nas));
  ok(nas['nas.example.com:5006'] === 'ok' && nas['http://192.168.1.20:5005'] === 'ok', 'NAS: a bare public host gets https, a home address keeps http');
  const conf = await st.evaluate(() => PolycarpNAS.getConfig ? PolycarpNAS.getConfig() : null);
  if (conf) ok(conf.url === 'http://192.168.1.20:5005', 'NAS: the home address is saved as given');
  await st.close();
  ok(errors.length === 0, 'no page or console errors ' + errors.join(' | '));
} catch (e) {
  ok(false, 'threw ' + (e.stack || e));
} finally {
  await ctx.close();
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
}
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
