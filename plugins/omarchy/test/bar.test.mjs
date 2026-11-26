import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { load, control, root } from './load.mjs'

const B = load('Bar.js')

const finds = (m) => {
  assert.equal(m.has({ left: [], center: [], right: [{ id: 'baney75.polycarp', show: 'tray' }, { id: 'omarchy.tray' }] }, 'omarchy.tray'), true)
  assert.equal(m.has({ left: ['omarchy.tray'] }, 'omarchy.tray'), true)
  assert.equal(m.has({ right: [{ id: 'baney75.polycarp', show: 'tray' }, { id: 'omarchy.audio' }] }, 'omarchy.tray'), false)
  assert.equal(m.has({ right: [{ id: 'omarchy.tray.extra' }, null, 3] }, 'omarchy.tray'), false)
  assert.equal(m.has(null, 'omarchy.tray'), false)
  assert.equal(m.has({}, 'omarchy.tray'), false)
}
test("the bar's layout says whether a widget is on it, in any region", (t) => {
  finds(B)
  control(t, 'Bar.js', '"left", "center", "right"', '"left", "center"', finds)
  control(t, 'Bar.js', ') === id) return true', ') == id) return false', finds)
})

// The tray part's Loader in Widget.qml waits for the layout and draws only where Omarchy's tray is not placed, so the bar
// has one chevron. The layout is read when it changes, not bound: a binding to it loops as the tray part loads.
const yields = (widget) => {
  const loader = widget.split('Loader {').find((block) => block.includes('TrayPart {'))
  assert.ok(loader, 'a Loader holds the tray part')
  assert.match(/active: (.*)/.exec(loader)[1], /&& root\.omarchyTray === 0$/)
  assert.match(widget, /^  property int omarchyTray: -1$/m)
  assert.match(widget, /omarchyTray = Bar\.has\(bar \? bar\.layoutConfig : null, "omarchy\.tray"\) \? 1 : 0/)
  assert.match(widget, /Component\.onCompleted: readLayout\(\)/)
  assert.match(widget, /function onLayoutConfigChanged\(\) \{ if \(root\) Qt\.callLater\(root\.readLayout\) \}/)
  assert.match(widget, /^import "lib\/Bar\.js" as Bar$/m)
}
test("the tray part steps aside where Omarchy's own tray is on the bar", () => {
  const widget = readFileSync(join(root, 'Widget.qml'), 'utf8')
  yields(widget)
  const faults = [
    [' && root.omarchyTray === 0', ''],
    ['property int omarchyTray: -1', 'property int omarchyTray: Bar.has(bar ? bar.layoutConfig : null, "omarchy.tray") ? 1 : 0'],
    ['Qt.callLater(root.readLayout)', 'root.readLayout()'],
  ]
  for (const [from, to] of faults) {
    const planted = widget.replace(from, to)
    assert.notEqual(planted, widget, from)
    assert.throws(() => yields(planted), from)
  }
})
