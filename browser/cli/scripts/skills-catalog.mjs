// Write cli/src/skills-catalog.ts from the folders under skills/ that hold a SKILL.md.
// CI runs it in the base branch's checkout after copying in a pull request's skills/, so the
// base build bundles exactly the pull request's skills: new ones are indexed and removed or
// renamed ones don't break the build. `tabkyra` comes first, the rest in name order.
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = join(cli, "..", "skills");
const names = readdirSync(skillsDir)
	.filter((n) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(n) && existsSync(join(skillsDir, n, "SKILL.md")))
	.sort((a, b) => (a === "tabkyra" ? -1 : b === "tabkyra" ? 1 : a.localeCompare(b)));
// SKILL_ plus the name: always a valid identifier ("1password" -> SKILL_1PASSWORD), and never
// SKILLS, the export below. Names are lowercase-kebab-case, so no two map to the same one.
// "none" is the router's answer when no skill fits; a skill by that name would look like no match.
if (names.includes("none")) {
	console.error('skills/none: the name "none" is reserved for "no skill fits". Rename the skill.');
	process.exit(1);
}
const constant = (n) => `SKILL_${n.toUpperCase().replace(/-/g, "_")}`;
const imports = [...names].sort().map((n) => `import ${constant(n)} from "../../skills/${n}/SKILL.md";`);
const text = `/**
 * Every skill the CLI ships, bundled as text at build time (cli/scripts/build.mjs). A test
 * (cli/test/skill-lint.test.mjs) fails when a folder under skills/ is missing here, and
 * every entry passes \`tabkyra skill lint\` before it can merge.
 */

${imports.join("\n")}

/** Name to SKILL.md text. \`tabkyra\` first: it's the one every other skill builds on. */
export const SKILLS: ReadonlyMap<string, string> = new Map([
${names.map((n) => `\t["${n}", ${constant(n)}],`).join("\n")}
]);
`;
writeFileSync(join(cli, "src", "skills-catalog.ts"), text);
console.log(`skills-catalog.ts: ${names.length} skills`);
