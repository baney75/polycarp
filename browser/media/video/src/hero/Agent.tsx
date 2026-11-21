import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { DATA } from "../data";
import { C, FONT } from "../theme";
import { BrowserWindow } from "../ui";
import { useBeat } from "./beat";
import { heroClaims } from "./heroClaims";
import { Backdrop, ease, Flash, shake, slam, useLayout, Whip, Words } from "./motion";
import { Center, Label, PanelPart, Shot, useSize } from "./parts";

const MAX = 2.6; // video px per CSS px before the 2x panel capture softens

/** B32–B43: the drop. The request card fills the frame; the real prompt and its choices land. */
export const Moment: React.FC = () => {
	// The ✓ goes on the choice the recorded run answered (checkPrompt in claims.ts).
	const { picked: answered } = heroClaims().prompt;
	const frame = useCurrentFrame();
	const { fps } = useVideoConfig();
	const at = useBeat();
	const size = useSize();
	const { vertical } = useLayout();
	const { requestCard: card, allowedRow } = DATA.boxes;
	const crop = { x: card.x - 10, y: card.y - 6, w: card.width + 20, h: card.height + 16 };
	// "Allowed sites", 127.0.0.1 and the new www.gutenberg.org row (two 32 px rows plus the heading above it).
	const allowedCrop = { x: card.x - 14, y: allowedRow.y - 82, w: card.width + 28, h: allowedRow.height + 96 };
	const scale = Math.min(MAX, size(860, 980) / crop.w);
	const hit = slam(frame, fps, 0, 10);
	const after = frame >= at(40);
	// Wide: the card sits centered until the prompt arrives on B36, then makes room for it.
	const promptW = size(700, 960);
	const makeRoom = vertical ? 1 : ease(frame, at(36) - 4, 12);
	const centerShift = vertical ? 0 : (1 - makeRoom) * ((promptW + size(40, 50)) / 2);
	const ring = 0.5 + 0.5 * Math.sin(((frame - at(32)) / (at(33) - at(32))) * Math.PI * 2);
	return (
		<AbsoluteFill>
			<Backdrop />
			{!after ? (
				<AbsoluteFill style={{ translate: shake(frame, 0, 30) }}>
					<Center gap={size(40, 50)} column={vertical} style={{ padding: size(80, 70) }}>
						<div style={{ display: "flex", flexDirection: "column", gap: size(56, 56), alignItems: vertical ? "center" : "flex-start", translate: `${centerShift}px 0` }}>
							<Words words={["It", "asks", "first."]} ats={[0, 0, 0]} size={size(150, 150)} colors={[C.paper, C.paper, C.brass]} />
							<div style={{ scale: String(2.2 - 1.2 * hit), opacity: Math.min(1, hit * 2) }}>
								<PanelPart
									src="capture/panel-pending.png"
									crop={crop}
									scale={scale}
									style={{ boxShadow: `0 0 0 ${4 + 6 * ring}px ${C.brass}, 0 0 ${60 + 40 * ring}px ${C.brass}88` }}
								/>
							</div>
						</div>
						<div style={{ display: "flex", flexDirection: "column", gap: size(14, 16), opacity: ease(frame, at(36), 6) }}>
						{/* A caption, outside the drawn prompt box: the box is drawn, its text is the recorded elicitation. */}
						<Label size={size(26, 28)}>in your agent</Label>
						<div
							style={{
								width: promptW,
								padding: size(40, 44),
								borderRadius: size(28, 30),
								border: `3px solid ${C.brass}`,
								background: "#16232D",
								fontFamily: FONT.mono,
								fontSize: size(32, 36),
								lineHeight: 1.45,
								color: C.paper,
								opacity: ease(frame, at(36), 6),
								translate: `0 ${(1 - ease(frame, at(36), 10)) * 60}px`,
							}}
						>
							<div>{DATA.prompt.message}</div>
							{DATA.prompt.choices.map((choice, i) => {
								const t = at(37) + i * Math.round((at(39) - at(37)) / 3);
								const picked = i === answered && frame >= at(39);
								return (
									<div
										key={choice}
										style={{
											marginTop: 10,
											padding: "4px 14px",
											borderRadius: 10,
											opacity: ease(frame, t, 5),
											translate: `${(1 - ease(frame, t, 8)) * 40}px 0`,
											background: picked ? "rgba(227,169,59,0.22)" : "transparent",
											color: picked ? C.brass : C.mist,
										}}
									>
										{picked ? "✓ " : "  "}
										{choice}
									</div>
								);
							})}
						</div>
						</div>
					</Center>
				</AbsoluteFill>
			) : (
				<Whip dur={at(44) - at(40)} from="right" inDur={6} start={at(40)}>
					<Center gap={size(50, 60)}>
						<Words words={["You", "decide."]} ats={[at(40), at(40)]} size={size(150, 150)} colors={[C.paper, C.tide]} />
						<PanelPart
							src="capture/panel-allowed.png"
							crop={allowedCrop}
							scale={Math.min(MAX, size(900, 960) / allowedCrop.w)}
							style={{ scale: String(1 + 0.04 * ease(frame, at(40), at(44) - at(40))) }}
						/>
					</Center>
					<Flash at={at(40)} color={C.tide} strength={0.25} />
				</Whip>
			)}
			<Flash at={0} strength={0.5} />
		</AbsoluteFill>
	);
};

/** B44–B51: the browser flies in with parallax; push in on the agent's own tab group. */
export const TabGroup: React.FC = () => {
	const { group } = heroClaims();
	const frame = useCurrentFrame();
	const at = useBeat();
	const size = useSize();
	const { vertical } = useLayout();
	const w = size(1500, 1000);
	const fly = ease(frame, 0, 14);
	const push = interpolate(frame, [at(48), at(48) + 10], [1, vertical ? 1.7 : 1.6], {
		extrapolateLeft: "clamp",
		extrapolateRight: "clamp",
		easing: (t) => 1 - (1 - t) ** 4,
	});
	// Push toward the pill near the window's top left, and lower the window so the pill stays in frame.
	const origin = `${(size(260, 230) / w) * 100}% 0%`;
	const lower = (push - 1) * size(260, 300);
	return (
		<Whip dur={at(52) - at(44)} from="left" inDur={6}>
			<Backdrop />
			<Center>
				<div style={{ translate: `0 ${(1 - fly) * 500 + lower}px`, rotate: `${(1 - fly) * -4}deg`, scale: String(push), transformOrigin: origin }}>
					<BrowserWindow
						width={w}
						style={{ position: "relative" }}
						group={group.group}
						ringAt={6}
						shots={[{ src: "capture/book.jpg", from: 0 }]}
						tabTitle={() => group.title}
						url={() => group.url}
					/>
				</div>
			</Center>
			<Center style={{ justifyContent: "flex-end", paddingBottom: size(70, 200) }}>
				<div style={{ padding: `${size(18, 22)}px ${size(40, 44)}px`, background: `${C.ink}ee`, borderRadius: size(24, 28) }}>
					{frame < at(48) ? (
						<Words words={["Its", "own", "tab", "group."]} ats={[4, 6, 8, 10]} size={size(110, 96)} colors={[C.paper, C.paper, C.brass, C.brass]} />
					) : (
						<Words words={["Your", "tabs", "stay", "yours."]} ats={[at(48), at(48) + 3, at(48) + 6, at(48) + 9]} size={size(110, 96)} />
					)}
				</div>
			</Center>
		</Whip>
	);
};

/** B52–B60: one cut per beat through the real catalog run, each with the call that made it. */
export const Form: React.FC = () => {
	const catalogRun = heroClaims().catalog;
	const frame = useCurrentFrame();
	const { fps } = useVideoConfig();
	const at = useBeat();
	const size = useSize();
	const steps = [
		// Each cut shows the recorded call that produced its screenshot, found by content in
		// order (catalogRunFrom in claims.ts); the // labels on the clicks are the button names
		// from the recorded read_page the agent acted on.
		{ b: 52, src: "capture/catalog-home.jpg", call: catalogRun.navigate },
		{ b: 53, src: "capture/catalog-results.jpg", call: catalogRun.type },
		{ b: 54, src: "capture/catalog-hold.jpg", call: catalogRun.clickHold },
		{ b: 55, src: "capture/catalog-form.jpg", call: catalogRun.fills },
		{ b: 56, src: "capture/catalog-done.jpg", call: catalogRun.clickConfirm },
	];
	const readBack = frame >= at(57);
	const current = [...steps].reverse().find((s) => frame >= at(s.b)) ?? steps[0];
	const local = frame - at(current.b);
	// Wide: leaves room under the shot for a two-line call panel (the fills).
	const w = size(1360, 1000);
	return (
		<AbsoluteFill>
			<Backdrop />
			{!readBack ? (
				<AbsoluteFill style={{ translate: shake(frame, at(current.b), 8) }}>
					<Center gap={size(36, 50)}>
						<div style={{ scale: String(1.06 - 0.06 * ease(local, 0, 6)), filter: local < 3 ? `blur(${(3 - local) * 4}px)` : undefined }}>
							<Shot src={current.src} dur={at(current.b + 1) - at(current.b)} width={w} zoom={[1.02, 1.07]} start={at(current.b)} />
						</div>
						<div
							style={{
								maxWidth: w,
								padding: `${size(16, 20)}px ${size(30, 30)}px`,
								borderRadius: size(18, 20),
								background: C.inkDeep,
								border: `1px solid ${C.inkLine}`,
								fontFamily: FONT.mono,
								fontSize: size(40, 34),
								color: C.paper,
								whiteSpace: "pre-wrap",
								opacity: ease(local, 0, 4),
								translate: `${(1 - ease(local, 0, 8)) * 80}px 0`,
							}}
						>
							<span style={{ color: C.brass }}>› </span>
							{current.call}
						</div>
					</Center>
				</AbsoluteFill>
			) : (
				<Whip dur={at(61) - at(57)} from="zoom" inDur={6} exit={false} start={at(57)}>
					<Center gap={size(40, 50)} style={{ padding: size(100, 60) }}>
						<div style={{ fontFamily: FONT.mono, fontSize: size(40, 36), color: C.paper }}>
							<span style={{ color: C.brass }}>› </span>
							{catalogRun.readBack}
						</div>
						<div
							style={{
								maxWidth: size(1500, 960),
								fontFamily: FONT.mono,
								fontSize: size(54, 48),
								lineHeight: 1.3,
								color: C.tide,
								textAlign: "center",
								opacity: ease(frame, at(57) + 4, 6),
								scale: String(1.3 - 0.3 * slam(frame, fps, at(57) + 4, 12)),
							}}
						>
							→ "{catalogRun.confirmation}"
						</div>
						<Words words={["Filled.", "Read", "back."]} ats={[at(58), at(59), at(59)]} size={size(140, 130)} colors={[C.paper, C.tide, C.tide]} />
					</Center>
					<Flash at={at(57)} color={C.tide} strength={0.2} />
				</Whip>
			)}
		</AbsoluteFill>
	);
};
