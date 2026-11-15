// A `run:` step on a Windows runner uses pwsh unless it says otherwise, and pwsh ends a multi-line script with the
// last command's exit code: a failing first line is hidden by a passing second one. So every Windows step that runs
// more than one command must use bash, which CI's runners start with -e. This reads ci.yml line by line; it knows
// only the shapes that file uses (jobs at two spaces, steps at six).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ciPath = new URL("../../.github/workflows/ci.yml", import.meta.url);

/** The Windows steps in `yaml` that run several commands without bash, as "job: step" names. */
export function maskedWindowsSteps(yaml) {
  const lines = yaml.split(/\r?\n/);
  const jobsAt = lines.indexOf("jobs:");
  const jobs = [];
  for (let i = jobsAt + 1; i < lines.length; i++) {
    const m = /^  ([\w-]+):\s*$/.exec(lines[i]);
    if (m) jobs.push({ name: m[1], lines: [] });
    else if (jobs.length) jobs.at(-1).lines.push(lines[i]);
  }
  const masked = [];
  for (const job of jobs) {
    const text = job.lines.join("\n");
    const onWindows = /runs-on:.*windows/.test(text) || (/runs-on: \$\{\{ matrix\.os \}\}/.test(text) && /os: \[[^\]]*windows/.test(text));
    if (!onWindows) continue;
    const stepsAt = job.lines.findIndex((l) => /^    steps:\s*$/.test(l));
    const jobBash = /^    defaults:\n      run:\n(?:        .*\n)*?        shell: bash\s*$/m.test(job.lines.slice(0, stepsAt).join("\n") + "\n");
    const steps = [];
    for (const l of job.lines.slice(stepsAt + 1)) {
      if (/^      - /.test(l)) steps.push([l.replace(/^      - /, "        ")]);
      else if (steps.length) steps.at(-1).push(l);
    }
    for (const step of steps) {
      const own = (key) => step.find((l) => l.startsWith(`        ${key}:`))?.slice(`        ${key}:`.length).trim();
      if (/runner\.os == '(Linux|macOS)'/.test(own("if") ?? "")) continue;
      if ((own("shell") ?? (jobBash ? "bash" : "")) === "bash") continue;
      const runAt = step.findIndex((l) => l.startsWith("        run:"));
      if (runAt < 0) continue;
      const head = own("run");
      const commands = /^[|>]/.test(head)
        ? step.slice(runAt + 1).filter((l) => /^          /.test(l) && l.trim() && !l.trim().startsWith("#"))
        : [head];
      if (commands.length > 1 || commands.some((c) => c.includes(";"))) masked.push(`${job.name}: ${own("name") ?? head}`);
    }
  }
  return masked;
}

test("every multi-command step that runs on Windows uses bash, so a failing command fails the step", () => {
  assert.deepEqual(maskedWindowsSteps(readFileSync(ciPath, "utf8")), []);
});

test("the check finds a two-line pwsh step on a Windows job, and passes it under a job-wide shell: bash", () => {
  const job = (defaults) => `jobs:\n  w:\n    runs-on: windows-latest\n${defaults}    steps:\n      - name: Two\n        run: |\n          node a\n          node b\n      - run: node c\n`;
  assert.deepEqual(maskedWindowsSteps(job("")), ["w: Two"]);
  assert.deepEqual(maskedWindowsSteps(job("    defaults:\n      run:\n        working-directory: x\n        shell: bash\n")), []);
  const matrix = `jobs:\n  m:\n    strategy:\n      matrix:\n        os: [ubuntu-24.04, windows-latest]\n    runs-on: \${{ matrix.os }}\n    steps:\n      - name: Linux only\n        if: runner.os == 'Linux'\n        run: |\n          a\n          b\n      - name: Everywhere\n        run: a; b\n`;
  assert.deepEqual(maskedWindowsSteps(matrix), ["m: Everywhere"]);
});
