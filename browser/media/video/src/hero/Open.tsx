import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { DATA } from "../data";
import { C, FONT } from "../theme";
import { useBeat } from "./beat";
import { Helm } from "./Helm";
import { Backdrop, ease, Flash, shake, slam, useLayout, Whip, Words } from "./motion";
import { Center, Label, PanelPart, Shot, useSize } from "./parts";

/** Peg i lights `i * step` frames after `start`. */
const pegsAt = (frame: number, start: number, step: number) =>
	Array.from({ length: 8 }, (_, i) => ease(frame, start + i * step, 5));

/** B0–B3: the helm assembles on the impact, its eight pegs lighting clockwise evenly over B0–B3 (one every 3/8 beat). */
export const ColdOpen: React.FC = () => {
	const frame = useCurrentFrame();
	const at = useBeat();
	const size = useSize();
	const step = (at(3) - at(0)) / 8;
	const push = interpolate(frame, [0, at(4)], [1.4, 1], { extrapolateRight: "clamp", easing: (t) => 1 - (1 - t) ** 4 });
	return (
		<AbsoluteFill>
			<Backdrop />
			<Center style={{ scale: String(push) }}>
				<Helm
					size={size(420, 520)}
					ring={ease(frame, at(0), at(2) - at(0))}
					pegs={pegsAt(frame, at(0), step)}
					pointer={ease(frame, at(3), 5)}
					style={{ filter: `drop-shadow(0 0 ${30 + 30 * (1 - ease(frame, at(0), 20))}px ${C.brass}88)` }}
				/>
			</Center>
			<Flash at={at(0)} strength={0.5} />
		</AbsoluteFill>
	);
};

/** B4–B11: "You steer." slams on the downbeat; the line lands word by word. */
export const Line: React.FC = () => {
	const frame = useCurrentFrame();
	const { fps } = useVideoConfig();
	const at = useBeat();
	const size = useSize();
	const { vertical } = useLayout();
	const settle = slam(frame, fps, at(8), 14);
	return (
		<Whip dur={at(12) - at(4)} from="zoom" inDur={1}>
			<Backdrop />
			<Center gap={size(10, 30)} style={{ translate: shake(frame, at(4), 24) }}>
				<Helm
					size={size(150, 200)}
					ring={1}
					pegs={Array(8).fill(1)}
					pointer={1}
					style={{ marginBottom: size(10, 40), scale: String(1 - 0.15 * settle) }}
				/>
				<div style={{ translate: `0 ${-settle * size(10, 20)}px`, scale: String(1 - 0.18 * settle) }}>
					<Words words={vertical ? ["You", "steer."] : ["You steer."]} ats={[at(4), at(4)]} size={size(250, 230)} font={FONT.serif} italic />
				</div>
				<div style={{ width: size(1700, 960) }}>
					<Words
						words={["Your", "agents", "work", "the tabs."]}
						ats={[at(8), at(9), at(10), at(11)]}
						size={size(130, 130)}
						font={FONT.serif}
						italic
						colors={[C.brass, C.brass, C.brass, C.brass]}
					/>
				</div>
			</Center>
			<Flash at={at(4)} strength={0.45} />
		</Whip>
	);
};

const BUILD_SHOTS = [
	{ b: 24, src: "capture/catalog-results.jpg" },
	{ b: 25, src: "capture/book.jpg" },
	{ b: 26, src: "capture/catalog-form.jpg" },
	{ b: 27, src: "capture/catalog-done.jpg" },
];

/** B12–B27: real captures with drift, words every four beats, then one cut per beat. */
export const Build: React.FC = () => {
	const frame = useCurrentFrame();
	const at = useBeat();
	const size = useSize();
	const { vertical } = useLayout();
	const phrases = [
		{ b: 12, text: "Your real browser.", src: "capture/catalog-home.jpg" },
		{ b: 16, text: "Your agent drives it.", src: "capture/book.jpg" },
		{ b: 20, text: "In tabs of its own.", src: "capture/catalog-hold.jpg" },
	];
	const shotW = size(1500, 1000);
	return (
		<AbsoluteFill>
			<Backdrop />
			{phrases.map((p, i) => {
				const from = at(p.b);
				const to = at(p.b + 4);
				if (frame < from || frame >= to) return null;
				const local = frame - from;
				return (
					<AbsoluteFill key={p.b} style={{ translate: `${0}px ${-local * 0.6}px` }}>
						<Whip dur={to - from} from={i % 2 ? "left" : "right"} inDur={7} start={from}>
							<Center gap={size(50, 70)}>
								<div style={{ scale: String(1.02 + 0.0015 * local), opacity: 0.9 }}>
									<Shot src={p.src} dur={to - from} width={shotW} zoom={[1.04, 1.14]} pan={[i % 2 ? 2 : -2, -1]} start={from} />
								</div>
							</Center>
							<Center style={{ justifyContent: vertical ? "flex-end" : "center", paddingBottom: vertical ? size(0, 260) : 0 }}>
								<div
									style={{
										padding: `${size(18, 22)}px ${size(40, 44)}px`,
										background: `${C.ink}e6`,
										borderRadius: size(24, 28),
										border: `1px solid ${C.inkLine}`,
									}}
								>
									<Words words={p.text.split(" ")} ats={p.text.split(" ").map((_, k) => from + k * 3)} size={size(120, 100)} />
								</div>
							</Center>
						</Whip>
					</AbsoluteFill>
				);
			})}
			{BUILD_SHOTS.map((s, i) => {
				const from = at(s.b);
				const to = at(s.b + 1);
				if (frame < from || frame >= to) return null;
				return (
					<Whip key={s.b} dur={to - from} from={["right", "up", "left", "down"][i] as "right"} inDur={4} start={from}>
						<Center>
							<Shot src={s.src} dur={to - from} width={size(1640, 1020)} zoom={[1.15, 1.3]} start={from} />
						</Center>
					</Whip>
				);
			})}
			{frame >= at(24) ? <Flash at={at(24)} strength={0.2} /> : null}
		</AbsoluteFill>
	);
};

/** B28–B31: the music drops out; a slow, near-still push into the real request card. */
export const Gap: React.FC = () => {
	const frame = useCurrentFrame();
	const at = useBeat();
	const size = useSize();
	const card = DATA.boxes.requestCard;
	const crop = { x: card.x - 12, y: card.y - 12, w: card.width + 24, h: card.height + 24 };
	const push = 1 + 0.06 * ease(frame, 0, at(32) - at(28));
	// The panel was captured at 2x; past about 2.6 video px per CSS px it softens.
	const scale = Math.min(2.6, size(1300, 980) / crop.w);
	return (
		<AbsoluteFill>
			<Backdrop />
			<Center gap={size(40, 60)}>
				<div style={{ opacity: ease(frame, 2, 12) }}>
					<Label size={size(34, 40)}>a new site</Label>
				</div>
				<div style={{ scale: String(push) }}>
					<PanelPart src="capture/panel-pending.png" crop={crop} scale={scale} />
				</div>
			</Center>
		</AbsoluteFill>
	);
};
