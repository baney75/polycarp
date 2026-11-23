/* Polycarp Reader, print. Prints the document the way it reads on screen, with an optional recall
   sheet: fill-in questions to answer from memory, answers on a separate last page.
   Paper helps many readers with long or hard texts (Delgado et al. 2018 meta-analysis), and
   self-testing on paper keeps the retrieval-practice benefit away from the screen. */
(function () {
  "use strict";
  const R = globalThis.PolycarpReader;
  const M = globalThis.PolycarpMemory;
  const P = globalThis.Polycarp;
  const $ = (id) => document.getElementById(id);
  const BOOK = "var(--pc-font-display)"; // the theme's book face

  $("tPrint").addEventListener("click", () => R.openPrint());
  $("pGo").innerHTML = globalThis.PolycarpIcons.icon("printer") + "<span>Print</span>";

  R.openPrint = function () {
    if (!R.blocks.length) return;
    R.closeSheet();
    $("pTint").checked = !!(R.settings.tint.on && P.TINTS[R.settings.tint.color]);
    $("pSheet").disabled = !M;
    $("printDlg").hidden = false;
    $("pGo").focus();
  };
  const close = () => { $("printDlg").hidden = true; };
  $("pCancel").addEventListener("click", close);
  $("printDlg").addEventListener("click", (e) => { if (e.target === $("printDlg")) close(); });
  $("printDlg").addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

  function studySheet() {
    const box = $("studySheet");
    box.textContent = "";
    if (!M || !$("pSheet").checked) return;
    const stats = M.docStats(R.rangeText(0, R.blocks.length - 1).slice(0, 400000));
    const qs = [];
    const seen = new Set();
    const per = R.sections.length > 12 ? 1 : R.sections.length > 4 ? 2 : 4;
    for (const s of R.sections.slice(0, 30)) {
      const text = R.rangeText(s.start, s.end);
      let n = 0;
      for (const k of M.keySentences(text, per * 3, stats)) {
        if (n >= per) break;
        const cz = M.makeCloze(k.text, stats);
        if (!cz || seen.has(M.normalize(cz.answer))) continue;
        seen.add(M.normalize(cz.answer));
        qs.push({ q: cz.prompt, a: cz.answer, sec: s.title });
        n++;
      }
    }
    if (!qs.length) return;
    const gist = R.sections.length > 1 ? R.sections.slice(0, 6).map((s) => s.title) : [];
    const esc = R.esc;
    box.innerHTML = "<h2>Recall sheet</h2><p>Answer from memory first. Check the answers on the last page only after you have tried every one.</p>" +
      "<ol>" + qs.map((x) => "<li>" + esc(x.q).replace(/_{3,}/, "________________") + "</li>").join("") + "</ol>" +
      (gist.length ? "<h3>In your own words</h3><ol>" + gist.map((t) => "<li>What was “" + esc(t) + "” about?<span class=\"lines\"></span><span class=\"lines\"></span></li>").join("") + "</ol>" : "") +
      '<div class="ans"><h3>Answers</h3><ol>' + qs.map((x) => "<li><b>" + esc(x.a) + "</b> · " + esc(x.sec) + "</li>").join("") + "</ol></div>";
  }

  $("pGo").addEventListener("click", () => {
    close();
    const s = R.settings;
    const body = document.body;
    body.classList.toggle("p-plain", !$("pAnchors").checked);
    body.classList.toggle("p-newpage", $("pBreaks").checked);
    const tint = P.TINTS[s.tint.color];
    body.classList.toggle("p-tint", $("pTint").checked && !!tint);
    if (tint) {
      const a = Math.min(0.35, s.tint.strength * 1.2);
      const hex = tint.color.replace("#", "");
      const [r, g, b] = [0, 2, 4].map((i) => Math.round(255 * (1 - a) + parseInt(hex.slice(i, i + 2), 16) * a));
      body.style.setProperty("--print-tint", "rgb(" + r + "," + g + "," + b + ")");
    }
    const mine = $("pMine").checked;
    const size = $("pLarge").checked ? "16pt" : "12.5pt";
    let st = $("printStyle");
    if (!st) { st = document.createElement("style"); st.id = "printStyle"; document.head.appendChild(st); }
    st.textContent = "@media print { #article { font-size: " + size + " !important; " +
      (mine ? "" : "font-family: " + BOOK + " !important; letter-spacing: 0 !important; word-spacing: 0 !important; line-height: 1.5 !important;") + " } }";
    studySheet();
    // Print every paragraph at full strength, whatever the focus mode shows on screen.
    setTimeout(() => window.print(), 60);
  });
  addEventListener("afterprint", () => {
    R.report({ print: true });
  });
})();
