import "./theme";
import { Composition, Folder, Still } from "remotion";
import { DEMO_FRAMES, Demo, SCENES } from "./Demo";
import { Agents } from "./agents/Agents";
import { AgentsPoster } from "./agents/AgentsPoster";
import { Poster } from "./Poster";
import { HERO_FRAMES } from "./hero/beat";
import { Hero } from "./hero/Hero";
import { HeroPoster } from "./hero/HeroPoster";
import { AsksFirst } from "./scenes/AsksFirst";
import { BrowserWork } from "./scenes/BrowserWork";
import { EndCard } from "./scenes/EndCard";
import { GetStarted } from "./scenes/GetStarted";
import { Library } from "./scenes/Library";
import { SkillLint } from "./scenes/SkillLint";
import { Title } from "./scenes/Title";

export const RemotionRoot: React.FC = () => (
	<>
		<Composition id="Demo" component={Demo} durationInFrames={DEMO_FRAMES} fps={30} width={1920} height={1080} />
		<Still id="Poster" component={Poster} width={1280} height={720} defaultProps={{ scale: 2 / 3 }} />
		<Composition id="Hero" component={Hero} durationInFrames={HERO_FRAMES} fps={30} width={1920} height={1080} />
		<Composition id="HeroVertical" component={Hero} durationInFrames={HERO_FRAMES} fps={30} width={1080} height={1920} />
		<Still id="HeroPoster" component={HeroPoster} width={1280} height={720} defaultProps={{ scale: 2 / 3 }} />
		<Composition id="Agents" component={Agents} durationInFrames={HERO_FRAMES} fps={30} width={1920} height={1080} />
		<Composition id="AgentsVertical" component={Agents} durationInFrames={HERO_FRAMES} fps={30} width={1080} height={1920} />
		<Still id="AgentsPoster" component={AgentsPoster} width={1280} height={720} defaultProps={{ scale: 2 / 3 }} />
		<Folder name="Scenes">
			<Composition id="Title" component={Title} durationInFrames={SCENES.title} fps={30} width={1920} height={1080} />
			<Composition id="AsksFirst" component={AsksFirst} durationInFrames={SCENES.asks} fps={30} width={1920} height={1080} />
			<Composition id="BrowserWork" component={BrowserWork} durationInFrames={SCENES.browser} fps={30} width={1920} height={1080} />
			<Composition id="Library" component={Library} durationInFrames={SCENES.library} fps={30} width={1920} height={1080} />
			<Composition id="SkillLint" component={SkillLint} durationInFrames={SCENES.lint} fps={30} width={1920} height={1080} />
			<Composition id="GetStarted" component={GetStarted} durationInFrames={SCENES.start} fps={30} width={1920} height={1080} />
			<Composition id="EndCard" component={EndCard} durationInFrames={SCENES.end} fps={30} width={1920} height={1080} />
		</Folder>
	</>
);
