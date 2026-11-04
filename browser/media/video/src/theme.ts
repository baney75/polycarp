import { loadFont } from "@remotion/fonts";
import { staticFile } from "remotion";

// The brand palette from media/brand/BRAND.md.
export const C = {
	brass: "#E3A93B",
	brassDeep: "#A8761C",
	ink: "#0F1B24",
	inkDeep: "#0A141B",
	inkLine: "#1F3140",
	tide: "#43B3A0",
	paper: "#F6F2EA",
	slate: "#6B7A86",
	mist: "#AFC0CB",
	// Only for errors and retractions, as the CLI prints them.
	alarm: "#E46B5D",
};

export const FONT = {
	serif: "Instrument Serif",
	sans: "Instrument Sans",
	mono: "JetBrains Mono",
};

const fonts = [
	{ family: FONT.serif, file: "instrument-serif-latin-400-italic.woff2", weight: "400", style: "italic" },
	{ family: FONT.serif, file: "instrument-serif-latin-400-normal.woff2", weight: "400", style: "normal" },
	{ family: FONT.sans, file: "instrument-sans-latin-400-normal.woff2", weight: "400", style: "normal" },
	{ family: FONT.sans, file: "instrument-sans-latin-600-normal.woff2", weight: "600", style: "normal" },
	{ family: FONT.mono, file: "jetbrains-mono-latin-400-normal.woff2", weight: "400", style: "normal" },
	{ family: FONT.mono, file: "jetbrains-mono-latin-700-normal.woff2", weight: "700", style: "normal" },
] as const;

for (const f of fonts) {
	loadFont({ family: f.family, url: staticFile(`fonts/${f.file}`), weight: f.weight, style: f.style });
}

export const FPS = 30;
export const WIDTH = 1920;
export const HEIGHT = 1080;
