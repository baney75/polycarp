// The two scripts that write, in a scratch HOME with stand-ins for Omarchy's commands.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load, root, plain } from './load.mjs'

const L = load('Looks.js')
const { themes } = load('Builtin.js')
const ready = ['sha256sum', 'base64'].every((c) => spawnSync('sh', ['-c', `command -v ${c}`]).status === 0)
const skip = !ready && 'no sha256sum here'

const OMARCHY = `#!/bin/bash
c=\${HOME:?}/.local/state/omarchy/current
case "$1 $2" in
"theme set") [[ -d $HOME/.config/omarchy/themes/$3 || -d $OMARCHY_PATH/themes/$3 ]] || exit 1
  rm -rf -- "\${c:?}/theme"; mkdir -p "$c"; cp -r "$OMARCHY_PATH/themes/$3" "$c/theme" 2>/dev/null || cp -r "$HOME/.config/omarchy/themes/$3" "$c/theme"
  echo "$3" >"$c/theme.name"; ln -nsf "$(ls "$c"/theme/backgrounds/* | head -n 1)" "$c/background" ;;
"theme bg") ln -nsf "$4" "$c/background" ;;
"default agent") echo "$*" >>"$HOME/ran" ;;
"default editor") echo "$3" >"$HOME/editor" ;;
esac
`

function desk(t, edit = (s) => s) {
  const home = mkdtempSync(join(tmpdir(), 'polycarp-omarchy-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const at = (...p) => join(home, ...p)
  const write = (p, text, mode) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text); if (mode) chmodSync(p, mode) }
  for (const name of ['looks', 'apps']) write(at('scripts', name), edit(readFileSync(join(root, 'scripts', name), 'utf8')), 0o755)
  write(at('bin/omarchy'), OMARCHY, 0o755)
  write(at('bin/omarchy-font-current'), '#!/bin/bash\necho "JetBrainsMono Nerd Font"\n', 0o755)
  for (const name of ['nord', 'gruvbox']) {
    write(at('share/themes', name, 'colors.toml'), `mode = "dark"\nbackground = "#2e3440"\n# ${name}\n`)
    write(at('share/themes', name, 'backgrounds/1.png'), name)
    write(at('share/themes', name, 'backgrounds/2.png'), `${name} two`)
  }
  // Only the scratch HOME's apps: a host's own Chromium must not count as installed.
  const env = { HOME: home, OMARCHY_PATH: at('share'), PATH: `${at('bin')}:${process.env.PATH}`, XDG_DATA_HOME: at('.local/share'), XDG_DATA_DIRS: at('share') }
  const run = (script, args, input = '') => spawnSync('bash', [at('scripts', script), ...args], { env, input, encoding: 'utf8' })
  const omarchy = (...args) => execFileSync(at('bin/omarchy'), args, { env })
  const payload = (name, mode) => { const look = L.toOmarchy(L.resolve(name, themes), mode); return `${L.base64(L.backgroundBytes(look))}\n${L.colorsToml(look)}` }
  omarchy('theme', 'set', 'nord')
  omarchy('theme', 'bg', 'set', at('.local/state/omarchy/current/theme/backgrounds/2.png'))
  return {
    at, write, omarchy,
    looks: (...args) => run('looks', args),
    apply: (id, name = 'calm', mode = 'dark') => run('looks', ['apply', id], payload(name, mode)).status,
    importTheme: (id, text) => run('looks', ['import', id], text).status,
    apps: (...args) => run('apps', args),
    list: () => L.parseList(run('looks', ['list']).stdout),
    theme: () => readFileSync(at('.local/state/omarchy/current/theme.name'), 'utf8').trim(),
    background: () => readFileSync(at('.local/state/omarchy/current/background'), 'latin1'),
    tree: () => execFileSync('sh', ['-c', 'find . \\( -type f -o -type l \\) ! -path "*/current/*" | sort'], { cwd: home, encoding: 'utf8' })
  }
}

// A planted fault in a script: the check must fail on it.
function control(t, from, to, check) {
  const held = ['looks', 'apps'].some((n) => readFileSync(join(root, 'scripts', n), 'utf8').includes(from))
  assert.ok(held, `control: "${from}" is in no script`)
  let caught = false
  try { check(desk(t, (s) => s.replace(from, to))) } catch { caught = true }
  assert.ok(caught, `control: the check still passes with "${from}" as "${to}"`)
}

test('a look is an ordinary Omarchy theme, and undo puts back the theme, its background and the disk', { skip }, (t) => {
  const check = (d) => {
    const before = d.tree()
    assert.equal(d.list().undo, false)
    assert.equal(d.apply('polycarp-calm'), 0)
    assert.equal(d.theme(), 'polycarp-calm')
    assert.deepEqual(readdirSync(d.at('.config/omarchy/themes')), ['polycarp-calm'])
    assert.deepEqual(readdirSync(d.at('.config/omarchy/themes/polycarp-calm')).sort(), ['backgrounds', 'colors.toml'])
    assert.equal(d.background().slice(0, 2), 'BM')
    assert.equal(L.parseToml(readFileSync(d.at('.config/omarchy/themes/polycarp-calm/colors.toml'), 'utf8')).mode, 'dark')
    assert.equal(d.list().undo, true)
    assert.equal(d.looks('undo').status, 0)
    assert.equal(d.theme(), 'nord')
    assert.equal(d.background(), 'nord two')
    assert.equal(d.list().undo, false)
    assert.equal(d.tree(), before, 'nothing is left behind')
  }
  check(desk(t))
  control(t, 'omarchy theme bg set "$background" >/dev/null 2>&1', 'true', check)
  control(t, 'if [[ $(field 4 "$last") == 1 ]] && ours', 'if false && ours', check)
})

test('looks applied one after another are undone one at a time', { skip }, (t) => {
  const check = (d) => {
    d.apply('polycarp-calm')
    d.apply('polycarp-evening', 'evening')
    assert.equal(d.looks('undo').status, 0)
    assert.equal(d.theme(), 'polycarp-calm')
    assert.equal(d.looks('undo').status, 0)
    assert.equal(d.theme(), 'nord')
    assert.equal(d.looks('undo').status, 3)
  }
  check(desk(t))
  control(t, `sed '$d'`, `sed 'd'`, check)
})

test('a theme chosen in Omarchy since then is not undone', { skip }, (t) => {
  const check = (d) => {
    d.apply('polycarp-calm')
    d.omarchy('theme', 'set', 'gruvbox')
    assert.equal(d.list().undo, false)
    assert.equal(d.looks('undo').status, 3)
    assert.equal(d.theme(), 'gruvbox')
    d.apply('polycarp-evening', 'evening')
    assert.equal(d.looks('undo').status, 0)
    assert.equal(d.theme(), 'gruvbox')
    assert.equal(d.list().undo, false, 'the older apply is forgotten')
  }
  check(desk(t))
  control(t, '[[ $(field 3 "$t") == "$(now)" ]]', 'true', check)
})

test('a theme Polycarp did not write, or somebody changed, is left alone', { skip }, (t) => {
  const check = (d) => {
    d.write(d.at('.config/omarchy/themes/polycarp-calm/colors.toml'), 'mine')
    assert.equal(d.apply('polycarp-calm'), 3)
    assert.equal(readFileSync(d.at('.config/omarchy/themes/polycarp-calm/colors.toml'), 'utf8'), 'mine')
    assert.deepEqual(plain(d.list().taken), { 'polycarp-calm': true })

    d.apply('polycarp-evening', 'evening')
    d.write(d.at('.config/omarchy/themes/polycarp-evening/backgrounds/mine.png'), 'mine')
    assert.equal(d.apply('polycarp-evening', 'evening'), 3)
    assert.equal(d.looks('undo').status, 0)
    assert.ok(existsSync(d.at('.config/omarchy/themes/polycarp-evening/backgrounds/mine.png')), 'undo keeps what somebody added')

    mkdirSync(d.at('elsewhere'))
    symlinkSync(d.at('elsewhere'), d.at('.config/omarchy/themes/polycarp'))
    assert.equal(d.apply('polycarp', 'polycarp'), 3)
    assert.ok(lstatSync(d.at('.config/omarchy/themes/polycarp')).isSymbolicLink())
    assert.equal(d.theme(), 'nord')
  }
  check(desk(t))
  control(t, 'then ours "omarchy.$id" "$dir" || exit 3; else new=1; fi', 'then :; else new=1; fi', check)
  control(t, '&& $(<"$state/$1") == "$(sum "$2")"', '', check)
})

test('a look applied again writes nothing, and a theme that changed is written over the one we wrote', { skip }, (t) => {
  const check = (d) => {
    d.apply('polycarp-calm')
    d.apply('polycarp-calm')
    assert.equal(readFileSync(d.at('.local/state/polycarp-omarchy/undo'), 'utf8').trim().split('\n').length, 1)
    assert.equal(d.apply('polycarp-calm', 'evening'), 0)
    const { dark } = L.resolve('evening', themes)
    assert.equal(L.parseToml(readFileSync(d.at('.config/omarchy/themes/polycarp-calm/colors.toml'), 'utf8')).background, dark.background.toLowerCase())
    assert.deepEqual(readdirSync(d.at('.config/omarchy/themes')), ['polycarp-calm'], 'no scratch folder is left')
  }
  check(desk(t))
  control(t, 'if [[ $before != "$id" ]]; then', 'if true; then', check)
})

test('names that would leave the folder, and empty input, are refused', { skip }, (t) => {
  const check = (d) => {
    for (const id of ['../x', 'polycarp/../../x', 'nord', 'mine', '', 'polycarp x', 'Polycarp']) assert.notEqual(d.apply(id), 0, id)
    assert.equal(d.looks('apply', 'polycarp-calm').status, 1)
    assert.deepEqual(existsSync(d.at('.config/omarchy/themes')) ? readdirSync(d.at('.config/omarchy/themes')) : [], [])
    for (const id of ['../x', 'calm', 'omarchy-../x']) assert.notEqual(d.importTheme(id, 'x'), 0, id)
    assert.equal(d.looks('forget', '../x').status, 3)
    assert.equal(d.theme(), 'nord')
  }
  check(desk(t))
  control(t, '&& [[ $id == polycarp* ]] || exit 1', '|| exit 1', check)
})

test('an Omarchy theme is saved for Polycarp with its background, and taken away whole', { skip }, (t) => {
  const check = (d) => {
    const before = d.tree()
    const made = L.fromOmarchy('nord', { mode: 'dark', background: '#2e3440', foreground: '#d8dee9' }, 'JetBrainsMono Nerd Font')
    assert.equal(d.importTheme(made.id, L.themeToml(made)), 0)
    assert.deepEqual(readdirSync(d.at('.config/polycarp/themes')).sort(), ['omarchy-nord.png', 'omarchy-nord.toml'])
    assert.equal(readFileSync(d.at('.config/polycarp/themes/omarchy-nord.png'), 'utf8'), 'nord two')
    assert.equal(d.list().user['omarchy-nord'].title, 'Nord')
    assert.equal(d.list().taken['omarchy-nord'], undefined)
    assert.equal(d.importTheme(made.id, L.themeToml(made)), 0, 'ours is written again')
    assert.equal(d.looks('forget', made.id).status, 0)
    assert.equal(d.tree(), before)
    d.write(d.at('.config/polycarp/themes/omarchy-nord.toml'), 'mine')
    assert.equal(d.importTheme(made.id, 'x'), 3)
    assert.equal(d.looks('forget', made.id).status, 3)
    assert.equal(d.list().taken['omarchy-nord'], true)
    assert.equal(readFileSync(d.at('.config/polycarp/themes/omarchy-nord.toml'), 'utf8'), 'mine')
  }
  check(desk(t))
  control(t, 'then ours "polycarp.$id" "$file" || exit 3; fi', 'then :; fi', check)
  control(t, 'if ours "picture.$id.${copy##*.}" "$copy"; then drop', 'if false; then drop', check)
})

test('the list carries the font, the palette in use and the user\'s own themes', { skip }, (t) => {
  const check = (d) => {
    d.write(d.at('.config/polycarp/themes/mine.toml'), 'title = "Mine"\nextends = "polycarp"\n')
    d.write(d.at('.config/polycarp/themes/Bad Name.toml'), 'title = "Bad"\n')
    d.write(d.at('.config/polycarp/themes/huge.toml'), `title = "${'x'.repeat(70000)}"\n`)
    const list = d.list()
    assert.equal(list.theme, 'nord')
    assert.equal(list.font, 'JetBrainsMono Nerd Font')
    assert.equal(list.colors.background, '#2e3440')
    assert.deepEqual(Object.keys(plain(list.user)), ['mine'])
  }
  check(desk(t))
  control(t, '&& (($(wc -c <"$f") <= 65536))', '', check)
})

test('default apps: the installed ones Omarchy itself knows, and only those can be set', { skip }, (t) => {
  const check = (d) => {
    const tool = (name, text = '') => d.write(d.at('bin', name), `#!/bin/bash\n${text}`, 0o755)
    const choice = (kind, args, now) => tool(`omarchy-default-${kind}`, `# omarchy:args=[${args}]\necho ${now}\n`)
    choice('browser', 'chromium|chrome|zen', 'chromium')
    choice('terminal', 'foot|kitty', 'foot')
    choice('editor', 'zed|helix|nvim', 'nvim')
    choice('agent', 'claude|codex', 'claude')
    d.write(d.at('.local/share/applications/google-chrome.desktop'), '')
    for (const name of ['foot', 'zeditor', 'helix']) tool(name)
    tool('claude', 'mise use -g claude\n')
    tool('mise', 'exit 1\n')
    const rows = Object.fromEntries(d.apps('list').stdout.trim().split('\n').map((l) => { const [k, now, ...rest] = l.split('\t'); return [k, [now, rest]] }))
    assert.deepEqual(rows.browser, ['chromium', ['chrome']])
    assert.equal(rows.terminal[0], 'foot')
    assert.ok(rows.terminal[1].includes('foot'))
    assert.deepEqual(rows.editor[1].slice(0, 2), ['zed', 'helix'])
    assert.ok(!rows.agent[1].includes('claude'), 'a stub that installs is not the app')
    assert.equal(d.apps('set', 'editor', 'helix').status, 0)
    assert.equal(readFileSync(d.at('editor'), 'utf8').trim(), 'helix')
    assert.equal(d.apps('set', 'editor', 'rm').status, 1)
    assert.equal(d.apps('set', 'shell', 'helix').status, 1)
    assert.equal(d.apps('set', 'agent', 'claude').status, 1)
    assert.ok(!existsSync(d.at('ran')), 'an agent that is not installed is never asked for')
    tool('claude')
    d.apps('set', 'agent', 'claude')
    assert.equal(readFileSync(d.at('ran'), 'utf8').trim(), 'default agent claude')
    tool('omarchy-default-agent', '# omarchy:args=[claude]\n[[ $1 == "--select" ]]\n')
    d.apps('set', 'agent', 'claude')
    assert.equal(readFileSync(d.at('ran'), 'utf8').trim().split('\n')[1], 'default agent --select claude')
  }
  check(desk(t))
  control(t, "| grep -q '^mise use -g'", '| grep -q nothing', check)
  control(t, '&& installed "$kind" "$id" || exit 1', '|| exit 1', check)
})
