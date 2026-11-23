/* Icon paths from Lucide (ISC license, see lib/lucide.LICENSE). */
(function () {
  "use strict";
  const P = {
    folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>',
    server: '<rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><path d="M6 6h.01M6 18h.01"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
    video: '<path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
    book: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
    printer: '<path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"/><rect x="6" y="14" width="12" height="8" rx="1"/>',
    file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M12 12v6"/><path d="m15 15-3-3-3 3"/>',
    sliders: '<path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4"/>',
    flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
    layers: '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
    headphones: '<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/>',
    zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
    list: '<path d="M3 12h.01M3 18h.01M3 6h.01M8 12h13M8 18h13M8 6h13"/>',
    type: '<path d="M21 14h-5"/><path d="M16 16v-3.5a2.5 2.5 0 0 1 5 0V16"/><path d="M4.5 13h6"/><path d="m3 16 4.5-9 4.5 9"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    play: '<path d="M6 3l14 9-14 9z"/>',
    pause: '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
    next: '<path d="m9 18 6-6-6-6"/>',
    skipF: '<path d="M5 4l10 8-10 8z"/><path d="M19 5v14"/>',
    skipB: '<path d="M19 20 9 12l10-8z"/><path d="M5 19V5"/>',
    sparkle: '<path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0l1.58 6.14a2 2 0 0 0 1.44 1.44l6.14 1.58a.5.5 0 0 1 0 .96l-6.14 1.58a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z"/>',
    target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
    rotate: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
    bookmark: '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    pen: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
    graph: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.59 13.51 6.83 3.98M15.41 6.51l-6.82 3.98"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    plus: '<path d="M5 12h14M12 5v14"/>',
    music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    library: '<path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/>',
    highlighter: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
    external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
    sync: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>'
  };
  function icon(name, cls) {
    return '<svg class="i' + (cls ? " " + cls : "") + '" viewBox="0 0 24 24" aria-hidden="true">' + (P[name] || "") + "</svg>";
  }
  // Polycarp's olive branch, brand/mark.svg, drawn in currentColor so the theme's accent colors it.
  const BRANCH = '<path d="M10 56C20 48 33 35 45 19" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/>' +
    '<g fill="currentColor"><path d="M45 19C51.4 17.6 53.2 11.2 52 5.8C46.9 7.8 42.6 12.9 45 19Z M40 25.5C42.9 19.8 39.2 14.2 34.4 11.6C32.7 16.8 34 23.4 40 25.5Z M38 27.5C43.8 31 50.7 27.9 54.5 23.4C49 21.2 41.5 21.7 38 27.5Z M28 38C30.1 32.1 25.9 26.9 21 24.8C20 30 22 36.5 28 38Z"/>' +
    '<ellipse cx="40" cy="44" rx="6.6" ry="8.4" transform="rotate(-14 40 44)"/><ellipse cx="22" cy="54" rx="5.8" ry="7.4" transform="rotate(-14 22 54)"/></g>' +
    '<path d="M32.5 33C35 34.5 37 35.5 38.5 36.5M16.5 51C18 50.5 19.5 49 20.5 47.5" fill="none" stroke="currentColor" stroke-width="2"/>';
  const MARK = '<svg class="mark" viewBox="4 2 54 58" aria-hidden="true">' + BRANCH + "</svg>";
  const wordmark = () => MARK + "<span>Polycarp</span>";
  // Fill any element marked data-wordmark.
  if (typeof document !== "undefined") {
    const fill = () => document.querySelectorAll("[data-wordmark]").forEach((el) => {
      if (!el.firstChild) {
        el.innerHTML = wordmark();
        // A link is named by its label; only a bare mark is an image.
        if (el.tagName === "A") { if (!el.hasAttribute("aria-label")) el.setAttribute("aria-label", el.getAttribute("title") || "Polycarp"); }
        else { el.setAttribute("aria-label", "Polycarp"); el.setAttribute("role", "img"); }
      }
    });
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fill); else fill();
  }
  // The branch where an earlier design had a face. States stay in data-state for styles and tests.
  function mascot(state, cls) {
    return '<svg class="pip ' + (cls || "") + '" data-state="' + (state || "open") + '" viewBox="4 2 54 58" aria-hidden="true">' + BRANCH + "</svg>";
  }

  // Memory garden: one plant per tier. 1 Seed, 2 Sprout, 3 Sapling, 4 Bloom, 5 Tree, 6 Evergreen.
  const GARDEN = [
    null,
    { name: "Seed", svg: '<path class="g-soil" d="M6 26h20"/><ellipse class="g-seed" cx="16" cy="22.5" rx="4.5" ry="3.2"/>' },
    { name: "Sprout", svg: '<path class="g-soil" d="M6 26h20"/><path class="g-stem" d="M16 26v-9"/><path class="g-leaf" d="M16 19c-1-4-5-5-8-4 1 4 5 5 8 4zM16 17c1-4 5-5 8-4-1 4-5 5-8 4z"/>' },
    { name: "Sapling", svg: '<path class="g-soil" d="M6 26h20"/><path class="g-stem" d="M16 26V9"/><path class="g-leaf" d="M16 21c-1-4-5-5-8-4 1 4 5 5 8 4zM16 17c1-4 5-5 8-4-1 4-5 5-8 4zM16 12c-1-3-4-4-6-3 1 3 4 4 6 3z"/>' },
    { name: "Bloom", svg: '<path class="g-soil" d="M6 26h20"/><path class="g-stem" d="M16 26V13"/><path class="g-leaf" d="M16 22c-1-4-5-5-8-4 1 4 5 5 8 4zM16 19c1-4 5-5 8-4-1 4-5 5-8 4z"/><circle class="g-petal" cx="16" cy="9" r="5"/><circle class="g-heart" cx="16" cy="9" r="2"/>' },
    { name: "Tree", svg: '<path class="g-soil" d="M6 26h20"/><path class="g-trunk" d="M16 26v-8"/><circle class="g-crown" cx="16" cy="12" r="8"/><circle class="g-fruit" cx="13" cy="11" r="1.6"/><circle class="g-fruit" cx="19" cy="14" r="1.6"/>' },
    { name: "Evergreen", svg: '<path class="g-soil" d="M6 26h20"/><path class="g-trunk" d="M16 26v-4"/><path class="g-pine" d="M16 3l7 9h-4l6 8H7l6-8H9z"/><circle class="g-star" cx="16" cy="3" r="2"/>' }
  ];
  function plant(tier, cls) {
    const g = GARDEN[Math.max(1, Math.min(6, tier || 1))];
    return '<svg class="plant ' + (cls || "") + '" viewBox="0 0 32 32" aria-hidden="true">' + g.svg + "</svg>";
  }

  globalThis.PolycarpIcons = { paths: P, icon, MARK, wordmark, mascot, plant, GARDEN };
})();
