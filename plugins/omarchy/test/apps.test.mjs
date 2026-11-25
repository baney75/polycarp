import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load, control, plain } from './load.mjs'

const A = load('Apps.js')
const eq = (a, b) => assert.deepEqual(plain(a), b)

test('each kind has its installed choices and the one in use', (t) => {
  const check = (m) => {
    const rows = m.parse('browser\tchromium\tchromium\tfirefox\neditor\tzeditor\tzed\tnvim\nagent\t\nterminal\tweird.desktop\tfoot\n')
    eq(rows.map((r) => [r.kind, r.choices.map((c) => `${c.title}${c.now ? '*' : ''}`)]), [
      ['browser', ['Chromium*', 'Firefox']], ['editor', ['Zed*', 'Neovim']], ['agent', []], ['terminal', ['Weird*', 'Foot']]])
    assert.equal(rows[3].choices[0].set, false, 'what Omarchy does not offer cannot be set')
    eq(m.parse(''), [])
  }
  check(A)
  control(t, 'Apps.js', 'zeditor: "zed"', 'zeditor: "x"', check)
  control(t, 'Apps.js', 'choices.unshift(', 'void (', check)
})

test('the keys skip a kind with no choice and stop at the ends', (t) => {
  const rows = A.parse('browser\ta\ta\tb\tc\nagent\t\nterminal\tx\tx\n')
  const check = (m) => {
    eq(m.step(rows, { row: 0, col: 2 }, 0, 1), { row: 2, col: 0 })
    eq(m.step(rows, { row: 2, col: 0 }, 0, 1), { row: 2, col: 0 })
    eq(m.step(rows, { row: 2, col: 0 }, 0, -1), { row: 0, col: 0 })
    eq(m.step(rows, { row: 0, col: 2 }, 1, 0), { row: 0, col: 2 })
    eq(m.step(rows, { row: 0, col: 0 }, -1, 0), { row: 0, col: 0 })
    eq(m.step([], { row: 0, col: 0 }, 1, 0), { row: 0, col: 0 })
  }
  check(A)
  control(t, 'Apps.js', 'if (rows[r].choices.length === 0) continue', ';', check)
  control(t, 'Apps.js', 'Math.min(n - 1, col + dx)', '(col + dx)', check)
})
