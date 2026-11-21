# DC-1 records

## 2026-10-25: copy button renders and copies (narrow check, not the DC-1 Check)

Build: #13 head 8b59ec5, built to a temp folder with
`TABKYRA_NO_BUMP=1 TABKYRA_OUT_DIR=/tmp/tk-ext-check node scripts/build.mjs` and loaded
unpacked into Playwright's headless Chromium (`--headless=new --use-mock-keychain`).

Steps and results:

- Open `chrome-extension://kenehmggpggpiolepbjojeenmeapgfoc/sidepanel.html`. The welcome
  dialog shows "Copy setup prompt for your agent": visible = true.
- Settings > API Keys: the text "posing as" appears 0 times; the button is present.
- Settings > Bridge: the button is present.
- Click the button with `navigator.clipboard.writeText` intercepted. The captured text
  starts "Set up Tabkyra (https://github.com/baney75/tabkyra) so you can use my browser.
  The Tabkyra extension 1.1.8 is already loaded". The toast "Setup prompt copied" count
  = 1.

What this could have failed on: a missing button, the old text still present, a
clipboard write that threw, or a prompt without the version.

`test/agent-setup-prompt.test.mjs` (in CI on every pull request) also fails if the
prompt loses a step, pins no version, builds from an empty version, or matches any skill
lint rule.

## DC-1 Check (clean containers per harness)

Not run. See STATUS.md and decision D7.
