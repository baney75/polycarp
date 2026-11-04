import { useCurrentFrame } from "remotion";
import { DATA } from "../data";
import { C, FONT } from "../theme";
import { Caption, ChapterLabel, Fill, Pane, type PaneLine, rise, Watermark } from "../ui";

const lint = DATA.cli.lintBad;
const shipped = DATA.cli.lintShipped;
const ERR_AT = 66;
const STEP = 16;

/** Which file line each error names, from the real lint output ("SKILL.md:14  error ..."). */
const flagged = lint.out
	.split("\n")
	.map((l) => Number(l.match(/SKILL\.md:(\d+)/)?.[1]))
	.filter((n) => n > 0);

const FileView: React.FC = () => {
	const frame = useCurrentFrame();
	const fileLines = DATA.cli.badSkill.trimEnd().split("\n");
	return (
		<div
			style={{
				position: "absolute",
				left: 80,
				top: 140,
				width: 760,
				height: 770,
				background: C.inkDeep,
				border: `1px solid ${C.inkLine}`,
				borderRadius: 16,
				overflow: "hidden",
				fontFamily: FONT.mono,
				fontSize: 19,
				lineHeight: 1.5,
			}}
		>
			<div style={{ height: 52, display: "flex", alignItems: "center", padding: "0 20px", borderBottom: `1px solid ${C.inkLine}`, fontFamily: FONT.sans, fontSize: 22, color: C.mist }}>
				page-helper/SKILL.md · a skill someone sent you
			</div>
			<div style={{ padding: "12px 0" }}>
				{fileLines.map((text, i) => {
					const n = i + 1;
					const hit = flagged.indexOf(n);
					const on = hit >= 0 ? rise(frame, ERR_AT + hit * STEP, 8) : 0;
					return (
						<div
							key={`${n}-${text}`}
							style={{
								display: "flex",
								minHeight: 28,
								background: on > 0 ? `rgba(228,107,93,${0.2 * on})` : "transparent",
								boxShadow: on > 0 ? `inset 5px 0 0 rgba(228,107,93,${on})` : "none",
							}}
						>
							<span style={{ width: 56, textAlign: "right", paddingRight: 16, color: "#43586A", flex: "none" }}>{n}</span>
							<span style={{ color: on > 0.5 ? C.paper : C.mist, whiteSpace: "pre-wrap", paddingRight: 16 }}>{text}</span>
						</div>
					);
				})}
			</div>
		</div>
	);
};

const lintLines: PaneLine[] = [
	{ at: 14, kind: "call", text: lint.shown, cps: 40 },
	...lint.out.split("\n").map((text, i) => ({
		at: ERR_AT + i * STEP,
		kind: "bad" as const,
		text: text.replace(/\s{2,}/g, "  "),
	})),
	{ at: 180, kind: "note", text: `# exit ${lint.code}` },
	{ at: 200, kind: "call", text: shipped.shown, cps: 40 },
	{ at: 236, kind: "ok", text: shipped.out },
];

export const SkillLint: React.FC = () => (
	<Fill>
		<Watermark />
		<ChapterLabel>Linted skills</ChapterLabel>
		<FileView />
		<Pane title="terminal" prompt="$" left={880} top={140} width={960} height={766} fontSize={23} lines={lintLines} />
		<Caption from={14} to={196}>
			Skill lint refuses piped installers, safety bypasses and secret grabs.
		</Caption>
		<Caption from={202} to={330}>
			Every bundled skill passes it, and CI runs it on every pull request.
		</Caption>
	</Fill>
);
