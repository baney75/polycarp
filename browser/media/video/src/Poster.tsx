import { Img, staticFile } from "remotion";
import { DATA } from "./data";
import { C, FONT } from "./theme";
import { BrowserWindow, Fill, Watermark } from "./ui";

/** The poster frame, laid out at 1920×1080 and scaled to the composition's size. */
export const Poster: React.FC<{ scale: number }> = ({ scale }) => (
	<Fill>
		<div style={{ position: "absolute", left: 0, top: 0, width: 1920, height: 1080, scale: String(scale), transformOrigin: "0 0" }}>
			<Fill>
				<Watermark />
				<div style={{ position: "absolute", left: 110, top: 0, bottom: 0, width: 830, display: "flex", flexDirection: "column", justifyContent: "center" }}>
					<div style={{ display: "flex", alignItems: "center", gap: 28 }}>
						<Img src={staticFile("brand/icon.svg")} style={{ width: 120, height: 120 }} />
						<span style={{ fontFamily: FONT.sans, fontWeight: 600, fontSize: 120, letterSpacing: "-0.035em", color: C.paper }}>Tabkyra</span>
					</div>
					<div style={{ marginTop: 30, fontFamily: FONT.serif, fontStyle: "italic", fontSize: 82, lineHeight: 1.05, color: C.paper }}>
						You steer.
						<br />
						<span style={{ color: C.brass }}>Your agents work the tabs.</span>
					</div>
					<div style={{ marginTop: 34, fontFamily: FONT.sans, fontSize: 40, lineHeight: 1.3, color: C.mist }}>
						Claude Code, Codex and any MCP agent drive your real browser, in their own tab group.
					</div>
				</div>
				<BrowserWindow
					width={860}
					style={{ left: 980, top: 270 }}
					group={DATA.group}
					shots={[{ src: "capture/catalog-form.jpg", from: 0 }]}
					tabTitle={() => "Pinecrest Library"}
					url={() => DATA.catalogUrl}
				/>
			</Fill>
		</div>
	</Fill>
);
