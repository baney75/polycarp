// What the whole folder must be, whoever edits it next: whole, small, quiet, themed, worded in one place.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { load, root } from './load.mjs'

const files = readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => !e.isDirectory())
  .map((e) => relative(root, join(e.parentPath, e.name))).filter((f) => !f.startsWith('.git'))
const text = (f) => readFileSync(join(root, f), 'utf8')
const shown = files.filter((f) => extname(f) === '.qml')
const source = new Map([...shown, ...files.filter((f) => f.startsWith('scripts/') || f.startsWith('lib/'))].map((f) => [f, text(f)]))

// Each rule says what is wrong with one file, or nothing.
const rules = {
  color: (s) => /#[0-9a-fA-F]{3,8}"|Qt\.rgba\(\s*[\d.]+\s*,|color: "(?!transparent)/.exec(s)?.[0],
  font: (s) => /font\.(pixelSize|pointSize|family): *["\d]/.exec(s)?.[0],
  poll: (s) => /repeat: *true|triggeredOnStart|\bsetInterval\b/.exec(s)?.[0],
  net: (s) => /XMLHttpRequest|\b(curl|wget)\b|https?:\/\//.exec(s)?.[0],
  root: (s) => /\b(sudo|pkexec|doas)\b/.exec(s)?.[0],
  word: (s) => /\b(text|title|description|tooltipText): *"[A-Za-z]{3}/.exec(s)?.[0],
  dash: (s) => /[\u2013\u2014]/.exec(s)?.[0],
}
const broken = (rule, from = source) => [...from].map(([f, s]) => [f, rules[rule](s)]).filter(([, hit]) => hit)

const planted = {
  color: 'color: "#ff0000"', font: 'font.pixelSize: 13', poll: 'Timer { repeat: true }', net: 'curl -s x',
  root: 'sudo true', word: 'text: "Workspaces"', dash: `a ${String.fromCharCode(0x2014)} b`,
}
for (const rule of Object.keys(rules)) {
  test(`no ${rule} in the source, and one planted is found`, () => {
    const where = rule === 'dash' ? new Map(files.filter((f) => f !== 'preview.png').map((f) => [f, text(f)])) : rule === 'color' || rule === 'font' || rule === 'word' ? new Map([...source].filter(([f]) => shown.includes(f))) : source
    assert.deepEqual(broken(rule, where), [])
    assert.equal(broken(rule, new Map([['x', planted[rule]]])).length, 1)
  })
}

test('the manifest names files that are here, and its settings are the ones read', () => {
  const m = JSON.parse(text('manifest.json'))
  assert.equal(m.id, 'baney75.polycarp')
  for (const entry of Object.values(m.entryPoints)) assert.ok(files.includes(entry), entry)
  const read = [...new Set([...source.values()].flatMap((s) => [...s.matchAll(/setting\("(\w+)"/g)].map((x) => x[1])))].sort()
  assert.deepEqual(m.barWidget.schema.map((x) => x.key).sort(), read)
  for (const x of m.barWidget.schema) {
    assert.deepEqual(x.defaultValue, m.barWidget.defaults[x.key], x.key)
    assert.ok(text('README.md').includes(`\`${x.key}\``), `README says nothing of ${x.key}`)
  }
})

test('every word used is in the table, and every word in the table is used', () => {
  const have = Object.keys(load('Strings.js').en)
  const all = [...source].filter(([f]) => f !== 'lib/Strings.js').map(([, s]) => s).join('\n')
  const used = new Set([...all.matchAll(/strings\.([a-zA-Z]+)/g)].map((x) => x[1]))
  assert.deepEqual([...used].filter((k) => !have.includes(k)), [])
  assert.deepEqual(have.filter((k) => !new RegExp(`\\b${k}\\b`).test(all)), [])
})

test('small, plain files, with a license and a readme that says how to install and remove it', () => {
  for (const f of files) assert.ok(lstatSync(join(root, f)).isFile(), `${f} is not a plain file`)
  const bytes = files.reduce((n, f) => n + lstatSync(join(root, f)).size, 0)
  assert.ok(bytes < 2 * 1024 * 1024, `${bytes} bytes`)
  assert.match(text('LICENSE'), /^MIT License/)
  for (const line of ['omarchy plugin add', 'omarchy plugin remove baney75.polycarp', '## Needs']) assert.ok(text('README.md').includes(line), line)
})

// The PNG signature holds a CRLF, so an image git treated as text no longer starts with it.
const pngs = (files) => files.filter((f) => extname(f) === '.png')
const whole = (bytes) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
test('images are as they were made, not rewritten as text', () => {
  const found = pngs(readdirSync(root, { recursive: true }))
  assert.ok(found.length > 0)
  for (const f of found) assert.ok(whole(readFileSync(join(root, f))), `${f} is not a whole PNG`)
  assert.ok(!whole(Buffer.from(readFileSync(join(root, found[0])).toString('latin1').replace(/\r\n/g, '\n'), 'latin1')))
})
