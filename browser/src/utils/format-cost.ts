/** Dollars for the Costs tab: cents for normal amounts, more digits only when a cost is under a cent. */
export function formatCost(usd: number): string {
	if (!Number.isFinite(usd) || usd === 0) return "$0.00";
	const sign = usd < 0 ? "-" : "";
	const abs = Math.abs(usd);
	if (abs < 0.0001) return `${sign}<$0.0001`;
	return `${sign}$${abs.toFixed(abs < 0.01 ? 4 : 2)}`;
}
