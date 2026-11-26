// The line to the Polycarp app (src/shared/bridge.js) with a made-up browser: what is sent, what never is, and what the
// app may ask. Run: node --test tests/bridge.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/shared/bridge.js';

const B = globalThis.PolycarpBridge;
const event = () => { const fns = new Set(); return { addListener: (f) => fns.add(f), fire: (...a) => [...fns].map((f) => f(...a)) }; };
const tab = (id, title, more = {}) => ({ id, windowId: 1, title, url: `https://site${id}.example/`, incognito: false, active: false, groupId: -1, ...more });

function browser({ perms = ['nativeMessaging'], tabs = [], set = {}, history = [], downloads = [], marks = [], windows = [], groups = [], fails = '', share = {} } = {}) {
  const ports = [], timers = [], did = [], kept = {};
  const granted = new Set(perms);
  const chrome = {
    runtime: { lastError: null, getURL: (p) => 'chrome-extension://x' + p, connectNative: (name) => {
      const port = { name, sent: [], onMessage: event(), onDisconnect: event(), disconnect() { port.off = true; }, postMessage: (m) => port.sent.push(structuredClone(m)) };
      ports.push(port);
      if (fails) queueMicrotask(() => { chrome.runtime.lastError = { message: fails }; port.onDisconnect.fire(); chrome.runtime.lastError = null; });
      return port;
    } },
    permissions: { contains: async ({ permissions }) => permissions.every((p) => granted.has(p)) },
    storage: { local: { get: async (k) => ({ [k]: set }) }, session: { get: async (k) => ({ [k]: kept[k] }), set: async (o) => { Object.assign(kept, structuredClone(o)); } } },
    tabs: { query: async (q) => tabs.filter((t) => (q.windowId === undefined || t.windowId === q.windowId) && (q.groupId === undefined || t.groupId === q.groupId)), get: async (id) => { const t = tabs.find((x) => x.id === id); if (!t) throw new Error('no tab'); return t; },
      create: async (o) => { did.push(['newTab', o]); return { id: 400 }; },
      remove: async (id) => { did.push(['closeTab', id]); },
      update: async (id, o) => { did.push(['tab', id, o]); return tabs.find((t) => t.id === id); },
      onCreated: event(), onUpdated: event(), onAttached: event(), onReplaced: event(), onRemoved: event(), onActivated: event() },
    tabGroups: { query: async () => groups, get: async (id) => groups.find((g) => g.id === id), move: async (id, o) => { did.push(['moveGroup', id, o]); },
      onCreated: event(), onUpdated: event(), onMoved: event(), onRemoved: event() },
    search: { query: async (o) => did.push(['search', o]) },
    windows: { getAll: async (q) => windows.filter((w) => q.windowTypes.includes(w.type || 'normal')), create: async (o) => { did.push(['newWindow', o]); return { id: 50, tabs: [{ id: 500 }] }; }, update: async (id, o) => did.push(['window', id, o]) },
    bookmarks: { getTree: async () => marks, onCreated: event(), onRemoved: event(), onChanged: event(), onMoved: event() },
    history: { search: async () => history, onVisited: event(), onVisitRemoved: event() },
    downloads: { show: (id) => did.push(['show', id]), search: async (q) => (q.id === undefined ? downloads : downloads.filter((d) => d.id === q.id)), onCreated: event(), onChanged: event(), onErased: event() },
  };
  const b = B.make(chrome, { later: (f) => timers.push(f), now: () => 1e12, share });
  b.listenTabs();
  const settle = async () => { for (let i = 0; i < 12; i++) { await new Promise((r) => setImmediate(r)); for (const f of timers.splice(0)) f(); } };
  return { b, chrome, ports, did, windows, kept, tabs, downloads, granted, set, settle, port: () => ports[ports.length - 1],
    async open(sources) { await b.start(); ports[ports.length - 1].onMessage.fire({ op: 'browser.want', sources }); await settle(); },
    sent: (op, source) => ports[ports.length - 1].sent.filter((m) => m.op === op && (!source || m.source === source)) };
}

test('nothing is sent before the app asks, and only what it asks', async () => {
  const x = browser({ tabs: [tab(1, 'One')], perms: ['nativeMessaging', 'history'], set: { history: true }, history: [{ url: 'https://h.example/', title: 'H' }] });
  await x.b.start();
  await x.settle();
  assert.deepEqual(x.port().sent, [{ op: 'browser.join' }]);
  x.port().onMessage.fire({ op: 'browser.want', sources: ['tabs', 'passwords'] });
  await x.settle();
  assert.deepEqual(x.sent('browser.rows').map((m) => m.source), ['tabs']);
  assert.deepEqual(x.sent('browser.rows')[0].rows, [{ id: 1, window: 1, title: 'One', url: 'https://site1.example/', incognito: false, front: false }]);
});

test('nothing private is ever sent, by any road', async () => {
  const secret = tab(2, 'Secret', { incognito: true, windowId: 9, url: 'https://secret.example/' });
  const unsaid = { ...tab(3, 'Unsaid'), incognito: undefined };
  const x = browser({ tabs: [tab(1, 'Open'), secret, unsaid], perms: ['nativeMessaging', 'downloads'], set: { downloads: true },
    downloads: [{ id: 1, filename: '/a/b/plain.zip', url: 'https://d.example/', incognito: false, state: 'complete' }, { id: 3, filename: '/a/b/local.pdf', url: 'file:///Folder/secret/local.pdf', incognito: false, state: 'complete' }, { id: 2, filename: '/a/secret.zip', url: 'https://secret.example/', incognito: true, state: 'complete' }] });
  await x.open(['tabs', 'downloads']);
  const t = x.chrome.tabs, d = x.chrome.downloads;
  t.onCreated.fire(secret); t.onUpdated.fire(2, { title: 'Secret' }); t.onAttached.fire(2); t.onActivated.fire({ tabId: 2, windowId: 9 }); t.onRemoved.fire(2);
  t.onUpdated.fire(3, { title: 'Unsaid' }); t.onReplaced.fire(2, 2);
  d.onCreated.fire(x.downloads[2]); d.onChanged.fire({ id: 2 });
  await x.settle();
  const all = JSON.stringify(x.port().sent);
  for (const word of ['Secret', 'secret', 'Unsaid']) assert.ok(!all.includes(word), word);
  assert.deepEqual(x.sent('browser.change'), [], 'not even that a private tab went away');
  assert.deepEqual(x.sent('browser.rows', 'downloads')[0].rows.map((r) => [r.title, r.url]), [['plain.zip', 'https://d.example/'], ['local.pdf', '']], "a file's name and never its folder, not even in a local address");
});

test('a source that is off, or that the browser was not asked to allow, gives nothing', async () => {
  const more = { history: [{ url: 'https://h.example/', title: 'H' }], marks: [{ children: [{ id: '5', title: 'B', url: 'https://b.example/' }] }] };
  for (const [perms, set] of [[['nativeMessaging'], { history: true, bookmarks: true }], [['nativeMessaging', 'history', 'bookmarks'], {}], [['nativeMessaging', 'history', 'bookmarks'], { history: 'yes', bookmarks: 1 }]]) {
    const x = browser({ perms, set, ...more });
    await x.open(['bookmarks', 'history']);
    assert.deepEqual(x.port().sent, [{ op: 'browser.join' }]);
  }
  const x = browser({ perms: ['nativeMessaging', 'history', 'bookmarks'], set: { history: true, bookmarks: true }, ...more });
  await x.open(['tabs', 'bookmarks', 'history']);
  assert.deepEqual(x.sent('browser.rows', 'bookmarks')[0].rows, [{ id: '5', title: 'B', url: 'https://b.example/' }]);
  x.set.history = false;
  await x.b.refresh();
  x.chrome.history.onVisited.fire({ url: 'https://later.example/', title: 'Later' });
  await x.settle();
  assert.deepEqual(x.sent('browser.rows', 'history').at(-1).rows, [], 'switched off: the app is told to drop it');
  assert.ok(!JSON.stringify(x.port().sent).includes('later.example'));
});

test('without the native messaging permission no port is opened', async () => {
  const x = browser({ perms: [] });
  await x.b.start();
  assert.equal(x.ports.length, 0);
});

test('changes are gathered into one message, the last word on each', async () => {
  const x = browser({ tabs: [tab(1, 'One'), tab(2, 'Two')] });
  await x.open(['tabs']);
  x.tabs[0].title = 'One again'; x.tabs[0].audible = true;
  x.chrome.tabs.onUpdated.fire(1, { title: 'x' });
  x.chrome.tabs.onUpdated.fire(1, { audible: true });
  x.chrome.tabs.onUpdated.fire(1, { favIconUrl: 'x' });
  x.tabs.splice(1, 1);
  x.chrome.tabs.onRemoved.fire(2);
  await x.settle();
  assert.deepEqual(x.sent('browser.change'), [{ op: 'browser.change', source: 'tabs', gone: [2],
    rows: [{ id: 1, window: 1, title: 'One again', url: 'https://site1.example/', incognito: false, front: false, audible: true }] }]);
});

test('a visit is news, a page cleared from history goes, and all of it cleared is an empty list', async () => {
  const x = browser({ perms: ['nativeMessaging', 'history'], set: { history: true, tabs: false }, history: [{ url: 'https://a.example/', title: 'A', visitCount: 3, lastVisitTime: 5.4 }, { url: 'chrome://settings', title: 'no' }] });
  await x.open(['tabs', 'history']);
  assert.deepEqual(x.sent('browser.rows').map((m) => m.rows), [[{ url: 'https://a.example/', title: 'A', visits: 3, last: 5 }]]);
  x.chrome.history.onVisited.fire({ url: 'https://b.example/', title: 'B' });
  x.chrome.history.onVisitRemoved.fire({ allHistory: false, urls: ['https://a.example/', 'file:///Folder/taxes.pdf', 'chrome://settings'] });
  await x.settle();
  assert.deepEqual(x.sent('browser.change').map((m) => [m.rows.map((r) => r.url), m.gone]), [[['https://b.example/'], ['https://a.example/']]]);
  x.chrome.history.onVisited.fire({ url: 'https://c.example/', title: 'C' });
  x.chrome.history.onVisitRemoved.fire({ allHistory: true });
  await x.settle();
  assert.deepEqual(x.sent('browser.rows').at(-1), { op: 'browser.rows', source: 'history', first: true, last: true, rows: [] });
  assert.ok(!JSON.stringify(x.port().sent).includes('c.example'));
});

test('the app goes to the exact tab, and asks for nothing else', async () => {
  const x = browser({ tabs: [tab(1, 'One'), tab(2, 'Two', { windowId: 8 }), tab(3, 'Secret', { incognito: true })] });
  await x.open(['tabs']);
  for (const m of [{ op: 'browser.go', tab: 2 }, { op: 'browser.go', tab: 3 }, { op: 'browser.go', tab: '1' }, { op: 'browser.show', download: 5 }, { op: 'browser.go' }, { op: 'browser.run', code: 'x' }, null]) x.port().onMessage.fire(m);
  await x.settle();
  assert.deepEqual(x.did, [['tab', 2, { active: true }], ['window', 8, { focused: true }]]);
});

test('a download is shown in its folder only while downloads are sent', async () => {
  const x = browser({ perms: ['nativeMessaging', 'downloads'], set: { downloads: true } });
  await x.open(['tabs']);
  x.port().onMessage.fire({ op: 'browser.show', download: 5 });
  await x.settle();
  x.port().onMessage.fire({ op: 'browser.want', sources: ['downloads'] });
  await x.settle();
  for (const m of [{ op: 'browser.show', download: 6 }, { op: 'browser.show', download: '7' }]) x.port().onMessage.fire(m);
  await x.settle();
  assert.deepEqual(x.did, [['show', 6]]);
});

test('a download on its way is told again until it is done, and a private or paused one never', async () => {
  const x = browser({ perms: ['nativeMessaging', 'downloads'], set: { downloads: true } });
  const told = () => x.sent('browser.change', 'downloads').flatMap((m) => m.rows).map((r) => [r.id, r.received]);
  let asked = 0;
  const search = x.chrome.downloads.search;
  x.chrome.downloads.search = async (q) => {
    if (!q.state) return search(q);
    if (++asked === 3) x.downloads[0].state = 'complete';
    x.downloads[0].bytesReceived += 10;
    return x.downloads.filter((d) => d.state === 'in_progress');
  };
  await x.open(['downloads']);
  x.downloads.push({ id: 1, filename: '/a/one.zip', incognito: false, state: 'in_progress', bytesReceived: 5, totalBytes: 100 },
    { id: 2, filename: '/a/secret.zip', incognito: true, state: 'in_progress' }, { id: 3, filename: '/a/held.zip', incognito: false, state: 'in_progress', paused: true });
  for (const d of x.downloads.slice(1)) x.chrome.downloads.onCreated.fire(d);
  await x.settle();
  assert.equal(asked, 0, 'nothing is on its way');
  for (let i = 0; i < 3; i++) x.chrome.downloads.onChanged.fire({ id: 1 });
  await x.settle(); await x.settle();
  assert.deepEqual(told().filter((r) => r[0] === 1), [[1, 5], [1, 15], [1, 25]]);
  assert.equal(asked, 3, 'one round at a time, and none once it is done');
  assert.ok(!told().some((r) => r[0] === 2));
  x.downloads[0].state = 'in_progress';
  x.port().onMessage.fire({ op: 'browser.want', sources: ['tabs'] });
  await x.settle();
  x.chrome.downloads.onChanged.fire({ id: 1 });
  await x.settle();
  assert.equal(asked, 3, 'downloads are off');
  const y = browser({ perms: ['nativeMessaging', 'downloads'], set: { downloads: true }, downloads: [{ id: 1, filename: '/a/one.zip', incognito: false, state: 'in_progress', bytesReceived: 5 }] });
  let rounds = 0;
  const find = y.chrome.downloads.search;
  y.chrome.downloads.search = async (q) => { if (q.state && ++rounds > 1) return []; return find(q); };
  await y.open(['downloads']);
  assert.equal(y.sent('browser.change', 'downloads').length, 1, 'one already on its way when the app asks');
});

test('a download says when it ended only once it is whole', () => {
  const d = { id: 1, filename: 'a.zip', incognito: false, endTime: '2026-11-25T12:00:00.000Z' };
  assert.equal(B.downloadRow({ ...d, state: 'complete' }).ended, Date.UTC(2026, 10, 25, 12));
  for (const not of [{ state: 'interrupted' }, { state: 'in_progress' }, { state: 'complete', endTime: undefined }, { state: 'complete', endTime: 'soon' }]) assert.ok(!('ended' in B.downloadRow({ ...d, ...not })), JSON.stringify(not));
});

test('an app from before the line, or none, is asked once a start', async () => {
  const none = browser({ fails: 'Specified native messaging host not found.' });
  await none.b.start();
  await none.settle();
  await none.b.start();
  assert.equal(none.ports.length, 1);
  await none.b.again();
  assert.equal(none.ports.length, 2);
  const old = browser();
  await old.b.start();
  old.port().onMessage.fire({ ok: false, error: 'there is no request called browser.join' });
  old.port().onDisconnect.fire();
  await old.b.start();
  assert.equal(old.ports.length, 1);
  assert.equal(old.port().off, true, 'the line to an app from before it is closed');
  const now = browser({ tabs: [tab(1, 'One')] });
  await now.open(['tabs']);
  now.port().onMessage.fire({ ok: false, error: 'not that one' });
  assert.equal(now.b.open, true, 'a working app turning down one message keeps the line');
  now.port().onDisconnect.fire();
  await now.b.start();
  assert.equal(now.ports.length, 2, 'and the line opens again when that app restarts');
});

test('a port that closes is opened again, and an app that comes back gets all of it again', async () => {
  const x = browser({ tabs: [tab(1, 'One')] });
  await x.open(['tabs']);
  x.port().onDisconnect.fire();
  assert.equal(x.b.open, false);
  await x.open(['tabs']);
  assert.equal(x.ports.length, 2);
  x.port().onMessage.fire({ op: 'browser.away' });
  x.chrome.tabs.onUpdated.fire(1, { title: 'x' });
  await x.settle();
  assert.deepEqual(x.sent('browser.change'), []);
  x.port().onMessage.fire({ op: 'browser.want', sources: ['tabs'] });
  await x.settle();
  assert.equal(x.sent('browser.rows').length, 2);
});

test('a list goes in pieces the host takes, first and last marked', () => {
  const rows = Array.from({ length: 2000 }, (_, i) => ({ id: i, url: 'https://a.example/' + 'é'.repeat(i % 2 === 0 ? 1900 : 10) }));
  const out = B.pieces('tabs', rows);
  assert.ok(out.length > 4);
  for (const m of out) assert.ok(Buffer.byteLength(JSON.stringify(m)) < 1 << 20);
  assert.deepEqual(out.flatMap((m) => m.rows), rows);
  assert.deepEqual(out.map((m) => [m.first, m.last]), out.map((_, i) => [i === 0, i === out.length - 1]));
  assert.deepEqual(B.pieces('downloads', []), [{ op: 'browser.rows', source: 'downloads', first: true, last: true, rows: [] }]);
  assert.equal(B.pieces('downloads', Array.from({ length: 900 }, (_, id) => ({ id }))).flatMap((m) => m.rows).length, 500);
});

test('what a row may carry: no tab without a real id, no sound when muted, web bookmarks only, no extension downloads', () => {
  assert.equal(B.tabRow(tab(-1, 'Tools')), null);
  assert.equal(B.tabRow(tab(1, 'Muted', { audible: true, mutedInfo: { muted: true } })).audible, undefined);
  assert.deepEqual(B.bookmarkRows([{ children: [{ id: '1', title: 'Web', url: 'https://w.example/' }, { id: '2', title: 'Script', url: 'javascript:alert(1)' }, { id: '3', title: 'Inner', url: 'chrome://flags' }] }]).map((r) => r.id), ['1']);
  assert.equal(B.downloadRow({ id: 1, filename: '/a/x.zip', url: 'https://d.example/', incognito: false, byExtensionId: 'abc' }), null);
});

test('an app that asks again gets all of it again, and one that goes gets no change made before it went', async () => {
  const x = browser({ tabs: [tab(1, 'One')] });
  await x.open(['tabs']);
  x.port().onMessage.fire({ op: 'browser.want', sources: ['tabs'] });
  await x.settle();
  assert.equal(x.sent('browser.rows', 'tabs').length, 2);
  x.tabs[0].title = 'Changed';
  x.chrome.tabs.onUpdated.fire(1, { title: 'Changed' });
  await new Promise((r) => setImmediate(r));
  x.port().onMessage.fire({ op: 'browser.away' });
  await x.settle();
  assert.deepEqual(x.sent('browser.change'), []);
});

test('a list read while the app went away is not sent', async () => {
  const x = browser({ tabs: [tab(1, 'One')] });
  let give;
  x.chrome.tabs.query = () => new Promise((r) => { give = r; });
  await x.b.start();
  x.port().onMessage.fire({ op: 'browser.want', sources: ['tabs'] });
  await x.settle();
  x.port().onMessage.fire({ op: 'browser.away' });
  give(x.tabs);
  await x.settle();
  assert.deepEqual(x.sent('browser.rows'), []);
});

test('a tab or a search opens in a window that is not private, the one named, or a new one', async () => {
  const windows = [{ id: 9, incognito: true, focused: true }, { id: 1, incognito: false, focused: false }, { id: 2, incognito: false, focused: false }];
  const x = browser({ windows });
  await x.open(['tabs']);
  const ask = async (m) => { x.did.length = 0; x.port().onMessage.fire({ op: 'browser.open', ...m }); await x.settle(); return structuredClone(x.did); };
  assert.deepEqual(await ask({ url: 'https://a.example/' }), [['newTab', { windowId: 1, active: true, url: 'https://a.example/' }], ['window', 1, { focused: true }]]);
  assert.deepEqual(await ask({ window: 2, text: ' cats ' }), [['newTab', { windowId: 2, active: true }], ['window', 2, { focused: true }], ['search', { text: 'cats', tabId: 400 }]]);
  assert.deepEqual(await ask({ window: 'new' }), [['newWindow', { focused: true }]]);
  assert.deepEqual(await ask({ window: 9 }), [], 'a private window is none of its business');
  assert.deepEqual(await ask({ url: 'javascript:alert(1)' }), []);
  windows[2].focused = true;
  assert.equal((await ask({}))[0][1].windowId, 2);
  windows.splice(1);
  assert.deepEqual(await ask({ text: 'cats' }), [['newWindow', { focused: true }], ['search', { text: 'cats', tabId: 500 }]], 'only a private window is open');
});

test("a site's icon is the browser's own copy, and only once something is sent", async () => {
  const x = browser({ tabs: [tab(1, 'One')] });
  const asked = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (u) => { asked.push(u); return { ok: true, arrayBuffer: async () => new Uint8Array(asked.length > 1 ? 60000 : 3).fill(7).buffer }; };
  try {
    await x.b.start();
    const ask = async (url) => { x.port().onMessage.fire({ op: 'browser.icon', url }); await x.settle(); };
    await ask('https://a.example/');
    assert.deepEqual(asked, [], 'the app has asked for nothing yet');
    x.port().onMessage.fire({ op: 'browser.want', sources: ['tabs'] });
    await x.settle();
    await ask('https://a.example/?q=1&r=2');
    await ask('file:///etc/hosts');
    assert.deepEqual(asked, ['chrome-extension://x/_favicon/?size=32&pageUrl=https%3A%2F%2Fa.example%2F%3Fq%3D1%26r%3D2']);
    assert.deepEqual(x.sent('browser.icon'), [{ op: 'browser.icon', url: 'https://a.example/?q=1&r=2', png: 'BwcH' }]);
    await ask('https://b.example/');
    assert.equal(x.sent('browser.icon').length, 1, 'a big one is left');
  } finally { globalThis.fetch = real; }
});

test('tab groups: named, never a private one, and moved whole to a window or one of its own', async () => {
  const windows = [{ id: 1, incognito: false }, { id: 2, incognito: false }, { id: 9, incognito: true }, { id: 8 }];
  const groups = [{ id: 11, windowId: 1, title: 'Trip', color: 'blue' }, { id: 12, windowId: 1, title: '', color: 'red' }, { id: 13, windowId: 9, title: 'Secret', color: 'red' }, { id: 14, windowId: 8, title: 'Unsaid', color: 'red' }];
  const off = browser({ groups, windows, set: { groups: true } });
  await off.open(['groups']);
  assert.deepEqual(off.sent('browser.rows'), [], 'not without the permission');
  const x = browser({ groups, windows, set: { groups: true }, perms: ['nativeMessaging', 'tabGroups'], tabs: [tab(5, 'A', { groupId: 11 }), tab(6, 'B', { groupId: 11 })] });
  const ask = async (m) => { x.did.length = 0; x.port().onMessage.fire({ op: 'browser.group', ...m }); await x.settle(); return structuredClone(x.did); };
  await x.b.start();
  assert.deepEqual(await ask({ group: 11, window: 2 }), [], 'nothing before it is asked for');
  await x.open(['groups']);
  const want = [{ id: 11, window: 1, title: 'Trip', incognito: false }, { id: 12, window: 1, title: 'Tab group (red)', incognito: false }];
  assert.deepEqual(x.sent('browser.rows')[0].rows, want);
  groups[0].title = 'Trips';
  x.chrome.tabGroups.onUpdated.fire(groups[0]);
  await x.settle();
  assert.equal(x.sent('browser.rows').at(-1).rows[0].title, 'Trips');
  assert.deepEqual(await ask({ group: 11, window: 2 }), [['moveGroup', 11, { windowId: 2, index: -1 }]]);
  assert.deepEqual(await ask({ group: 11, window: 'new' }), [['newWindow', { focused: false }], ['moveGroup', 11, { windowId: 50, index: -1 }], ['closeTab', 500]]);
  for (const m of [{ group: 11, window: 1 }, { group: 11, window: 9 }, { group: 13, window: 2 }, { group: 14, window: 'new' }, { group: 11, window: 77 }]) assert.deepEqual(await ask(m), [], JSON.stringify(m));
  x.did.length = 0;
  x.port().onMessage.fire({ op: 'browser.go', group: 11 });
  await x.settle();
  assert.deepEqual(structuredClone(x.did), [['tab', 5, { active: true }], ['window', 1, { focused: true }]]);
  x.set.groups = false;
  await x.b.refresh();
  x.did.length = 0;
  x.port().onMessage.fire({ op: 'browser.go', group: 11 });
  await x.settle();
  assert.deepEqual(structuredClone(x.did), [], 'switched off: a group is no longer gone to');
});

test('a web app opens in a window of its own, once, and its tab says whose it is', async () => {
  const x = browser({ tabs: [tab(1, 'One'), tab(2, 'Sign in', { windowId: 3 })], windows: [{ id: 1, incognito: false }, { id: 3, incognito: false, type: 'popup' }] });
  await x.open(['tabs']);
  assert.deepEqual(x.sent('browser.rows')[0].rows.map((r) => [r.popup, r.app]), [[undefined, undefined], [true, undefined]], "a site's own popup is nobody's app");
  const ask = async (m) => { x.port().onMessage.fire({ op: 'browser.app', id: 'mail-1', url: 'https://mail.example/', ...m }); await x.settle(); };
  for (const bad of [{ id: 'A B' }, { id: 5 }, { id: '' }, { id: 'a'.repeat(41) }, { url: 'javascript:alert(1)' }, { url: 'chrome://settings' }, { url: undefined }]) await ask(bad);
  assert.deepEqual(x.did, []);
  x.chrome.windows.create = async (o) => { x.did.push(['newWindow', o]); x.windows.push({ id: 50, incognito: false, type: 'popup' }); return { id: 50 }; };
  x.port().onMessage.fire({ op: 'browser.app', id: 'mail-1', url: 'https://mail.example/' });
  await ask();
  assert.deepEqual(x.did.splice(0), [['newWindow', { type: 'popup', url: 'https://mail.example/', focused: true, width: 1200, height: 800 }], ['window', 50, { focused: true }]], 'asked for twice at once');
  x.tabs.push(tab(500, 'Inbox', { windowId: 50, active: true }));
  x.chrome.tabs.onUpdated.fire(500, { title: 'Inbox' });
  await x.settle();
  assert.deepEqual(x.sent('browser.change').at(-1).rows.map((r) => [r.id, r.popup, r.app]), [[500, true, 'mail-1']]);
  await ask();
  assert.deepEqual(x.did.splice(0), [['window', 50, { focused: true }]], 'open already');
  x.windows.splice(2, 1);
  x.windows.push({ id: 50, incognito: true, type: 'popup' });
  await ask();
  assert.equal(x.did.splice(0)[0][0], 'newWindow', 'never a private window, nor one that closed');
  x.windows.length = 0;
  await ask({ id: 'map-2', url: 'https://map.example/' });
  assert.deepEqual(x.kept['polycarp.apps'], { 50: 'map-2' }, 'a window that is gone is forgotten');
});

test("a new app window's tab is said again once it is known whose it is", async () => {
  const x = browser({ tabs: [tab(500, 'Inbox', { windowId: 50 })], windows: [{ id: 50, incognito: false, type: 'popup' }] });
  await x.open(['tabs']);
  x.port().onMessage.fire({ op: 'browser.app', id: 'mail-1', url: 'https://mail.example/' });
  await x.settle();
  assert.deepEqual(x.sent('browser.change').map((m) => m.rows.map((r) => r.app)), [['mail-1']]);
});

test('the app windows of one browser are all kept', async () => {
  const x = browser({ windows: [{ id: 3, incognito: false, type: 'popup' }] });
  x.kept['polycarp.apps'] = { 3: 'map-2', 4: 'gone-3' };
  await x.open(['tabs']);
  x.port().onMessage.fire({ op: 'browser.app', id: 'mail-1', url: 'https://mail.example/' });
  await x.settle();
  assert.deepEqual(x.kept['polycarp.apps'], { 3: 'map-2', 50: 'mail-1' });
});

test('a tab sent from the launcher goes to the Reader or the library, and never a private one', async () => {
  const got = [];
  const share = { reader: (t) => got.push(['reader', t.id]), library: (t) => got.push(['library', t.id]), mail: (t) => got.push(['mail', t.id]) };
  const x = browser({ share, tabs: [tab(1, 'One'), tab(2, 'Secret', { incognito: true }), tab(3, 'Unsaid', { incognito: undefined }), tab(4, 'File', { url: 'file:///etc/hosts' })] });
  const send = async (tabId, to) => { x.port().onMessage.fire({ op: 'browser.send', tab: tabId, to }); await x.settle(); };
  await x.b.start();
  await send(1, 'reader');
  assert.deepEqual(got, [], 'not before the app asked for tabs');
  x.port().onMessage.fire({ op: 'browser.want', sources: ['tabs'] });
  await x.settle();
  for (const [id, to] of [[1, 'reader'], [1, 'library'], [2, 'reader'], [3, 'library'], [4, 'reader'], [1, 'mail'], ['1', 'reader']]) await send(id, to);
  assert.deepEqual(got, [['reader', 1], ['library', 1]]);
});

test('chosen text goes to the launcher only while the app is there, and never from a private window', async () => {
  const x = browser();
  const open = { incognito: false };
  assert.equal(x.b.find('hello', open), false, 'no line yet');
  await x.b.start();
  assert.equal(x.b.find('hello', open), false, 'the app has not said it is there');
  x.port().onMessage.fire({ op: 'browser.want', sources: [] });
  await x.settle();
  assert.equal(x.b.find('  a\n  b ', open), true);
  assert.equal(x.b.find('secret', { incognito: true }), false);
  assert.equal(x.b.find('unsaid', {}), false);
  assert.equal(x.b.find('   ', open), false);
  x.b.find('c'.repeat(500), open);
  assert.deepEqual(x.sent('browser.find').map((m) => m.text.length), [3, 200]);
  assert.equal(x.sent('browser.find')[0].text, 'a b');
  x.port().onMessage.fire({ op: 'browser.away' });
  await x.settle();
  assert.equal(x.b.find('later', open), false, 'not once the app is gone');
});

test("a page's text goes to the app once, when it asks, and never a private one's", async () => {
  const asked = [];
  const share = { text: async (t) => { asked.push(t.id); return { title: '', text: t.id === 5 ? '' : 'Words ' + 'x'.repeat(200000) }; } };
  const x = browser({ share, tabs: [tab(1, 'One'), tab(2, 'Secret', { incognito: true }), tab(3, 'File', { url: 'file:///etc/hosts' }), tab(5, 'Empty'), tab(6, 'Unsaid', { incognito: undefined })] });
  const read = async (id) => { x.port().onMessage.fire({ op: 'browser.read', tab: id }); await x.settle(); };
  await x.b.start();
  await read(1);
  assert.deepEqual(asked, [], 'not before the app asked for tabs');
  x.port().onMessage.fire({ op: 'browser.want', sources: ['tabs'] });
  await x.settle();
  for (const id of [1, 2, 3, 5, 6, '1']) await read(id);
  assert.deepEqual(asked, [1, 5]);
  const sent = x.sent('browser.text');
  assert.equal(sent.length, 1, 'nothing for a page with no text');
  assert.equal(sent[0].tab, 1);
  assert.equal(sent[0].title, 'One', "the tab's title when the page has none");
  assert.equal(sent[0].text.length, 100000);
  assert.ok(JSON.stringify(sent[0]).length < 1 << 20);
});
