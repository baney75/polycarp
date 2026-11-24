// Page edits: what src/shared/edits.js takes, refuses and turns into CSS. spec/edits.json holds the cases the Polycarp
// app's Edits.swift must pass too. Run: node --test tests/edits.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import '../src/shared/edits.js';

const E = globalThis.PolycarpEdits;
const cases = JSON.parse(fs.readFileSync(new URL('../../spec/edits.json', import.meta.url)));
const edit = (o) => { const r = E.check({ id: 'a', sites: ['example.com'], ...o }); assert.ok(r.edit, r.path + ' ' + r.why); return r.edit; };

test('the cases shared with the app', () => {
  assert.ok(cases.accept.length > 10 && cases.refuse.length > 35);
  assert.deepEqual([E.NEVER, E.EDITORS, E.CARRY], [cases.rules.never, cases.rules.editors, cases.rules.carry]);
  for (const c of cases.accept) {
    const r = E.check(c.edit);
    assert.ok(r.edit, c.case + ': ' + r.path + ' ' + r.why);
    assert.deepEqual(E.check(r.edit).edit, r.edit, c.case);
    if (c.sites) assert.deepEqual(r.edit.sites, c.sites, c.case);
  }
  for (const c of cases.refuse) {
    const r = E.check(c.edit);
    assert.ok(!r.edit, c.case + ' was accepted');
    assert.equal(r.path, c.path, c.case + ': ' + r.why);
  }
});

test('a prototype name is not a verb or a field', () => {
  for (const verb of ['constructor', '__proto__', 'toString']) assert.equal(E.check({ id: 'a', sites: ['x.com'], changes: [{ do: verb, at: 'a' }] }).path, 'changes[0].do');
});

test('sites cover their subdomains and nothing else', () => {
  const e = edit({ sites: ['example.com'], css: 'a{}' });
  for (const h of ['example.com', 'www.example.com', 'a.b.example.com']) assert.ok(E.onSite(e, h), h);
  const w = edit({ sites: ['www.gov.uk'], css: 'a{}' });
  assert.ok(E.onSite(w, 'www.gov.uk') && E.onSite(w, 'gov.uk') && !E.onSite(w, 'tax.service.gov.uk'));
  for (const h of ['notexample.com', 'example.com.evil.org', 'com', '']) assert.ok(!E.onSite(e, h), h);
});

test('paths are globs', () => {
  const on = (paths, p) => E.onPath(edit({ paths, css: 'a{}' }), p);
  assert.ok(on([], '/anything') && on(['/home'], '/home/') && on(['/'], '/') && on(['/watch/*'], '/watch/1/2') && on(['/a/*/c'], '/a/b/c'));
  assert.ok(!on(['/home'], '/home/x') && !on(['/watch/*'], '/watc') && !on(['/a/*/c'], '/a/c') && !on(['/'], '/x') && !on(['/ab*ab'], '/ab'));
});

test('the stylesheet never hides the page itself or Polycarp', () => {
  const css = E.sheet([edit({ changes: [{ do: 'hide', at: '*' }, { do: 'style', at: 'p', style: { color: 'red', 'font-size': '18px' } }] })]);
  assert.match(css, /:is\(\*\):not\(html,body,head,polycarp-ui,[a-z,-]+\)\{display:none !important\}/);
  assert.match(css, /:is\(p\):not\(polycarp-ui,[a-z,-]+\)\{color:red !important;font-size:18px !important\}/);
});

test('an app edit switched off here stays off until its agent changes it', () => {
  const raw = { id: 'a', sites: ['x.com'], css: 'a{color:red}' };
  const off = { a: E.fingerprint(E.check(raw).edit) };
  assert.equal(E.merge([raw], [], off).edits[0].enabled, false);
  assert.equal(E.merge([{ ...raw, name: 'New name' }], [], off).edits[0].enabled, false, 'a rename is not a change');
  assert.equal(E.merge([{ ...raw, css: 'a{color:blue}' }], [], off).edits[0].enabled, true);
  assert.equal(E.merge([], [raw], off).edits[0].enabled, true, 'a local edit is its own');
});

test('a bad edit is listed, not thrown, and the rest still apply', () => {
  const r = E.merge([null, 3, { id: 'b' }, { id: 'a', sites: ['x.com'], css: 'a{}' }], 'nonsense');
  assert.deepEqual(r.edits.map((e) => [e.id, e.source]), [['a', 'app']]);
  assert.equal(r.refused.length, 3);
});

test('every change has a line a person can read', () => {
  for (const c of cases.accept) for (const ch of E.check(c.edit).edit.changes) assert.ok(E.describe(ch).length > 4, c.case);
});
