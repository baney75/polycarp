import type React from "react";
import { Easing, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { C, FONT } from "./theme";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const ease = Easing.bezier(0.16, 1, 0.3, 1);

/** 0 to 1 over `dur` frames starting at `at`, eased. */
export const rise = (frame: number, at: number, dur = 10) =>
	interpolate(frame, [at, at + dur], [0, 1], { ...clamp, easing: ease });

/** Visible from `from` to `to` with short fades at both ends. */
export const window01 = (frame: number, from: number, to: number, fade = 8) =>
	Math.min(rise(frame, from, fade), 1 - rise(frame, to - fade, fade));

/** How many characters of a typed string show at this frame. */
export const typed = (text: string, frame: number, at: number, cps = 45, fps = 30) =>
	text.slice(0, Math.max(0, Math.floor(((frame - at) / fps) * cps)));

export const Fill: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) => (
	<div style={{ position: "absolute", inset: 0, background: C.ink, overflow: "hidden", ...style }}>{children}</div>
);

/** A faint brass helm, cropped off the edge, like the hero's watermark (7%, turned 11°). */
export const Watermark: React.FC = () => (
	<Img
		src={staticFile("brand/mark-brass.svg")}
		style={{ position: "absolute", width: 1100, right: -330, bottom: -380, opacity: 0.07, rotate: "11deg" }}
	/>
);

export const ChapterLabel: React.FC<{ children: string; at?: number }> = ({ children, at = 0 }) => {
	const frame = useCurrentFrame();
	const t = rise(frame, at, 12);
	return (
		<div
			style={{
				position: "absolute",
				left: 80,
				top: 54,
				display: "flex",
				alignItems: "center",
				gap: 16,
				opacity: t,
				translate: `${(1 - t) * -16}px 0`,
			}}
		>
			<Img src={staticFile("brand/icon.svg")} style={{ width: 44, height: 44 }} />
			<span
				style={{
					fontFamily: FONT.sans,
					fontWeight: 600,
					fontSize: 30,
					letterSpacing: "0.12em",
					textTransform: "uppercase",
					color: C.brass,
				}}
			>
				{children}
			</span>
		</div>
	);
};

/** The burned-in caption: paper on an ink plate, bottom center. */
export const Caption: React.FC<{ children: React.ReactNode; from: number; to: number }> = ({ children, from, to }) => {
	const frame = useCurrentFrame();
	const o = window01(frame, from, to, 10);
	if (o <= 0) return null;
	return (
		<div
			style={{
				position: "absolute",
				left: 0,
				right: 0,
				bottom: 52,
				display: "flex",
				justifyContent: "center",
				opacity: o,
				translate: `0 ${(1 - o) * 14}px`,
			}}
		>
			<div
				style={{
					maxWidth: 1640,
					padding: "18px 36px",
					borderRadius: 18,
					background: "rgba(10,20,27,0.92)",
					border: `1px solid ${C.inkLine}`,
					fontFamily: FONT.sans,
					fontSize: 46,
					lineHeight: 1.25,
					color: C.paper,
					textAlign: "center",
					boxShadow: "0 20px 50px -20px rgba(0,0,0,0.8)",
				}}
			>
				{children}
			</div>
		</div>
	);
};

export const Code: React.FC<{ children: React.ReactNode }> = ({ children }) => (
	<span style={{ fontFamily: FONT.mono, fontSize: "0.86em", color: C.brass }}>{children}</span>
);

export type PaneLine = {
	at: number;
	kind: "call" | "result" | "note" | "ok" | "bad" | "text";
	text: string;
	/** Characters per second for a typed line; results appear at once. */
	cps?: number;
};

const lineColor: Record<PaneLine["kind"], string> = {
	call: C.paper,
	result: C.mist,
	note: C.slate,
	ok: C.tide,
	bad: C.alarm,
	text: C.paper,
};

const HEADER = 52;
const PAD_X = 24;
const PAD_Y = 18;
const LINE = 1.5;

/** Rows a line wraps to in a mono pane (JetBrains Mono advances 0.6 em). */
const rowsOf = (text: string, width: number, fontSize: number) => {
	const perRow = Math.floor((width - 2 * PAD_X) / (fontSize * 0.6));
	return text.split("\n").reduce((n, part) => n + Math.max(1, Math.ceil(part.length / perRow)), 0);
};

/**
 * A dark pane of mono lines, filled from the top like a terminal. Once the lines outgrow
 * the pane, they scroll up so the newest line stays in view.
 */
export const Pane: React.FC<{
	title: string;
	lines: PaneLine[];
	left: number;
	top: number;
	width: number;
	height: number;
	fontSize?: number;
	prompt?: string;
}> = ({ title, lines, left, top, width, height, fontSize = 24, prompt = "›" }) => {
	const frame = useCurrentFrame();
	const { fps } = useVideoConfig();
	const shown = lines.filter((l) => frame >= l.at);
	const used = shown.reduce(
		(h, l, i) =>
			h + rowsOf(`${l.kind === "call" ? `${prompt} ` : ""}${l.text}`, width, fontSize) * fontSize * LINE + (l.kind === "call" && i > 0 ? 10 : 0),
		0,
	);
	const room = height - HEADER - 2 * PAD_Y;
	const scroll = Math.min(0, room - used);
	return (
		<div
			style={{
				position: "absolute",
				left,
				top,
				width,
				height,
				display: "flex",
				flexDirection: "column",
				background: C.inkDeep,
				border: `1px solid ${C.inkLine}`,
				borderRadius: 16,
				overflow: "hidden",
				boxShadow: "0 40px 80px -30px rgba(0,0,0,0.85)",
			}}
		>
			<div
				style={{
					flex: "none",
					height: HEADER,
					display: "flex",
					alignItems: "center",
					gap: 10,
					padding: "0 20px",
					borderBottom: `1px solid ${C.inkLine}`,
					fontFamily: FONT.sans,
					fontSize: 22,
					color: C.mist,
				}}
			>
				<span style={{ width: 12, height: 12, borderRadius: 6, background: "#2B3D4B" }} />
				<span style={{ width: 12, height: 12, borderRadius: 6, background: "#2B3D4B" }} />
				<span style={{ width: 12, height: 12, borderRadius: 6, background: "#2B3D4B", marginRight: 8 }} />
				{title}
			</div>
			<div
				style={{
					flex: 1,
					overflow: "hidden",
					padding: `${PAD_Y}px ${PAD_X}px`,
					fontFamily: FONT.mono,
					fontSize,
					lineHeight: LINE,
				}}
			>
				<div style={{ translate: `0 ${scroll}px` }}>
				{shown.map((l, i) => {
					const isTyped = l.kind === "call" || (l.cps !== undefined && l.cps > 0);
					const body = isTyped ? typed(l.text, frame, l.at, l.cps ?? 55, fps) : l.text;
					const o = isTyped ? 1 : rise(frame, l.at, 6);
					const lead = l.kind === "call" ? prompt : "";
					return (
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: lines are append-only
							key={i}
							style={{
								color: lineColor[l.kind],
								opacity: o,
								whiteSpace: "pre-wrap",
								wordBreak: "break-word",
								marginTop: l.kind === "call" && i > 0 ? 10 : 0,
							}}
						>
							{lead ? <span style={{ color: C.brass }}>{`${lead} `}</span> : null}
							{body}
						</div>
					);
				})}
				</div>
			</div>
		</div>
	);
};

/** A quiet browser frame: the agent's brass tab group, its tab, the URL, then the page. */
export const BrowserWindow: React.FC<{
	shots: { src: string; from: number }[];
	tabTitle: (frame: number) => string;
	url: (frame: number) => string;
	group: string;
	ringAt?: number;
	style?: React.CSSProperties;
	width: number;
}> = ({ shots, tabTitle, url, group, ringAt, style, width }) => {
	const frame = useCurrentFrame();
	const contentHeight = (width * 800) / 1280;
	const ring = ringAt === undefined ? 0 : window01(frame, ringAt, ringAt + 75, 12);
	return (
		<div
			style={{
				position: "absolute",
				width,
				borderRadius: 16,
				overflow: "hidden",
				background: "#fff",
				boxShadow: "0 50px 90px -30px rgba(0,0,0,0.9)",
				...style,
			}}
		>
			<div style={{ height: 58, background: "#DEE3E8", display: "flex", alignItems: "flex-end", gap: 10, padding: "0 16px" }}>
				<div style={{ display: "flex", gap: 9, alignSelf: "center", marginRight: 10 }}>
					<span style={{ width: 14, height: 14, borderRadius: 7, background: "#C5CBD1" }} />
					<span style={{ width: 14, height: 14, borderRadius: 7, background: "#C5CBD1" }} />
					<span style={{ width: 14, height: 14, borderRadius: 7, background: "#C5CBD1" }} />
				</div>
				<div
					style={{
						alignSelf: "center",
						display: "flex",
						alignItems: "center",
						gap: 8,
						padding: "6px 14px",
						borderRadius: 9,
						background: "#F4DFAE",
						color: "#5A4310",
						fontFamily: FONT.sans,
						fontWeight: 600,
						fontSize: 21,
						boxShadow: ring > 0 ? `0 0 0 ${4 * ring}px ${C.brass}, 0 0 ${30 * ring}px ${C.brass}` : "none",
					}}
				>
					<Img src={staticFile("brand/icon.svg")} style={{ width: 22, height: 22 }} />
					{group}
				</div>
				<div
					style={{
						height: 46,
						maxWidth: width * 0.55,
						display: "flex",
						alignItems: "center",
						padding: "0 18px",
						borderRadius: "12px 12px 0 0",
						borderTop: "3px solid #E9C77E",
						background: "#fff",
						fontFamily: FONT.sans,
						fontSize: 20,
						color: "#2A3540",
						whiteSpace: "nowrap",
						overflow: "hidden",
						textOverflow: "ellipsis",
					}}
				>
					{tabTitle(frame)}
				</div>
			</div>
			<div style={{ height: 46, display: "flex", alignItems: "center", padding: "0 18px", borderBottom: "1px solid #E3E6EA" }}>
				<div
					style={{
						flex: 1,
						height: 32,
						borderRadius: 16,
						background: "#EEF1F4",
						display: "flex",
						alignItems: "center",
						padding: "0 16px",
						fontFamily: FONT.sans,
						fontSize: 19,
						color: "#3E4A55",
					}}
				>
					{url(frame)}
				</div>
			</div>
			<div style={{ position: "relative", width, height: contentHeight, background: "#fff" }}>
				{shots.map((s, i) => {
					const next = shots[i + 1];
					const o = i === 0 ? 1 : rise(frame, s.from, 8);
					const hidden = next !== undefined && frame >= next.from + 8;
					if (hidden || frame < s.from) return null;
					return (
						<Img
							key={s.src}
							src={staticFile(s.src)}
							style={{ position: "absolute", inset: 0, width, height: contentHeight, opacity: o }}
						/>
					);
				})}
			</div>
		</div>
	);
};

/**
 * A crop of a 2x side panel capture. `crop` is in the panel's CSS pixels; `scale` is how
 * many video pixels each CSS pixel takes.
 */
export const PanelCrop: React.FC<{
	src: string;
	crop: { x: number; y: number; w: number; h: number };
	scale: number;
	style?: React.CSSProperties;
}> = ({ src, crop, scale, style }) => (
	<div
		style={{
			position: "absolute",
			width: crop.w * scale,
			height: crop.h * scale,
			overflow: "hidden",
			borderRadius: 18,
			border: `1px solid ${C.inkLine}`,
			boxShadow: "0 40px 80px -30px rgba(0,0,0,0.85)",
			...style,
		}}
	>
		<Img
			src={staticFile(src)}
			style={{ position: "absolute", width: 440 * scale, left: -crop.x * scale, top: -crop.y * scale }}
		/>
	</div>
);

/** A soft ring drawn over a region, for "look here". */
export const Ring: React.FC<{ x: number; y: number; w: number; h: number; at: number; until: number; color?: string }> = ({
	x,
	y,
	w,
	h,
	at,
	until,
	color = C.brass,
}) => {
	const frame = useCurrentFrame();
	const o = window01(frame, at, until, 10);
	if (o <= 0) return null;
	const pulse = 0.5 + 0.5 * Math.sin(((frame - at) / 30) * Math.PI * 1.4);
	return (
		<div
			style={{
				position: "absolute",
				left: x - 8,
				top: y - 8,
				width: w + 16,
				height: h + 16,
				borderRadius: 16,
				border: `4px solid ${color}`,
				boxShadow: `0 0 ${18 + 14 * pulse}px ${color}`,
				opacity: o,
			}}
		/>
	);
};
