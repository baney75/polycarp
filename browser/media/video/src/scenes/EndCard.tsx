import { Img, staticFile, useCurrentFrame } from "remotion";
import { C, FONT } from "../theme";
import { Fill, rise, Watermark } from "../ui";

export const EndCard: React.FC = () => {
	const frame = useCurrentFrame();
	const a = rise(frame, 0, 18);
	const b = rise(frame, 14, 18);
	const c = rise(frame, 30, 18);
	return (
		<Fill>
			<Watermark />
			<div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
				<div style={{ display: "flex", alignItems: "center", gap: 34, opacity: a }}>
					<Img src={staticFile("brand/icon.svg")} style={{ width: 132, height: 132 }} />
					<span style={{ fontFamily: FONT.sans, fontWeight: 600, fontSize: 120, letterSpacing: "-0.035em", color: C.paper }}>Tabkyra</span>
				</div>
				<div style={{ marginTop: 26, fontFamily: FONT.serif, fontStyle: "italic", fontSize: 84, color: C.paper, opacity: b }}>
					You steer. <span style={{ color: C.brass }}>Your agents work the tabs.</span>
				</div>
				<div style={{ marginTop: 64, display: "flex", gap: 44, opacity: c, fontFamily: FONT.mono, fontSize: 50, color: C.paper }}>
					<span>github.com/baney75/tabkyra</span>
					<span style={{ color: C.slate }}>·</span>
					<span>dbaney.com/tabkyra</span>
				</div>
				<div style={{ marginTop: 30, fontFamily: FONT.sans, fontSize: 36, color: C.mist, opacity: c }}>
					Free and open source. AGPL-3.0.
				</div>
			</div>
		</Fill>
	);
};
