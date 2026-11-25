// The person's Polycarp theme in the extension: what src/shared/core.js takes of the app's answer, the CSS it builds, and
// what it keeps. Run: node --test tests/theme-rules.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import '../src/shared/core.js';

const P = globalThis.Polycarp;
const shipped = fs.readFileSync(new URL('../src/shared/theme.css', import.meta.url), 'utf8');
const NAMES = [...shipped.slice(0, shipped.indexOf('}')).matchAll(/(--pc-[a-z-]+):/g)].map((m) => m[1]);
const COLORS = [...shipped.slice(shipped.indexOf('[data-theme-mode="dark"]'), shipped.indexOf('@media')).matchAll(/(--pc-[a-z-]+):/g)].map((m) => m[1]);
// The shipped theme's own values, as the app would send them.
const values = (mode, names) => Object.fromEntries(names.map((n) => [n, P.themeVars(shipped, mode)[n.slice(5)]]));
const THEME = {
  mode: 'auto', shared: values('light', NAMES.filter((n) => !COLORS.includes(n))),
  light: values('light', COLORS), dark: values('dark', COLORS),
};
const theme = (change = {}) => ({ ...structuredClone(THEME), ...structuredClone(change) });
const shared = (o) => theme({ shared: { ...THEME.shared, ...o } });
const tell = (rules) => rules.replace(/\s+/g, ' ').trim();

test('the shipped theme, sent as values, builds the shipped rules again', () => {
  assert.equal(NAMES.length, 32);
  assert.equal(COLORS.length, 13);
  const body = shipped.slice(shipped.indexOf(':root'));
  assert.equal(tell(P.themeRules(THEME)), tell(body));
});

test('a theme of one mode pins it, and leaves a part that picked its own mode alone', () => {
  for (const mode of ['light', 'dark']) {
    const css = P.themeRules(theme({ mode }));
    assert.equal(P.themeMode(css), mode);
    assert.equal(P.themeClass(css, mode === 'dark' ? 'light' : 'dark'), 'pc-' + mode);
    assert.doesNotMatch(css, /@media/);
    assert.match(css, new RegExp(':root:not\\(\\[data-theme-mode\\]\\) \\{\\n  color-scheme: ' + mode + ';\\n  --pc-background: ' + THEME[mode]['--pc-background']));
    assert.match(css, /:root\[data-theme-mode="light"\] \{\n  color-scheme: light;\n  --pc-background: #f6f3e8/);
    // Colors in the plain :root block would lose to the shipped rule for dark mode, which names an attribute.
    assert.doesNotMatch(css.slice(0, css.indexOf('}')), /--pc-background/);
  }
  assert.equal(P.themeMode(P.themeRules(THEME)), '');
  assert.equal(P.themeMode(shipped), '');
  assert.equal(P.themeClass(shipped, 'dark'), 'pc-dark');
});

test('no theme is no rules', () => {
  for (const t of [null, undefined, 1, 'x', [], {}, theme({ mode: 'sepia' }), theme({ mode: undefined }), theme({ light: null }), theme({ dark: [] }),
    theme({ light: undefined }), [THEME]]) assert.equal(P.themeRules(t), '', JSON.stringify(t));
  assert.notEqual(P.themeRules(theme({ shared: null })), '', 'colors alone are a theme');
});

test('colors come whole or not at all', () => {
  for (const bad of ['red', '#abc', '#12345g', '#1234567', '#123456;', ' #123456', '#123456\n', 'var(--x)', 'url(https://example.com)', '#f6f3e8;}body{display:none', 7, null, {}, ['#123456']]) {
    for (const mode of ['light', 'dark']) for (const name of ['--pc-background', '--pc-on-accent']) {
      assert.equal(P.themeRules(theme({ [mode]: { ...THEME[mode], [name]: bad } })), '', mode + name + JSON.stringify(bad));
    }
  }
  const less = { ...THEME.dark }; delete less['--pc-done'];
  assert.equal(P.themeRules(theme({ dark: less })), '');
  assert.match(P.themeRules(theme({ light: { ...THEME.light, '--pc-accent': '#ABCDEF' } })), /--pc-accent: #abcdef;/);
});

// For each name: values it takes as they are, and values that must leave no trace.
const CSS_IN_IT = ['1;}body{display:none}', '1px;--pc-accent:red', 'url(https://example.com/a)', 'expression(1)', '\\31 px', '</style>', '1px/**/', '', ' ', '\n', '1px\n', 'var(--a)', 'calc(1px)', 'inherit', '1e3px', '-1px', '+1px', '0x1', '１px'];
const CASES = {
  '--pc-radius': [['0px', '10px', '64px', '2.5px'], ['65px', '10', '10em', '10ms', '99999px', '10 px']],
  '--pc-radius-small': [['0px'], ['65px']], '--pc-radius-large': [['64px'], ['65px']],
  '--pc-border-width': [['0px', '1.5px', '8px'], ['9px', '1']],
  '--pc-blur': [['0px', '80px'], ['81px']],
  '--pc-shadow': [['0', '0.12', '1'], ['1.1', '0.5px', '.5']],
  '--pc-density': [['compact', 'regular', 'spacious'], ['Regular', 'regular;', 'tight']],
  '--pc-indicator': [['dot', 'bar', 'number-block'], ['toString', '__proto__']],
  '--pc-font-size': [['10px', '24px'], ['9px', '25px', '16']],
  '--pc-font-weight': [['300', '800'], ['299', '801', 'bold', '400px']],
  '--pc-line-height': [['1', '1.5', '2'], ['0.9', '2.1', '1.5px']],
  '--pc-motion-fast': [['0ms', '1000ms'], ['1001ms', '1s', '120', '120px', 'NaN', 'Infinity']],
  '--pc-motion-normal': [['200ms'], ['1001ms']], '--pc-motion-slow': [['320ms'], ['1001ms']],
  '--pc-motion-scale-from': [['0.5', '0.98', '1'], ['0.4', '1.1']],
  '--pc-motion-easing': [['ease', 'linear', 'ease-in', 'ease-out', 'ease-in-out', 'cubic-bezier(0.2, 0, 0, 1)', 'cubic-bezier(0.3, -1.5, 0.7, 2.5)'],
    ['steps(4)', 'cubic-bezier(0, 0, 0)', 'cubic-bezier(0, 0, 0, 1, 1)', 'cubic-bezier(2, 0, 0, 1)', 'cubic-bezier(0, 0, -1, 1)', 'cubic-bezier(0, 0, 0, calc(1))', 'cubic-bezier(0, 0, 0, 1);', 'cubic-bezier(a, b, c, d)', 'cubic-bezier(0, 1;--pc-accent:red, 0, 1)', 'ease;', 'ease ']],
  '--pc-font-ui': [['Georgia, serif', '"Iowan Old Style", Georgia, serif', "'Helvetica Neue', Arial, sans-serif", '-apple-system, system-ui', 'Straße, 日本語フォント, serif', 'A_b-c 2, ui-monospace', '"A, B", serif'],
    ['a;}body{', 'a, url(https://example.com)', 'url("a")', '"a\\22 b", serif', '"a;b", serif', '"a{b}", serif', '"a<b", serif', '"a(b", serif', '"a\nb", serif', '"a b", serif', '"a‮b", serif', '"a, serif', "'a\", serif", '"a"b, serif', 'a "b", serif', 'a,', ',a', 'a,,b', '""', '" "', 'a/*b', '"a/*b", serif', 'serif, inherit', 'initial', 'default', '2fast, serif', '@import, serif', 'a!important', 'a:b', '<a>', 'a'.repeat(301)]],
  '--pc-font-display': [['Newsreader, serif'], ['a;b']], '--pc-font-mono': [['Menlo, monospace'], ['a;b']],
};

test('every value but a color is checked by its kind, and one that fails leaves the shipped value', () => {
  assert.deepEqual(Object.keys(CASES).sort(), Object.keys(THEME.shared).sort(), 'every name has cases');
  for (const [name, [good, bad]] of Object.entries(CASES)) {
    for (const v of good) assert.equal(P.soundTheme(shared({ [name]: v })).shared[name], v, name + ' takes ' + v);
    for (const v of [...bad, ...CSS_IN_IT, 1, 0, null, true, [], ['1px'], {}]) {
      const t = shared({ [name]: v });
      assert.ok(!(name in P.soundTheme(t).shared), name + ' refuses ' + JSON.stringify(v));
      assert.doesNotMatch(P.themeRules(t), new RegExp(name + ':'), name);
    }
  }
});

test('a name that is not on the list goes nowhere', () => {
  const odd = JSON.parse('{"__proto__":"1px","--pc-evil":"1px","--pc-radius;}body{":"1px","background":"red","--pc-constructor":"1px","--pc-toString":"1px"}');
  const t = P.soundTheme({ ...shared(odd), light: { ...THEME.light, ...odd }, dark: THEME.dark, evil: 1 });
  assert.deepEqual(t, P.soundTheme(THEME));
  assert.deepEqual(Object.keys(t), ['mode', 'shared', 'light', 'dark']);
  assert.equal(P.themeRules({ ...theme(), shared: Object.create({ '--pc-radius': '3px' }) }).includes('3px'), false, 'an inherited value');
});

test('a font stack with no generic name gets one', () => {
  const of = (o) => P.soundTheme(shared(o)).shared;
  assert.equal(of({ '--pc-font-display': 'Nowhere' })['--pc-font-display'], 'Nowhere, serif');
  assert.equal(of({ '--pc-font-ui': '"Nowhere Sans"' })['--pc-font-ui'], '"Nowhere Sans", system-ui, sans-serif');
  assert.equal(of({ '--pc-font-mono': 'Nowhere Mono' })['--pc-font-mono'], 'Nowhere Mono, ui-monospace, monospace');
});

test('the values in force for a mode: the live rules over the shipped ones', () => {
  const live = P.themeRules(theme({ mode: 'dark', shared: { '--pc-radius': '3px' }, dark: { ...THEME.dark, '--pc-accent': '#c9a24b' } }));
  const css = shipped + '\n' + live;
  assert.deepEqual([P.themeVars(css, 'dark').accent, P.themeVars(css, 'dark').radius, P.themeVars(css, 'dark')['font-size']], ['#c9a24b', '3px', '16px']);
  assert.equal(P.themeVars(css, 'light').accent, '#59693f');
  assert.equal(P.themeVars(shipped, 'dark').accent, '#a9bb8a');
});

test('in a shadow root no rule is left that names :root', () => {
  for (const mode of ['auto', 'light', 'dark']) {
    const css = P.shadowThemeCss(shipped + '\n' + P.themeRules(theme({ mode })));
    assert.doesNotMatch(css, /:root|data-theme-mode|:host[:[]/);
    assert.match(css, /\.pc-dark \{\n  color-scheme: dark/);
  }
  assert.match(P.shadowThemeCss(P.themeRules(theme({ mode: 'dark' }))), /:host \{\n  color-scheme: dark;\n  --pc-background: #2b2e26/);
});

// A stand-in for chrome: storage with change events, the permission, and the app's answer.
function chromeWith({ granted = true, answer = () => ({ ok: true }) } = {}) {
  const data = {}, heard = new Set(), asked = [];
  const tell = (ch) => { for (const fn of heard) fn(ch, 'local'); };
  globalThis.chrome = {
    runtime: { getURL: (f) => f, lastError: undefined, sendNativeMessage: (host, req, cb) => {
      asked.push([host, req]);
      const r = answer(req);
      chrome.runtime.lastError = r instanceof Error ? r : undefined;
      cb(r instanceof Error ? undefined : r);
      chrome.runtime.lastError = undefined;
    } },
    permissions: { contains: async (p) => granted && p.permissions[0] === 'nativeMessaging' },
    storage: { onChanged: { addListener: (fn) => heard.add(fn), removeListener: (fn) => heard.delete(fn) }, local: {
      get: async (k) => structuredClone(Object.fromEntries([k].flat().filter((x) => x in data).map((x) => [x, data[x]]))),
      set: async (o) => { Object.assign(data, structuredClone(o)); writes.push(Object.keys(o)); tell(Object.fromEntries(Object.keys(o).map((k) => [k, { newValue: o[k] }]))); },
      remove: async (k) => { delete data[k]; writes.push(['-' + k]); tell({ [k]: {} }); },
    } },
  };
  globalThis.fetch = async () => ({ text: async () => shipped });
  const writes = [];
  return { data, asked, writes, heard };
}
const kept = (c) => c.data[P.THEME_KEY];

test('asking the app keeps its theme once, and writes again only when it changes', async () => {
  let reply = { ok: true, theme: { ...theme(), evil: '</style>' }, stamp: 'one' };
  const c = chromeWith({ answer: () => reply });
  await P.askTheme();
  assert.deepEqual(c.asked, [['com.polycarp.newtab', { op: 'theme' }]]);
  assert.deepEqual(kept(c), { theme: P.soundTheme(THEME), stamp: 'one' });
  await P.askTheme();
  assert.equal(c.writes.length, 1);
  reply = { ok: true, theme: theme({ mode: 'dark' }), stamp: 'two' };
  await P.askTheme();
  assert.deepEqual([kept(c).theme.mode, kept(c).stamp, c.writes.length], ['dark', 'two', 2]);
  reply = { ok: true };
  await P.askTheme();
  assert.equal(kept(c), undefined, 'the theme went off');
});

test('no app, an app from before this and a theme that is no theme leave the shipped one; a broken answer keeps the last', async () => {
  const gone = [new Error('Specified native messaging host not found.'), new Error('Access to the specified native messaging host is forbidden.'),
    { ok: false, error: 'there is no request called theme' }, { ok: true, theme: theme({ dark: {} }), stamp: 'x' }, { ok: true, theme: 'x' }];
  const broken = [new Error('Native host has exited.'), new Error('Error when communicating with the native messaging host.'), { ok: false, error: 'busy' }, undefined];
  for (const [answers, stays] of [[gone, false], [broken, true]]) for (const answer of answers) {
    const c = chromeWith({ answer: () => answer });
    c.data[P.THEME_KEY] = { theme: P.soundTheme(THEME), stamp: 'one' };
    await P.askTheme();
    assert.equal(!!kept(c), stays, String(answer && (answer.message || JSON.stringify(answer))));
  }
});

test('without the permission the app is not asked, and its theme goes', async () => {
  const c = chromeWith({ granted: false, answer: () => ({ ok: true, theme: theme() }) });
  c.data[P.THEME_KEY] = { theme: THEME, stamp: 'one' };
  await P.askTheme();
  assert.deepEqual([c.asked.length, kept(c)], [0, undefined]);
});

test('switched off: the shipped theme, nothing asked, and what was kept is kept for later', async () => {
  const c = chromeWith({ answer: () => ({ ok: true }) });
  c.data[P.THEME_KEY] = { theme: theme({ mode: 'dark' }), stamp: 'one' };
  assert.equal(P.themeMode(await P.themeCss()), 'dark');
  await P.patchSettings({ matchTheme: false }, { keepProfile: true });
  assert.equal(await P.themeCss(), shipped);
  await P.askTheme();
  assert.deepEqual([c.asked.length, kept(c).stamp], [0, 'one']);
});

test('what is in storage is checked again on the way out', async () => {
  const c = chromeWith();
  c.data[P.THEME_KEY] = { theme: shared({ '--pc-radius': '1px;}body{display:none}' }), stamp: 'one' };
  assert.doesNotMatch(await P.themeCss(), /display:none/);
  for (const odd of ['x', { theme: 'x' }, [], { theme: theme({ light: {} }) }]) {
    c.data[P.THEME_KEY] = odd;
    assert.equal(await P.themeCss(), shipped);
  }
});

test('a watcher hears the theme now and at each change, and nothing once stopped', async () => {
  const c = chromeWith();
  const heard = [];
  const stop = P.watchTheme((css, live) => heard.push([css.includes(shipped), P.themeMode(live)]));
  const settle = () => new Promise((r) => setTimeout(r, 5));
  await settle();
  await chrome.storage.local.set({ [P.THEME_KEY]: { theme: theme({ mode: 'dark' }), stamp: 'one' } });
  await settle();
  await P.patchSettings({ ruler: { on: true } });
  await settle();
  await P.patchSettings({ matchTheme: false });
  await settle();
  assert.deepEqual(heard, [[true, ''], [true, 'dark'], [true, '']]);
  stop();
  await P.patchSettings({ matchTheme: true });
  await settle();
  assert.deepEqual([heard.length, c.heard.size], [3, 0]);
  P.watchTheme(() => heard.push('late'))();
  await settle();
  assert.equal(heard.length, 3, 'stopped before the first answer');
});
