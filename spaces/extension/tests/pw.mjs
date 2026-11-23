// Resolve Playwright without a node_modules folder in the project.
// Order: POLYCARP_PLAYWRIGHT (path to a playwright package dir), a normal import,
// then the global npm root.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import path from 'node:path';

export async function loadPlaywright() {
  const tries = [];
  if (process.env.POLYCARP_PLAYWRIGHT) tries.push(process.env.POLYCARP_PLAYWRIGHT);
  tries.push('playwright');
  try {
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
    tries.push(path.join(root, 'playwright'));
  } catch { /* npm missing */ }
  const require = createRequire(import.meta.url);
  for (const t of tries) {
    try { return require(t); } catch { /* next */ }
  }
  throw new Error('Playwright not found. Install it globally (npm i -g playwright) or set POLYCARP_PLAYWRIGHT.');
}
