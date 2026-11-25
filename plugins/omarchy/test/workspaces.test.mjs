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
}
test('empty ones fill the first numbers of the monitor, not the ones another holds', (t) => {
  padded(W)
  control(t, 'Workspaces.js', 'if (seen[id] !== undefined) continue', '', padded)
  control(t, 'Workspaces.js', 'Math.floor((id - 1) / 10) * 10 + 1 : 1', '1 : 1', padded)
})

const named = (m) => {
  const all = [ws(-1338, { name: 'mail', windows: [win('m')] }), ws(2, { windows: [win('a')] }), ws(-1337, { name: 'chat', windows: [win('c')] })]
  assert.deepEqual(ids(m.shown(all, 'A', 2, 0)), [2, -1337, -1338])
  assert.equal(m.label(all[0], 'numbers'), 'mail')
  assert.equal(m.focusCommand(all[0]), 'hl.dsp.focus({ workspace = "name:mail" })')
}
test('named workspaces come after the numbers and go by name', (t) => {
  named(W)
  control(t, 'Workspaces.js', "if (an !== bn) return an ? -1 : 1", '', named)
})

test('a number is its place in the monitor\'s ten', () => {
  assert.equal(W.label(ws(1), 'numbers'), '1')
  assert.equal(W.label(ws(10), 'numbers'), '10')
  assert.equal(W.label(ws(12), 'numbers'), '2')
  assert.equal(W.label(ws(4, { name: 'web' }), 'numbers'), '4')
  assert.equal(W.label(ws(4, { name: 'web' }), 'names'), 'web')
  assert.equal(W.label(ws(4), 'names'), '4')
})

const icons = (m) => {
  const windows = ['foot', 'foot', 'zed', '', 'mail', 'web', 'web'].map((a) => win(a))
  assert.deepEqual(plain(m.icons(windows, 3)), { apps: ['foot', 'zed', 'mail'], more: 1 })
  assert.deepEqual(plain(m.icons(windows, 0)), { apps: [], more: 4 })
  assert.deepEqual(plain(m.icons([], 3)), { apps: [], more: 0 })
}
test('each app shows once, then how many are left out', (t) => {
  icons(W)
  control(t, 'Workspaces.js', '|| seen[app]', '', icons)
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
}
test('the wheel goes one workspace a notch and stops at the ends', (t) => {
  wheel(W)
  control(t, 'Workspaces.js', '(rest !== 0 && (rest > 0) !== (delta > 0))', '(false)', wheel)
})

const quoting = (m) => {
  assert.equal(m.focusCommand(ws(-1337, { name: 'a"b\\c\nd' })), 'hl.dsp.focus({ workspace = "name:a\\"b\\\\c d" })')
  assert.equal(m.windowCommand('0x5f'), 'hl.dsp.focus({ window = "address:0x5f" })')
  assert.equal(m.windowCommand('5f'), 'hl.dsp.focus({ window = "address:0x5f" })')
  assert.equal(m.windowCommand('5f" })os.exit()'), '')
}
test('a name or an address cannot leave its Lua string', (t) => {
  quoting(W)
  control(t, 'Workspaces.js', '.replace(/"/g, "\\\\\\"")', '', quoting)
})

test('the layout glyph follows the workspace', () => {
  assert.equal(W.layoutKind('dwindle'), 'tiled')
  assert.equal(W.layoutKind('scrolling'), 'scrolling')
  assert.equal(W.layoutKind('monocle'), 'single')
  assert.equal(W.layoutKind(''), '')
})

test('a mark says what is on it', () => {
  const s = { workspace: 'Workspace %1', wantsYou: 'wants you' }
  assert.equal(W.describe(ws(2, { windows: [win('foot', 'notes')], urgent: true }), false, s), 'Workspace 2  notes  wants you')
})
