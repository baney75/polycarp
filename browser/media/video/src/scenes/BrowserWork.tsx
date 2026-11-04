import { useCurrentFrame } from "remotion";
import { DATA, args, field, result } from "../data";
import { Caption, ChapterLabel, Fill, Pane, type PaneLine, Watermark, BrowserWindow } from "../ui";

// Chapter 3 (its own tabs) runs to FORMS; chapter 4 (forms) runs to the end.
export const FORMS = 330;
const T = {
	home: FORMS + 20,
	results: FORMS + 150,
	hold: FORMS + 220,
	form: FORMS + 330,
	done: FORMS + 395,
};

const lines: PaneLine[] = [
	// Carried over from the last chapter, already on screen.
	{ at: -90, kind: "call", text: args("navigate", 1) },
	{ at: -90, kind: "ok", text: `→ title: "${field("navigate", "title", 1)}"` },
	{ at: 10, kind: "call", text: "get_page_text {}" },
	{ at: 40, kind: "result", text: `→ ${DATA.bookHeading}` },
	{ at: 52, kind: "result", text: `  ${DATA.bookSummary}` },
	{ at: FORMS - 10, kind: "note", text: "# allowed beforehand: tabkyra allow 127.0.0.1" },
	{ at: FORMS + 6, kind: "call", text: args("navigate", 0) },
	{ at: T.home + 30, kind: "call", text: 'read_page { filter: "interactive" }' },
	...DATA.readPage1.map((l, i) => ({ at: T.home + 62 + i * 4, kind: "result" as const, text: `  ${l}` })),
	{ at: T.home + 90, kind: "call", text: args("type", 0) },
	{ at: T.results, kind: "result", text: `→ ${result("type", 0)}` },
	// The results page renumbers the refs, so the agent reads it again before it clicks.
	{ at: T.results + 14, kind: "call", text: 'read_page { filter: "interactive" }' },
	...DATA.readPage2.map((l, i) => ({ at: T.results + 34 + i * 4, kind: "result" as const, text: `  ${l}` })),
	{ at: T.results + 50, kind: "call", text: `${args("click", 0)}  // Place hold` },
	{ at: T.hold + 20, kind: "call", text: 'read_page { filter: "interactive" }' },
	...DATA.readPage3.map((l, i) => ({ at: T.hold + 50 + i * 4, kind: "result" as const, text: `  ${l}` })),
	{ at: T.hold + 66, kind: "call", text: args("fill", 0) },
	{ at: T.hold + 98, kind: "call", text: args("fill", 1) },
	{ at: T.form + 10, kind: "call", text: `${args("click", 1)}  // Confirm hold` },
	{ at: T.done + 20, kind: "call", text: "get_page_text {}" },
	{ at: T.done + 50, kind: "ok", text: `→ "${DATA.confirmation}"` },
];

export const BrowserWork: React.FC = () => {
	const frame = useCurrentFrame();
	const forms = frame >= FORMS;
	return (
		<Fill>
			<Watermark />
			{forms ? <ChapterLabel at={FORMS}>Fills forms, reads back</ChapterLabel> : <ChapterLabel>Its own tabs</ChapterLabel>}
			<Pane title="claude · tool calls" left={80} top={140} width={660} height={766} fontSize={23} lines={lines} />
			<BrowserWindow
				width={1060}
				style={{ left: 780, top: 140 }}
				group={DATA.group}
				ringAt={14}
				shots={[
					{ src: "capture/book.jpg", from: 0 },
					{ src: "capture/catalog-home.jpg", from: T.home },
					{ src: "capture/catalog-results.jpg", from: T.results },
					{ src: "capture/catalog-hold.jpg", from: T.hold },
					{ src: "capture/catalog-form.jpg", from: T.form },
					{ src: "capture/catalog-done.jpg", from: T.done },
				]}
				tabTitle={(f) => (f < T.home ? DATA.bookTitle : "Pinecrest Library")}
				url={(f) => (f < T.home ? DATA.bookUrl : DATA.catalogUrl)}
			/>
			<Caption from={16} to={FORMS - 6}>
				It works in its own background tab group, and it can't see your other tabs.
			</Caption>
			<Caption from={FORMS + 20} to={T.form}>
				It reads the page as element refs, then clicks and types by ref.
			</Caption>
			<Caption from={T.form + 6} to={T.done + 150}>
				Then it reads the result back to check its own work.
			</Caption>
		</Fill>
	);
};

export const BROWSER_WORK_FRAMES = T.done + 150;
