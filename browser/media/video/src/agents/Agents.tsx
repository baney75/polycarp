import { AbsoluteFill, Audio, staticFile } from "remotion";
import { Seg } from "../hero/beat";
import { Finish } from "../hero/motion";
import { EndCard } from "../hero/Outro";
import { agentsClaims } from "./data";
import { Handoff, Hook, Resume, Separate } from "./Team";
import { Ask, Composer, Reload, Terminal } from "./Work";

/**
 * The Agents cut: what changed for agents, on the hero's music and beat map. Every segment starts
 * and ends on a beat index from src/hero/music.json. `Agents` (16:9) and `AgentsVertical` (9:16)
 * render this same edit. Shot plan: AGENTS-STORYBOARD.md.
 */
export const Agents: React.FC = () => {
	// Every frame first checks the whole recording, so any frame of a bad capture fails the render.
	agentsClaims();
	return (
		<AbsoluteFill style={{ background: "#0F1B24" }}>
			<Audio src={staticFile("hero/music.m4a")} />
			<Seg name="Hook" start={0} end={10}>
				<Hook />
			</Seg>
			<Seg name="Separate" start={10} end={28}>
				<Separate />
			</Seg>
			<Seg name="Resume" start={28} end={44}>
				<Resume />
			</Seg>
			<Seg name="Hand-off" start={44} end={56}>
				<Handoff />
			</Seg>
			<Seg name="It asks" start={56} end={72}>
				<Ask />
			</Seg>
			<Seg name="/ and @" start={72} end={88}>
				<Composer />
			</Seg>
			<Seg name="Terminal" start={88} end={101}>
				<Terminal />
			</Seg>
			<Seg name="Reload" start={101} end={110}>
				<Reload />
			</Seg>
			<Seg name="End card" start={110} end={1000}>
				<EndCard />
			</Seg>
			<Finish />
		</AbsoluteFill>
	);
};
