import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { load, control, plain } from './load.mjs'
import { build, target, themes as folder } from '../tools/builtin.mjs'

const L = load('Looks.js')
const { themes } = load('Builtin.js')
const eq = (a, b, why) => assert.deepEqual(plain(a), b, why)

test('the TOML a theme uses is read, and nothing reaches past the table', (t) => {
  const check = (m) => {
    eq(m.parseToml('# a theme\nname = "x"\nsize = 12.5 # points\non = true\n[light]\nbackground = "#FFFFFF" # paper\n[surface.bar]\nfill = \'a # b\'\nquote = "say \\"hi\\""\n'),
      { name: 'x', size: 12.5, on: true, light: { background: '#FFFFFF' }, surface: { bar: { fill: 'a # b', quote: 'say "hi"' } } })
    eq(m.parseToml('[dark]\na = "1"\n[ light ]\na = "2"\n["x"]\na = "3"\n[[y]]\na = "4"\n'), { dark: { a: '1' }, light: { a: '2' } })
    m.parseToml('[__proto__]\nowned = true\n[constructor.prototype]\nowned = true\n')
    assert.equal(m.parseToml('').owned, undefined)
  }
  check(L)
  control(t, 'Looks.js', 'return key === "__proto__" ||', 'return false &&', check)
  control(t, 'Looks.js', '"((?:[^"\\\\]|\\\\.)*)"', '"([^"]*)"', check)
  control(t, 'Looks.js', 'if (!m && line.charAt(0) === "[") { table = {}; continue }', '', check)
})

test('contrast is WCAG contrast', (t) => {
  const check = (m) => {
    assert.equal(m.contrast('#000000', '#ffffff'), 21)
    assert.equal(m.contrast('#ffffff', '#000000'), 21)
    assert.ok(Math.abs(m.contrast('#767676', '#ffffff') - 4.54) < 0.01)
  }
  check(L)
  control(t, 'Looks.js', '(Math.max(x, y) + 0.05)', 'Math.max(x, y)', check)
})

test('a theme takes what it extends, and a loop or a missing piece is no theme', (t) => {
  const check = (m) => {
    const calm = m.resolve('calm', themes)
    assert.equal(calm.title, themes.calm.title)
    for (const mode of m.MODES) for (const role of m.ROLES) assert.ok(m.isHex(calm[mode][role]), `${mode} ${role}`)
    assert.equal(m.resolve('a', { a: { extends: 'b' }, b: { extends: 'a' } }), null)
    assert.equal(m.resolve('a', { a: { extends: 'gone' } }), null)
    assert.equal(m.resolve('a', { a: { light: {}, dark: {} } }), null)
    const mine = m.resolve('mine', { ...themes, mine: { extends: 'polycarp', dark: { accent: '#ffffff' } } })
    assert.equal(mine.dark.accent, '#ffffff')
    assert.equal(mine.dark.background, themes.polycarp.dark.background)
    assert.equal(mine.description, '', 'a description is not inherited')
    assert.equal(mine.title, 'mine', 'nor a title')
  }
  check(L)
  control(t, 'Looks.js', 'for (i = chain.length - 1; i >= 0; i--)', 'for (i = 0; i < chain.length; i++)', check)
  control(t, 'Looks.js', 'if (!isHex(out[MODES[j]][ROLES[i]])) return null', ';', check)
  control(t, 'Looks.js', 'if (i === 0 && t.title)', 'if (t.title)', check)
})

test('every built-in theme becomes an Omarchy theme that reads, in both modes', (t) => {
  const keys = ['accent', 'selection', 'muted', 'background', 'dark_background', 'darker_background', 'lighter_background', 'foreground', 'dark_foreground', 'light_foreground', 'bright_foreground', 'red', 'yellow', 'orange', 'green', 'cyan', 'blue', 'magenta', 'brown', 'bright_red', 'bright_yellow', 'bright_green', 'bright_cyan', 'bright_blue', 'bright_magenta']
  const check = (m) => {
    for (const name of Object.keys(themes)) for (const mode of ['dark', 'light']) {
      const look = m.toOmarchy(m.resolve(name, themes), mode)
      const read = m.parseToml(m.colorsToml(look))
      assert.equal(read.mode, mode)
      eq(Object.keys(read).sort(), ['mode', ...keys].sort())
      for (const key of keys) assert.match(read[key], /^#[0-9a-f]{6}$/, `${name} ${mode} ${key}`)
      eq(look.misses, [], `${name} ${mode}`)
      assert.notEqual(read.blue, read.magenta)
    }
  }
  check(L)
  control(t, 'Looks.js', 'return fit(fromHsl(h, dark ? 0.42 : 0.5, dark ? 0.72 : 0.36)', 'return (fromHsl(h, dark ? 0.42 : 0.5, 0.5)', (m) => check(m))
  control(t, 'Looks.js', '["bright_red", "bright_yellow", "bright_green"', '["bright_yellow", "bright_green"', check)
})

test('a theme that cannot be read is reported by the pair that misses', (t) => {
  const check = (m) => {
    const look = m.toOmarchy(m.resolve('dim', { ...themes, dim: { extends: 'polycarp', dark: { muted: '#4a4d45' } } }), 'dark')
    eq(look.misses.map((x) => [x.role, x.ground, x.least]), [['muted', 'background', 4.5]])
    assert.ok(look.misses[0].ratio < 2)
  }
  check(L)
  control(t, 'Looks.js', 'if (ratio < pairs[i][2])', 'if (ratio < 1)', check)
})

test('Omarchy names are the theme and its mode, and Polycarp alone is not said twice', (t) => {
  const check = (m) => eq([m.omarchyId('polycarp', 'dark'), m.omarchyId('polycarp', 'light'), m.omarchyId('calm', 'dark'), m.omarchyId('calm', 'light')],
    ['polycarp', 'polycarp-light', 'polycarp-calm', 'polycarp-calm-light'])
  check(L)
  control(t, 'Looks.js', '(mode === "light" ? "-light" : "")', '""', check)
})

test('the background is a picture Omarchy accepts, in the theme\'s colors', (t) => {
  const check = (m) => {
    const look = m.toOmarchy(m.resolve('polycarp', themes), 'dark')
    const b = Buffer.from(m.base64(m.backgroundBytes(look)), 'base64')
    assert.equal(b.toString('latin1', 0, 2), 'BM')
    assert.equal(b.readUInt32LE(2), b.length, 'the file says its own length')
    assert.equal(b.length, 54 + 96 * 54 * 3)
    const at = (x, y) => { const i = 54 + ((53 - y) * 96 + x) * 3; return [b[i + 2], b[i + 1], b[i]] }
    const want = [0x2b, 0x2e, 0x26]
    at(0, 0).forEach((v, i) => assert.ok(Math.abs(v - want[i]) < 6, `top left ${at(0, 0)}`))
    assert.ok(at(79, 8)[1] > at(0, 8)[1] + 10, 'the accent lights one corner')
  }
  check(L)
  control(t, 'Looks.js', 'put(54 + row * h, 4)', 'put(54, 4)', check)
  control(t, 'Looks.js', 'for (var y = h - 1; y >= 0; y--)', 'for (var y = 0; y < h; y++)', check)
})

test('the bundled themes are the repo\'s themes', { skip: !existsSync(`${folder}/polycarp.toml`) && 'not in the Polycarp repo' }, () => {
  assert.equal(readFileSync(target, 'utf8'), build(), 'run: node plugins/omarchy/tools/builtin.mjs')
})
