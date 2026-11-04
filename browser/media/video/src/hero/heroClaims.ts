// The hero's checked claims, computed on first use. The Hero and HeroPoster roots call
// heroClaims() while rendering, so a recording that doesn't back a stamp, label or figure fails
// those renders; it never runs at import, so the Demo composition and Studio still load.
import capture from "../../public/capture/capture.json";
import router from "../../public/capture/router.json";
import { DATA } from "../data";
import { type Call, catalogRunFrom, checkCli, checkGroup, checkPrompt, checkRouter } from "./claims";

const compute = () => {
	const b = capture.browser;
	return {
		cli: checkCli(DATA.cli),
		catalog: catalogRunFrom(b.calls as Call[], b.catalog.refs, b.catalogUrl, b.catalog.confirmation),
		router: checkRouter(router),
		// The capture's MCP client is "claude-code" (scripts/demo/capture-video.mjs); its group is "Tabkyra · claude".
		group: checkGroup(b.statusAfter, b.book, "claude"),
		prompt: checkPrompt(
			b.permissionPrompt.requestedSchema.properties.decision,
			b.permissionPrompt.message,
			b.permissionAnswer,
			b.statusAfter.allowedHosts,
			new URL(b.book.url).hostname,
		),
	};
};

let cached: ReturnType<typeof compute> | undefined;
export const heroClaims = () => {
	cached ??= compute();
	return cached;
};
