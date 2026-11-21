import { Easing, interpolate, useCurrentFrame } from "remotion";
import { DATA } from "../data";

import { Caption, ChapterLabel, Fill, Pane, PanelCrop, Ring, rise, Watermark } from "../ui";

// The welcome dialog and, after the click, the toast above it. Boxes are CSS px of the
// 440-wide panel, measured during the capture.
const box = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x, y: b.y, w: b.width, h: b.height });
const CROP = box(DATA.boxes.welcomeDialog);
const TOAST = box(DATA.boxes.toast);
const SCALE = Math.min(653 / CROP.w, 650 / CROP.h);
const PANEL = { left: 100, top: 262 };
const CLICK = 70;

const button = DATA.copyButton;
const target = {
	x: PANEL.left + (button.x + button.width / 2 - CROP.x) * SCALE,
	y: PANEL.top + (button.y + button.height / 2 - CROP.y) * SCALE,
};

/** A plain arrow pointer that glides to the button and clicks it. */
const Cursor: React.FC = () => {
	const frame = useCurrentFrame();
	const t = interpolate(frame, [12, CLICK - 6], [0, 1], {
		extrapolateLeft: "clamp",
		extrapolateRight: "clamp",
		easing: Easing.bezier(0.45, 0, 0.2, 1),
	});
	const x = interpolate(t, [0, 1], [target.x + 380, target.x]);
	const y = interpolate(t, [0, 1], [target.y + 260, target.y]);
	const press = frame >= CLICK && frame < CLICK + 6 ? 0.85 : 1;
	return (
		<svg
			width={44}
			height={56}
			viewBox="0 0 22 28"
			style={{ position: "absolute", left: x - 4, top: y - 2, scale: String(press), opacity: 1 - rise(frame, 140, 12) }}
			role="img"
			aria-label="pointer"
		>
			<path d="M2 2 L2 22 L7.5 17 L11 25 L14.5 23.5 L11 16 L18 16 Z" fill="#fff" stroke="#0F1B24" strokeWidth={1.6} strokeLinejoin="round" />
		</svg>
	);
};

const promptLines = DATA.setupPrompt.split("\n").filter((l) => l.trim() !== "").slice(0, 7);

export const GetStarted: React.FC = () => {
	const frame = useCurrentFrame();
	const copied = rise(frame, CLICK + 2, 8);
	return (
		<Fill>
			<Watermark />
			<ChapterLabel>Get started</ChapterLabel>
			<PanelCrop src="capture/panel-welcome.png" crop={CROP} scale={SCALE} style={PANEL} />
			<PanelCrop
				src="capture/panel-copied.png"
				crop={TOAST}
				scale={SCALE}
				style={{ left: PANEL.left + (TOAST.x - CROP.x) * SCALE, top: 128, opacity: copied, translate: `0 ${(1 - copied) * -24}px`, border: "none" }}
			/>
			<Ring x={target.x - (button.width * SCALE) / 2} y={target.y - (button.height * SCALE) / 2} w={button.width * SCALE} h={button.height * SCALE} at={40} until={CLICK + 30} />
			<Pane
				title="your agent · pasted prompt"
				left={800} top={140} width={1040} height={766}
				fontSize={23}
				lines={promptLines.map((text, i) => ({ at: CLICK + 24 + i * 9, kind: i === 0 ? "text" : "result", text }))}
			/>
			<Cursor />
			<Caption from={14} to={255}>
				Copy one prompt into your agent. It installs the CLI and connects itself.
			</Caption>
		</Fill>
	);
};
