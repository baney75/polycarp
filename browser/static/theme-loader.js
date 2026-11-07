// Apply theme immediately to prevent white flash
// This runs before any other scripts or CSS
(function() {
	const theme = localStorage.getItem('theme') || 'system';
	if (theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
		document.documentElement.classList.add('dark');
	}
	// The saved colors from the last open in this mode, so the first frame is already in them (src/appearance/apply.ts keeps them current).
	try {
		const dark = document.documentElement.classList.contains('dark');
		const colors = JSON.parse(localStorage.getItem(dark ? 'tk-colors-dark' : 'tk-colors-light') || '{}');
		for (const name in colors) document.documentElement.style.setProperty(name, colors[name]);
	} catch {
		// Nothing saved yet, or it can't be read: the stylesheet's colors stand until the panel applies the real ones.
	}
})();
