/* Polycarp to Obsidian: turns Library items into Markdown notes with frontmatter and [[links]],
   writes them into a Polycarp/ folder of a vault through the File System Access API, or zips them.
   Never deletes a file and never overwrites a file the user made. Classic script. */
(function () {
  "use strict";

  const FOLDER = "Polycarp";
  const INDEX_NAME = "Polycarp Library";
  const INDEX_ID = "polycarp-library-index";
  const HANDLE_KEY = "obsidian.dir";
  const KIND_HEADINGS = [["doc", "Documents"], ["link", "Links"], ["audio", "Audio"], ["note", "Notes"]];

  // ---------- Names ----------

  // A file name that works on Windows, macOS, Linux and inside an Obsidian [[link]].
  function safeName(title) {
    let s = String(title || "")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/[\\/:*?"<>|#^\[\]]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^\.+/, "")
      .replace(/[.\s]+$/, "");
    if (s.length > 120) s = s.slice(0, 120).replace(/[.\s]+$/, "");
    if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s += " note";
    return s || "Untitled";
  }

  // Map item id to vault basename. Older items keep the plain name; later ones get " 2", " 3".
  function basenames(items) {
    const used = new Set([INDEX_NAME.toLowerCase()]);
    const out = {};
    const list = (items || []).slice().sort((a, b) => (a.created || 0) - (b.created || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const it of list) {
      const base = safeName(it.title);
      let name = base;
      let n = 2;
      while (used.has(name.toLowerCase())) name = base + " " + n++;
      used.add(name.toLowerCase());
      out[it.id] = name;
    }
    return out;
  }

  // ---------- Markdown ----------

  function yamlStr(v) { return JSON.stringify(String(v == null ? "" : v)); }
  function yamlTag(t) {
    const s = String(t).replace(/^#/, "").trim().replace(/\s+/g, "-");
    return /^[\p{L}\p{N}_\-/]+$/u.test(s) ? s : yamlStr(s);
  }
  function isoDate(ms) {
    const d = new Date(Number(ms) || 0);
    if (isNaN(d.getTime())) return "";
    const z = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + z(d.getMonth() + 1) + "-" + z(d.getDate());
  }
  function clock(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    const pad = (x) => (x < 10 ? "0" : "") + x;
    return h ? h + ":" + pad(m) + ":" + pad(r) : m + ":" + pad(r);
  }
  // "page 12", "12:34" or "paragraph 8". Reader blocks count from 0.
  function anchorLabel(a) {
    if (!a) return "";
    if (a.page != null && a.page !== "") return "page " + a.page;
    if (a.time != null && a.time !== "") return clock(a.time);
    if (a.block != null && a.block !== "") return "paragraph " + (typeof a.block === "number" ? a.block + 1 : a.block);
    return "";
  }
  // One line per memory card, with a cloze blank filled in.
  function ideaLine(card) {
    const prompt = String((card && card.prompt) || "").trim();
    const answer = String((card && card.answer) || "").trim();
    if (/_{3,}/.test(prompt)) return prompt.replace(/_{3,}/, answer);
    if (!prompt || card.type === "gist") return answer;
    return answer ? prompt + ": " + answer : prompt;
  }
  function quoteLines(text) {
    return String(text || "").trim().split(/\r?\n/).map(l => (l.trim() ? "> " + l : ">")).join("\n");
  }

  function frontmatter(item) {
    const lines = ["---", "polycarp-id: " + yamlStr(item.id), "type: " + (item.kind || "doc"), "title: " + yamlStr(item.title || "")];
    if (item.author) lines.push("author: " + yamlStr(item.author));
    if (item.url) lines.push("url: " + yamlStr(item.url));
    if (item.source) lines.push("source: " + item.source);
    const tags = ["polycarp"];
    for (const t of item.tags || []) if (t && tags.indexOf(String(t).toLowerCase()) < 0) tags.push(String(t).toLowerCase());
    lines.push("tags:");
    for (const t of tags) lines.push("  - " + yamlTag(t));
    if (item.created) lines.push("created: " + isoDate(item.created));
    if (item.updated) lines.push("updated: " + isoDate(item.updated));
    if (item.kind === "audio" && item.duration) lines.push("duration: " + Math.round(item.duration));
    lines.push("---");
    return lines.join("\n");
  }

  function toMarkdown(item, opts) {
    const o = opts || {};
    const names = o.names || {};
    const base = names[item.id] || safeName(item.title);
    const path = FOLDER + "/" + base + ".md";
    const fm = frontmatter(item);
    if (item.kind === "note") {
      return { path, body: fm + "\n\n" + String(item.text || "").trim() + "\n" };
    }
    const parts = ["# " + (item.title || base)];
    if (item.url) parts.push("[Open the original](" + String(item.url).replace(/\s/g, "%20").replace(/\)/g, "%29") + ")");
    if (item.excerpt) parts.push(quoteLines(item.excerpt));
    const ideas = (o.ideas || []).map(ideaLine).filter(Boolean);
    if (ideas.length) parts.push("## Key ideas\n\n" + ideas.map(l => "- " + l.replace(/\s*\n\s*/g, " ")).join("\n"));
    const notes = o.notes || [];
    const highs = notes.filter(n => n.quote);
    if (highs.length) {
      parts.push("## Highlights\n\n" + highs.map(n => {
        const label = anchorLabel(n.anchor);
        let s = quoteLines(n.quote);
        if (label) s += "\n> (" + label + ")";
        if (String(n.text || "").trim()) s += "\n\n" + String(n.text).trim();
        return s;
      }).join("\n\n"));
    }
    const plain = notes.filter(n => !n.quote && String(n.text || "").trim());
    if (plain.length) {
      parts.push("## Notes\n\n" + plain.map(n => {
        const label = anchorLabel(n.anchor);
        return (label ? "*" + label + "*\n\n" : "") + String(n.text).trim();
      }).join("\n\n"));
    }
    const rel = (o.related || []).filter(r => r && r.item);
    if (rel.length) {
      parts.push("## Related\n\n" + rel.map(r => "- [[" + (names[r.item.id] || safeName(r.item.title)) + "]]" + (r.why ? ": " + r.why : "")).join("\n"));
    }
    return { path, body: fm + "\n\n" + parts.join("\n\n") + "\n" };
  }

  function indexNote(items, names) {
    const map = names || basenames(items);
    const lines = ["---", "polycarp-id: " + yamlStr(INDEX_ID), "type: index", "tags:", "  - polycarp", "---", "", "# " + INDEX_NAME, ""];
    const list = items || [];
    lines.push(list.length + (list.length === 1 ? " item" : " items") + " saved in Polycarp.");
    for (const [kind, heading] of KIND_HEADINGS) {
      const group = list.filter(i => (i.kind || "doc") === kind).sort((a, b) => String(a.title).localeCompare(String(b.title)));
      if (!group.length) continue;
      lines.push("", "## " + heading, "");
      for (const it of group) lines.push("- [[" + (map[it.id] || safeName(it.title)) + "]]" + (it.author ? " by " + it.author : ""));
    }
    return { path: FOLDER + "/" + INDEX_NAME + ".md", body: lines.join("\n") + "\n" };
  }

  // ---------- Writing to a vault folder ----------

  function idIn(text) {
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ""));
    if (!fm) return "";
    const m = /^(?:polycarp|phont)-id:\s*"?([^"\r\n]*?)"?\s*$/m.exec(fm[1]); // migration: notes written under the earlier name
    return m ? m[1].trim() : "";
  }

  async function readExisting(dir, name) {
    let fh;
    try { fh = await dir.getFileHandle(name); } catch (e) {
      if (e && (e.name === "NotFoundError" || e.name === "TypeMismatchError" || e.code === 8)) return null;
      throw e;
    }
    const file = await fh.getFile();
    return { text: await file.text() };
  }

  // A vault synced under the earlier name keeps getting its notes in that folder, so nothing is written twice,
  // until a Polycarp folder exists there.
  const OLD_FOLDER = "Phont"; // migration: the earlier name's vault folder
  async function folderIn(dirHandle) {
    const has = async (name) => { try { await dirHandle.getDirectoryHandle(name); return true; } catch (e) { return false; } };
    return !(await has(FOLDER)) && (await has(OLD_FOLDER)) ? OLD_FOLDER : FOLDER;
  }

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  async function writeVault(dirHandle, files, opts) {
    const onProgress = (opts && opts.onProgress) || null;
    const result = { written: 0, skipped: 0, renamed: 0, renames: [] };
    const plan = [];
    for (const f of files || []) {
      const p = String((f && f.path) || "");
      const name = p.slice(FOLDER.length + 1);
      // Only flat files directly inside Polycarp/.
      if (p.indexOf(FOLDER + "/") !== 0 || !name || /[\\/]/.test(name) || name === "." || name === ".." || !/\.md$/i.test(name)) {
        result.skipped++;
        continue;
      }
      plan.push({ name, body: String(f.body || ""), id: idIn(f.body) });
    }
    const disk = await folderIn(dirHandle);
    result.folder = disk;
    const dir = await dirHandle.getDirectoryHandle(disk, { create: true });
    const intended = new Set(plan.map(p => p.name.toLowerCase()));
    const claimed = new Set();
    const cache = new Map();
    async function look(name) {
      const k = name.toLowerCase();
      if (!cache.has(k)) cache.set(k, await readExisting(dir, name));
      return cache.get(k);
    }
    // Pass 1: pick a final name for each file without touching a file someone else made.
    const renameMap = [];
    for (const p of plan) {
      const ex = await look(p.name);
      const ours = !ex || (p.id && idIn(ex.text) === p.id);
      if (ours && !claimed.has(p.name.toLowerCase())) { claimed.add(p.name.toLowerCase()); continue; }
      const stem = p.name.replace(/\.md$/i, "");
      let n = 2;
      for (;;) {
        const cand = stem + " " + n++ + ".md";
        const k = cand.toLowerCase();
        if (claimed.has(k) || intended.has(k)) continue;
        const ex2 = await look(cand);
        if (!ex2 || (p.id && idIn(ex2.text) === p.id)) {
          claimed.add(k);
          renameMap.push([stem, cand.replace(/\.md$/i, "")]);
          result.renames.push({ from: disk + "/" + p.name, to: disk + "/" + cand });
          p.name = cand;
          break;
        }
      }
    }
    result.renamed = result.renames.length;
    // Pass 2: point [[links]] at the renamed files.
    if (renameMap.length) {
      for (const p of plan) {
        for (const [from, to] of renameMap) {
          p.body = p.body.replace(new RegExp("\\[\\[" + escapeRe(from) + "(?=[\\]|#])", "g"), "[[" + to);
        }
      }
    }
    // Pass 3: write what changed.
    let done = 0;
    for (const p of plan) {
      const ex = await look(p.name);
      if (ex && ex.text === p.body) {
        result.skipped++;
      } else {
        const fh = await dir.getFileHandle(p.name, { create: true });
        const w = await fh.createWritable();
        await w.write(p.body);
        await w.close();
        result.written++;
      }
      done++;
      if (onProgress) { try { onProgress({ done, total: plan.length, path: disk + "/" + p.name }); } catch (e) { /* ignore */ } }
    }
    return result;
  }

  // ---------- Zip, links and the saved folder ----------

  function zip(files) {
    const Z = globalThis.JSZip;
    if (!Z) return Promise.reject(new Error("JSZip is not loaded"));
    const z = new Z();
    for (const f of files || []) z.file(String(f.path), String(f.body || ""));
    return z.generateAsync({ type: "blob", mimeType: "application/zip" });
  }

  function obsidianUrl(vaultName, path) {
    const file = String(path || "").replace(/\.md$/i, "");
    return "obsidian://open?vault=" + encodeURIComponent(String(vaultName || "")) + "&file=" + encodeURIComponent(file);
  }

  function lib() {
    const L = globalThis.PolycarpLibrary;
    if (!L) throw new Error("PolycarpLibrary is not loaded");
    return L;
  }
  function saveHandle(h) { return lib().setMeta(HANDLE_KEY, h); }
  async function loadHandle() { return (await lib().getMeta(HANDLE_KEY)) || null; }
  async function ensurePermission(h) {
    if (!h) return false;
    const opts = { mode: "readwrite" };
    if (typeof h.queryPermission === "function" && (await h.queryPermission(opts)) === "granted") return true;
    if (typeof h.requestPermission === "function" && (await h.requestPermission(opts)) === "granted") return true;
    return false;
  }

  globalThis.PolycarpObsidian = {
    FOLDER, INDEX_NAME,
    safeName, basenames, toMarkdown, indexNote, writeVault, folderIn, idIn, zip, obsidianUrl,
    saveHandle, loadHandle, ensurePermission, ideaLine, anchorLabel
  };
})();
