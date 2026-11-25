// Loads a QML JavaScript library in node: the same file the shell runs, minus the two QML-only lines.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

export const root = join(dirname(fileURLToPath(import.meta.url)), '..')

export function load(name, edit = (s) => s) {
  const source = edit(readFileSync(join(root, 'lib', name), 'utf8'))
  const imports = [...source.matchAll(/^\.import "(.+?)" as (\w+)$/gm)]
  const context = vm.createContext(Object.fromEntries(imports.map(([, file, as]) => [as, load(file)])))
  vm.runInContext(source.replace(/^\.(pragma|import).*$/gm, ''), context, { filename: name })
  return context
}

// A planted fault: the same library with one thing broken. `check` must throw on it, and `from` must be in the file.
export function control(t, name, from, to, check) {
  const broken = load(name, (s) => {
    if (!s.includes(from)) throw new Error(`control: "${from}" is not in ${name}`)
    return s.replace(from, to)
  })
  let caught = false
  try { check(broken) } catch { caught = true }
  if (!caught) throw new Error(`control: the check still passes with "${from}" as "${to}"`)
}

export const plain = (value) => JSON.parse(JSON.stringify(value))
