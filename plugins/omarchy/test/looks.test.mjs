import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { load, control, plain } from './load.mjs'
import { build, target, themes as folder } from '../tools/builtin.mjs'

const L = load('Looks.js')
const { themes } = load('Builtin.js')
const eq = (a, b, why) => assert.deepEqual(plain(a), b, why)

// Two real shapes from Omarchy: a dark one whose muted is faint, a light one whose colors are pastel.
const faint = { mode: 'dark', accent: '#81a1c1', selection: '#4c566a', muted: '#4c566a', background: '#2e3440', dark_background: '#242933', lighter_background: '#3b4252', foreground: '#d8dee9', bright_foreground: '#eceff4', red: '#bf616a', yellow: '#ebcb8b', green: '#a3be8c' }
const pastel = { mode: 'light', accent: '#1e66f5', selection: '#ccd0da', muted: '#acb0be', background: '#eff1f5', dark_background: '#e6e9ef', lighter_background: '#ffffff', foreground: '#4c4f69', red: '#d20f39', yellow: '#df8e1d', green: '#40a02b' }

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

test('dim text is quiet but still reads at 3 to 1, even from a theme whose ink is only just dark enough', (t) => {
  const check = (m) => {
    const grey = m.resolve('grey', { ...themes, grey: { extends: 'polycarp', light: { foreground: '#6b6b64' } } })
    assert.ok(m.contrast(grey.light.foreground, grey.light.background) >= 4.5)
    for (const theme of [grey, ...Object.keys(themes).map((name) => m.resolve(name, themes))]) for (const mode of ['dark', 'light']) {
      const c = m.toOmarchy(theme, mode).colors
      assert.ok(m.contrast(c.dark_foreground, c.background) >= 3, `${theme.name} ${mode}`)
      assert.ok(m.contrast(c.dark_foreground, c.background) < m.contrast(c.foreground, c.background), `${theme.name} ${mode} stays quieter`)
    }
  }
  check(L)
  control(t, 'Looks.js', 'dark_foreground: fit(mix(r.foreground, r.background, 0.45), ground, MARK, r.foreground)', 'dark_foreground: mix(r.foreground, r.background, 0.45)', check)
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

test('an Omarchy theme becomes a Polycarp theme that Polycarp would accept, and says what moved', (t) => {
  const check = (m) => {
    for (const [id, colors, mode] of [['nord', faint, 'dark'], ['catppuccin-latte', pastel, 'light']]) {
      const made = m.fromOmarchy(id, colors, 'JetBrainsMono Nerd Font')
      assert.equal(made.mode, mode)
      eq(made.misses, [], id)
      for (const role of m.ROLES) assert.ok(m.isHex(made.colors[role]), role)
      assert.equal(made.colors.background, colors.background, 'the page is the theme\'s own')
      assert.equal(made.colors.foreground, colors.foreground)
      const muted = made.fitted.find((f) => f.role === 'muted')
      assert.equal(muted.was, colors.muted)
      assert.ok(muted.ratio < 4.5)
      assert.ok(!made.fitted.some((f) => f.role === 'foreground'))
    }
    assert.equal(m.fromOmarchy('x', { mode: 'dark', background: 'red' }, ''), null)
    const { mode, ...unsaid } = pastel
    assert.equal(m.fromOmarchy('latte', unsaid, '').mode, 'light', 'a palette that does not say its mode has its page\'s')
    assert.equal(m.fromOmarchy('nord', { ...faint, mode: undefined }, '').mode, 'dark')
    const deep = m.fromOmarchy('deep', { mode: 'light', background: '#ffffff', foreground: '#222222', dark_background: '#b0b0b0', red: '#c0392b' }, '')
    eq(deep.misses, [], 'status on a dark sunken ground still reads')
    assert.ok(deep.fitted.some((f) => f.role === 'urgent'))
  }
  check(L)
  control(t, 'Looks.js', ', [want.sunken], MARK, far)', ', [], MARK, far)', check)
  control(t, 'Looks.js', ' : contrast("#000000", bg) > contrast("#ffffff", bg) ? "light" : "dark"', ' : "dark"', check)
  control(t, 'Looks.js', 'out.muted = fit(want.muted, grounds, TEXT, out.strong)', ';', check)
  control(t, 'Looks.js', 'colors.mode === "light" || colors.mode === "dark" ? colors.mode :', '"dark" ||', check)
})

test('the Polycarp theme written is one Polycarp reads: names, mode, font', (t) => {
  const check = (m) => {
    const made = m.fromOmarchy('Tokyo Night!', faint, 'JetBrainsMono Nerd Font')
    const toml = m.parseToml(m.themeToml(made))
    assert.equal(toml.name, 'omarchy-tokyo-night')
    assert.equal(toml.title, 'Tokyo Night')
    assert.equal(toml.extends, 'polycarp')
    assert.equal(toml.dark.background, '#2e3440')
    assert.equal(toml.light, undefined)
    assert.equal(toml.type.mono, "'JetBrainsMono Nerd Font', monospace")
    assert.equal(m.parseToml(m.themeToml(m.fromOmarchy('x', faint, 'bad"; font'))).type, undefined)
    assert.match(m.fromOmarchy('a'.repeat(90), faint, '').id, /^[a-z][a-z0-9-]{0,47}$/)
  }
  check(L)
  control(t, 'Looks.js', 'if (/^[A-Za-z0-9 _-]{1,60}$/.test(made.font))', 'if (made.font)', check)
  control(t, 'Looks.js', '.slice(0, 39)', '', check)
})

test('a round trip keeps the colors both sides name', (t) => {
  const check = (m) => {
    const calm = m.resolve('parchment', themes)
    const back = m.fromOmarchy('p', m.parseToml(m.colorsToml(m.toOmarchy(calm, 'light'))), '')
    for (const role of ['background', 'surface', 'sunken', 'foreground', 'strong', 'muted', 'accent', 'selection', 'urgent', 'working', 'done'])
      assert.equal(back.colors[role], calm.light[role].toLowerCase(), role)
    eq(back.fitted, [])
  }
  check(L)
  control(t, 'Looks.js', 'lighter_background: r.surface', 'lighter_background: r.sunken', check)
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

test('the list on disk is read by section', (t) => {
  const check = (m) => {
    const list = m.parseList('\u001etheme nord\n\u001efont JetBrainsMono Nerd Font\n\u001ecolors\nmode = "dark"\nred = "#ff0000"\n\u001euser mine\ntitle = "Mine"\n[dark]\naccent = "#ffffff"\n\u001etaken polycarp-calm\n\u001eundo\n')
    assert.equal(list.theme, 'nord')
    assert.equal(list.font, 'JetBrainsMono Nerd Font')
    eq(list.colors, { mode: 'dark', red: '#ff0000' })
    eq(list.user, { mine: { title: 'Mine', dark: { accent: '#ffffff' } } })
    eq(list.taken, { 'polycarp-calm': true })
    assert.equal(list.undo, true)
    assert.equal(m.parseList('').undo, false)
  }
  check(L)
  control(t, 'Looks.js', 'if (section === "undo") out.undo = true', ';', check)
})

test('the looks offered: built-ins first, the user\'s own that are whole, never one that came from Omarchy', (t) => {
  const check = (m) => {
    const all = m.offer(themes, {
      mine: { extends: 'polycarp', title: 'Mine', dark: { accent: '#ffffff' } }, broken: { extends: 'gone' },
      polycarp: { title: 'Not this', extends: 'evening', dark: { accent: '#dddddd' } }, 'omarchy-nord': { extends: 'polycarp', dark: { accent: '#eeeeee' } },
      hasOwnProperty: { extends: 'gone' }
    }, { 'polycarp-evening': true })
    eq(all.map((x) => x.name), ['polycarp', 'still-water', 'evening', 'parchment', 'mine'], 'blocks and calm are the default in other shapes')
    assert.equal(all[0].title, 'Polycarp')
    eq(all.map((x) => x.own), [false, false, false, false, true])
    eq(all[2].taken, { dark: true, light: false })
  }
  check(L)
  control(t, 'Looks.js', ' && key.indexOf("omarchy-") !== 0', '', check)
  control(t, 'Looks.js', 'if (!own(builtin, key) &&', 'if (', check)
  control(t, 'Looks.js', 'if (seen[colors] || seen[ids[0]]', 'if (seen[ids[0]]', check)
  control(t, 'Looks.js', 'return Object.prototype.hasOwnProperty.call(o, k)', 'return o.hasOwnProperty(k)', check)
})

test('no two looks offered share an Omarchy id; the one listed first keeps it', (t) => {
  const check = (m) => {
    const all = m.offer(themes, {
      mine: { extends: 'polycarp', dark: { accent: '#ffffff' } }, 'mine-light': { extends: 'polycarp', dark: { accent: '#eeeeee' } },
      light: { extends: 'polycarp', dark: { accent: '#dddddd' } }
    }, {})
    const names = all.map((x) => x.name)
    assert.ok(names.includes('mine'))
    assert.ok(!names.includes('mine-light'), 'mine-light in dark would overwrite mine in light')
    assert.ok(!names.includes('light'), 'light in dark would overwrite the built-in polycarp in light')
    const ids = all.flatMap((x) => [x.dark.id, x.light.id])
    eq(ids.length, new Set(ids).size)
  }
  check(L)
  control(t, 'Looks.js', 'if (seen[colors] || seen[ids[0]] || seen[ids[1]]) continue', 'if (seen[colors]) continue', check)
})

test('the bundled themes are the repo\'s themes', { skip: !existsSync(`${folder}/polycarp.toml`) && 'not in the Polycarp repo' }, () => {
  assert.equal(readFileSync(target, 'utf8'), build(), 'run: node plugins/omarchy/tools/builtin.mjs')
})
