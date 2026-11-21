import type React from "react";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { ease, slam, useLayout } from "../hero/motion";
import { useSize } from "../hero/parts";
import { C, FONT } from "../theme";
import { hex } from "./data";

/**
 * The shot's caption: one line of claim on an ink plate, low in the frame, readable with the
 * sound off. It lands on `at` (rise, scale and blur together) and then holds still. A "\n" in
 * `text` is where the vertical cut breaks the line; the wide cut shows it as a space.
 */
export const Caption: React.FC<{ text: string; at: number; until?: number; color?: string }> = ({ text, at, until, color = C.paper }) => {
	const frame = useCurrentFrame();
	const { fps } = useVideoConfig();
	const size = useSize();
	const { vertical } = useLayout();
	if (frame < at || (until !== undefined && frame >= until)) return null;
	const s = slam(frame, fps, at, 14);
	const out = until === undefined ? 0 : interpolate(frame, [until - 4, until], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
	return (
		<AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: size(46, 210), pointerEvents: "none" }}>
			<div
				style={{
					maxWidth: size(1700, 980),
					padding: `${size(14, 22)}px ${size(36, 40)}px`,
					borderRadius: size(20, 26),
					background: "rgba(10,20,27,0.92)",
					border: `1px solid ${C.inkLine}`,
					fontFamily: FONT.sans,
					fontWeight: 600,
					fontSize: size(64, 70),
					lineHeight: 1.12,
					letterSpacing: "-0.02em",
					color,
					textAlign: "center",
					opacity: Math.min(1, s * 1.6) * (1 - out),
					translate: `0 ${(1 - s) * 40 + out * 20}px`,
					scale: String(1.08 - 0.08 * s),
					filter: s < 0.85 ? `blur(${(1 - s) * 8}px)` : undefined,
					boxShadow: "0 30px 60px -20px rgba(0,0,0,0.8)",
					whiteSpace: vertical ? "pre-line" : "nowrap",
				}}
			>
				{vertical ? text : text.replace(/\n/g, " ")}
			</div>
		</AbsoluteFill>
	);
};

/** A tab group chip as Chrome draws it: the group's color, its title in white. */
export const Pill: React.FC<{ title: string; color: string; size: number; dim?: number; ring?: number; style?: React.CSSProperties }> = ({
	title,
	color,
	size,
	dim = 0,
	ring = 0,
	style,
}) => (
	<div
		style={{
			display: "inline-flex",
			alignItems: "center",
			gap: size * 0.4,
			padding: `${size * 0.28}px ${size * 0.6}px`,
			borderRadius: size * 0.42,
			background: hex(color),
			color: "#fff",
			fontFamily: FONT.sans,
			fontWeight: 600,
			fontSize: size,
			lineHeight: 1.1,
			whiteSpace: "nowrap",
			filter: dim > 0 ? `grayscale(${dim}) brightness(${1 - 0.35 * dim})` : undefined,
			boxShadow: ring > 0 ? `0 0 0 ${size * 0.14 * ring}px ${C.paper}, 0 0 ${size * ring}px ${hex(color)}` : "0 8px 20px -8px rgba(0,0,0,0.6)",
			...style,
		}}
	>
		{title}
	</div>
);

/** A recorded page screenshot under a slim drawn address bar that shows the recorded URL. */
export const Card: React.FC<{ src: string; url: string; width: number; drift?: number; aspect?: number; style?: React.CSSProperties }> = ({
	src,
	url,
	width,
	drift = 0,
	aspect = 800 / 1280,
	style,
}) => {
	const bar = Math.max(30, width * 0.055);
	return (
		<div style={{ width, borderRadius: width * 0.022, overflow: "hidden", background: "#fff", boxShadow: "0 50px 90px -30px rgba(0,0,0,0.9)", ...style }}>
			<div style={{ height: bar, display: "flex", alignItems: "center", padding: `0 ${bar * 0.4}px`, background: "#EEF1F4", borderBottom: "1px solid #DDE2E7" }}>
				<div
					style={{
						flex: 1,
						height: bar * 0.66,
						borderRadius: bar,
						background: "#fff",
						display: "flex",
						alignItems: "center",
						padding: `0 ${bar * 0.4}px`,
						fontFamily: FONT.sans,
						fontSize: bar * 0.42,
						color: "#3E4A55",
						whiteSpace: "nowrap",
						overflow: "hidden",
					}}
				>
					{url}
				</div>
			</div>
			<div style={{ width, height: width * aspect, overflow: "hidden" }}>
				<Img src={staticFile(src)} style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "top", scale: String(1 + drift * 0.05) }} />
			</div>
		</div>
	);
};

export type CallLine = { text: string; color?: string; at?: number; mark?: boolean; prompt?: "call" | "result" };

/**
 * A panel of call and result text. Lines appear on their own frame; a `call` line types in.
 * `mark` puts a highlight bar behind a line (the claim the shot makes about it).
 */
export const CallBox: React.FC<{
	lines: CallLine[];
	size: number;
	width: number;
	head?: React.ReactNode;
	markAt?: number;
	markColor?: string;
	wrap?: boolean;
	style?: React.CSSProperties;
}> = ({ lines, size, width, head, markAt = 0, markColor = C.brass, wrap = true, style }) => {
	const frame = useCurrentFrame();
	return (
		<div
			style={{
				width,
				padding: `${size * 0.9}px ${size * 1.0}px`,
				borderRadius: size * 0.8,
				background: C.inkDeep,
				border: `1px solid ${C.inkLine}`,
				boxShadow: "0 50px 100px -40px rgba(0,0,0,0.9)",
				fontFamily: FONT.mono,
				fontSize: size,
				lineHeight: 1.42,
				...style,
			}}
		>
			{head ? <div style={{ marginBottom: size * 0.7 }}>{head}</div> : null}
			{lines.map((l, i) => {
				const at = l.at ?? 0;
				if (frame < at) return null;
				const typedCall = l.prompt === "call";
				const shown = typedCall ? l.text.slice(0, Math.max(1, Math.floor((frame - at) * 2.6))) : l.text;
				const o = typedCall ? 1 : ease(frame, at, 6);
				const m = l.mark ? ease(frame, markAt, 8) : 0;
				return (
					<div
						key={`${i}-${l.text.slice(0, 20)}`}
						style={{
							color: l.color ?? C.mist,
							opacity: o,
							translate: `0 ${(1 - o) * size * 0.4}px`,
							whiteSpace: wrap ? "pre-wrap" : "pre",
							overflow: "hidden",
							textOverflow: "ellipsis",
							wordBreak: "break-word",
							margin: `0 ${-size * 0.35}px`,
							padding: `${size * 0.05}px ${size * 0.35}px`,
							borderRadius: size * 0.3,
							background: m > 0 ? `${markColor}${Math.round(m * 0x33).toString(16).padStart(2, "0")}` : undefined,
							boxShadow: m > 0 ? `inset ${size * 0.18 * m}px 0 0 ${markColor}` : undefined,
						}}
					>
						{typedCall ? <span style={{ color: C.brass }}>› </span> : l.prompt === "result" ? <span style={{ color: C.slate }}>← </span> : null}
						{shown}
					</div>
				);
			})}
		</div>
	);
};

/** A crop of a 2x side panel capture in its CSS pixels, at `scale` video px per CSS px, with optional ring. */
export const PanelCrop: React.FC<{
	src: string;
	crop: { x: number; y: number; w: number; h: number };
	scale: number;
	ring?: { x: number; y: number; w: number; h: number; t: number };
	style?: React.CSSProperties;
}> = ({ src, crop, scale, ring, style }) => (
	<div
		style={{
			position: "relative",
			width: crop.w * scale,
			height: crop.h * scale,
			overflow: "hidden",
			borderRadius: 12 * scale,
			boxShadow: "0 50px 100px -30px rgba(0,0,0,0.9)",
			border: `1px solid ${C.inkLine}`,
			...style,
		}}
	>
		<Img src={staticFile(src)} style={{ position: "absolute", width: 440 * scale, left: -crop.x * scale, top: -crop.y * scale }} />
		{ring && ring.t > 0 ? (
			<div
				style={{
					position: "absolute",
					left: (ring.x - crop.x - 4) * scale,
					top: (ring.y - crop.y - 4) * scale,
					width: (ring.w + 8) * scale,
					height: (ring.h + 8) * scale,
					borderRadius: 10 * scale,
					border: `${3 * scale}px solid ${C.brass}`,
					boxShadow: `0 0 ${24 * scale}px ${C.brass}`,
					opacity: ring.t,
					scale: String(1.15 - 0.15 * ring.t),
				}}
			/>
		) : null}
	</div>
);
