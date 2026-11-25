// Writes lib/Builtin.js: Polycarp's built-in themes, so the plugin offers them with no Polycarp command installed.
// Run from the Polycarp repo after a theme changes: node plugins/omarchy/tools/builtin.mjs
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from '../test/load.mjs'

const here = dirname(fileURLToPath(import.meta.url))
export const themes = join(here, '../../../themes')
export const target = join(here, '../lib/Builtin.js')

export function build() {
  const { parseToml } = load('Looks.js')
  const out = {}
  const first = ['polycarp', 'still-water', 'evening', 'parchment', 'blocks', 'calm']
  const names = readdirSync(themes).filter((f) => f.endsWith('.toml')).map((f) => f.slice(0, -5))
  names.sort((a, b) => (first.indexOf(a) + 1 || 99) - (first.indexOf(b) + 1 || 99) || a.localeCompare(b))
  for (const name of names) {
    const { title, description, extends: base, light, dark } = parseToml(readFileSync(join(themes, `${name}.toml`), 'utf8'))
    out[name] = { title, description, ...(base ? { extends: base } : {}), light, dark }
  }
  return `.pragma library\n\n// Written by tools/builtin.mjs from Polycarp's themes. Do not edit.\nvar themes = ${JSON.stringify(out, null, 1)}\n`
}

if (process.argv[1] === fileURLToPath(import.meta.url)) writeFileSync(target, build())
