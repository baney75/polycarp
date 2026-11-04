import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { useBeat } from "../hero/beat";
import { Backdrop, CountUp, ease, Flash, shake, slam, useLayout, Whip } from "../hero/motion";
import { Center, Label, useSize } from "../hero/parts";
import { C, FONT } from "../theme";
import { agentsClaims, hex } from "./data";
import { CallBox, Caption, Card, PanelCrop, Pill } from "./parts";

const MAX = 2.4; // video px per CSS px before the 2x panel capture softens

/** B56–B72: agent 3 asks; the user picks in the side panel; the agent fills the form with it. */
export const Ask: React.FC = () => {
	const { team, ask, raw } = agentsClaims();
	const frame = useCurrentFrame();
	const at = useBeat();
	const size = useSize();
	const { vertical } = useLayout();
	const a3 = team.agents[2];
	const { card, option } = raw.ask.boxes;
	const crop = { x: card.x - 8, y: card.y - 8, w: card.width + 16, h: card.height + 16 };
	const scale = Math.min(MAX, vertical ? 960 / crop.w : 820 / crop.w);
	const picked = frame >= at(60);
	const after = frame >= at(64);
	return (
		<AbsoluteFill>
			<Backdrop />
			{!after ? (
				<Whip dur={at(64) - at(56)} from="right" inDur={7}>
					<Center column={vertical} gap={size(56, 40)} style={{ paddingBottom: size(160, 300), paddingTop: size(0, 40) }}>
						<CallBox
							width={size(800, 980)}
							size={size(28, 34)}
							head={<Pill title={a3.title} color={a3.color} size={size(26, 30)} />}
							lines={[
								{ text: "ask_user", prompt: "call", at: 3, color: C.paper },
								{ text: `${ask.header}: ${ask.question}`, at: 9, color: C.paper },
								...ask.options.map((o, i) => ({ text: `  ○ ${o.label}`, at: 12 + i * 3 })),
							]}
						/>
						<div style={{ opacity: ease(frame, at(57), 6), translate: `${(1 - ease(frame, at(57), 12)) * 80}px 0` }}>
							<PanelCrop
								src={picked ? raw.ask.shots.picked : raw.ask.shots.asking}
								crop={crop}
								scale={scale}
								ring={{ x: option.x, y: option.y, w: option.width, h: option.height, t: ease(frame, at(59.5), 6) }}
							/>
						</div>
					</Center>
					<Caption text="Your agent asks. You answer in the side panel." at={at(56) + 4} />
				</Whip>
			) : (
				<Whip dur={at(72) - at(64)} from="right" inDur={7} start={at(64)}>
					<Center column={vertical} gap={size(50, 40)} style={{ paddingBottom: size(160, 300), paddingTop: size(0, 40) }}>
						<CallBox
							width={size(820, 980)}
							size={size(28, 34)}
							markAt={at(65)}
							markColor={C.tide}
							head={<Pill title={a3.title} color={a3.color} size={size(26, 30)} />}
							lines={[
								...ask.resultLines.map((t, i) => ({ text: t, prompt: i === 0 ? ("result" as const) : undefined, at: at(64) + 2 + i * 3, color: i === 1 ? C.paper : C.mist, mark: i === 1 })),
								...ask.fills.map((f, i) => ({ text: `fill ${f.ref} "${f.value}"`, prompt: "call" as const, at: at(67) + i * 6, color: C.paper })),
							]}
						/>
						<div style={{ opacity: ease(frame, at(68), 6), translate: `0 ${(1 - ease(frame, at(68), 12)) * 60}px` }}>
							<Card src={raw.ask.after.shot} url={a3.url} width={size(820, 900)} drift={ease(frame, at(68), at(72) - at(68))} />
						</div>
					</Center>
					<Caption text="It gets your answer and keeps going." at={at(64) + 4} />
				</Whip>
			)}
			<Flash at={at(64)} color={C.tide} strength={0.2} />
		</AbsoluteFill>
	);
};

/** B72–B88: the side panel composer: "/" menu, filtered, "@" menu, the message, the reply. */
export const Composer: React.FC = () => {
	const { raw } = agentsClaims();
	const k = raw.composer;
	const frame = useCurrentFrame();
	const at = useBeat();
	const size = useSize();
	const { vertical } = useLayout();
	const steps = [
		{ b: 72, key: "slash" },
		{ b: 75, key: "slash-filtered" },
		{ b: 78, key: "at" },
		{ b: 81.5, key: "composed" },
		{ b: 84, key: "reply" },
	];
	const current = [...steps].reverse().find((s) => frame >= at(s.b)) ?? steps[0];
	const local = frame - at(current.b);
	const box = k.boxes[current.key] ?? k.boxes.composed;
	// Menu shots: the menu and the composer under it. The message: the composer. The reply: the transcript above the composer.
	const editor = box.editor;
	const top = current.key === "reply" ? 48 : current.key === "composed" ? editor.y - 140 : (box.menu?.y ?? editor.y) - 10;
	const bottom = current.key === "reply" ? (box.contentBottom ?? editor.y - 4) + 14 : editor.y + editor.height + 6;
	const crop = { x: 0, y: Math.max(0, top), w: 440, h: bottom - Math.max(0, top) };
	const room = vertical ? { w: 1000, h: 1340 } : { w: 1500, h: 800 };
	const scale = Math.min(MAX, room.w / crop.w, room.h / crop.h);
	return (
		<AbsoluteFill>
			<Backdrop />
			<Center style={{ paddingBottom: size(170, 300), paddingTop: size(20, 40) }}>
				<div
					key={current.key}
					style={{
						opacity: ease(local, 0, 5),
						translate: `${(1 - ease(local, 0, 10)) * 120}px 0`,
						scale: String(1.04 - 0.04 * ease(local, 0, 10)),
						filter: local < 3 ? `blur(${(3 - local) * 4}px)` : undefined,
					}}
				>
					<PanelCrop src={k.shots[current.key]} crop={crop} scale={scale} />
				</div>
			</Center>
			<Caption text={"/ runs a skill.\n@ points it at a tab."} at={at(72) + 4} until={at(84)} />
			<Caption text="It runs right in the side panel." at={at(84)} />
		</AbsoluteFill>
	);
};

/** B88–B101: three real commands against the same browser, their output as printed. */
export const Terminal: React.FC = () => {
	const { cli, team } = agentsClaims();
	const frame = useCurrentFrame();
	const at = useBeat();
	const size = useSize();
	const { vertical } = useLayout();
	const blocks = [
		{ r: cli.sessions, b: 88 },
		{ r: cli.tabs, b: 92 },
		{ r: cli.threads, b: 96.5 },
	];
	const fs = size(26, 27);
	const lines: { text: string; at: number; typed?: boolean }[] = [];
	for (const { r, b } of blocks) {
		lines.push({ text: r.shown.replace(/^tabkyra /, "tabkyra "), at: at(b), typed: true });
		const outLines = r.out.split("\n").filter((l, i, all) => !(l === "" && (i === 0 || all[i - 1] === "")));
		outLines.forEach((l, i) => lines.push({ text: l, at: at(b) + 14 + i }));
	}
	// The group names in the output take their group's color.
	const paint = (text: string) => {
		const hit = [...team.agents].reverse().find((a) => text.includes(a.title));
		if (!hit) return text;
		const [pre, post] = [text.slice(0, text.indexOf(hit.title)), text.slice(text.indexOf(hit.title) + hit.title.length)];
		return (
			<>
				{pre}
				<span style={{ color: "#fff", background: hex(hit.color), borderRadius: 6, padding: "0 6px" }}>{hit.title}</span>
				{post}
			</>
		);
	};
	// Keep the newest lines in view: scroll once the output outgrows the window.
	const visible = lines.filter((l) => frame >= l.at).length;
	const room = vertical ? 33 : 22;
	const scroll = Math.max(0, visible - room) * fs * 1.42;
	const s = interpolate(frame, [0, at(101) - at(88)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
	return (
		<Whip dur={at(101) - at(88)} from="zoom" inDur={8}>
			<Backdrop hue={C.tide} />
			<Center style={{ paddingBottom: size(160, 300), paddingTop: size(30, 80) }}>
				<div
					style={{
						width: size(1780, 1056),
						height: size(820, 1320),
						overflow: "hidden",
						borderRadius: 22,
						background: C.inkDeep,
						border: `1px solid ${C.inkLine}`,
						boxShadow: "0 60px 120px -40px rgba(0,0,0,0.9)",
						scale: String(1 + 0.02 * s),
					}}
				>
					<div style={{ height: 44, display: "flex", alignItems: "center", gap: 10, padding: "0 18px", borderBottom: `1px solid ${C.inkLine}` }}>
						{[0, 1, 2].map((i) => (
							<span key={i} style={{ width: 13, height: 13, borderRadius: 7, background: C.inkLine }} />
						))}
						<span style={{ marginLeft: 12, fontFamily: FONT.sans, fontSize: 22, color: C.slate }}>~/shop</span>
					</div>
					<div style={{ padding: `${fs}px ${fs * 1.1}px`, fontFamily: FONT.mono, fontSize: fs, lineHeight: 1.42, translate: `0 ${-scroll}px` }}>
						{lines.map((l, i) => {
							if (frame < l.at) return null;
							if (l.typed) {
								const shown = l.text.slice(0, Math.floor((frame - l.at) * 2.4));
								return (
									<div key={`${i}-${l.text}`} style={{ marginTop: i === 0 ? 0 : fs * 0.6, whiteSpace: "pre" }}>
										<span style={{ color: C.brass }}>$ </span>
										<span style={{ color: C.paper }}>{shown}</span>
									</div>
								);
							}
							return (
								<div key={`${i}-${l.text}`} style={{ color: C.mist, whiteSpace: "pre", overflow: "hidden", textOverflow: "ellipsis", opacity: ease(frame, l.at, 4) }}>
									{paint(l.text) || " "}
								</div>
							);
						})}
					</div>
				</div>
			</Center>
			<Caption text="Every session, from your terminal." at={4} />
		</Whip>
	);
};

/** B101–B110: the extension reloads mid-click; the click ran once and the agent is told to check. */
export const Reload: React.FC = () => {
	const { reload, team, raw } = agentsClaims();
	const frame = useCurrentFrame();
	const { fps } = useVideoConfig();
	const at = useBeat();
	const size = useSize();
	const { vertical } = useLayout();
	const a3 = team.agents[2];
	const bolt = at(103);
	const args = raw.reload.call.args as { steps: unknown[] };
	return (
		<Whip dur={at(110) - at(101)} from="right" inDur={7}>
			<Backdrop hue={C.brass} />
			<AbsoluteFill style={{ translate: shake(frame, bolt, 26) }}>
				<Center column={vertical} gap={size(50, 36)} style={{ paddingBottom: size(160, 300), paddingTop: size(0, 40) }}>
					<div style={{ display: "flex", flexDirection: "column", gap: size(24, 24), alignItems: "center" }}>
						<CallBox
							width={size(960, 980)}
							size={size(27, 34)}
							markAt={at(104.5)}
							head={<Pill title={a3.title} color={a3.color} size={size(26, 30)} />}
							lines={[
								{ text: `actions ${JSON.stringify(args.steps)}`, prompt: "call", at: 3, color: C.paper },
								{ text: "the extension reloads", at: bolt, color: C.alarm },
								{ text: reload.text, prompt: "result", at: bolt + 6, color: C.paper, mark: true },
							]}
						/>
					</div>
					<div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: size(14, 14), opacity: ease(frame, at(105.5), 6) }}>
						<Label size={size(26, 28)}>orders the shop received</Label>
						<div style={{ fontFamily: FONT.sans, fontWeight: 600, fontSize: size(170, 150), color: C.tide, lineHeight: 1, scale: String(1.3 - 0.3 * slam(frame, fps, at(105.5), 12)) }}>
							<CountUp to={reload.runs} at={at(105.5)} dur={4} />
						</div>
						<div style={{ maxWidth: size(640, 900), fontFamily: FONT.mono, fontSize: size(26, 28), color: C.paper, textAlign: "center" }}>{reload.placed}</div>
					</div>
				</Center>
			</AbsoluteFill>
			<Caption text="Reload mid-click. The click runs once." at={4} />
			<Flash at={bolt} color={C.alarm} strength={0.3} />
		</Whip>
	);
};
