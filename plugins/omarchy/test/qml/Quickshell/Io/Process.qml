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
  function finish(code, text) {
    if (stdout) stdout.text = text
    running = false
    exited(code)
  }
}
