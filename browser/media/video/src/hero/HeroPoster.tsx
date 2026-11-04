import { AbsoluteFill, Img, staticFile } from "remotion";
import { DATA } from "../data";
import { C, FONT } from "../theme";
import { BrowserWindow } from "../ui";
import { Helm } from "./Helm";
import { heroClaims } from "./heroClaims";
import { Backdrop, Finish } from "./motion";
import { PanelPart } from "./parts";

/** The hero poster: the line, the helm and the moment it asks first, at 1920×1080 scaled down. */
export const HeroPoster: React.FC<{ scale: number }> = ({ scale }) => {
	heroClaims();
	const card = DATA.boxes.requestCard;
	const crop = { x: card.x - 10, y: card.y - 6, w: card.width + 20, h: card.height + 16 };
	return (
		<AbsoluteFill style={{ background: C.ink }}>
			<div style={{ position: "absolute", width: 1920, height: 1080, scale: String(scale), transformOrigin: "0 0" }}>
				<Backdrop />
				<Img src={staticFile("brand/mark-brass.svg")} style={{ position: "absolute", width: 1100, right: -330, bottom: -380, opacity: 0.07, rotate: "11deg" }} />
				<div style={{ position: "absolute", left: 110, top: 0, bottom: 0, width: 900, display: "flex", flexDirection: "column", justifyContent: "center" }}>
					<div style={{ display: "flex", alignItems: "center", gap: 30 }}>
						<Helm size={130} ring={1} pegs={Array(8).fill(1)} pointer={1} />
						<span style={{ fontFamily: FONT.sans, fontWeight: 600, fontSize: 130, letterSpacing: "-0.035em", color: C.paper }}>Tabkyra</span>
					</div>
					<div style={{ marginTop: 26, fontFamily: FONT.serif, fontStyle: "italic", fontSize: 96, lineHeight: 1.02, color: C.paper }}>
						You steer.
						<br />
						<span style={{ color: C.brass }}>Your agents work the tabs.</span>
					</div>
				</div>
				<div style={{ position: "absolute", left: 990, top: 190, rotate: "-3deg" }}>
					<BrowserWindow width={820} group={DATA.group} shots={[{ src: "capture/book.jpg", from: 0 }]} tabTitle={() => DATA.bookTitle} url={() => DATA.bookUrl} />
				</div>
				<div style={{ position: "absolute", left: 1060, top: 640, rotate: "2deg" }}>
					<PanelPart src="capture/panel-pending.png" crop={crop} scale={2.1} style={{ boxShadow: `0 0 0 6px ${C.brass}, 0 0 70px ${C.brass}88` }} />
				</div>
				<Finish />
			</div>
		</AbsoluteFill>
	);
};
