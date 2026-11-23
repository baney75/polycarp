/* Polycarp to Notion: keeps a "Polycarp Library" database in the user's Notion workspace in step with
   the Library. One page per item, body rewritten only when its content changed, Related filled in
   from Polycarp's links. Never deletes or archives a page. Classic script. */
(function () {
  "use strict";

  const BASE = "https://api.notion.com/v1";
  const VERSION = "2022-06-28";
  const GAP_MS = 340;
  const TEXT_MAX = 2000;
  const RICH_MAX = 100;
  const APPEND_MAX = 100;
  const DB_TITLE = "Polycarp Library";
  const TYPE_NAMES = { doc: "Document", link: "Link", audio: "Audio", note: "Note" };

  const PROPS = {
    Name: { title: {} },
    Type: { select: { options: [{ name: "Document" }, { name: "Link" }, { name: "Audio" }, { name: "Note" }] } },
    URL: { url: {} },
    Author: { rich_text: {} },
    Tags: { multi_select: { options: [] } },
    "Polycarp ID": { rich_text: {} },
    Updated: { date: {} },
    Sync: { rich_text: {} }
  };

  // ---------- Blocks (pure) ----------

  // Split text into rich text runs of at most 2000 characters, never inside a surrogate pair.
  function chunks(text) {
    const s = String(text || "");
    const out = [];
    let i = 0;
    while (i < s.length) {
      let end = Math.min(s.length, i + TEXT_MAX);
      if (end < s.length) {
        const c = s.charCodeAt(end - 1);
        if (c >= 0xd800 && c <= 0xdbff) end--;
      }
      out.push(s.slice(i, end));
      i = end;
    }
    return out;
  }
  function rich(text, ann) {
    return chunks(text).map(c => {
      const r = { type: "text", text: { content: c } };
      if (ann) r.annotations = ann;
      return r;
    });
  }
  // A block type that holds rich text; very long text becomes several blocks.
  function textBlocks(type, text, extra) {
    const runs = Array.isArray(text) ? text : rich(text);
    const out = [];
    for (let i = 0; i < Math.max(1, runs.length); i += RICH_MAX) {
      const body = { rich_text: runs.slice(i, i + RICH_MAX) };
      if (extra) Object.assign(body, extra);
      out.push({ object: "block", type, [type]: body });
    }
    return out;
  }
  function heading(text) { return textBlocks("heading_2", text)[0]; }

  // Light Markdown: # and ## headings, - and * bullets, and paragraphs.
  function markdownBlocks(md) {
    const out = [];
    let para = [];
    const flush = () => {
      if (para.length) out.push(...textBlocks("paragraph", para.join("\n")));
      para = [];
    };
    for (const raw of String(md || "").replace(/\r\n?/g, "\n").split("\n")) {
      const line = raw.replace(/\s+$/, "");
      let m;
      if (!line.trim()) { flush(); continue; }
      if ((m = /^##\s+(.*)$/.exec(line))) { flush(); out.push(...textBlocks("heading_3", m[1])); continue; }
      if ((m = /^#\s+(.*)$/.exec(line))) { flush(); out.push(...textBlocks("heading_2", m[1])); continue; }
      if ((m = /^\s*[-*]\s+(.*)$/.exec(line))) { flush(); out.push(...textBlocks("bulleted_list_item", m[1])); continue; }
      para.push(line.trim());
    }
    flush();
    return out;
  }

  function clock(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    const pad = (x) => (x < 10 ? "0" : "") + x;
    return h ? h + ":" + pad(m) + ":" + pad(r) : m + ":" + pad(r);
  }
  function anchorLabel(a) {
    if (!a) return "";
    if (a.page != null && a.page !== "") return "page " + a.page;
    if (a.time != null && a.time !== "") return clock(a.time);
    if (a.block != null && a.block !== "") return "paragraph " + (typeof a.block === "number" ? a.block + 1 : a.block);
    return "";
  }
  function ideaLine(card) {
    const prompt = String((card && card.prompt) || "").trim();
    const answer = String((card && card.answer) || "").trim();
    if (/_{3,}/.test(prompt)) return prompt.replace(/_{3,}/, answer);
    if (!prompt || card.type === "gist") return answer;
    return answer ? prompt + ": " + answer : prompt;
  }

  function blocksFor(item, notes, ideas) {
    const out = [];
    if (!item) return out;
    if (item.kind === "note") return markdownBlocks(item.text);
    if (item.excerpt) out.push(...textBlocks("quote", item.excerpt));
    const lines = (ideas || []).map(ideaLine).filter(Boolean);
    if (lines.length) {
      out.push(heading("Key ideas"));
      for (const l of lines) out.push(...textBlocks("bulleted_list_item", l));
    }
    const list = notes || [];
    const highs = list.filter(n => n.quote);
    if (highs.length) {
      out.push(heading("Highlights"));
      for (const n of highs) {
        out.push(...textBlocks("quote", n.quote));
        const label = anchorLabel(n.anchor);
        const body = String(n.text || "").trim();
        if (label || body) {
          const runs = [];
          if (label) runs.push(...rich(label, { italic: true }));
          if (label && body) runs.push(...rich("  "));
          if (body) runs.push(...rich(body));
          out.push(...textBlocks("paragraph", runs));
        }
      }
    }
    const plain = list.filter(n => !n.quote && String(n.text || "").trim());
    if (plain.length) {
      out.push(heading("Notes"));
      for (const n of plain) out.push(...markdownBlocks(n.text));
    }
    return out;
  }

  // FNV-1a, enough to notice a change.
  function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16).padStart(8, "0");
  }

  function propsFor(item) {
    const tags = Array.from(new Set((item.tags || []).map(t => String(t).replace(/,/g, " ").trim().slice(0, 100)).filter(Boolean)));
    return {
      Name: { title: rich(item.title || "Untitled").slice(0, RICH_MAX) },
      Type: { select: { name: TYPE_NAMES[item.kind] || "Document" } },
      URL: { url: item.url || null },
      Author: { rich_text: item.author ? rich(item.author) : [] },
      Tags: { multi_select: tags.map(name => ({ name })) },
      "Polycarp ID": { rich_text: rich(item.id) },
      Updated: { date: item.updated ? { start: new Date(item.updated).toISOString() } : null }
    };
  }

  function plainOf(prop) {
    if (!prop) return "";
    const arr = prop.rich_text || prop.title || [];
    return arr.map(r => r.plain_text != null ? r.plain_text : ((r.text && r.text.content) || "")).join("");
  }
  function titleOf(page) {
    for (const k of Object.keys((page && page.properties) || {})) {
      const p = page.properties[k];
      if (p && p.type === "title") return plainOf(p);
    }
    if (page && Array.isArray(page.title)) return page.title.map(r => r.plain_text || "").join("");
    return "";
  }
  function bareId(id) { return String(id || "").replace(/-/g, "").toLowerCase(); }

  // ---------- Client ----------

  function create(opts) {
    const o = opts || {};
    const token = String(o.token || "");
    const fetchFn = o.fetch || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
    const sleep = o.sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
    const now = o.now || (() => Date.now());
    if (!fetchFn) throw new Error("No fetch available");
    let chain = Promise.resolve();
    let lastAt = 0;

    async function once(method, path, body) {
      const wait = lastAt + GAP_MS - now();
      if (lastAt && wait > 0) await sleep(wait);
      lastAt = now();
      const init = {
        method,
        headers: { Authorization: "Bearer " + token, "Notion-Version": VERSION, "Content-Type": "application/json" }
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      return fetchFn(BASE + path, init);
    }

    async function send(method, path, body) {
      let fails = 0;
      let limited = 0;
      for (;;) {
        let res;
        try {
          res = await once(method, path, body);
        } catch (e) {
          if (fails++ < 3) { await sleep(500 * Math.pow(2, fails - 1)); continue; }
          const err = new Error("Could not reach Notion: " + ((e && e.message) || e));
          err.status = 0; err.code = "network_error";
          throw err;
        }
        const raw = typeof res.text === "function" ? await res.text() : "";
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = null; }
        if (res.status === 429 && limited++ < 8) {
          const h = res.headers && typeof res.headers.get === "function" ? res.headers.get("Retry-After") : null;
          const sec = Number(h);
          await sleep((isFinite(sec) && sec > 0 ? sec : 1) * 1000);
          continue;
        }
        if (res.status >= 500 && fails++ < 3) { await sleep(500 * Math.pow(2, fails - 1)); continue; }
        if (res.status < 200 || res.status >= 300) {
          const err = new Error((data && data.message) || "Notion request failed (" + res.status + ")");
          err.status = res.status;
          err.code = (data && data.code) || "";
          throw err;
        }
        return data;
      }
    }

    // One request at a time, in the order asked.
    function request(method, path, body) {
      const p = chain.then(() => send(method, path, body));
      chain = p.catch(() => {});
      return p;
    }

    async function me() { return request("GET", "/users/me"); }

    async function searchPages(query) {
      const out = [];
      let cursor;
      for (let i = 0; i < 5; i++) {
        const body = { query: String(query || ""), filter: { property: "object", value: "page" }, page_size: 50 };
        if (cursor) body.start_cursor = cursor;
        const r = await request("POST", "/search", body);
        for (const p of (r && r.results) || []) {
          if (p.archived || p.in_trash) continue;
          out.push({ id: p.id, title: titleOf(p) || "Untitled", url: p.url || "" });
        }
        if (!r || !r.has_more || !r.next_cursor) break;
        cursor = r.next_cursor;
      }
      return out;
    }

    function relationProp(dbId) { return { relation: { database_id: dbId, type: "single_property", single_property: {} } }; }

    async function ensureDatabase(parentPageId, existingDbId) {
      if (existingDbId) {
        let db = null;
        try { db = await request("GET", "/databases/" + existingDbId); } catch (e) {
          if (!(e.status === 404 || e.status === 400 || e.code === "object_not_found")) throw e;
        }
        if (db && !db.archived && !db.in_trash) {
          const have = db.properties || {};
          const patch = {};
          const titleName = Object.keys(have).find(k => have[k] && have[k].type === "title");
          if (titleName && titleName !== "Name") patch[titleName] = { name: "Name" };
          // A database made under the earlier name keys its pages by that name's ID column: rename it, so the
          // pages already there are matched rather than made a second time.
          const OLD_ID = "Phont ID"; // migration: the earlier name's key column
          if (have[OLD_ID] && !have["Polycarp ID"]) patch[OLD_ID] = { name: "Polycarp ID" };
          for (const k of Object.keys(PROPS)) {
            if (k === "Name" && titleName) continue;
            if (k === "Polycarp ID" && patch[OLD_ID]) continue;
            if (!have[k]) patch[k] = PROPS[k];
          }
          if (!have.Related) patch.Related = relationProp(db.id || existingDbId);
          if (Object.keys(patch).length) await request("PATCH", "/databases/" + existingDbId, { properties: patch });
          return db.id || existingDbId;
        }
      }
      if (!parentPageId) throw new Error("Pick a Notion page to hold the Polycarp Library database");
      const made = await request("POST", "/databases", {
        parent: { type: "page_id", page_id: parentPageId },
        title: [{ type: "text", text: { content: DB_TITLE } }],
        properties: PROPS
      });
      await request("PATCH", "/databases/" + made.id, { properties: { Related: relationProp(made.id) } });
      return made.id;
    }

    async function queryAll(dbId) {
      const pages = [];
      let cursor;
      for (;;) {
        const body = { page_size: 100 };
        if (cursor) body.start_cursor = cursor;
        const r = await request("POST", "/databases/" + dbId + "/query", body);
        pages.push(...((r && r.results) || []));
        if (!r || !r.has_more || !r.next_cursor) break;
        cursor = r.next_cursor;
      }
      return pages;
    }

    async function childrenOf(blockId) {
      const out = [];
      let cursor;
      for (;;) {
        const r = await request("GET", "/blocks/" + blockId + "/children?page_size=100" + (cursor ? "&start_cursor=" + encodeURIComponent(cursor) : ""));
        out.push(...((r && r.results) || []));
        if (!r || !r.has_more || !r.next_cursor) break;
        cursor = r.next_cursor;
      }
      return out;
    }

    async function appendAll(pageId, blocks) {
      for (let i = 0; i < blocks.length; i += APPEND_MAX) {
        await request("PATCH", "/blocks/" + pageId + "/children", { children: blocks.slice(i, i + APPEND_MAX) });
      }
    }

    // Archive the old body. Child pages and databases stay: they are pages, and pages are never archived.
    async function clearBody(pageId) {
      for (const b of await childrenOf(pageId)) {
        if (b.type === "child_page" || b.type === "child_database") continue;
        await request("DELETE", "/blocks/" + b.id);
      }
    }

    function stateOf(page) {
      const props = (page && page.properties) || {};
      const sync = plainOf(props.Sync);
      const parts = sync.split(".");
      const rel = (props.Related && props.Related.relation) || [];
      return { id: page.id, propHash: parts[0] || "", blockHash: parts[1] || "", related: rel.map(r => bareId(r.id)).sort() };
    }

    async function syncItems(dbId, items, o2) {
      const opt = o2 || {};
      const notesFor = opt.notesFor || (() => []);
      const relatedFor = opt.relatedFor || (() => []);
      const ideasFor = opt.ideasFor || (() => []);
      const onProgress = opt.onProgress || null;
      const pageIds = Object.assign({}, opt.pageIds || {});
      const res = { created: 0, updated: 0, unchanged: 0, errors: [], pageIds };
      const list = (items || []).filter(Boolean);
      const total = list.length;
      const tick = (done, phase, item) => {
        if (onProgress) { try { onProgress({ done, total, phase, id: item && item.id, title: item && item.title }); } catch (e) { /* ignore */ } }
      };

      // What is already in the database, keyed by Polycarp ID and by page id.
      const byPolycarp = new Map();
      const byPage = new Map();
      for (const p of await queryAll(dbId)) {
        if (p.archived || p.in_trash) continue;
        const st = stateOf(p);
        byPage.set(bareId(p.id), st);
        const props = p.properties || {};
        const pid = plainOf(props["Polycarp ID"]) || plainOf(props["Phont ID"]); // migration: pages keyed under the earlier name
        if (pid && !byPolycarp.has(pid)) byPolycarp.set(pid, st);
      }

      let done = 0;
      for (const item of list) {
        try {
          let state = null;
          const known = pageIds[item.id];
          if (known) {
            state = byPage.get(bareId(known)) || null;
            if (!state) {
              try {
                const p = await request("GET", "/pages/" + known);
                if (p && !p.archived && !p.in_trash) state = stateOf(p);
              } catch (e) {
                if (!(e.status === 404 || e.status === 400)) throw e;
              }
            }
          }
          if (!state) state = byPolycarp.get(item.id) || null;

          const notes = (await notesFor(item.id, item)) || [];
          const ideas = (await ideasFor(item)) || [];
          const blocks = blocksFor(item, notes, ideas);
          const props = propsFor(item);
          const blockHash = hash(JSON.stringify(blocks));
          const propHash = hash(JSON.stringify(props));
          props.Sync = { rich_text: rich(propHash + "." + blockHash) };

          if (!state) {
            const page = await request("POST", "/pages", {
              parent: { database_id: dbId },
              properties: props,
              children: blocks.slice(0, APPEND_MAX)
            });
            if (blocks.length > APPEND_MAX) await appendAll(page.id, blocks.slice(APPEND_MAX));
            pageIds[item.id] = page.id;
            byPage.set(bareId(page.id), { id: page.id, propHash, blockHash, related: [] });
            res.created++;
          } else {
            pageIds[item.id] = state.id;
            if (state.propHash === propHash && state.blockHash === blockHash) {
              res.unchanged++;
            } else {
              await request("PATCH", "/pages/" + state.id, { properties: props });
              if (state.blockHash !== blockHash) {
                await clearBody(state.id);
                await appendAll(state.id, blocks);
              }
              state.propHash = propHash;
              state.blockHash = blockHash;
              res.updated++;
            }
          }
        } catch (e) {
          if (e && e.status === 401) throw e;
          res.errors.push({ id: item.id, title: item.title, message: (e && e.message) || String(e), status: (e && e.status) || 0, code: (e && e.code) || "" });
        }
        tick(++done, "pages", item);
      }

      // Second pass: Related, once every page exists.
      done = 0;
      for (const item of list) {
        const pid = pageIds[item.id];
        if (!pid) continue;
        try {
          const rel = (await relatedFor(item.id, item)) || [];
          const ids = [];
          for (const r of rel) {
            const otherId = r && (r.item ? r.item.id : r.id);
            const target = otherId && pageIds[otherId];
            if (target && bareId(target) !== bareId(pid) && ids.indexOf(target) < 0) ids.push(target);
          }
          const want = ids.slice(0, 100);
          const st = byPage.get(bareId(pid));
          const have = st ? st.related : [];
          const wantKey = want.map(bareId).sort();
          if (JSON.stringify(have) !== JSON.stringify(wantKey)) {
            await request("PATCH", "/pages/" + pid, { properties: { Related: { relation: want.map(id => ({ id })) } } });
            if (st) st.related = wantKey;
          }
        } catch (e) {
          if (e && e.status === 401) throw e;
          res.errors.push({ id: item.id, title: item.title, message: (e && e.message) || String(e), status: (e && e.status) || 0, code: (e && e.code) || "" });
        }
        tick(++done, "relations", item);
      }
      return res;
    }

    return { request, me, searchPages, ensureDatabase, syncItems };
  }

  globalThis.PolycarpNotion = { VERSION, BASE, create, blocksFor, chunks, markdownBlocks, propsFor, hash };
})();
