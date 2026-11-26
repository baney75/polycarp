import test from 'node:test'
import assert from 'node:assert/strict'
import { load, control, plain } from './load.mjs'

const W = load('Workspaces.js')
const ws = (id, o = {}) => ({ id, name: String(id), monitor: 'A', windows: [], urgent: false, layout: 'dwindle', ...o })
const win = (app, title = app) => ({ app, title })
const ids = (list) => plain(list.map((w) => w.id))

const onlyWhatMatters = (m) => {
  const all = [ws(3, { windows: [win('foot')] }), ws(1), ws(2, { monitor: 'B', windows: [win('x')] }), ws(7, { urgent: true }), ws(-98, { name: 'special:magic', windows: [win('y')] })]
  assert.deepEqual(ids(m.shown(all, 'A', 1, 0)), [1, 3, 7])
}
test('a monitor shows its own workspaces with windows, the one you are on and one that wants you', (t) => {
  onlyWhatMatters(W)
  control(t, 'Workspaces.js', 'if (w.monitor !== monitor) continue', '', onlyWhatMatters)
  control(t, 'Workspaces.js', 'if (!real(w.id)) continue', '', onlyWhatMatters)
  control(t, 'Workspaces.js', ' || w.urgent', '', onlyWhatMatters)
})

const padded = (m) => {
  assert.deepEqual(ids(m.shown([ws(1), ws(2, { monitor: 'B' }), ws(8, { windows: [win('a')] })], 'A', 1, 5)), [1, 3, 4, 5, 8])
  assert.deepEqual(ids(m.shown([ws(12)], 'A', 12, 3)), [11, 12, 13])
  assert.deepEqual(ids(m.shown([ws(1), ws(2)], 'A', 1, 3)), [1, 2, 3])
  assert.deepEqual(ids(m.shown([ws(11), ws(-1337, { name: 'chat' })], 'A', -1337, 3)), [11, 12, 13, -1337])
  assert.equal(ids(m.shown([ws(1)], 'A', 1, 12)).length, 10)
  assert.deepEqual(ids(m.shown([ws(1), ws(2), ws(-1337, { name: 'chat', monitor: 'B' })], 'B', -1337, 5)), [-1337])
}
test('empty ones fill the first numbers of the monitor, not the ones another holds', (t) => {
  padded(W)
  control(t, 'Workspaces.js', 'if (seen[id] !== undefined) continue', '', padded)
  control(t, 'Workspaces.js', 'Math.floor((id - 1) / 10) * 10 + 1 : 0', '1 : 0', padded)
  control(t, 'Workspaces.js', ') id = w.id', ') id = id', padded)
  control(t, 'Workspaces.js', 'Math.min(empty, 10)', 'empty', padded)
  control(t, 'Workspaces.js', 'i < empty && first > 0', 'i < empty', padded)
})

const named = (m) => {
  const all = [ws(-1338, { name: 'mail', windows: [win('m')] }), ws(2, { windows: [win('a')] }), ws(-1337, { name: 'chat', windows: [win('c')] })]
  assert.deepEqual(ids(m.shown(all, 'A', 2, 0)), [2, -1337, -1338])
  assert.equal(m.label(all[0], 'numbers', 1), 'mail')
  assert.equal(m.focusCommand(all[0]), 'hl.dsp.focus({ workspace = "name:mail" })')
}
test('named workspaces come after the numbers and go by name', (t) => {
  named(W)
  control(t, 'Workspaces.js', "if (an !== bn) return an ? -1 : 1", '', named)
})

const labels = (m) => {
  assert.equal(m.label(ws(1), 'numbers', 1), '1')
  assert.equal(m.label(ws(10), 'numbers', 1), '10')
  assert.equal(m.label(ws(12), 'numbers', 11), '2')
  assert.equal(m.label(ws(11), 'numbers', 1), '11')
  assert.equal(m.label(ws(1), 'numbers', 11), '1')
  assert.equal(m.label(ws(21), 'numbers', 11), '21')
  assert.equal(m.label(ws(3), 'numbers', 0), '3')
  assert.equal(m.label(ws(4, { name: 'web' }), 'numbers', 1), '4')
  assert.equal(m.label(ws(4, { name: 'web' }), 'names', 1), 'web')
  assert.equal(m.label(ws(4), 'names', 1), '4')
}
test('a number is its place in the monitor\'s ten, and one from another ten keeps its own', (t) => {
  labels(W)
  control(t, 'Workspaces.js', 'workspace.id >= first && ', '', labels)
  control(t, 'Workspaces.js', 'workspace.id < first + 10', 'true', labels)
  control(t, 'Workspaces.js', 'first > 0 && workspace.id', 'workspace.id', labels)
  control(t, 'Workspaces.js', 'style === "names" && named', 'named', labels)
})

const icons = (m) => {
  const windows = ['foot', 'foot', 'zed', '', 'mail', 'web', 'web'].map((a) => win(a))
  assert.deepEqual(plain(m.icons(windows, 3)), { apps: ['foot', 'zed', 'mail'], more: 1 })
  assert.deepEqual(plain(m.icons(windows, 0)), { apps: [], more: 4 })
  assert.deepEqual(plain(m.icons([], 3)), { apps: [], more: 0 })
  assert.deepEqual(plain(m.icons([win('constructor')], 3)).apps, ['constructor'])
}
test('each app shows once, then how many are left out', (t) => {
  icons(W)
  control(t, 'Workspaces.js', '|| seen[app]', '', icons)
  control(t, 'Workspaces.js', 'Object.create(null)', '{}', icons)
})

const wheel = (m) => {
  const marks = [ws(1), ws(3), ws(7)]
  assert.equal(m.step(marks, 1, 1).id, 3)
  assert.equal(m.step(marks, 7, 1), null)
  assert.equal(m.step(marks, 1, -1), null)
  assert.equal(m.step(marks, 99, 1), null)
  assert.deepEqual(plain(m.wheel(0, 120)), { steps: 1, rest: 0 })
  assert.deepEqual(plain(m.wheel(90, 60)), { steps: 1, rest: 30 })
  assert.deepEqual(plain(m.wheel(90, -20)), { steps: 0, rest: -20 })
  assert.deepEqual(plain(m.wheel(0, -250)), { steps: -2, rest: -10 })
  assert.deepEqual(plain(m.wheel(90, 0)), { steps: 0, rest: 90 })
}
test('the wheel goes one workspace a notch and stops at the ends', (t) => {
  wheel(W)
  control(t, 'Workspaces.js', 'rest * delta < 0', 'false', wheel)
})

const quoting = (m) => {
  assert.equal(m.focusCommand(ws(-1337, { name: 'a"b\\c\nd' })), 'hl.dsp.focus({ workspace = "name:a\\"b\\\\c d" })')
  assert.equal(m.windowCommand('0x5f'), 'hl.dsp.focus({ window = "address:0x5f" })')
  assert.equal(m.windowCommand('0X5F'), 'hl.dsp.focus({ window = "address:0x5F" })')
  assert.equal(m.windowCommand('5f'), 'hl.dsp.focus({ window = "address:0x5f" })')
  assert.equal(m.windowCommand('5f" })os.exit()'), '')
}
test('a name or an address cannot leave its Lua string', (t) => {
  quoting(W)
  control(t, 'Workspaces.js', '.replace(/"/g, "\\\\\\"")', '', quoting)
})

const layouts = (m) => {
  assert.equal(m.layoutKind('dwindle'), 'tiled')
  assert.equal(m.layoutKind('scrolling'), 'scrolling')
  assert.equal(m.layoutKind('monocle'), 'single')
  assert.equal(m.layoutKind(''), '')
}
test('the layout glyph follows the workspace', (t) => {
  layouts(W)
  control(t, 'Workspaces.js', 'name === "scrolling"', 'false', layouts)
})

const described = (m) => {
  const s = { workspace: 'Workspace %1', wantsYou: 'wants you' }
  assert.equal(m.describe(ws(2, { windows: [win('foot', 'notes')], urgent: true }), s), 'Workspace 2  notes  wants you')
  assert.equal(m.describe(ws(-1337, { name: 'a$$b' }), s), 'Workspace a$$b')
}
test('a mark says what is on it', (t) => {
  described(W)
  control(t, 'Workspaces.js', 'if (workspace.urgent)', 'if (false)', described)
  control(t, 'Workspaces.js', 'function() { return workspace.name || workspace.id }', 'workspace.name || workspace.id', described)
})
