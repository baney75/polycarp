import test from 'node:test'
import assert from 'node:assert/strict'
import { load, control } from './load.mjs'

const S = load('Strings.js')

const filled = (m) => {
  assert.equal(m.fill('%1 of %2', 3, 9), '3 of 9')
  assert.equal(m.fill('%2, then %1', 'a', 'b'), 'b, then a')
  assert.equal(m.fill('%1 %2 %3 %4', 'w', 'x', 'y', 'z'), 'w x y z')
  assert.equal(m.fill('%1 and %2', '%2', 'b'), '%2 and b')
  assert.equal(m.fill('Workspace %1', 'a$&b'), 'Workspace a$&b')
  assert.equal(m.fill('%1 left', undefined), ' left')
}
test('fill puts every value in its place, in one pass, as it is', (t) => {
  filled(S)
  control(t, 'Strings.js', 'values[n] === undefined ? "" : ', '', filled)
  control(t, 'Strings.js', '/%(\\d)/g', '/%(\\d)/', filled)
})

const translated = (m) => {
  m.tables.pt = { copy: 'Copiar', copied: 'Copiado' }
  m.tables.pt_BR = { copy: 'Copie' }
  assert.equal(m.table('pt_BR.UTF-8').copy, 'Copie')
  assert.equal(m.table('pt_BR.UTF-8').copied, 'Copiado')
  assert.equal(m.table('pt-PT').copy, 'Copiar')
  assert.equal(m.table('de_DE').copy, 'Copy')
  assert.equal(m.table('').keyClose, 'Close')
}
test('a translation is found by language and region first, and English fills what it lacks', (t) => {
  translated(load('Strings.js'))
  control(t, 'Strings.js', 'tables[whole] || {}, ', '', translated)
  control(t, 'Strings.js', '.replace("-", "_")', '', translated)
})
