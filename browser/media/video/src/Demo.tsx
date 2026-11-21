import { linearTiming, TransitionSeries } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { useVideoConfig } from "remotion";
import { AsksFirst } from "./scenes/AsksFirst";
import { BROWSER_WORK_FRAMES, BrowserWork } from "./scenes/BrowserWork";
import { EndCard } from "./scenes/EndCard";
import { GetStarted } from "./scenes/GetStarted";
import { Library } from "./scenes/Library";
import { SkillLint } from "./scenes/SkillLint";
import { Title } from "./scenes/Title";

export const T_FADE = 15;
export const SCENES = {
	title: 150,
	asks: 420,
	browser: BROWSER_WORK_FRAMES,
	library: 420,
	lint: 330,
	start: 255,
	end: 180,
};
export const DEMO_FRAMES = Object.values(SCENES).reduce((a, b) => a + b, 0) - T_FADE * (Object.keys(SCENES).length - 1);

const cut = <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: T_FADE })} />;

export const Demo: React.FC = () => {
	const { fps } = useVideoConfig();
	return (
		<TransitionSeries>
			<TransitionSeries.Sequence name="Title" durationInFrames={SCENES.title} premountFor={fps}>
				<Title />
			</TransitionSeries.Sequence>
			{cut}
			<TransitionSeries.Sequence name="Asks first" durationInFrames={SCENES.asks} premountFor={fps}>
				<AsksFirst />
			</TransitionSeries.Sequence>
			{cut}
			<TransitionSeries.Sequence name="Own tabs, forms" durationInFrames={SCENES.browser} premountFor={fps}>
				<BrowserWork />
			</TransitionSeries.Sequence>
			{cut}
			<TransitionSeries.Sequence name="Library" durationInFrames={SCENES.library} premountFor={fps}>
				<Library />
			</TransitionSeries.Sequence>
			{cut}
			<TransitionSeries.Sequence name="Skill lint" durationInFrames={SCENES.lint} premountFor={fps}>
				<SkillLint />
			</TransitionSeries.Sequence>
			{cut}
			<TransitionSeries.Sequence name="Get started" durationInFrames={SCENES.start} premountFor={fps}>
				<GetStarted />
			</TransitionSeries.Sequence>
			{cut}
			<TransitionSeries.Sequence name="End card" durationInFrames={SCENES.end} premountFor={fps}>
				<EndCard />
			</TransitionSeries.Sequence>
		</TransitionSeries>
	);
};
