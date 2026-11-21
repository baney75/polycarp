import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { useBeat } from "../hero/beat";
import { Backdrop, ease, Flash, shake, slam, Stamp, useLayout, Whip } from "../hero/motion";
import { Center, Label, useSize } from "../hero/parts";
import { C, FONT } from "../theme";
import { agentsClaims, hex } from "./data";
import { CallBox, Caption, Card, Pill } from "./parts";

/** A page card with its group pill above it, landing with a slam at `at`. */
const AgentCard: React.FC<{ i: number; at: number; width: number; pill: number; dim?: number; ring?: number }> = ({ i, at, width, pill, dim = 0, ring = 0 }) => {
	const a = agentsClaims().team.agents[i];
	const frame = useCurrentFrame();
	const { fps } = useVideoConfig();
	const s = slam(frame, fps, at, 12);
	if (frame < at) return <div style={{ width }} />;
	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				gap: pill * 0.45,
				width,
				opacity: Math.min(1, s * 1.8) * (1 - 0.6 * dim),
				translate: `0 ${(1 - s) * 140}px`,
				scale: String(1.12 - 0.12 * s),
				filter: s < 0.85 ? `blur(${(1 - s) * 14}px)` : undefined,
			}}
		>
			<div>
				<Pill title={a.title} color={a.color} size={pill} dim={dim} ring={ring} />
			</div>
			<Card src={a.shot} url={a.url} width={width} drift={ease(frame, at, 120)} />
		</div>
	);
};

/** B0–B10: the hook. Three agents' pages land under their own group pills. */
export const Hook: React.FC = () => {
	const frame = useCurrentFrame();
	const at = useBeat();
	const { vertical } = useLayout();
	const lands = [2, at(1), at(2)];
	const ringAt = (i: number) => {
		const t0 = at(5) + i * 4;
		return interpolate(frame, [t0, t0 + 6, t0 + 22], [0, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
	};
	const push = 1 + 0.04 * ease(frame, 0, at(10));
	return (
		<AbsoluteFill>
			<Backdrop />
			<AbsoluteFill style={{ scale: String(push) }}>
				{vertical ? (
					// Vertical: a cascade, each card lower and in front of the last.
					<AbsoluteFill>
						{[0, 1, 2].map((i) => (
							<div key={i} style={{ position: "absolute", left: 70 + i * 40, top: 70 + i * 370, rotate: `${(i - 1) * -1.5}deg` }}>
								<AgentCard i={i} at={lands[i]} width={860} pill={40} ring={ringAt(i)} />
							</div>
						))}
					</AbsoluteFill>
				) : (
					<Center column={false} gap={36} style={{ paddingBottom: 170 }}>
						{[0, 1, 2].map((i) => (
							<AgentCard key={i} i={i} at={lands[i]} width={580} pill={32} ring={ringAt(i)} />
						))}
					</Center>
				)}
			</AbsoluteFill>
			<Caption text="Three agents. One browser." at={at(1)} until={at(5)} />
			<Caption text="Each one gets its own tab group." at={at(5)} />
			<Flash at={0} strength={0.45} />
		</AbsoluteFill>
	);
};

/** B10–B28: agent 2 reaches for agent 1's tab and is refused; then each one's own view. */
export const Separate: React.FC = () => {
	const { team } = agentsClaims();
	const frame = useCurrentFrame();
	const at = useBeat();
	const size = useSize();
	const { vertical } = useLayout();
	const [a1, a2] = team.agents;
	const views = frame >= at(20);
	const dimOthers = ease(frame, at(26.5), 10);
	return (
		<AbsoluteFill>
			<Backdrop />
			{!views ? (
				<Whip dur={at(20) - at(10)} from="right" inDur={7}>
					<AbsoluteFill style={{ translate: shake(frame, at(14), 22) }}>
						<Center column={vertical} gap={size(56, 60)} style={{ paddingBottom: size(150, 260) }}>
							<div style={{ position: "relative" }}>
								<AgentCard i={0} at={0} width={size(760, 880)} pill={size(32, 40)} />
								<div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", paddingTop: size(60, 60) }}>
									<Stamp text="NOT YOURS" at={at(14)} size={size(96, 104)} />
								</div>
							</div>
							<CallBox
								width={size(860, 960)}
								size={size(30, 34)}
								head={<Pill title={a2.title} color={a2.color} size={size(28, 34)} />}
								lines={[
									{ text: team.refusal.call, prompt: "call", at: at(11), color: C.paper },
									{ text: team.refusal.text, prompt: "result", at: at(14), color: C.alarm },
									{ text: `${a1.title.replace("Tabkyra · ", "")} keeps tab ${a1.tabId}`, at: at(16), color: C.tide },
								]}
							/>
						</Center>
					</AbsoluteFill>
					<Caption text="None of them can touch another's tabs." at={at(10.5)} />
				</Whip>
			) : (
				<Whip dur={at(28) - at(20)} from="right" inDur={7} exit={false} start={at(20)}>
					<Center gap={size(26, 30)} style={{ paddingBottom: size(150, 260), paddingTop: size(30, 80) }}>
						<Label size={size(26, 30)}>tabs_context, as each agent got it</Label>
						{team.agents.map((a, i) => (
							<CallBox
								key={a.key}
								width={size(1640, 980)}
								size={size(26, 32)}
								markAt={at(22) + i * 3}
								markColor={C.tide}
								style={{ opacity: i === 0 ? 1 : 1 - 0.75 * dimOthers }}
								head={<Pill title={a.title} color={a.color} size={size(26, 30)} dim={0} />}
								lines={[
									{ text: a.header, at: at(20) + 4 + i * 3 },
									{ text: a.line, at: at(20) + 6 + i * 3, color: C.paper, mark: true },
								]}
							/>
						))}
					</Center>
					<Caption text="Each one sees only its own." at={at(20.5)} until={at(27.5)} />
				</Whip>
			)}
			<Flash at={at(14)} color={C.alarm} strength={0.22} />
		</AbsoluteFill>
	);
};

/** One drawn tab in a light tab strip: favicon dot and the recorded title. */
const Tab: React.FC<{ title: string; width: number; size: number; color?: string; style?: React.CSSProperties }> = ({ title, width, size, color, style }) => (
	<div
		style={{
			width,
			height: size * 2.2,
			display: "flex",
			alignItems: "center",
			gap: size * 0.5,
			padding: `0 ${size * 0.7}px`,
			borderRadius: `${size * 0.5}px ${size * 0.5}px 0 0`,
			background: "#fff",
			borderBottom: color ? `${size * 0.18}px solid ${color}` : `${size * 0.18}px solid transparent`,
			fontFamily: FONT.sans,
			fontSize: size,
			color: "#2A3540",
			whiteSpace: "nowrap",
			overflow: "hidden",
			boxShadow: "0 10px 24px -12px rgba(0,0,0,0.5)",
			...style,
		}}
	>
		<span style={{ width: size * 0.8, height: size * 0.8, borderRadius: size * 0.2, background: "#7a3e1d", flexShrink: 0 }} />
		<span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{title}</span>
	</div>
);

/** B28–B44: agent 1 quits, its group stays; it starts again and its tabs come back. */
export const Resume: React.FC = () => {
	const { team, resume } = agentsClaims();
	const frame = useCurrentFrame();
	const { fps } = useVideoConfig();
	const at = useBeat();
	const size = useSize();
	const { vertical } = useLayout();
	const a1 = team.agents[0];
	const back = frame >= at(32);
	const dim = back ? 1 - slam(frame, fps, at(32), 10) : ease(frame, 4, 14);
	const tabW = size(520, 460);
	const tabs = resume.whileClosed.tabs;
	return (
		<AbsoluteFill>
			<Backdrop hue={back ? C.tide : C.slate} />
			<AbsoluteFill style={{ translate: back ? shake(frame, at(32), 18) : undefined }}>
				<Center gap={size(40, 50)} style={{ paddingBottom: size(160, 280) }}>
					<div style={{ display: "flex", flexDirection: vertical ? "column" : "row", alignItems: vertical ? "flex-start" : "flex-end", gap: size(16, 18), scale: String(back ? 1 + 0.08 * (1 - ease(frame, at(32), 14)) : 1) }}>
						<Pill title={a1.title} color={a1.color} size={size(44, 44)} dim={dim} ring={back ? 1 - ease(frame, at(32), 30) : 0} />
						<div style={{ display: "flex", gap: size(10, 12) }}>
							{tabs.map((t) => (
								<Tab key={t.id} title={t.title} width={tabW} size={size(32, 30)} color={dim > 0.5 ? "#9AA4AD" : hex(a1.color)} style={{ opacity: 1 - 0.35 * dim }} />
							))}
						</div>
					</div>
					{!back ? (
						<div style={{ fontFamily: FONT.mono, fontSize: size(40, 32), color: C.mist, opacity: ease(frame, 6, 8), maxWidth: size(1600, 900), textAlign: "center" }}>
							agent 1 quit · its {tabs.length} tabs stay in the group
						</div>
					) : (
						<CallBox
							width={size(1600, 980)}
							size={size(28, 34)}
							markAt={at(34)}
							markColor={C.tide}
							head={<Label size={size(24, 26)}>agent 1, started again: tabs_context</Label>}
							lines={[
								{ text: resume.header, at: at(32) + 3 },
								...resume.after.map((t, i) => ({ text: t.line, at: at(32) + 6 + i * 3, color: C.paper, mark: true })),
							]}
						/>
					)}
				</Center>
			</AbsoluteFill>
			<Caption text="Quit an agent. Its tabs stay put." at={4} until={at(32)} />
			<Caption text="Start it again. Its tabs come back." at={at(32) + 4} />
			<Flash at={at(32)} color={C.tide} strength={0.4} />
		</AbsoluteFill>
	);
};

/** B44–B56: the user drags a tab out of the agent's group; the agent is told it's theirs. */
export const Handoff: React.FC = () => {
	const { team, handoff } = agentsClaims();
	const frame = useCurrentFrame();
	const at = useBeat();
	const size = useSize();
	const { vertical } = useLayout();
	const a1 = team.agents[0];
	const tabs = handoff.groupBefore.tabs;
	const leaving = tabs.find((t) => t.title === handoff.tabTitle) ?? tabs[tabs.length - 1];
	const staying = tabs.filter((t) => t !== leaving);
	const tabW = size(520, 640);
	// The drag: lift (anticipation), pull out, drop clear of the group.
	const lift = ease(frame, at(46), 5);
	const pull = interpolate(frame, [at(46) + 4, at(48)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: (t) => 1 - (1 - t) ** 3 });
	// Wide: right and down, clear of the strip. Vertical: down, below it.
	const dx = vertical ? pull * 60 : pull * size(120, 0);
	const dy = -lift * 14 * (1 - pull) + pull * size(170, 190);
	const out = pull > 0.6;
	const cursor = { x: dx + tabW * 0.55, y: dy + size(40, 44) };
	return (
		<Whip dur={at(56) - at(44)} from="up" inDur={7}>
			<Backdrop />
			<Center gap={size(250, 280)} style={{ paddingBottom: size(160, 280) }}>
				<div style={{ padding: size(26, 30), borderRadius: size(20, 24), background: "#DEE3E8", display: "flex", flexDirection: vertical ? "column" : "row", alignItems: vertical ? "flex-start" : "flex-end", gap: size(14, 16) }}>
					<Pill title={a1.title} color={a1.color} size={size(40, 48)} />
					<div style={{ display: "flex", flexDirection: vertical ? "column" : "row", gap: size(10, 12) }}>
						{staying.map((t) => (
							<Tab key={t.id} title={t.title} width={tabW} size={size(32, 36)} color={hex(a1.color)} />
						))}
						<div style={{ position: "relative", translate: `${dx}px ${dy}px`, zIndex: 2 }}>
							<Tab
								title={leaving.title}
								width={tabW}
								size={size(32, 36)}
								color={out ? undefined : hex(a1.color)}
								style={{ rotate: `${lift * (1 - pull) * 2}deg`, boxShadow: lift > 0 ? "0 24px 40px -12px rgba(0,0,0,0.6)" : undefined, outline: out ? `3px solid ${C.brass}` : undefined }}
							/>
							{frame >= at(45.5) && frame < at(49) ? (
								<svg width={size(44, 48)} height={size(44, 48)} viewBox="0 0 24 24" style={{ position: "absolute", left: cursor.x - dx, top: cursor.y - dy, filter: "drop-shadow(0 4px 6px rgba(0,0,0,.5))" }}>
									<path d="M4 2 L4 20 L9 15 L12 22 L15 21 L12 14 L19 14 Z" fill="#111" stroke="#fff" strokeWidth="1.5" />
								</svg>
							) : null}
							{out ? (
								<div style={{ position: "absolute", top: "100%", left: 0, marginTop: size(10, 10), fontFamily: FONT.sans, fontWeight: 600, fontSize: size(34, 34), color: C.brass, opacity: ease(frame, at(48), 6) }}>
									your tab now
								</div>
							) : null}
						</div>
					</div>
				</div>
				<CallBox
					width={size(1640, 980)}
					size={size(28, 34)}
					markAt={at(50)}
					head={<Label size={size(24, 26)}>agent 1's next tabs_context</Label>}
					style={{ opacity: ease(frame, at(49), 6) }}
					lines={[{ text: handoff.news, at: at(49), color: C.paper, mark: true }]}
				/>
			</Center>
			<Caption text="Drag a tab out. Now it's yours." at={at(44) + 4} />
		</Whip>
	);
};
