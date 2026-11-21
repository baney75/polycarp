import type React from "react";
import { createContext, useContext } from "react";
import { Sequence, useVideoConfig } from "remotion";
import music from "./music.json";

// Every cut and slam is a beat index into the measured beat map (scripts/analyze_music.py).
export const BEATS: number[] = music.beats;
export const FPS = 30;
/** The video ends with the music: the master is trimmed to its end (57.6 s) and fades itself out. */
export const HERO_FRAMES = Math.round(music.duration * FPS);

/** The frame a beat lands on, rounded to the nearest frame. */
export const beatFrame = (b: number): number => {
	const whole = Math.floor(b);
	const t0 = BEATS[whole];
	const t1 = BEATS[Math.min(whole + 1, BEATS.length - 1)] ?? t0;
	return Math.round((t0 + (t1 - t0) * (b - whole)) * FPS);
};

/** Frames per beat at this tempo. */
export const BEAT = (60 / music.tempo) * FPS;

const SegContext = createContext(0);

/** Local frame of global beat `b` inside the current segment. */
export const useBeat = () => {
	const from = useContext(SegContext);
	return (b: number) => beatFrame(b) - from;
};

/** A timeline segment from beat `start` to beat `end` (the first one starts at frame 0). */
export const Seg: React.FC<{ start: number; end: number; name: string; children: React.ReactNode }> = ({
	start,
	end,
	name,
	children,
}) => {
	const { fps } = useVideoConfig();
	const from = start === 0 ? 0 : beatFrame(start);
	const to = end >= BEATS.length ? HERO_FRAMES : beatFrame(end);
	return (
		<Sequence name={name} from={from} durationInFrames={to - from} premountFor={fps}>
			<SegContext.Provider value={from}>{children}</SegContext.Provider>
		</Sequence>
	);
};
