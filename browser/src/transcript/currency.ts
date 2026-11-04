/**
 * Dollar amounts in the agent's text read as prices, not math. The markdown renderer treats
 * "$...$" as inline LaTeX, so "costs $89, and $4 less" became a formula with the words run
 * together. A "$" right before a number is escaped, unless the number goes on into math
 * ("$2^{10}$", "$3x+1$"). Code spans and fenced blocks are left as they are.
 */
const PRICE = /(?<![\\$])\$(?=\d[\d,]*(?:\.\d+)?(?:[kKmMbB]n?)?(?![\d^_{}\\=+*/$a-zA-Z(]))/g;

export function escapeCurrency(text: string): string {
	if (!text.includes("$")) return text;
	// Split out fenced blocks and inline code; only the prose between them is touched.
	return text
		.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/)
		.map((part, i) => (i % 2 === 1 ? part : part.replace(PRICE, "\\$")))
		.join("");
}
