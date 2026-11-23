/* Polycarp welcome: pick a profile with a live sample, first things to try, the evidence behind each
   feature, what is new and the privacy note. Opened on install, and on update from the popup. */
(async function () {
  "use strict";
  const P = globalThis.Polycarp;
  const IC = globalThis.PolycarpIcons;
  const I = IC.icon;
  const $ = (id) => document.getElementById(id);

  $("navRead").innerHTML = I("book") + "<span>Reader</span>";

  $("navSearch").innerHTML = I("search") + "<span>Search</span>";
  $("navLib").innerHTML = I("library") + "<span>Library</span>";
  $("navReview").innerHTML = I("layers") + "<span>Review</span>";
  $("navSettings").innerHTML = I("sliders") + "<span>Settings</span>";
  $("pip").innerHTML = IC.mascot("open");
  $("openReader").innerHTML = I("upload") + "<span>Open a file</span>";
  $("ver").textContent = chrome.runtime.getManifest().version;
  $("pin").textContent = "Keep Polycarp one click away: click the puzzle piece in your browser's toolbar, then the pin next to Polycarp.";

  // ---------- Evidence ----------
  // level: strong, moderate, mixed, weak, small. Every DOI was resolved against Crossref on 2026-11-20.
  const doi = (d) => "https://doi.org/" + d;
  const EVIDENCE = [
    ["Recall breaks", "strong", "Trying to recall what you just read fixes it in memory far better than reading it again.",
      [["Roediger and Karpicke 2006", doi("10.1111/j.1467-9280.2006.01693.x")], ["Dunlosky et al. 2013", doi("10.1177/1529100612453266")]]],
    ["Spaced review", "strong", "Reviews spread over days beat cramming, and the best gap grows as an idea gets stronger.",
      [["Cepeda et al. 2006", doi("10.1037/0033-2909.132.3.354")]]],
    ["Missed ideas come back", "strong", "Recall, relearn what you missed, and repeat across sessions. Memory built this way lasts, and it takes little time.",
      [["Rawson and Dunlosky 2011", doi("10.1037/a0023956")]]],
    ["Warm-up guess", "moderate", "Guessing before you read, even when the guess is wrong, helps the real answer stick when you reach it.",
      [["Richland, Kornell and Kao 2009", doi("10.1037/a0016496")]]],
    ["Fill in the blank", "moderate", "Words you produce yourself are remembered better than words you only read.",
      [["Slamecka and Graf 1978", doi("10.1037/0278-7393.4.6.592")]]],
    ["Your own font and spacing", "moderate", "In a large study, each reader's fastest font beat their slowest by about 35 percent, and the best font was different for different people.",
      [["Wallace et al. 2022", doi("10.1145/3502222")]]],
    ["Wider letter spacing", "moderate", "Extra space between letters helped children with dyslexia read better on the spot, with no training.",
      [["Zorzi et al. 2012", doi("10.1073/pnas.1205566109")]]],
    ["Focus ruler", "moderate", "Reading rulers helped readers with dyslexia read a little faster. Other readers did not speed up, though many liked them.",
      [["Niklaus et al. 2023", doi("10.1145/3544548.3581367")]]],
    ["Listen while you read", "moderate", "Hearing text read aloud while following along improved understanding for students with reading disabilities, across 22 studies.",
      [["Wood et al. 2018", doi("10.1177/0022219416688170")]]],
    ["Printing on paper", "moderate", "Paper edges out screens for informational text, most of all under time pressure. Remembering where something sat on the page also helps you recall it.",
      [["Delgado et al. 2018", doi("10.1016/j.edurev.2018.09.003")], ["Rothkopf 1971", doi("10.1016/s0022-5371(71)80066-x")]]],
    ["Garden and celebrations", "small", "Game elements give small gains in learning and motivation. Polycarp keeps them gentle, with no guilt for a missed day.",
      [["Sailer and Homner 2020", doi("10.1007/s10648-019-09498-w")]]],
    ["Color tints", "mixed", "Reviews find small effects from studies with weak designs. Tints are here for comfort, not as a treatment.",
      [["Griffiths et al. 2016", doi("10.1111/opo.12316")]]],
    ["Bold anchors", "none", "A careful study of bolded word starts found no gain in reading speed. Keep them only if they feel easier.",
      [["Snell 2024", doi("10.1016/j.actpsy.2024.104304")]]],
    ["Speed read, one word at a time", "weak", "It helped some readers with ADHD in one small study, but it hides the words behind you, and looking back is part of understanding. It stays off until you open it, and it has a back button.",
      [["Moussaoui et al. 2025", doi("10.1017/S1355617725101628")], ["Schotter, Tran and Rayner 2014", doi("10.1177/0956797614531148")]]]
  ];
  const LEVEL = { strong: "Strong evidence", moderate: "Good evidence", small: "Good evidence, small effect", mixed: "Mixed evidence", weak: "Weak evidence", none: "No gain found" };
  const ev = $("evidence");
  for (const [name, level, text, cites] of EVIDENCE) {
    const li = document.createElement("li");
    const b = document.createElement("b"); b.textContent = name;
    const tag = document.createElement("span"); tag.className = "lvl " + level; tag.textContent = LEVEL[level];
    const p = document.createElement("p"); p.textContent = text;
    const c = document.createElement("cite");
    cites.forEach(([label, url], i) => {
      if (i) c.append("; ");
      if (url) { const a = document.createElement("a"); a.href = url; a.target = "_blank"; a.rel = "noopener"; a.textContent = label; c.append(a); }
      else c.append(label);
    });
    li.append(b, tag, p, c);
    ev.append(li);
  }

  // ---------- Profile picker with a live sample ----------
  let s = await P.getSettings();
  const order = ["everyday", "focus", "dyslexia", "calm", "steady"];
  const box = $("profiles");
  box.innerHTML = order.map((p) => '<button class="chip" data-id="' + p + '">' + P.PROFILES[p].label + "<small>" + P.PROFILES[p].tag + "</small></button>").join("");
  box.addEventListener("click", async (e) => {
    const b = e.target.closest(".chip");
    if (!b) return;
    s = await P.setSettings(P.applyProfile(s, b.dataset.id));
    paint();
  });

  const text = $("sampleText");
  function paint() {
    box.querySelectorAll(".chip").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.id === s.profile)));
    const prof = P.PROFILES[s.profile];
    $("blurb").innerHTML = prof ? "<b>" + prof.tag + ".</b> " + prof.blurb : "<b>Custom.</b> Your own mix from Settings.";
    const t = s.type, f = P.FONTS[t.font];
    text.style.fontFamily = f && f.family ? f.family : "Georgia, 'Times New Roman', serif";
    text.style.letterSpacing = t.letter ? t.letter + "em" : "";
    text.style.wordSpacing = t.word ? t.word + "em" : "";
    text.style.lineHeight = t.line || 1.6;
    text.style.color = s.calm.soft ? "color-mix(in srgb, var(--ink) 82%, var(--surface))" : "";
    text.style.textAlign = s.force.leftAlign ? "left" : "";
    const tint = s.tint.on && P.TINTS[s.tint.color];
    $("sample").style.setProperty("--tint", tint ? "color-mix(in srgb, " + tint.color + " " + Math.round(s.tint.strength * 100) + "%, transparent)" : "transparent");
    text.style.setProperty("--polycarp-weight", s.bionic.weight);
    text.style.setProperty("--polycarp-fade", (1 - s.bionic.fade).toFixed(2));
    text.textContent = text.dataset.text;
    if (s.bionic.on) P.transformTree(text, { strength: s.bionic.strength, every: s.bionic.every, fade: s.bionic.fade });
  }
  paint();
  chrome.storage.onChanged.addListener(async (ch, area) => {
    if (area === "local" && ch[P.SETTINGS_KEY]) { s = await P.getSettings(); paint(); }
  });

  if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
})();
