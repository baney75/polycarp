import { POLYCARP_MARK } from "../../components/polycarp-svg.js";

/**
 * The bar's look: the side panel's own tokens, the Polycarp preset's light and dark palettes (src/appearance/palettes.ts),
 * mini-lit's type and radii, and its small danger button. The page has no panel tokens, so they are copied here.
 */
const BAR_CSS = `
.bar {
	--bg: #fffdf6;
	--fg: #2b2e26;
	--muted: #5c6152;
	--border: #d5d0bf;
	--mark: #59693f;
	--ring: #59693f;
	--danger: #a33a2a;
	--on-danger: #ffffff;
	--shadow: 0 1px 3px 0 rgb(0 0 0 / 0.1), 0 8px 24px -4px rgb(0 0 0 / 0.18);
}
@media (prefers-color-scheme: dark) {
	.bar {
		--bg: #2b2e26;
		--fg: #f6f3e8;
		--muted: #cdcfbf;
		--border: #464a3d;
		--mark: #a9bb8a;
		--ring: #a9bb8a;
		--danger: #e58a76;
		--on-danger: #000000;
		--shadow: 0 8px 24px -4px rgb(0 0 0 / 0.45);
	}
}
.bar, .bar * { box-sizing: border-box; }
.bar { position: absolute; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 1; pointer-events: auto;
	display: flex; align-items: center; gap: 12px; height: 48px; padding: 0 8px 0 16px;
	width: max-content; max-width: min(560px, calc(100vw - 32px));
	background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 14px; box-shadow: var(--shadow);
	font: 500 14px/20px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif; }
.mark { flex: none; display: block; width: 20px; height: 20px; color: var(--mark); }
.mark svg { display: block; width: 20px; height: 20px; }
.text { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.text b { font-weight: 600; }
.task { font-weight: 400; color: var(--muted); }
button { all: unset; box-sizing: border-box; flex: none; display: inline-flex; align-items: center; justify-content: center;
	height: 32px; padding: 0 12px; border-radius: 8px; font: inherit; font-size: 12px; line-height: 16px;
	background: var(--danger); color: var(--on-danger); cursor: pointer; }
button:hover { background: color-mix(in srgb, var(--danger) 90%, transparent); }
button:focus-visible { box-shadow: 0 0 0 3px color-mix(in srgb, var(--ring) 50%, transparent); }
@media (prefers-reduced-motion: reduce) { .fx, .fx * { animation: none !important; } .particles { display: none; } }
`;

/**
 * This code gets stringified and injected into the page context.
 * Creates a full-viewport overlay with shimmer effect and abort button.
 */
export function createOverlayScript(taskName: string): string {
	return `
(function() {
	// Check if overlay already exists (prevent duplicates)
	if (document.getElementById('tabkyra-repl-overlay')) {
		return;
	}

	// A tag no site styles, with its style reset inline, holding everything in its own shadow root: a site's CSS (button
	// padding, line-height, fonts) never reaches the bar.
	const host = document.createElement('polycarp-repl-overlay');
	host.id = 'tabkyra-repl-overlay';
	host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;';
	const root = host.attachShadow({ mode: 'open' });
	const overlay = document.createElement('div');
	overlay.style.cssText = 'position: absolute; inset: 0; pointer-events: none;';

	// Create shimmer backdrop with multiple layers
	const shimmerContainer = document.createElement('div');
	shimmerContainer.className = 'fx';
	shimmerContainer.style.cssText = \`
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		overflow: hidden;
	\`;

	// Vignette base - very subtle darkening at edges
	const vignette = document.createElement('div');
	vignette.style.cssText = \`
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		background: radial-gradient(
			ellipse at center,
			transparent 0%,
			transparent 50%,
			rgba(0, 0, 0, 0.02) 80%,
			rgba(0, 0, 0, 0.05) 100%
		);
	\`;

	// Layer 1: Inner orange/red glow
	const layer1 = document.createElement('div');
	layer1.style.cssText = \`
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		background: radial-gradient(
			ellipse at center,
			transparent 0%,
			transparent 50%,
			rgba(255, 107, 0, 0.04) 65%,
			rgba(255, 69, 0, 0.06) 80%,
			rgba(220, 38, 38, 0.03) 100%
		);
		animation: tabkyra-shimmer-radial-1 3s ease-in-out infinite;
	\`;

	// Layer 2: Mid magenta/red layer
	const layer2 = document.createElement('div');
	layer2.style.cssText = \`
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		background: radial-gradient(
			ellipse at center,
			transparent 0%,
			transparent 55%,
			rgba(194, 24, 91, 0.05) 70%,
			rgba(219, 39, 119, 0.08) 85%,
			rgba(157, 23, 77, 0.04) 100%
		);
		animation: tabkyra-shimmer-radial-2 4s ease-in-out infinite;
	\`;

	// Layer 3: Outer violet/purple layer - most prominent
	const layer3 = document.createElement('div');
	layer3.style.cssText = \`
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		background: radial-gradient(
			ellipse at center,
			transparent 0%,
			transparent 60%,
			rgba(147, 51, 234, 0.06) 75%,
			rgba(126, 34, 206, 0.12) 88%,
			rgba(107, 33, 168, 0.08) 100%
		);
		animation: tabkyra-shimmer-radial-3 5s ease-in-out infinite;
	\`;

	// Layer 4: Deep purple edge glow
	const borderGlow = document.createElement('div');
	borderGlow.style.cssText = \`
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		box-shadow: inset 0 0 120px 20px rgba(126, 34, 206, 0.08),
		            inset 0 0 60px 10px rgba(147, 51, 234, 0.05);
		animation: tabkyra-pulse 2s ease-in-out infinite;
	\`;

	shimmerContainer.appendChild(vignette);
	shimmerContainer.appendChild(layer1);
	shimmerContainer.appendChild(layer2);
	shimmerContainer.appendChild(layer3);
	shimmerContainer.appendChild(borderGlow);

	// Create particle system
	const particleContainer = document.createElement('div');
	particleContainer.className = 'particles';
	particleContainer.style.cssText = \`
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		overflow: hidden;
		pointer-events: none;
	\`;

	// Generate 20 particles with random properties, concentrated at edges
	for (let i = 0; i < 20; i++) {
		const particle = document.createElement('div');
		const size = Math.random() * 2 + 1; // 1-3px (much smaller)

		// Bias particles towards edges (vignette effect)
		// Random angle around the circle
		const angle = Math.random() * Math.PI * 2;
		// Distance from center - heavily weighted towards edges (70-100% of radius)
		const distanceFromCenter = 70 + Math.random() * 30;
		// Convert polar to cartesian, centered at 50%, 50%
		const startX = 50 + Math.cos(angle) * distanceFromCenter * 0.7; // 0.7 for ellipse width
		const startY = 50 + Math.sin(angle) * distanceFromCenter;

		const duration = Math.random() * 12 + 10; // 10-22s (slower)
		const delay = Math.random() * 5; // 0-5s delay
		const opacity = Math.random() * 0.2 + 0.15; // 0.15-0.35 (much more subtle)

		// Random color - heavily favor violet/purple tones (matching reference)
		const colors = [
			'147, 51, 234',   // purple (violet)
			'126, 34, 206',   // deep purple
			'107, 33, 168',   // darker purple
			'147, 51, 234',   // purple (violet) - repeated for higher probability
			'168, 85, 247',   // lighter purple
			'194, 24, 91',    // magenta/pink
			'219, 39, 119',   // bright pink
			'255, 69, 0',     // red-orange
			'220, 38, 38',    // red
		];
		const color = colors[Math.floor(Math.random() * colors.length)];

		particle.style.cssText = \`
			position: absolute;
			left: \${startX}%;
			top: \${startY}%;
			width: \${size}px;
			height: \${size}px;
			background: rgba(\${color}, \${opacity});
			border-radius: 50%;
			box-shadow: 0 0 \${size * 1.5}px rgba(\${color}, \${opacity * 0.5});
			animation: tabkyra-particle-float \${duration}s ease-in-out \${delay}s infinite;
		\`;
		particleContainer.appendChild(particle);
	}

	shimmerContainer.appendChild(particleContainer);

	// The bar: Polycarp's mark and name with the task on one line, clipped (the whole task on hover), and Stop.
	const toolbar = document.createElement('div');
	toolbar.className = 'bar';
	toolbar.innerHTML = '<span class="mark" aria-hidden="true">' + ${JSON.stringify(POLYCARP_MARK)} +
		'</span><span class="text" role="status"><b>Polycarp</b><span class="task"></span></span>' +
		'<button type="button" aria-label="Stop the script Polycarp is running">Stop</button>';
	const task = ${JSON.stringify(taskName)};
	toolbar.querySelector('.task').textContent = ' \u00b7 ' + task;
	toolbar.querySelector('.text').title = task;
	const abortBtn = toolbar.querySelector('button');
	abortBtn.onclick = async (event) => {
		// Only a person's click stops the script: the page can't press it for them.
		if (!event.isTrusted) return;
		try {
			await chrome.runtime.sendMessage({ type: 'abort-repl' });
		} catch (error) {
			console.error('[Overlay] sendMessage failed:', error);
		}
		host.remove();
	};

	// Assemble overlay
	overlay.appendChild(shimmerContainer);
	overlay.appendChild(toolbar);

	// Add CSS animations
	const style = document.createElement('style');
	style.textContent = ${JSON.stringify(BAR_CSS)} + \`
		@keyframes tabkyra-shimmer-radial-1 {
			0%, 100% {
				opacity: 0.8;
				transform: scale(1);
			}
			50% {
				opacity: 1;
				transform: scale(1.02);
			}
		}

		@keyframes tabkyra-shimmer-radial-2 {
			0%, 100% {
				opacity: 0.7;
				transform: scale(1) rotate(0deg);
			}
			50% {
				opacity: 0.9;
				transform: scale(1.03) rotate(2deg);
			}
		}

		@keyframes tabkyra-shimmer-radial-3 {
			0%, 100% {
				opacity: 0.75;
				transform: scale(1.01);
			}
			50% {
				opacity: 0.9;
				transform: scale(1);
			}
		}

		@keyframes tabkyra-pulse {
			0%, 100% {
				box-shadow: inset 0 0 120px 20px rgba(126, 34, 206, 0.08),
				            inset 0 0 60px 10px rgba(147, 51, 234, 0.05);
			}
			50% {
				box-shadow: inset 0 0 140px 25px rgba(126, 34, 206, 0.11),
				            inset 0 0 70px 12px rgba(147, 51, 234, 0.07);
			}
		}

		@keyframes tabkyra-particle-float {
			0%, 100% {
				transform: translate(0, 0) scale(1);
				opacity: 1;
			}
			25% {
				transform: translate(8px, -12px) scale(1.1);
				opacity: 0.8;
			}
			50% {
				transform: translate(-5px, -20px) scale(0.9);
				opacity: 0.6;
			}
			75% {
				transform: translate(10px, -15px) scale(1.05);
				opacity: 0.9;
			}
		}
	\`;
	root.appendChild(style);
	root.appendChild(overlay);
	(document.body || document.documentElement).appendChild(host);
})();
`;
}

/**
 * Code to remove the overlay from the page.
 */
export function removeOverlayScript(): string {
	return `
(function() {
	const overlay = document.getElementById('tabkyra-repl-overlay');
	if (overlay) {
		overlay.remove();
	}
})();
`;
}
