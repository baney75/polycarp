/* Polycarp shared effects and answer checking for extension pages: soft chimes, a short confetti burst
   and the forgiving answer judge used by recall breaks and reviews. */
(function () {
  "use strict";
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  function party(s) {
    if (!s || s.celebrate !== "full" || reduced() || s.calm.still) return;
    const c = document.createElement("canvas");
    c.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:90";
    c.width = innerWidth; c.height = innerHeight;
    document.body.appendChild(c);
    const g = c.getContext("2d");
    // The theme's own status and accent colors, as this page has them now.
    const css = getComputedStyle(document.documentElement);
    const cols = ["--pc-accent", "--pc-working", "--pc-done", "--pc-urgent", "--pc-strong"].map((v) => css.getPropertyValue(v).trim()).filter(Boolean);
    const slow = css.getPropertyValue("--pc-motion-slow").trim();
    const life = (parseFloat(slow) || 0) * (/ms$/.test(slow) ? 1 : 1000) * 5.6;
    if (!cols.length || !life) { c.remove(); return; }
    const bits = Array.from({ length: 90 }, () => ({
      x: innerWidth / 2 + (Math.random() - 0.5) * 160, y: innerHeight * 0.35,
      vx: (Math.random() - 0.5) * 9, vy: -Math.random() * 9 - 3, r: Math.random() * 6, w: 5 + Math.random() * 5,
      c: cols[Math.floor(Math.random() * cols.length)]
    }));
    const t0 = performance.now();
    (function frame(t) {
      g.clearRect(0, 0, c.width, c.height);
      for (const b of bits) {
        b.vy += 0.28; b.x += b.vx; b.y += b.vy; b.r += 0.1;
        g.save(); g.translate(b.x, b.y); g.rotate(b.r); g.fillStyle = b.c; g.fillRect(-b.w / 2, -2, b.w, 4); g.restore();
      }
      if (t - t0 < life) requestAnimationFrame(frame); else c.remove();
    })(t0);
  }
  let audioCtx = null;
  function chime(kind, s) {
    if (!s || !s.reader.sound || s.celebrate === "off") return;
    try {
      audioCtx = audioCtx || new AudioContext();
      const notes = { got: [784, 1047], seed: [659], close: [587, 659], finish: [523, 659, 784, 1047], level: [659, 784, 1047] }[kind] || [659];
      notes.forEach((f, i) => {
        const o = audioCtx.createOscillator(), v = audioCtx.createGain();
        const at = audioCtx.currentTime + i * 0.11;
        o.type = "sine"; o.frequency.value = f;
        v.gain.setValueAtTime(0, at); v.gain.linearRampToValueAtTime(0.05, at + 0.02); v.gain.exponentialRampToValueAtTime(0.0001, at + 0.5);
        o.connect(v).connect(audioCtx.destination); o.start(at); o.stop(at + 0.55);
      });
    } catch (e) { /* sound is optional */ }
  }

  const STOP = new Set(["the", "a", "an", "of", "to", "and", "in", "on", "for", "is", "are"]);
  function norm(s) {
    return String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
      .replace(/[^\p{L}\p{N}\s.]/gu, " ").replace(/(\D)\.|\.(\D)/g, "$1 $2").split(/\s+/).filter((w) => w && !STOP.has(w)).join(" ");
  }
  function lev(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (!m || !n) return m || n;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[n];
  }
  // got: right, typos forgiven. close: part of it, or a near miss. missed: not it.
  function judge(guess, answer) {
    const g = norm(guess), a = norm(answer);
    if (!g) return "missed";
    if (g === a) return "got";
    const digits = (s) => (s.match(/\d+(\.\d+)?/g) || []).join(" ");
    if (digits(a)) return digits(g) === digits(a) ? (lev(g, a) <= Math.max(2, a.length * 0.3) ? "got" : "close") : "missed";
    const d = lev(g, a);
    if (d <= Math.max(1, Math.floor(a.length * 0.2))) return "got";
    // Stems: "photosynthesis" for "photosynthetic", plural and tense forms.
    const stem = (w) => w.replace(/(ing|ed|es|s|al|ic|ical|ly|tion|ation)$/, "");
    const gw = g.split(" ").map(stem), aw = a.split(" ").map(stem);
    if (gw.join(" ") === aw.join(" ")) return "got";
    const hits = aw.filter((w) => w.length > 2 && gw.some((x) => x === w || lev(x, w) <= 1)).length;
    if (hits && hits >= Math.ceil(aw.length / 2)) return "close";
    if (d <= Math.max(2, Math.floor(a.length * 0.35))) return "close";
    return "missed";
  }

  globalThis.PolycarpFx = { party, chime, judge, norm, lev };
})();
