import test from 'node:test'
import assert from 'node:assert/strict'
import { load, control, plain } from './load.mjs'

const A = load('Agents.js')

const commands = (m) => {
  const yes = { 'claude': 'claude', '/home/u/.local/bin/claude --resume': 'claude', 'node /x/@openai/codex/bin/codex.js': 'codex',
    'node --no-warnings /x/@anthropic-ai/claude-code/cli.js': 'claude', 'bun /x/node_modules/opencode/bin/run.ts': 'opencode', 'codex fix the exec path': 'codex', 'claude what does -p do': 'claude',
    'uv run aider': 'aider', 'uvx aider': 'aider', 'claude --resume abc': 'claude', 'aider -v': 'aider' }
  for (const [args, agent] of Object.entries(yes)) assert.equal(m.agentOf(args, 'pts/1'), agent, args)
  for (const args of ['claude -p hello', 'codex exec ls', 'codex app-server', 'claude mcp serve', 'vim claude', 'bash claude', 'node server.js', '/opt/claude/helper',
    'claude --model sonnet -p hi', 'codex --full-auto exec ls', 'node /home/u/code/pi/server.js', 'python3 /home/u/code/hermes/manage.py runserver'])
    assert.equal(m.agentOf(args, 'pts/1'), '', args)
  assert.equal(m.agentOf('claude', '?'), '')
}
test('an agent is a known command with a terminal, not one run by a script', (t) => {
  commands(A)
  control(t, 'Agents.js', 'if (!tty || tty === "?") return ""', '', commands)
  control(t, 'Agents.js', 'if (HEADLESS_FLAGS.test(word) || HEADLESS_COMMANDS.test(word)) return true', '', commands)
  control(t, 'Agents.js', 'if (i > 0 && /^--[^=]+$/.test(words[i - 1])) continue', '', commands)
  control(t, 'Agents.js', 'if (!/(node_modules|site-packages)\\//.test(path)) return ""', '', commands)
  control(t, 'Agents.js', 'if (runs === "uv" && words[at] === "run")', 'if (false)', commands)
})

const titles = (m) => {
  assert.equal(m.titleState('⠐ Fix the bar'), 'working')
  assert.equal(m.titleState('✳ Fix the bar'), 'ready')
  assert.equal(m.titleState('✦ Working (app)'), 'working')
  assert.equal(m.titleState('✋ Action Required (app)'), 'blocked')
  assert.equal(m.titleState('~/code'), '')
  assert.equal(m.titleState('✳ Remove action required banner'), 'ready')
  assert.equal(m.plainTitle('⠐ Fix the bar'), 'Fix the bar')
  assert.equal(m.plainTitle('~/code'), '~/code')
  assert.equal(m.titleAgent('✳ On the server'), 'claude')
  assert.equal(m.titleAgent('⠐ npm install'), '')
}
test('a title says what its agent is doing', (t) => {
  titles(A)
  control(t, 'Agents.js', '[\\u2800-\\u28ff◐◓◑◒]/.test(t)', '[x]/.test(t)', titles)
  control(t, 'Agents.js', '/^\\s*(✋|⚠|\\[ ?!|Action Required)/i.test(t)', '/action required/i.test(t)', titles)
})

const ps = (...rows) => '#ps\n' + rows.join('\n') + '\n'
const win = (address, pid, title = '', app = 'foot') => ({ address, pid, title, app })

const placing = (m) => {
  const scan = m.parse(ps('10 1 ? foot', '11 10 pts/1 bash', '12 11 pts/1 claude', '13 12 pts/1 node /x/codex.js', '20 1 ? foot', '21 20 pts/2 codex') + '#cwd\n12\t/home/u/app\n')
  const rows = m.find(scan, [win('a', 10), win('b', 20), win('c', 30)])
  assert.deepEqual(plain(rows.map((r) => [r.agent, r.address, r.cwd])), [['claude', 'a', '/home/u/app'], ['codex', 'b', '']])
}
test('an agent is in the window its terminal is in, and one it started is its own', (t) => {
  placing(A)
  control(t, 'Agents.js', '|| underAgent(p, byPid)', '', placing)
  control(t, 'Agents.js', 'if (up < 0) continue', '', placing)
})

const oneProcess = (m) => {
  const scan = m.parse(ps('10 1 ? ghostty', '11 10 pts/1 claude', '12 10 pts/2 codex') + '#cwd\n12\t/home/u/site\n')
  const rows = m.find(scan, [win('c', 10, 'bash'), win('a', 10, 'site'), win('b', 10, '⠂ Plan')])
  assert.deepEqual(plain(rows.map((r) => [r.agent, r.address])), [['claude', 'b'], ['codex', 'a']])
}
test('with one process for every window, the title picks the window', (t) => {
  oneProcess(A)
  control(t, 'Agents.js', 'score += 100', 'score += 0', oneProcess)
})

const multiplexers = (m) => {
  const scan = m.parse(ps('5 1 ? tmux: server', '6 5 pts/9 bash', '7 6 pts/9 claude', '10 1 ? foot', '11 10 pts/1 tmux attach', '30 1 ? foot --app-id=org.omarchy.herdr', '40 1 ? herdr server', '41 40 pts/5 codex') +
    '#panes\n6\t%3\twork\t✳ Notes\n#clients\n11\twork\n#herdr\n' + JSON.stringify({ result: { agents: [
      { pane_id: 'w1:p2', agent: 'codex', agent_status: 'done', title: 'Tests', cwd: '/srv', terminal_id: 't' },
      { pane_id: 'w1:p3', agent: 'pi', agent_status: 'working' }] } }) + '\n')
  const rows = m.find(scan, [win('a', 10), win('h', 30, 'herdr', 'org.omarchy.herdr')])
  assert.deepEqual(plain(rows.map((r) => [r.agent, r.address, r.pane || r.herdr, r.raw, r.paneTitle])),
    [['claude', 'a', '%3', '', '✳ Notes'], ['codex', 'h', 'w1:p2', 'ready', 'Tests'], ['pi', 'h', 'w1:p3', 'working', '']])
}
test('tmux panes go to the window of their client, and herdr says for itself', (t) => {
  multiplexers(A)
  control(t, 'Agents.js', 'if (scan.clients[c].session !== pane.session) continue', 'continue', multiplexers)
  control(t, 'Agents.js', 'h.agent_status === "done"', 'false', multiplexers)
  control(t, 'Agents.js', 'if (scan.herdr.length > 0 && under(p, byPid, /^herdr$/)) continue', '', multiplexers)
})

const sharing = (m) => {
  const remote = m.find(m.parse(ps('10 1 ? foot', '11 10 pts/1 codex')), [win('a', 10, '✳ Remote'), win('b', 10, '⠐ Building')])
  assert.deepEqual(plain(remote.map((r) => [r.agent, r.address])), [['codex', 'b'], ['claude', 'a']])
  const folder = m.find(m.parse(ps('10 1 ? foot', '11 10 pts/1 codex') + '#cwd\n11\t/home/u/app\n'), [win('a', 10, 'Mapping tool'), win('b', 10, 'app')])
  assert.deepEqual(plain(folder.map((r) => [r.agent, r.address])), [['codex', 'b']])
}
test('a window that one process shares goes to the agent its mark or folder names', (t) => {
  sharing(A)
  control(t, 'Agents.js', '(marked === "" || marked === rows[i].agent)', 'true', sharing)
  control(t, 'Agents.js', '/[\\s\\/:~]/.test(before) && /[\\s\\/]/.test(after)', 'true', sharing)
})

test('an agent over ssh counts by its title, once', () => {
  const scan = A.parse(ps('10 1 ? foot', '11 10 pts/1 ssh box'))
  assert.deepEqual(plain(A.find(scan, [win('a', 10, '✳ Remote'), win('b', 11, 'bash')]).map((r) => [r.agent, r.address])), [['claude', 'a']])
})

test('a broken scan finds nothing and does not throw', () => {
  for (const text of ['', '#ps\nx y z', '#herdr\n{oops', '#panes\n1\t2', null]) assert.deepEqual(plain(A.find(A.parse(text), [])), [])
})

const states = (m) => {
  const run = (...steps) => steps.reduce((was, now) => m.next(was, { focused: false, urgent: false, ...now }), null)
  assert.equal(m.kind(run({ raw: 'working' })), 'working')
  assert.equal(m.kind(run({ raw: 'ready' })), 'open')
  assert.equal(m.kind(run({ raw: 'working' }, { raw: 'ready' })), 'needs')
  assert.equal(m.kind(run({ raw: 'working' }, { raw: 'ready' }, { raw: 'ready' })), 'needs')
  assert.equal(m.kind(run({ raw: 'working' }, { raw: 'ready' }, { raw: 'ready', focused: true })), 'open')
  assert.equal(m.kind(run({ raw: 'working' }, { raw: 'ready', focused: true }, { raw: 'ready' })), 'open')
  assert.equal(m.kind(run({ raw: 'working' }, { raw: 'ready' }, { raw: 'working' })), 'working')
  assert.equal(m.kind(run({ raw: 'ready', urgent: true })), 'needs')
  assert.equal(m.kind(run({ raw: 'blocked', focused: true })), 'needs')
}
test('an agent that stops while you look elsewhere wants you until you look', (t) => {
  states(A)
  control(t, 'Agents.js', 'if (now.focused) return { raw: now.raw, wants: false }', '', states)
  control(t, 'Agents.js', '|| (was !== null && was.wants)', '', states)
  control(t, 'Agents.js', 'now.raw !== "working" && ', '', states)
})

const reading = (m) => {
  const row = { agent: 'claude', cwd: '/home/u/app', paneTitle: '', titled: true, address: 'a', raw: '' }
  assert.deepEqual(plain(m.read(row, { a: '⠐ Fix the bar' }, '/home/u')), { raw: 'working', heading: 'Fix the bar', detail: 'Claude Code  ~/app' })
  assert.deepEqual(plain(m.read(row, { a: '~/app' }, '/home/u')), { raw: '', heading: 'Claude Code', detail: '~/app' })
  assert.deepEqual(plain(m.read({ ...row, titled: false }, { a: '⠐ Other split' }, '/home/u')), { raw: '', heading: 'Claude Code', detail: '~/app' })
  assert.equal(m.read({ ...row, paneTitle: '✳ In tmux' }, { a: '⠐ x' }, '').raw, 'ready')
  assert.equal(m.read({ ...row, raw: 'blocked' }, { a: '⠐ x' }, '').raw, 'blocked')
}
test('a row reads its own title, and never another split\'s', (t) => {
  reading(A)
  control(t, 'Agents.js', '(row.titled ? titles[row.address] || "" : "")', 'titles[row.address]', reading)
})

test('only terminals are watched for titles', () => {
  const scan = A.parse(ps('10 1 ? foot', '11 10 pts/1 bash', '20 1 ? browser', '21 20 ? renderer'))
  assert.deepEqual(plain(A.terminals(scan)), { 10: true })
})

test('the list is what needs you, what works, then the rest', () => {
  const rows = [{ kind: 'open', at: 0 }, { kind: 'working', at: 1 }, { kind: 'needs', at: 2 }, { kind: 'working', at: 3 }]
  assert.deepEqual(plain(A.sorted(rows).map((r) => r.at)), [2, 1, 3, 0])
  assert.deepEqual(plain(A.counts(rows)), { needs: 1, working: 2, open: 1 })
})

test('a folder reads short', () => {
  assert.equal(A.shortPath('/home/u/code/app', '/home/u'), '~/code/app')
  assert.equal(A.shortPath('/home/u2/x', '/home/u'), '/home/u2/x')
  assert.equal(A.shortPath('/home/u/a/b/c/d', '/home/u'), '…/c/d')
  assert.equal(A.shortPath('', '/home/u'), '')
})

// The scan script itself, on Linux, where it runs: it must find this test's own process under its parent.
test('the scan finds this process under its parent', { skip: process.platform !== 'linux' && 'the scan reads /proc' }, async () => {
  const { execFileSync } = await import('node:child_process')
  const { mkdtempSync, readFileSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { root } = await import('./load.mjs')
  const script = join(root, 'scripts', 'agents-scan')
  const mine = (path) => {
    const scan = A.parse(execFileSync('bash', [path], { encoding: 'utf8' }))
    const me = scan.processes.filter((p) => p.pid === process.pid)
    assert.equal(me.length, 1)
    assert.equal(me[0].ppid, process.ppid)
    assert.match(me[0].args, /node/)
  }
  mine(script)
  const dir = mkdtempSync(join(tmpdir(), 'scan-'))
  try {
    const broken = join(dir, 'agents-scan')
    writeFileSync(broken, readFileSync(script, 'utf8').replace('pid=,ppid=', 'ppid=,pid='))
    assert.throws(() => mine(broken))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// tmux on Linux, in a server of its own: panes come through whole without a UTF-8 locale, and a pane that set no title
// (tmux then shows the host's name) comes through untitled.
test('the scan reads tmux panes whole, without a locale', { skip: process.platform !== 'linux' && 'the scan reads /proc' }, async (t) => {
  const { execFileSync } = await import('node:child_process')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { root } = await import('./load.mjs')
  try { execFileSync('tmux', ['-V']) } catch { t.skip('no tmux'); return }
  const dir = mkdtempSync(join(tmpdir(), 'tmux-'))
  const env = { PATH: process.env.PATH, HOME: dir, TMUX_TMPDIR: dir }
  const run = (...args) => execFileSync('tmux', ['-f', '/dev/null', ...args], { env, encoding: 'utf8' })
  try {
    run('new-session', '-d', '-s', 'work', 'sleep 60')
    run('split-window', '-t', 'work', 'sleep 60')
    run('select-pane', '-t', 'work.0', '-T', '✳ Notes')
    const scan = A.parse(execFileSync('bash', [join(root, 'scripts', 'agents-scan')], { env, encoding: 'utf8' }))
    assert.deepEqual(plain(scan.panes.map((p) => [p.session, p.title])).sort(), [['work', ''], ['work', '✳ Notes']])
  } finally {
    try { run('kill-server') } catch {}
    rmSync(dir, { recursive: true, force: true })
  }
})
