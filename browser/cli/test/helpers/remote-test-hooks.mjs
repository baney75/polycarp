// Preloaded with `node --import` by the remote proof tests, never by the CLI itself: it lets a fake public server on 127.0.0.1
// count as public, and, when REMOTE_HOOK_THROW=1 is in this test process's environment, makes the probe throw right after its
// token is made. A normal run has no way to load it, so no environment variable weakens a real `remote test`.
globalThis[Symbol.for("polycarp.remote-test.hooks")] = {
	reachable: (address) => address === "127.0.0.1",
	afterMint: () => {
		if (process.env.REMOTE_HOOK_THROW === "1") throw new Error("the test hook threw after the token was made");
	},
};
