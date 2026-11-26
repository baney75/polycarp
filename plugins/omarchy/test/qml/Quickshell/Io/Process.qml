import QtQuick

// A stand-in for Quickshell's Process: the test says when it ends, with what output and code.
QtObject {
  property var command: []
  property bool running: false
  property bool stdinEnabled: false
  property QtObject stdout: null
  signal started()
  signal exited(int exitCode)
  onRunningChanged: if (running) started()
  function write(text) {}
  // Quickshell does not promise whether the output ends before or after the exit; late puts the exit first.
  function finish(code, text, late) {
    if (!late) end(text)
    running = false
    exited(code)
    if (late) end(text)
  }
  function end(text) {
    if (!stdout) return
    stdout.text = text
    stdout.streamFinished()
  }
}
