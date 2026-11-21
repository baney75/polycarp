import { AbsoluteFill } from "remotion";
import { Backdrop, Finish } from "../hero/motion";
import { C, FONT } from "../theme";
import { agentsClaims } from "./data";
import { Card, Pill } from "./parts";

/** The still for the post: the three recorded pages under their group pills, and the line. */
export const AgentsPoster: React.FC<{ scale: number }> = ({ scale }) => {
	const { team } = agentsClaims();
	return (
		<AbsoluteFill>
			<AbsoluteFill style={{ scale: String(scale), width: 1920, height: 1080, transformOrigin: "0 0" }}>
				<Backdrop />
				<AbsoluteFill style={{ alignItems: "center", justifyContent: "center", gap: 70 }}>
					<div style={{ fontFamily: FONT.sans, fontWeight: 600, fontSize: 104, letterSpacing: "-0.03em", color: C.paper }}>
						Three agents. <span style={{ color: C.brass }}>One browser.</span>
					</div>
					<div style={{ display: "flex", gap: 44 }}>
						{team.agents.map((a) => (
							<div key={a.key} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
								<div>
									<Pill title={a.title} color={a.color} size={30} />
								</div>
								<Card src={a.shot} url={a.url} width={560} />
							</div>
						))}
					</div>
					<div style={{ fontFamily: FONT.mono, fontSize: 40, color: C.mist }}>Tabkyra · github.com/baney75/tabkyra</div>
				</AbsoluteFill>
				<Finish />
			</AbsoluteFill>
		</AbsoluteFill>
	);
};
