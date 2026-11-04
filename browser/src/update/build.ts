/**
 * What the running code was built from. scripts/build.mjs and cli/scripts/build.mjs compile it in
 * as __TABKYRA_BUILD__ and write the same record to build-info.json next to the build, so the
 * update system can tell the running extension, the native host and the files on disk apart.
 */

export interface BuildInfo {
	/** New for every build. */
	id: string;
	/** git HEAD at build time; empty outside a checkout. */
	commit: string;
	/** The extension manifest version. */
	version: string;
	builtAt: string;
}

declare const __TABKYRA_BUILD__: BuildInfo | undefined;

/** Undefined when the code runs unbundled (tests run the TypeScript source). */
export const BUILD: BuildInfo | undefined = typeof __TABKYRA_BUILD__ === "undefined" ? undefined : __TABKYRA_BUILD__;

/** A build-info record from untrusted JSON, or undefined. */
export function asBuildInfo(value: unknown): BuildInfo | undefined {
	if (!value || typeof value !== "object") return undefined;
	const v = value as Record<string, unknown>;
	if (typeof v.id !== "string" || typeof v.version !== "string") return undefined;
	return {
		id: v.id,
		commit: typeof v.commit === "string" ? v.commit : "",
		version: v.version,
		builtAt: typeof v.builtAt === "string" ? v.builtAt : "",
	};
}

/** "1.1.9 (abc1234)", or the version alone. */
export function describeBuild(build: BuildInfo | undefined): string {
	if (!build) return "unknown";
	return build.commit ? `${build.version} (${build.commit.slice(0, 7)})` : build.version;
}
