// Looks.qml and Apps.qml in Qt's own qml runner, with Quickshell's Process stood in for. Runs where Qt 6 is installed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { root } from './load.mjs'

const qml = ['/usr/lib/qt6/bin/qml', '/usr/lib64/qt6/bin/qml'].find((p) => existsSync(p))

function run(dir) {
  return spawnSync(qml, ['-I', join(dir, 'test/qml'), join(dir, 'test/qml/state.qml')], {
    env: { ...process.env, QT_QPA_PLATFORM: 'offscreen', QT_FORCE_STDERR_LOGGING: '1', QT_LOGGING_RULES: 'qml.debug=true' }, encoding: 'utf8', timeout: 20000
  })
}

// The plugin copied with one planted fault, which the run must catch.
function planted(t, file, from, to) {
  const dir = mkdtempSync(join(tmpdir(), 'polycarp-state-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  cpSync(root, dir, { recursive: true })
  const text = readFileSync(join(dir, file), 'utf8')
  assert.ok(text.includes(from), `control: "${from}" is not in ${file}`)
  writeFileSync(join(dir, file), text.replace(from, to))
  return run(dir)
}

test('a panel that opens while a change runs shows the state after it, and a failed read keeps the last', { skip: !qml && 'no Qt 6 qml here' }, (t) => {
  const r = run(root)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /state: pass/)
  for (const [file, from, to] of [
    ['ui/Looks.qml', 'if (reader.running) again = true\n    else reader.running = true', 'reader.running = true'],
    ['ui/Looks.qml', 'if (ok) list =', 'list ='],
    ['ui/Looks.qml', 'if (reader.code < 0 || !reader.ended) return', 'if (reader.code < 0) return'],
    ['ui/Looks.qml', ': strings.listFailed', ': say(writer.what, writer.target, writer.code)'],
    ['ui/Apps.qml', 'if (reader.running) again = true\n    else reader.running = true', 'reader.running = true'],
    ['ui/Apps.qml', 'if (ok) rows =', 'rows ='],
    ['ui/Apps.qml', 'if (reader.code < 0 || !reader.ended) return', 'if (reader.code < 0) return']
  ]) assert.notEqual(planted(t, file, from, to).status, 0, `control: ${file} with "${from}" as "${to}"`)
})
