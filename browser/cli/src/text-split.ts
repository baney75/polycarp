/**
 * Cut text into pieces of at most `size` UTF-16 units, never between the halves of a surrogate pair:
 * a lone half would turn into U+FFFD when the hub writes it out.
 */
export function splitText(text: string, size: number): string[] {
	const pieces: string[] = [];
	for (let at = 0; at < text.length; ) {
		let end = Math.min(at + size, text.length);
		const last = text.charCodeAt(end - 1);
		if (end < text.length && end - 1 > at && last >= 0xd800 && last <= 0xdbff) end--;
		pieces.push(text.slice(at, end));
		at = end;
	}
	return pieces;
}
