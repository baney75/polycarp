/**
 * Tabkyra's artifact viewers. pi-web-ui asks this factory first (setArtifactViewerFactory,
 * patches/pi-mono.patch) and keeps its own viewer when it returns undefined.
 */
import { type ArtifactElement, TextArtifact } from "@mariozechner/pi-web-ui";
import { DelimitedArtifact } from "./DelimitedArtifact.js";
import { MediaArtifact } from "./MediaArtifact.js";
import { NotebookArtifact } from "./NotebookArtifact.js";
import { OdfArtifact } from "./OdfArtifact.js";
import { PptxArtifact } from "./PptxArtifact.js";
import { getArtifactFileType } from "./preview/file-types.js";
import { RtfArtifact } from "./RtfArtifact.js";
import { TkExcelArtifact } from "./TkExcelArtifact.js";
import { TkFileArtifact } from "./TkFileArtifact.js";
import { TkImageArtifact } from "./TkImageArtifact.js";

export function createArtifactViewer(filename: string): ArtifactElement | undefined {
	switch (getArtifactFileType(filename)) {
		case "pptx":
			return new PptxArtifact();
		case "excel":
			return new TkExcelArtifact();
		case "delimited":
			return new DelimitedArtifact();
		case "audio":
		case "video":
			return new MediaArtifact();
		case "notebook":
			return new NotebookArtifact();
		case "odt":
		case "odp":
			return new OdfArtifact();
		case "rtf":
			return new RtfArtifact();
		case "image":
			return new TkImageArtifact();
		case "text":
			return new TextArtifact();
		case "generic":
			return new TkFileArtifact();
		default:
			// html, svg, markdown, pdf, docx: pi-web-ui's own viewers.
			return undefined;
	}
}
