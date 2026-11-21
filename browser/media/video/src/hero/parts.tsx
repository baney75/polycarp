import type React from "react";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { C, FONT } from "../theme";
import { ease, useLayout } from "./motion";

/** A real screenshot with Ken Burns drift (never static for more than a moment). */
export const Shot: React.FC<{
	src: string;
	dur: number;
	zoom?: [number, number];
	pan?: [number, number];
	radius?: number;
	style?: React.CSSProperties;
	width: number;
	aspect?: number;
	/** Segment frame the shot starts on, so its drift runs on the shot's own clock. */
	start?: number;
}> = ({ src, dur, zoom = [1.0, 1.08], pan = [0, -2], radius = 22, style, width, aspect = 800 / 1280, start = 0 }) => {
	const frame = useCurrentFrame() - start;
	const t = interpolate(frame, [0, Math.max(dur, 1)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
	const s = zoom[0] + (zoom[1] - zoom[0]) * t;
	return (
		<div
			style={{
				width,
				height: width * aspect,
				borderRadius: radius,
				overflow: "hidden",
				boxShadow: "0 60px 120px -40px rgba(0,0,0,0.9)",
				background: "#fff",
				...style,
			}}
		>
			<Img
				src={staticFile(src)}
				style={{ width: "100%", height: "100%", objectFit: "cover", scale: String(s), translate: `${pan[0] * t}% ${pan[1] * t}%` }}
			/>
		</div>
	);
};

/** A crop of a 2x side panel capture, in the panel's CSS pixels, at `scale` video px per CSS px. */
export const PanelPart: React.FC<{
	src: string;
	crop: { x: number; y: number; w: number; h: number };
	scale: number;
	style?: React.CSSProperties;
}> = ({ src, crop, scale, style }) => (
	<div
		style={{
			position: "relative",
			width: crop.w * scale,
			height: crop.h * scale,
			overflow: "hidden",
			borderRadius: 14 * scale,
			boxShadow: "0 50px 100px -30px rgba(0,0,0,0.9)",
			...style,
		}}
	>
		<Img src={staticFile(src)} style={{ position: "absolute", width: 440 * scale, left: -crop.x * scale, top: -crop.y * scale }} />
	</div>
);

/** Centered stage that fills the frame. */
export const Center: React.FC<{ children: React.ReactNode; style?: React.CSSProperties; column?: boolean; gap?: number }> = ({
	children,
	style,
	column = true,
	gap = 0,
}) => (
	<AbsoluteFill
		style={{
			display: "flex",
			flexDirection: column ? "column" : "row",
			alignItems: "center",
			justifyContent: "center",
			gap,
			...style,
		}}
	>
		{children}
	</AbsoluteFill>
);

/** Real terminal output, big: a `$` command and the lines it printed, each shown from its frame. */
export const Term: React.FC<{
	lines: { text: string; at: number; color?: string; typed?: boolean }[];
	size: number;
	width: number;
	style?: React.CSSProperties;
}> = ({ lines, size, width, style }) => {
	const frame = useCurrentFrame();
	return (
		<div
			style={{
				width,
				padding: `${size * 0.9}px ${size * 1.1}px`,
				borderRadius: size * 0.8,
				background: C.inkDeep,
				border: `1px solid ${C.inkLine}`,
				boxShadow: "0 60px 120px -40px rgba(0,0,0,0.9)",
				fontFamily: FONT.mono,
				fontSize: size,
				lineHeight: 1.45,
				...style,
			}}
		>
			{lines.map((l, i) => {
				if (frame < l.at) return null;
				const shown = l.typed ? l.text.slice(0, Math.floor((frame - l.at) * 2.2)) : l.text;
				const o = l.typed ? 1 : ease(frame, l.at, 6);
				return (
					<div
						key={`${i}-${l.text}`}
						style={{ color: l.color ?? C.mist, opacity: o, translate: `0 ${(1 - o) * size * 0.4}px`, whiteSpace: "pre-wrap", wordBreak: "break-word" }}
					>
						{l.typed ? (
							<>
								<span style={{ color: C.brass }}>$ </span>
								<span style={{ color: C.paper }}>{shown}</span>
							</>
						) : (
							shown
						)}
					</div>
				);
			})}
		</div>
	);
};

/** A small slate label above a shot. */
export const Label: React.FC<{ children: React.ReactNode; size: number; color?: string }> = ({ children, size, color = C.mist }) => (
	<div style={{ fontFamily: FONT.sans, fontSize: size, color, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 600 }}>
		{children}
	</div>
);

/** Shorthand for a layout-aware size: wide value, vertical value. */
export const useSize = () => {
	const { vertical, u } = useLayout();
	return (wide: number, tall: number = wide) => (vertical ? tall : wide) * u;
};
