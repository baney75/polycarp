/**
 * A settings switch whose save was refused goes back to what is saved, and says so (issue 386). The switch flips in
 * the page before the save runs; without this a refused write left it showing the new value with no error, so Private
 * mode could read on while prompts were not private. Bind the switch's `.checked` through lit's `live()`, so the redraw
 * puts the box back even though the state value never changed.
 */
export async function saveSwitch(
	save: () => Promise<unknown>,
	redraw: () => void,
	what: string,
	notify: (message: string) => void,
): Promise<boolean> {
	try {
		await save();
		return true;
	} catch (err) {
		notify(
			`Couldn't save ${what}: ${err instanceof Error ? err.message : String(err)}. It is back to what was saved.`,
		);
		redraw();
		return false;
	}
}
