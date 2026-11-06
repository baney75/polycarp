/**
 * Every skill the CLI ships, bundled as text at build time (cli/scripts/build.mjs). A test
 * (cli/test/skill-lint.test.mjs) fails when a folder under skills/ is missing here, and
 * every entry passes `tabkyra skill lint` before it can merge.
 */

import SKILL_ACADEMIC_RESEARCH from "../../skills/academic-research/SKILL.md";
import SKILL_ADVERSARIAL_REVIEW from "../../skills/adversarial-review/SKILL.md";
import SKILL_ANNOTATION from "../../skills/annotation/SKILL.md";
import SKILL_ARTIFACTS from "../../skills/artifacts/SKILL.md";
import SKILL_AUTORESEARCH from "../../skills/autoresearch/SKILL.md";
import SKILL_BIOLOGY from "../../skills/biology/SKILL.md";
import SKILL_BRANDING from "../../skills/branding/SKILL.md";
import SKILL_BUG from "../../skills/bug/SKILL.md";
import SKILL_CHEMISTRY from "../../skills/chemistry/SKILL.md";
import SKILL_DESIGN_LIBRARY from "../../skills/design-library/SKILL.md";
import SKILL_DORKS from "../../skills/dorks/SKILL.md";
import SKILL_EMAIL_ORGANIZATION from "../../skills/email-organization/SKILL.md";
import SKILL_FIX from "../../skills/fix/SKILL.md";
import SKILL_GENETICS from "../../skills/genetics/SKILL.md";
import SKILL_KYRASKILLMAKER from "../../skills/kyraskillmaker/SKILL.md";
import SKILL_MAP_DATA from "../../skills/map-data/SKILL.md";
import SKILL_MAPS from "../../skills/maps/SKILL.md";
import SKILL_MATHEMATICS from "../../skills/mathematics/SKILL.md";
import SKILL_MECHANISM_DESIGN from "../../skills/mechanism-design/SKILL.md";
import SKILL_NEWS_RESEARCH from "../../skills/news-research/SKILL.md";
import SKILL_NOTES from "../../skills/notes/SKILL.md";
import SKILL_OFFICE_DOCS from "../../skills/office-docs/SKILL.md";
import SKILL_OSINT from "../../skills/osint/SKILL.md";
import SKILL_PCB_DESIGN from "../../skills/pcb-design/SKILL.md";
import SKILL_PROTON from "../../skills/proton/SKILL.md";
import SKILL_PROTON_PASS from "../../skills/proton-pass/SKILL.md";
import SKILL_REFERENCE from "../../skills/reference/SKILL.md";
import SKILL_RSI from "../../skills/rsi/SKILL.md";
import SKILL_TABKYRA from "../../skills/tabkyra/SKILL.md";
import SKILL_VIDEO_EDITING from "../../skills/video-editing/SKILL.md";
import SKILL_VISUAL_EXPLAINER from "../../skills/visual-explainer/SKILL.md";
import SKILL_WORLD_DATA from "../../skills/world-data/SKILL.md";
import SKILL_WRITING from "../../skills/writing/SKILL.md";
import SKILL_WRITING_VOICE from "../../skills/writing-voice/SKILL.md";

/** Name to SKILL.md text. `tabkyra` first: it's the one every other skill builds on. */
export const SKILLS: ReadonlyMap<string, string> = new Map([
	["tabkyra", SKILL_TABKYRA],
	["academic-research", SKILL_ACADEMIC_RESEARCH],
	["adversarial-review", SKILL_ADVERSARIAL_REVIEW],
	["annotation", SKILL_ANNOTATION],
	["artifacts", SKILL_ARTIFACTS],
	["autoresearch", SKILL_AUTORESEARCH],
	["biology", SKILL_BIOLOGY],
	["branding", SKILL_BRANDING],
	["bug", SKILL_BUG],
	["chemistry", SKILL_CHEMISTRY],
	["design-library", SKILL_DESIGN_LIBRARY],
	["dorks", SKILL_DORKS],
	["email-organization", SKILL_EMAIL_ORGANIZATION],
	["fix", SKILL_FIX],
	["genetics", SKILL_GENETICS],
	["kyraskillmaker", SKILL_KYRASKILLMAKER],
	["map-data", SKILL_MAP_DATA],
	["maps", SKILL_MAPS],
	["mathematics", SKILL_MATHEMATICS],
	["mechanism-design", SKILL_MECHANISM_DESIGN],
	["news-research", SKILL_NEWS_RESEARCH],
	["notes", SKILL_NOTES],
	["office-docs", SKILL_OFFICE_DOCS],
	["osint", SKILL_OSINT],
	["pcb-design", SKILL_PCB_DESIGN],
	["proton", SKILL_PROTON],
	["proton-pass", SKILL_PROTON_PASS],
	["reference", SKILL_REFERENCE],
	["rsi", SKILL_RSI],
	["video-editing", SKILL_VIDEO_EDITING],
	["visual-explainer", SKILL_VISUAL_EXPLAINER],
	["world-data", SKILL_WORLD_DATA],
	["writing", SKILL_WRITING],
	["writing-voice", SKILL_WRITING_VOICE],
]);
