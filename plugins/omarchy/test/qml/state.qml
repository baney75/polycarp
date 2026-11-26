import QtQuick

// Looks.qml and Apps.qml with their scripts stood in for: a panel that opens while a change runs, and a read that fails.
Item {
  id: t

  property var fails: []
  property var steps: []
  property var looks
  property var apps
  // Set at the end of setup: a run that broke before it fails.
  property bool set: false

  function ok(c, why) { if (!c) fails.push(why) }
  function procs(o) {
    var r = { reader: null, writer: null }
    for (var i = 0; i < o.data.length; i++) {
      var p = o.data[i]
      if (typeof p.finish !== "function") continue
      if (p.command && p.command[2] === "list") r.reader = p
      else r.writer = p
    }
    return r
  }

  // One step at a time, each after what the last one queued has run.
  Timer {
    id: next
    interval: 5
    running: true
    onTriggered: {
      if (t.steps.length > 0) { t.steps.shift()(); next.start(); return }
      t.ok(t.set, "setup finished")
      console.log(t.fails.length === 0 ? "state: pass" : "state: FAIL " + t.fails.join("; "))
      Qt.exit(t.fails.length === 0 ? 0 : 1)
    }
  }

  Component.onCompleted: {
    var strings = { looksFailed: "failed", looksLeft: "left", undone: "undone %1", undoFailed: "no undo", saved: "saved %1", saveLeft: "save left", saveFailed: "save failed", removed: "removed", listFailed: "read failed" }
    var lc = Qt.createComponent(Qt.resolvedUrl("../../ui/Looks.qml"))
    var ac = Qt.createComponent(Qt.resolvedUrl("../../ui/Apps.qml"))
    if (lc.status !== Component.Ready || ac.status !== Component.Ready) console.log("state: " + lc.errorString() + ac.errorString())
    looks = lc.createObject(t, { strings: strings })
    apps = ac.createObject(t)
    var l = procs(looks)
    var a = procs(apps)
    ok(l.reader && l.writer && a.reader && a.writer, "the stand-ins are found")
    steps = [
      function() {
        looks.run("apply", "polycarp-calm", "x")
        looks.look()
        l.writer.finish(0, "")
        l.reader.finish(0, "\u001etheme nord\n")
      },
      function() {
        ok(looks.busy !== "", "a read that began before the apply ended does not end it")
        ok(l.reader.running, "another read follows it")
        l.reader.finish(0, "\u001etheme polycarp-calm\n", true)
      },
      function() {
        ok(looks.busy === "", "the read after the apply ends it")
        ok(looks.list.theme === "polycarp-calm", "with the list after it")
        looks.look()
        l.reader.finish(1, "")
      },
      function() {
        ok(looks.list.theme === "polycarp-calm", "a list that cannot be read keeps the last one")
        looks.run("undo", "", "")
        l.writer.finish(0, "")
      },
      function() {
        l.reader.finish(1, "")
      },
      function() {
        ok(looks.said === "read failed", "an undo whose list cannot be read does not name the theme from before it")
        ok(looks.busy === "", "and it ends")
        apps.set("editor", "helix")
        apps.look()
        a.writer.finish(1, "")
        a.reader.finish(0, "editor\tnvim\tnvim\thelix\n")
      },
      function() {
        ok(apps.busy !== "", "apps: a read that began before the change does not end it")
        a.reader.finish(0, "editor\thelix\tnvim\thelix\n", true)
      },
      function() {
        ok(apps.busy === "" && apps.rows[0].now === "helix" && apps.failed, "apps: the read after the change ends it")
        apps.look()
        a.reader.finish(1, "")
      },
      function() { ok(apps.rows.length === 1, "apps: rows that cannot be read keep the last ones") }
    ]
    set = true
  }
}
