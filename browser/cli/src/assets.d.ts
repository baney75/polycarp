/** Text files bundled by cli/scripts/build.mjs: the release public key and the agent skill. */
declare module "*.pub" {
	const text: string;
	export default text;
}

declare module "*.md" {
	const text: string;
	export default text;
}
