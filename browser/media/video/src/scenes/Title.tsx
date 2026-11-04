import { Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { C, FONT } from "../theme";
import { Fill, rise, Watermark } from "../ui";

export const Title: React.FC = () => {
	const frame = useCurrentFrame();
	const tile = rise(frame, 0, 24);
	const word = rise(frame, 16, 20);
	const steer = rise(frame, 40, 16);
	const agents = rise(frame, 58, 18);
	const sub = rise(frame, 84, 20);
	return (
		<Fill>
			<Watermark />
			<div
				style={{
					position: "absolute",
					inset: 0,
					display: "flex",
					flexDirection: "column",
					alignItems: "center",
					justifyContent: "center",
					scale: String(interpolate(frame, [0, 150], [1, 1.02])),
				}}
			>
				<Img
					src={staticFile("brand/icon.svg")}
					style={{
						width: 200,
						height: 200,
						opacity: tile,
						translate: `0 ${(1 - tile) * 40}px`,
						filter: "drop-shadow(0 18px 50px rgba(227,169,59,0.35))",
					}}
				/>
				<div
					style={{
						marginTop: 34,
						fontFamily: FONT.sans,
						fontWeight: 600,
						fontSize: 132,
						letterSpacing: "-0.035em",
						color: C.paper,
						opacity: word,
					}}
				>
					Tabkyra
				</div>
				<div style={{ marginTop: 6, fontFamily: FONT.serif, fontStyle: "italic", fontSize: 84, color: C.paper }}>
					<span style={{ opacity: steer }}>You steer. </span>
					<span style={{ opacity: agents, color: C.brass }}>Your agents work the tabs.</span>
				</div>
				<div style={{ marginTop: 34, fontFamily: FONT.sans, fontSize: 44, color: C.mist, opacity: sub }}>
					A Chromium extension and CLI for Claude Code, Codex and any MCP agent.
				</div>
			</div>
		</Fill>
	);
};
