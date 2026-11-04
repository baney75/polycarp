import { AbsoluteFill, useCurrentFrame } from "remotion";
import { C, FONT } from "../theme";
import { useBeat } from "./beat";
import { Helm } from "./Helm";
import { heroClaims } from "./heroClaims";
import { Backdrop, ease, Flash, useLayout, Whip, Words } from "./motion";
import { Center, useSize } from "./parts";

/**
 * B92–B103: the skill router (merged in #21), from real runs recorded by
 * scripts/demo/capture-router.mjs: four `tabkyra skill match` tasks and the router's own p95
 * latency from `tabkyra skill eval`.
 */
export const Router: React.FC = () => {
	// The headline, the figures and each row's skill, score and description are checked and
	// parsed from router.json (checkRouter in claims.ts).
	const ROUTER = heroClaims().router;
	const frame = useCurrentFrame();
	const at = useBeat();
	const size = useSize();
	const { vertical } = useLayout();
	const rows = ROUTER.rows.map((m, i) => ({ ...m, at: at(96 + 2 * i) }));
	const lift = ease(frame, at(96), 10);
	return (
		<Whip dur={at(104) - at(92)} from="up" inDur={6}>
			<Backdrop />
			<AbsoluteFill style={{ padding: size(90, 80), display: "flex", flexDirection: "column", justifyContent: "center", gap: size(40, 46) }}>
				<div style={{ scale: String(1 - 0.38 * lift), transformOrigin: "50% 0%", marginBottom: -lift * size(110, 90) }}>
					<Words
						words={vertical ? ["The right skill,", "in under", "a millisecond", "at p95."] : ["The right skill,", "in under a millisecond at p95."]}
						ats={[0, at(93), at(93) + 4, at(93) + 8]}
						size={size(104, 104)}
						colors={[C.paper, C.brass, C.brass, C.brass]}
					/>
					<div style={{ marginTop: size(18, 24), textAlign: "center", fontFamily: FONT.mono, fontSize: size(40, 40), color: C.tide, opacity: ease(frame, at(94), 6) }}>
						tabkyra skill eval: p95 {ROUTER.p95Ms} ms per match over {ROUTER.timed.toLocaleString("en-US")} timed matches · {ROUTER.skills} skills
					</div>
				</div>
				<div style={{ display: "flex", flexDirection: "column", gap: size(22, 30), alignItems: "center" }}>
					{rows.map((r) => {
						if (frame < r.at) return null;
						const { none, name, score, description } = r;
						const s = ease(frame, r.at, 8);
						const hit = ease(frame, r.at + 4, 6);
						return (
							<div
								key={r.task}
								style={{
									width: size(1700, 960),
									padding: `${size(16, 20)}px ${size(28, 28)}px`,
									borderRadius: size(18, 20),
									background: C.inkDeep,
									border: `1px solid ${C.inkLine}`,
									opacity: s,
									translate: `${(1 - s) * 80}px 0`,
								}}
							>
								<div style={{ fontFamily: FONT.mono, fontSize: size(28, 32), color: C.mist, whiteSpace: vertical ? "normal" : "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
									<span style={{ color: C.brass }}>$ </span>
									{r.shown}
								</div>
								<div style={{ display: "flex", alignItems: "baseline", gap: size(22, 18), marginTop: 6, opacity: hit, scale: String(1.15 - 0.15 * hit), transformOrigin: "0 50%" }}>
									<span style={{ fontFamily: FONT.mono, fontWeight: 700, fontSize: size(46, 54), color: none ? C.tide : C.brass, whiteSpace: "nowrap", flex: "none" }}>{name}</span>
									{score ? <span style={{ fontFamily: FONT.mono, fontSize: size(30, 34), color: C.mist, flex: "none" }}>{score}</span> : null}
									<span style={{ fontFamily: FONT.sans, fontSize: size(26, 24), color: C.slate, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>
										{description}
									</span>
								</div>
							</div>
						);
					})}
				</div>
				<div style={{ textAlign: "center", fontFamily: FONT.mono, fontSize: size(24, 26), color: C.mist, opacity: ease(frame, at(96), 6) }}>
					each whole command: {ROUTER.commandMs.min}–{ROUTER.commandMs.max} ms, starting Node; the match inside it is the p95 above
				</div>
			</AbsoluteFill>
		</Whip>
	);
};

// All five are named in the README's "Connect your agent" section.
const AGENTS = ["Claude Code", "Codex", "pi", "OMP", "Cursor"];

/** B104–B109: the agents it works with, one per half beat. */
export const WorksWith: React.FC = () => {
	const frame = useCurrentFrame();
	const at = useBeat();
	const size = useSize();
	const { vertical } = useLayout();
	return (
		<Whip dur={at(110) - at(104)} from="zoom" inDur={1}>
			<Backdrop />
			<Center gap={size(40, 50)}>
				<Words words={["Works", "with"]} ats={[0, 0]} size={size(120, 120)} font={FONT.serif} italic colors={[C.mist, C.mist]} />
				<div
					style={{
						display: "flex",
						flexDirection: vertical ? "column" : "row",
						flexWrap: "wrap",
						justifyContent: "center",
						alignItems: "center",
						gap: `${size(20, 24)}px ${size(60, 0)}px`,
						maxWidth: size(1700, 1000),
					}}
				>
					{AGENTS.map((name, i) => (
						<Words key={name} words={[name]} ats={[at(104.5 + i / 2)]} size={size(130, 130)} colors={[i % 2 ? C.paper : C.brass]} />
					))}
				</div>
				<div style={{ opacity: ease(frame, at(107.5), 6), fontFamily: FONT.sans, fontSize: size(60, 56), color: C.mist }}>and any MCP agent</div>
			</Center>
			<Flash at={0} strength={0.3} />
		</Whip>
	);
};

/** B110 to the end: the helm assembles, the wordmark, the line, the command, the address. */
export const EndCard: React.FC = () => {
	const frame = useCurrentFrame();
	const at = useBeat();
	const size = useSize();
	const { vertical } = useLayout();
	// The eight pegs light clockwise within one beat, B110 to B111 (one every 1/8 beat).
	const step = (at(111) - at(110)) / 8;
	const command = "tabkyra setup";
	const typed = command.slice(0, Math.max(0, Math.floor((frame - at(113)) / 1.4)));
	return (
		<AbsoluteFill>
			<Backdrop />
			<Center gap={size(26, 40)} style={{ padding: size(80, 60) }}>
				<div style={{ display: "flex", flexDirection: vertical ? "column" : "row", alignItems: "center", gap: size(40, 30) }}>
					<Helm
						size={size(190, 240)}
						ring={ease(frame, 0, at(111))}
						pegs={Array.from({ length: 8 }, (_, i) => ease(frame, i * step, 5))}
						pointer={ease(frame, at(111) - 2, 5)}
					/>
					<div
						style={{
							fontFamily: FONT.sans,
							fontWeight: 600,
							fontSize: size(180, 170),
							letterSpacing: "-0.035em",
							color: C.paper,
							opacity: ease(frame, at(111), 6),
							translate: `${(1 - ease(frame, at(111), 12)) * (vertical ? 0 : -60)}px ${(1 - ease(frame, at(111), 12)) * (vertical ? 40 : 0)}px`,
						}}
					>
						Tabkyra
					</div>
				</div>
				<Words
					words={vertical ? ["You steer.", "Your agents", "work the tabs."] : ["You steer.", "Your agents work the tabs."]}
					ats={[at(111.5), at(112), at(112.5)]}
					size={size(96, 96)}
					font={FONT.serif}
					italic
					colors={[C.paper, C.brass, C.brass]}
				/>
				<div
					style={{
						marginTop: size(20, 30),
						padding: `${size(22, 26)}px ${size(40, 44)}px`,
						borderRadius: size(20, 22),
						background: C.inkDeep,
						border: `1px solid ${C.inkLine}`,
						opacity: ease(frame, at(113), 5),
						display: "flex",
						flexDirection: "column",
						alignItems: "center",
						gap: 10,
					}}
				>
					<div style={{ fontFamily: FONT.mono, fontSize: size(64, 60), color: C.paper }}>
						<span style={{ color: C.brass }}>$ </span>
						{typed}
					</div>
					<div style={{ fontFamily: FONT.sans, fontSize: size(30, 30), color: C.mist, opacity: ease(frame, at(113.5), 6), textAlign: "center" }}>
						builds the extension, registers your browser, offers to add your agents
					</div>
				</div>
				<div
					style={{
						marginTop: size(16, 30),
						display: "flex",
						flexDirection: vertical ? "column" : "row",
						alignItems: "center",
						gap: size(50, 18),
						opacity: ease(frame, at(114), 6),
						translate: `0 ${(1 - ease(frame, at(114), 10)) * 30}px`,
					}}
				>
					<span style={{ fontFamily: FONT.mono, fontSize: size(64, 64), color: C.brass }}>dbaney.com/tabkyra</span>
					<span style={{ fontFamily: FONT.mono, fontSize: size(40, 40), color: C.mist }}>github.com/baney75/tabkyra</span>
				</div>
			</Center>
			<Flash at={0} strength={0.16} />
			<Flash at={at(120)} strength={0.4} />
		</AbsoluteFill>
	);
};
