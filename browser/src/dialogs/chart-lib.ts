/** Chart.js, for the two cost views: loaded when one opens, not with the panel. */
let lib: Promise<typeof import("chart.js")> | undefined;

export function loadChart() {
	lib ??= import("chart.js").then(
		(chart) => {
			chart.Chart.register(...chart.registerables);
			return chart;
		},
		(error) => {
			// An update can replace the extension's files under an open panel. Let the next try load the new ones.
			lib = undefined;
			throw error;
		},
	);
	return lib;
}
