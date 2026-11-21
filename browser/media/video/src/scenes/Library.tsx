import { DATA } from "../data";
import { Caption, ChapterLabel, Code, Fill, Pane, type PaneLine, Watermark } from "../ui";

// `shown` is the command quoted the way it can be pasted into a shell.
const cmd = (r: { shown: string }) => r.shown;

/** Real CLI output, one pane line per output line, colored the way the CLI means it. */
const output = (out: string, at: number, step = 5): PaneLine[] =>
	out.split("\n").map((text, i) => ({
		at: at + i * step,
		kind: /RETRACTED|retraction|^✗|not registered/.test(text) ? "bad" : /verified by/.test(text) ? "ok" : "result",
		text,
	}));

const { libraryGood: good, libraryRetracted: bad, libraryMadeUp: madeUp } = DATA.cli;
export const SWAP = 200;

export const Library: React.FC = () => (
	<Fill>
		<Watermark />
		<ChapterLabel>Checked sources</ChapterLabel>
		<Pane
			title="terminal"
			prompt="$"
			left={80} top={140} width={1760} height={766}
			fontSize={28}
			lines={[
				{ at: 12, kind: "call", text: cmd(good), cps: 40 },
				...output(good.out, 62),
				{ at: 110, kind: "call", text: cmd(bad), cps: 40 },
				...output(bad.out, 162),
				{ at: 200, kind: "note", text: `# exit ${bad.code}: saved, but flagged` },
				{ at: 262, kind: "call", text: cmd(madeUp), cps: 40 },
				...output(madeUp.out, 312),
				{ at: 318, kind: "note", text: `# exit ${madeUp.code}: nothing saved` },
			]}
		/>
		<Caption from={14} to={SWAP}>
			<Code>tabkyra library</Code> checks every DOI with doi.org, OpenAlex and Crossref.
		</Caption>
		<Caption from={SWAP + 6} to={420}>
			Retracted papers get flagged. Made-up DOIs are refused.
		</Caption>
	</Fill>
);
