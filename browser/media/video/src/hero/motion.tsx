import type React from "react";
import { AbsoluteFill, Easing, interpolate, random, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { C, FONT } from "../theme";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
export const expoOut = Easing.bezier(0.16, 1, 0.3, 1);
export const expoIn = Easing.bezier(0.7, 0, 0.84, 0);

/** 0→1 over `dur` frames from `at`, ease-out expo. */
export const ease = (frame: number, at: number, dur: number) =>
	interpolate(frame, [at, at + dur], [0, 1], { ...clamp, easing: expoOut });

/** A spring that overshoots a little and settles: anticipation-free "slam". */
export const slam = (frame: number, fps: number, at: number, damping = 11) =>
	spring({ frame: frame - at, fps, config: { damping, stiffness: 180, mass: 0.7 } });

/** Layout for both cuts: `u` is one unit at 1080 px on the short side. */
export function useLayout() {
	const { width, height } = useVideoConfig();
	const vertical = height > width;
	return { W: width, H: height, vertical, u: Math.min(width, height) / 1080 };
}

/** Background: ink with a slow brass bloom, so no frame is flat. */
export const Backdrop: React.FC<{ hue?: string }> = ({ hue = C.brass }) => {
	const frame = useCurrentFrame();
	const { W, H } = useLayout();
	const x = 50 + 18 * Math.sin(frame / 90);
	const y = 40 + 12 * Math.cos(frame / 110);
	return (
		<AbsoluteFill
			style={{
				background: `radial-gradient(${Math.max(W, H) * 0.9}px circle at ${x}% ${y}%, ${hue}22, transparent 60%), ${C.ink}`,
			}}
		/>
	);
};

/** Film grain (seeded per frame pair, so renders repeat) and a vignette on top. */
export const Finish: React.FC = () => {
	const frame = useCurrentFrame();
	const seed = Math.floor(frame / 2);
	return (
		<AbsoluteFill style={{ pointerEvents: "none" }}>
			<svg width="100%" height="100%" style={{ position: "absolute", inset: 0, opacity: 0.07, mixBlendMode: "overlay" }}>
				<filter id={`grain-${seed}`}>
					<feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed={seed} />
				</filter>
				<rect width="100%" height="100%" filter={`url(#grain-${seed})`} />
			</svg>
			<AbsoluteFill style={{ background: "radial-gradient(circle at 50% 45%, transparent 55%, rgba(0,0,0,0.55) 100%)" }} />
		</AbsoluteFill>
	);
};

/**
 * Whip in and out of a shot: a fast slide with motion blur. Entrances take `inDur`
 * frames; exits are faster (about 60%).
 */
export const Whip: React.FC<{
	children: React.ReactNode;
	dur: number;
	from?: "left" | "right" | "up" | "down" | "zoom";
	inDur?: number;
	exit?: boolean;
	/** Segment frame the shot starts on, when it starts partway into its segment. */
	start?: number;
}> = ({ children, dur, from = "right", inDur = 8, exit = true, start = 0 }) => {
	const frame = useCurrentFrame() - start;
	const { W, H } = useLayout();
	const outDur = Math.round(inDur * 0.6);
	const tin = 1 - ease(frame, 0, inDur);
	const tout = exit ? interpolate(frame, [dur - outDur, dur], [0, 1], { ...clamp, easing: expoIn }) : 0;
	const d = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1], zoom: [0, 0] }[from];
	const x = (d[0] * tin - d[0] * tout) * W * 0.6;
	const y = (d[1] * tin - d[1] * tout) * H * 0.6;
	const blur = 26 * Math.max(tin, tout);
	const s = from === "zoom" ? 1 + 0.5 * tin - 0.3 * tout : 1;
	return (
		<AbsoluteFill
			style={{
				translate: `${x}px ${y}px`,
				scale: String(s),
				filter: blur > 0.5 ? `blur(${blur}px)` : undefined,
				opacity: from === "zoom" ? 1 - tin * 0.8 : 1,
			}}
		>
			{children}
		</AbsoluteFill>
	);
};

/** A short camera shake after an impact at `at`, decaying over 10 frames. */
export const shake = (frame: number, at: number, amount: number) => {
	const t = frame - at;
	if (t < 0 || t > 10) return "0px 0px";
	const k = amount * (1 - t / 10);
	return `${(random(`sx${at}-${t}`) - 0.5) * 2 * k}px ${(random(`sy${at}-${t}`) - 0.5) * 2 * k}px`;
};

/** A stamp graphic (REFUSED, BLOCKED) that slams in at `at`. Graphic, not product UI. */
export const Stamp: React.FC<{ text: string; at: number; color?: string; size: number; tilt?: number }> = ({
	text,
	at,
	color = C.alarm,
	size,
	tilt = -9,
}) => {
	const frame = useCurrentFrame();
	const { fps } = useVideoConfig();
	if (frame < at) return null;
	const s = slam(frame, fps, at, 9);
	return (
		<div
			style={{
				display: "inline-block",
				padding: `${size * 0.12}px ${size * 0.34}px`,
				border: `${size * 0.09}px solid ${color}`,
				borderRadius: size * 0.16,
				color,
				fontFamily: FONT.sans,
				fontWeight: 600,
				fontSize: size,
				letterSpacing: "0.06em",
				lineHeight: 1,
				rotate: `${tilt}deg`,
				scale: String(2.4 - 1.4 * s),
				opacity: Math.min(1, s * 2),
				background: `${C.ink}cc`,
				boxShadow: `0 0 ${size * 0.6}px ${color}66`,
			}}
		>
			{text}
		</div>
	);
};

/** A number that counts up from 0 to `to` between `at` and `at + dur`, with thousands commas. */
export const CountUp: React.FC<{ to: number; at: number; dur: number; style?: React.CSSProperties }> = ({
	to,
	at,
	dur,
	style,
}) => {
	const frame = useCurrentFrame();
	const v = Math.round(to * ease(frame, at, dur));
	return <span style={{ fontVariantNumeric: "tabular-nums", ...style }}>{v.toLocaleString("en-US")}</span>;
};

/**
 * Words that slam in one after another (opacity, rise, scale and blur together), each on
 * its own frame from `ats`.
 */
export const Words: React.FC<{
	words: string[];
	ats: number[];
	size: number;
	colors?: string[];
	font?: string;
	italic?: boolean;
	gap?: number;
	wrap?: boolean;
}> = ({ words, ats, size, colors = [], font = FONT.sans, italic = false, gap = 0.28, wrap = true }) => {
	const frame = useCurrentFrame();
	const { fps } = useVideoConfig();
	return (
		<div
			style={{
				display: "flex",
				flexWrap: wrap ? "wrap" : "nowrap",
				justifyContent: "center",
				columnGap: size * gap,
				rowGap: size * 0.05,
				fontFamily: font,
				fontStyle: italic ? "italic" : "normal",
				fontWeight: font === FONT.sans ? 600 : 400,
				fontSize: size,
				lineHeight: 1.05,
				letterSpacing: font === FONT.sans ? "-0.03em" : "0",
			}}
		>
			{words.map((w, i) => {
				const at = ats[i] ?? ats[ats.length - 1];
				const s = slam(frame, fps, at, 12);
				return (
					<span
						key={`${w}-${i}`}
						style={{
							display: "inline-block",
							color: colors[i] ?? C.paper,
							opacity: frame < at ? 0 : Math.min(1, s * 1.6),
							translate: `0 ${(1 - s) * size * 0.5}px`,
							scale: String(1.25 - 0.25 * s),
							filter: s < 0.9 ? `blur(${(1 - s) * 12}px)` : undefined,
						}}
					>
						{w}
					</span>
				);
			})}
		</div>
	);
};

/** A brass (or other) flash at `at`, fading over 6 frames. */
export const Flash: React.FC<{ at: number; color?: string; strength?: number }> = ({
	at,
	color = C.brass,
	strength = 0.35,
}) => {
	const frame = useCurrentFrame();
	const o = frame < at ? 0 : strength * (1 - ease(frame, at, 8));
	if (o <= 0.001) return null;
	return <AbsoluteFill style={{ background: color, opacity: o, mixBlendMode: "screen" }} />;
};
