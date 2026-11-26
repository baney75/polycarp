import test from 'node:test'
import assert from 'node:assert/strict'
import { load, control, plain } from './load.mjs'

const C = load('Calendar.js')
const today = { year: 2026, month: 10, day: 25 }

const month = (m) => {
  const sunday = m.days(2026, 10, 0, today)
  assert.equal(sunday.length, 42)
  assert.equal(sunday[0].day, 1)
  assert.deepEqual(plain(sunday.filter((d) => d.today)), [{ year: 2026, month: 10, day: 25, inMonth: true, weekend: false, today: true }])
  const monday = m.days(2026, 10, 1, today)
  assert.deepEqual([monday[0].month, monday[0].day, monday[0].inMonth], [9, 26, false])
  assert.equal(monday[6].day, 1)
  assert.ok(monday[5].weekend && monday[6].weekend && !monday[7].weekend)
  assert.equal(m.days(2028, 1, 0, today).filter((d) => d.inMonth).length, 29)
  assert.equal(m.days(2025, 10, 0, today).filter((d) => d.today).length, 0)
}
test('a month is six rows from the first day of the week', (t) => {
  month(C)
  control(t, 'Calendar.js', '- first + 7', '+ 7', month)
  control(t, 'Calendar.js', 'today.year === d.getUTCFullYear() && ', '', month)
})

const stepping = (m) => {
  assert.deepEqual(plain(m.step(2026, 11, 1)), { year: 2027, month: 0 })
  assert.deepEqual(plain(m.step(2026, 0, -1)), { year: 2025, month: 11 })
  assert.deepEqual(plain(m.step(2026, 10, -12)), { year: 2025, month: 10 })
}
test('months step over the year', (t) => {
  stepping(C)
  control(t, 'Calendar.js', 'Math.floor(at / 12)', 'year', stepping)
})

const clock = (m) => {
  assert.deepEqual(plain(m.time(0, 5, true)), { hour: '12', minute: '05', half: 'AM' })
  assert.deepEqual(plain(m.time(12, 0, true)), { hour: '12', minute: '00', half: 'PM' })
  assert.deepEqual(plain(m.time(16, 9, true)), { hour: '4', minute: '09', half: 'PM' })
  assert.deepEqual(plain(m.time(4, 9, false)), { hour: '04', minute: '09', half: '' })
  assert.equal(m.twelveHour('auto', 'h:mm AP'), true)
  assert.equal(m.twelveHour('auto', 'HH:mm'), false)
  assert.equal(m.twelveHour('12', 'HH:mm'), true)
  assert.equal(m.twelveHour('24', 'h:mm AP'), false)
}
test('the clock follows the setting, then the region', (t) => {
  clock(C)
  control(t, 'Calendar.js', 'hours % 12 === 0 ? 12 : hours % 12', 'hours % 12', clock)
  control(t, 'Calendar.js', 'if (setting === "24") return false', '', clock)
})

test('weekdays start where the week does', () => {
  assert.deepEqual(plain(C.weekdays(1)), [1, 2, 3, 4, 5, 6, 0])
})
