import { useCurrentFrame } from "remotion";
import { DATA, args, field } from "../data";
import { C, FONT } from "../theme";
import { Caption, ChapterLabel, Code, Fill, Pane, PanelCrop, Ring, rise, Watermark } from "../ui";

// The Bridge tab, cropped from "Site access" down to the first allowed site, around the
// request card. All boxes are CSS px of the 440-wide panel, measured during the capture.
const { siteAccess, requestCard: card, firstAllowedRow, allowedRow } = DATA.boxes;
const CROP = {
	x: card.x - 25,
	y: siteAccess.y - 13,
	w: card.width + 50,
	h: firstAllowedRow.y + firstAllowedRow.height + 12 - (siteAccess.y - 13),
};
const SCALE = Math.min(772 / CROP.w, 740 / CROP.h);
const PANEL = { left: 1000, top: 150 };
const ANSWER = 215;

/** Claude Code's inline question, with the real message and choices from the elicitation. */
const Prompt: React.FC = () => {
	const frame = useCurrentFrame();
	const o = rise(frame, 60, 10);
	const picked = frame >= ANSWER - 25;
	const done = frame >= ANSWER;
	return (
		<div
			style={{
				position: "absolute",
				left: 80,
				top: 520,
				width: 860,
				padding: "24px 28px",
				borderRadius: 16,
				border: `2px solid ${C.brass}`,
				background: "#16232D",
				opacity: o,
				translate: `0 ${(1 - o) * 16}px`,
				fontFamily: FONT.mono,
				fontSize: 25,
				lineHeight: 1.5,
				color: C.paper,
			}}
		>
			<div style={{ fontFamily: FONT.sans, fontSize: 22, color: C.brass, marginBottom: 8 }}>Your agent asks you</div>
			<div style={{ marginBottom: 14 }}>{DATA.prompt.message}</div>
			{DATA.prompt.choices.map((choice, i) => {
				const on = picked && i === 0;
				return (
					<div
						key={choice}
						style={{
							padding: "4px 12px",
							borderRadius: 8,
							background: on ? "rgba(227,169,59,0.18)" : "transparent",
							color: on ? C.brass : C.mist,
						}}
					>
						{on ? (done ? "✓ " : "› ") : "  "}
						{choice}
					</div>
				);
			})}
		</div>
	);
};

export const AsksFirst: React.FC = () => {
	const frame = useCurrentFrame();
	const after = rise(frame, ANSWER + 10, 12);
	const enter = rise(frame, 20, 16);
	return (
		<Fill>
			<Watermark />
			<ChapterLabel>Asks first</ChapterLabel>
			<Pane
				title="claude · tool calls"
				left={80} top={150} width={860} height={340}
				fontSize={25}
				lines={[
					{ at: 6, kind: "note", text: "# a new site, not allowed yet" },
					{ at: 18, kind: "call", text: args("navigate", 1) },
					{ at: 48, kind: "note", text: "# the call waits for your answer" },
					{ at: ANSWER + 12, kind: "ok", text: `→ title: "${field("navigate", "title", 1)}"` },
				]}
			/>
			<Prompt />
			<div style={{ position: "absolute", left: PANEL.left, top: PANEL.top - 52, fontFamily: FONT.sans, fontSize: 24, color: C.mist, opacity: enter }}>
				Tabkyra side panel · Settings › Bridge
			</div>
			<div style={{ opacity: enter, scale: String(0.97 + 0.03 * enter) }}>
				<PanelCrop src="capture/panel-pending.png" crop={CROP} scale={SCALE} style={{ ...PANEL, opacity: 1 - after }} />
				<PanelCrop src="capture/panel-allowed.png" crop={CROP} scale={SCALE} style={{ ...PANEL, opacity: after }} />
			</div>
			<Ring
				x={PANEL.left + (card.x - CROP.x) * SCALE}
				y={PANEL.top + (card.y - CROP.y) * SCALE}
				w={card.width * SCALE}
				h={card.height * SCALE}
				at={70}
				until={ANSWER}
			/>
			<Ring
				x={PANEL.left + (card.x - CROP.x) * SCALE}
				y={PANEL.top + (allowedRow.y - CROP.y) * SCALE}
				w={card.width * SCALE}
				h={allowedRow.height * SCALE}
				at={ANSWER + 20}
				until={400}
				color={C.tide}
			/>
			<Caption from={24} to={ANSWER}>
				A new site? The agent asks first. You answer inline or in the side panel.
			</Caption>
			<Caption from={ANSWER + 10} to={420}>
				Allow it once, for good, or deny it. <Code>tabkyra allow &lt;host&gt;</Code> works too.
			</Caption>
		</Fill>
	);
};
