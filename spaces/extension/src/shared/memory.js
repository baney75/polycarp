/* Polycarp memory: spaced retrieval practice for what you read.
   Leitner style tiers (Cepeda et al. 2006) and retrieval practice cards (Roediger and Karpicke 2006),
   built fully on device. Classic script for extension pages, the service worker and Node tests. */
(function () {
  "use strict";

  const STORE_KEY = "polycarp.memory";
  const STORE_SCHEMA = 1;
  const CAP = 5000;
  const MIN = 60 * 1000;
  const DAY = 24 * 60 * MIN;
  const RETRY_MS = 10 * MIN;
  const LEECH = 4;

  // Tier 6 is "Mastered": a card gets there by passing tier 5.
  const TIERS = [
    { tier: 1, name: "Fresh", days: 1 },
    { tier: 2, name: "Warm", days: 3 },
    { tier: 3, name: "Settling", days: 7 },
    { tier: 4, name: "Strong", days: 16 },
    { tier: 5, name: "Long-term", days: 35 },
    { tier: 6, name: "Mastered", days: 90 }
  ];
  const MAX_TIER = TIERS.length;

  function clampTier(t) {
    t = Math.round(Number(t) || 1);
    return Math.min(MAX_TIER, Math.max(1, t));
  }
  function tierInfo(t) { return TIERS[clampTier(t) - 1]; }
  function intervalMs(t) { return tierInfo(t).days * DAY; }

  // FNV-1a, so jitter is stable for a given card and review count.
  function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }
  function jitterFactor(id, reviews) {
    return 0.9 + (hash(String(id) + ":" + reviews) / 0xffffffff) * 0.2;
  }

  function makeId() {
    try {
      if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") return globalThis.crypto.randomUUID();
    } catch (e) { /* fall through */ }
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  // ---------- Cards ----------

  const TYPES = ["cloze", "gist", "quote", "qa"];

  function newCard(fields, now) {
    fields = fields || {};
    now = typeof now === "number" ? now : Date.now();
    const src = fields.source || {};
    return {
      id: fields.id || makeId(),
      type: TYPES.indexOf(fields.type) >= 0 ? fields.type : "cloze",
      prompt: String(fields.prompt || ""),
      answer: String(fields.answer || ""),
      hint: String(fields.hint || ""),
      context: String(fields.context || ""),
      source: {
        title: String(src.title || ""),
        url: String(src.url || ""),
        docKey: String(src.docKey || ""),
        section: src.section == null ? "" : src.section
      },
      tier: 1,
      due: now + DAY,
      created: now,
      reviews: 0,
      lapses: 0,
      last: 0
    };
  }

  // Pure: returns a new card. result is "got", "fuzzy" or "missed".
  function grade(card, result, now) {
    now = typeof now === "number" ? now : Date.now();
    const c = Object.assign({}, card, { source: Object.assign({}, card.source) });
    const tier = clampTier(c.tier);
    if (result === "got") {
      c.tier = Math.min(MAX_TIER, tier + 1);
      c.due = now + Math.round(intervalMs(c.tier) * jitterFactor(c.id, c.reviews || 0));
    } else if (result === "fuzzy") {
      c.tier = tier;
      c.due = now + Math.max(DAY, Math.round(intervalMs(tier) / 2));
    } else if (result === "missed") {
      // A slip costs two stages, not the whole climb: an idea known for months is relearned
      // faster than a new one. Back in ten minutes either way.
      c.tier = Math.max(1, tier - 2);
      c.due = now + RETRY_MS;
      c.lapses = (c.lapses || 0) + 1;
      // Missed four times or more: the card itself is likely the problem. Review offers a rewrite.
      if (c.lapses >= LEECH) c.leech = true;
    } else {
      throw new Error("PolycarpMemory.grade: unknown result " + result);
    }
    c.reviews = (c.reviews || 0) + 1;
    c.last = now;
    return c;
  }

  function due(cards, now) {
    now = typeof now === "number" ? now : Date.now();
    return (cards || []).filter(c => c.due <= now).sort((a, b) => a.due - b.due || a.tier - b.tier);
  }

  function counts(cards, now) {
    now = typeof now === "number" ? now : Date.now();
    const byTier = {};
    for (const t of TIERS) byTier[t.tier] = 0;
    let d = 0;
    for (const c of cards || []) {
      byTier[clampTier(c.tier)] += 1;
      if (c.due <= now) d += 1;
    }
    return { due: d, total: (cards || []).length, byTier };
  }

  function nextDue(cards) {
    let min = null;
    for (const c of cards || []) if (typeof c.due === "number" && (min === null || c.due < min)) min = c.due;
    return min;
  }

  // ---------- Text basics ----------

  const STOP = new Set((
    "a about above after again against all almost also although always am among an and another any are aren't around as at " +
    "be became because been before being below between both but by can can't cannot could couldn't did didn't do does doesn't " +
    "doing don't down during each either else enough etc even ever every few first for from further get gets getting given " +
    "goes had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's " +
    "however i i'd i'll i'm i've if in instead into is isn't it it's its itself just last least less let's like likely made " +
    "make makes many may me might more most mostly much must mustn't my myself near neither never new next no nor not now of " +
    "off often on once one only onto or other others otherwise ought our ours ourselves out over own per perhaps quite rather " +
    "really same second several shall shan't she she'd she'll she's should shouldn't since so some something sometimes still " +
    "such than that that's the their theirs them themselves then there there's therefore these they they'd they'll they're " +
    "they've this those though three through thus to together too toward towards two under until up upon us usually very via " +
    "was wasn't way we we'd we'll we're we've well were weren't what what's whatever when when's where where's whether which " +
    "while who who's whole whom whose why why's will with within without won't would wouldn't yet you you'd you'll you're " +
    "you've your yours yourself yourselves also called known means mean meant include includes including use used uses using " +
    "said say says see seen take takes taken typically generally particularly especially simply certain various upon " +
    "throughout across beyond along behind beside besides inside outside despite except plus versus whereas unless already " +
    "again ever around including whose fewer lower higher larger smaller greater lesser able"
  ).split(/\s+/));

  // Words that are fine in a sentence but make weak answers.
  const GENERIC = new Set((
    "part parts thing things way ways kind kinds type types time times case cases example examples number numbers amount " +
    "level levels place places point points fact facts lot lots area areas form forms use step steps people person year years " +
    "day days place result results set sets order rest end ends side sides group groups term terms system systems process " +
    "processes practice instance aspect aspects issue issues factor factors range basis cost costs job role"
  ).split(/\s+/));

  const UNITS = new Set((
    "percent percentage % mg mg/l g kg lb lbs oz ml l liter liters litre litres gallon gallons meter meters metre metres km mile " +
    "miles foot feet inch inches cm mm second seconds minute minutes hour hours day days week weeks month months year years " +
    "decade decades century centuries degree degrees ntu ppm ppb ppt parts milligrams milligram micrograms microgram grams gram " +
    "kilograms kilometers volts watts kwh mph log logs times dollars cents million billion trillion thousand hundred"
  ).split(/\s+/));

  // Everyday words: allowed as answers but ranked below the text's own technical terms.
  const COMMON = new Set((
    "account act action activity add age agency air allow amount answer appear apply approach area argue arm art ask " +
    "attention authority available average away baby back bad ball bank base basin bear beat beautiful bed begin behavior " +
    "believe benefit best better big bill bit black blood blue board body book born box boy break bring brother budget build " +
    "building business buy call camera campaign capital car card care career carry catch cause cell center central century " +
    "chair challenge chance change character charge check child choice choose church citizen city civil claim class clear " +
    "close coach cold collection college color come commercial common community company compare computer concern condition " +
    "conference consider consumer contain continue control cost country couple course court cover create crime cultural " +
    "culture cup current customer cut dark data daughter dead deal death debate decade decide decision deep defense degree " +
    "deliver describe design detail determine develop development die difference different difficult difficulty dinner " +
    "direct direction director discover discuss discussion disease doctor dog door draw dream drive drop drug early east easy " +
    "eat economic economy edge education effect effective effectiveness effort eight election else employee end energy enjoy " +
    "enter entire environment environmental equipment establish evening event evidence exactly exist expect experience expert " +
    "explain eye face facility factor fail fall family far fast father fear federal feel feeling field fight figure fill film " +
    "final finally financial find fine finger finish fire firm fish five floor fly focus follow food foot force foreign forget " +
    "former forward four free friend front full fund future game garden gas general generation girl give glass go goal good " +
    "government great green ground grow growth guess gun guy hair half hand hang happen happy hard head health hear heart " +
    "heat heavy help high history hit hold home hope hospital hot hotel house huge human hundred husband idea identify image " +
    "imagine impact important improve increase indeed indicate individual industry information inside institution interest " +
    "interesting international interview investment involve issue item job join keep key kid kill kind kitchen know " +
    "knowledge land language large late later laugh law lawyer lay lead leader learn leave left leg legal let letter life " +
    "light line list listen little live local long look lose loss love low machine magazine main maintain major majority " +
    "manage management manager market marriage material matter measure media medical meet meeting member memory mention " +
    "message method middle military million mind minute miss mission model modern moment money month morning mother mouth " +
    "move movement movie music name nation national natural nature necessary need network news newspaper nice night north " +
    "note nothing notice offer office officer official oil ok old open operation opportunity option organization outside owner " +
    "page pain painting paper parent part participant particular partner party pass past patient pattern pay peace perform " +
    "performance period personal phone physical pick picture piece plan plant play player pm police policy political politics " +
    "poor popular population position positive possible potential power practice prepare present president pressure pretty " +
    "prevent price private probably problem produce product production professional professor program project property " +
    "protect prove public pull purpose push put quality question quickly race radio raise range rate reach read ready real " +
    "reality realize reason receive recent recently recognize record red reduce reflect region relate relationship religious " +
    "remain remember remove report represent republican require research resource respond response responsibility rest " +
    "return reveal rich right rise risk road rock room rule run safe save scene school science scientist score sea season " +
    "seat security seek seem sell send senior sense series serious serve service share shoot short shot show side sign " +
    "significant similar simple single sister sit site situation size skill skin small smile social society soldier son song " +
    "soon sort sound source south southern space speak special specific speech spend sport spring staff stage stand standard " +
    "star start state statement station stay step stock stop store story strategy street strong structure student study " +
    "stuff style subject success successful suddenly suffer suggest summer support sure surface table talk task tax teach " +
    "teacher team technology television tell ten tend test thank theory thing think third thought thousand threat throw " +
    "today tonight top total tough town trade traditional training travel treat treatment tree trial trip trouble true truth " +
    "try turn tv unit upon value various victim view violence visit voice vote wait walk wall want war watch water weapon wear " +
    "week weight west western white wide wife win wind window wish woman wonder word work worker world worry write writer " +
    "wrong yard yeah young youth"
  ).split(/\s+/));
  // A word after one of these is usually a verb.
  const MODALS = new Set("can could will would should may might must shall to does did do not cannot".split(" "));

  const TOKEN_RE = /\p{N}+(?:[.,:/]\p{N}+)*%?|[\p{L}\p{N}][\p{L}\p{M}\p{N}'’\-]*/gu;
  const CJK_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/g;

  function tokens(text) {
    const out = [];
    const s = String(text || "");
    TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = TOKEN_RE.exec(s))) {
      let w = m[0];
      while (/['’\-]$/.test(w)) w = w.slice(0, -1);
      if (w) out.push({ w, start: m.index, end: m.index + w.length });
    }
    return out;
  }

  function isNumber(w) { return /^\p{N}/u.test(w); }
  function isAcronym(w) { return /^[A-Z][A-Z0-9]{1,6}s?$/.test(w); }
  function isCapitalized(w) { return /^\p{Lu}/u.test(w); }

  // Term key: lowercase, no possessive, crude plural folding.
  function termKey(w) {
    let k = String(w).toLowerCase().replace(/['’]s$/, "").replace(/’/g, "'");
    if (k.length > 4 && /ies$/.test(k)) k = k.slice(0, -3) + "y";
    else if (k.length > 3 && /s$/.test(k) && !/(ss|us|is|ys)$/.test(k)) k = k.slice(0, -1);
    return k;
  }
  function isStop(w) { return STOP.has(String(w).toLowerCase().replace(/’/g, "'")); }
  function isContent(w) { return !isNumber(w) && !isStop(w) && w.length > 1; }

  function normalize(s) {
    return String(s || "").toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  }

  function wordCount(s) {
    const str = String(s || "");
    const cjk = (str.match(CJK_RE) || []).length;
    const rest = tokens(str.replace(CJK_RE, " ")).length;
    return rest + Math.ceil(cjk / 2);
  }

  // ---------- Sentence splitter ----------

  // Abbreviations that never end a sentence when another word follows.
  const ABBR_HOLD = new Set((
    "mr mrs ms mx dr prof sr st mt rev hon gen col lt sgt capt cmdr pres gov sen rep vs v e.g i.e cf viz fig figs no nos vol vols " +
    "pp p ch sec art approx ca dept est inc ltd co corp jan feb mar apr jun jul aug sep sept oct nov dec ave blvd rd univ assn bros"
  ).split(/\s+/));
  // Abbreviations that may also end a sentence; split only when a common sentence opener follows.
  const ABBR_SOFT = new Set("u.s u.k u.n e.u u.s.a ph.d a.m p.m d.c jr inc ltd co corp etc al".split(" "));
  const OPENERS = new Set((
    "a an the this that these those it its he she they we i you there here in on at for to from by with as but and or so if " +
    "when while after before because however then thus therefore also each every some many most all no one our their his her " +
    "my your what which who how why where during under over since although though yet"
  ).split(/\s+/));
  const HOLD_NUMBER = new Set("no nos vol vols p pp fig figs ch sec art approx ca".split(" "));

  function splitBlock(t, out) {
    const re = /[.!?…]+["'”’»)\]]*(?=\s|$)|[。！？]+["'”’」』)]*/g;
    let start = 0;
    let m;
    while ((m = re.exec(t))) {
      const end = m.index + m[0].length;
      // Look only near the mark: slicing the whole text each time made long books quadratic.
      const rest = t.slice(end, end + 200);
      const nextTok = rest.replace(/^[\s"'“‘«(\[]+/, "");
      const next = nextTok.charAt(0);
      if (!next) break;
      const punct = m[0].replace(/["'”’»)\]」』]+$/, "");
      let split;
      if (/[。！？]/.test(punct)) {
        split = true;
      } else if (/[!?]/.test(punct)) {
        split = !/\p{Ll}/u.test(next);
      } else if (/…|\.\.\./.test(punct)) {
        split = /\p{Lu}/u.test(next);
      } else {
        const before = t.slice(Math.max(0, m.index - 80), m.index);
        const pm = before.match(/([\p{L}\p{N}][\p{L}\p{N}.]*)$/u);
        const prev = pm ? pm[1] : "";
        const prevL = prev.toLowerCase();
        const nextWord = (nextTok.match(/^[\p{L}\p{N}'’]+/u) || [""])[0].toLowerCase();
        if (/\p{Ll}/u.test(next)) split = false;
        else if (/\p{N}/u.test(next)) split = !HOLD_NUMBER.has(prevL);
        else if (/^\p{Lu}$/u.test(prev)) split = false; // initial, as in J. K. Rowling
        else if (ABBR_SOFT.has(prevL) || (prevL.indexOf(".") > 0 && !ABBR_HOLD.has(prevL))) split = OPENERS.has(nextWord);
        else if (ABBR_HOLD.has(prevL)) split = false;
        else split = true;
      }
      if (split) {
        const s = t.slice(start, end).trim();
        if (s) out.push(s);
        start = end;
      }
    }
    const tail = t.slice(start).trim();
    if (tail) out.push(tail);
  }

  function sentences(text) {
    const out = [];
    if (!text) return out;
    const blocks = String(text).replace(/\r\n?/g, "\n").split(/\n[ \t]*\n+/);
    for (const block of blocks) {
      // A short line with no end punctuation is a heading or list item: keep it apart.
      const lines = block.split("\n");
      let buf = "";
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].replace(/\s+/g, " ").trim();
        if (!line) continue;
        buf = buf ? buf + " " + line : line;
        const nextLine = (lines[i + 1] || "").trim();
        const shortNoEnd = !/[.!?…:;,。！？"”’)]$/.test(line) && wordCount(line) <= 12;
        if (nextLine && shortNoEnd && /^[\p{Lu}\p{N}\u2022*\-\u2013]/u.test(nextLine)) {
          splitBlock(buf, out);
          buf = "";
        }
      }
      if (buf) splitBlock(buf, out);
    }
    return out;
  }

  // ---------- Document statistics ----------

  function chunksOf(text) {
    const paras = String(text || "").replace(/\r\n?/g, "\n").split(/\n[ \t]*\n+/).map(p => p.trim()).filter(Boolean);
    if (paras.length >= 4) return paras;
    const sents = sentences(text);
    const out = [];
    for (let i = 0; i < sents.length; i += 4) out.push(sents.slice(i, i + 4).join(" "));
    return out.length ? out : [String(text || "")];
  }

  function docStats(fullText) {
    const tf = Object.create(null);
    const df = Object.create(null);
    const forms = Object.create(null);
    const chunks = chunksOf(fullText);
    let total = 0;
    for (const chunk of chunks) {
      const seen = new Set();
      for (const t of tokens(chunk)) {
        if (!isContent(t.w)) continue;
        const k = termKey(t.w);
        tf[k] = (tf[k] || 0) + 1;
        total += 1;
        if (!seen.has(k)) { seen.add(k); df[k] = (df[k] || 0) + 1; }
        if (!forms[k]) forms[k] = t.w;
      }
    }
    let maxW = 0;
    const stats = { schema: 1, chunks: chunks.length, total, tf, df, forms, maxW: 1 };
    for (const k in tf) maxW = Math.max(maxW, rawWeight(k, stats));
    stats.maxW = maxW || 1;
    return stats;
  }

  // Topical and specific: frequent in the document, not spread evenly through every chunk.
  function rawWeight(k, stats) {
    const tf = stats.tf[k] || 0;
    const df = stats.df[k] || 0;
    const n = stats.chunks || 1;
    const idf = Math.log((n + 1) / (df + 0.5)) + 0.3;
    return Math.max(0, idf) * (0.6 + Math.log1p(tf));
  }
  function weight(k, stats) {
    if (!stats || !stats.tf) return 0.5;
    if (!(k in stats.tf)) return 0.45; // unseen term: treat as moderately specific
    return Math.min(1, rawWeight(k, stats) / stats.maxW);
  }

  // ---------- Key sentences ----------

  const DEF_RE = /\b(is|are|was|were)\s+(a|an|the|defined|known|called|described)\b|\b(is|are)\s+called\b|\bmeans?\b|\brefers?\s+to\b|\bdefined\s+as\b|\bknown\s+as\b|\bconsists?\s+of\b/i;
  const CAUSE_RE = /\bbecause\b|\blead(s)?\s+to\b|\bresult(s|ed)?\s+in\b|\bcause(s|d)?\b|\btherefore\b|\bso\s+that\b|\bdue\s+to\b|\bin\s+order\s+to\b|\bthus\b|\bwhich\s+(leads|causes|means)\b/i;
  const VAGUE_START_RE = /^(this|that|these|those|it|they|he|she|such|however|but|also|and|so|then|here|there)\b/i;

  function vectorOf(sentence, stats) {
    const v = new Map();
    for (const t of tokens(sentence)) {
      if (!isContent(t.w)) continue;
      const k = termKey(t.w);
      v.set(k, weight(k, stats));
    }
    return v;
  }
  function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (const [k, x] of a) { na += x * x; const y = b.get(k); if (y) dot += x * y; }
    for (const y of b.values()) nb += y * y;
    return na && nb ? dot / Math.sqrt(na * nb) : 0;
  }

  function hasNamedEntity(sentence) {
    const toks = tokens(sentence);
    for (let i = 1; i < toks.length; i++) {
      const w = toks[i].w;
      if (isAcronym(w) || (isCapitalized(w) && !isStop(w))) return true;
    }
    return false;
  }

  function scoreSentences(text, stats) {
    const all = sentences(text);
    const items = [];
    for (let i = 0; i < all.length; i++) {
      const wc = wordCount(all[i]);
      if (wc < 8 || wc > 45) continue;
      items.push({ text: all[i], index: i, v: vectorOf(all[i], stats) });
    }
    if (!items.length) return items;
    // Document centroid: every eligible sentence pooled.
    const centroid = new Map();
    for (const it of items) for (const [k, x] of it.v) centroid.set(k, (centroid.get(k) || 0) + x);
    let maxCent = 0;
    for (const it of items) {
      let graph = 0;
      for (const other of items) if (other !== it) graph += cosine(it.v, other.v);
      graph = items.length > 1 ? graph / (items.length - 1) : 0;
      it.cent = 0.5 * graph + 0.5 * cosine(it.v, centroid);
      maxCent = Math.max(maxCent, it.cent);
    }
    const first = items[0].index;
    for (const it of items) {
      const s = it.text;
      let cue = 0;
      if (DEF_RE.test(s)) cue += 0.4;
      if (CAUSE_RE.test(s)) cue += 0.3;
      if (/\p{N}/u.test(s)) cue += 0.15;
      if (hasNamedEntity(s)) cue += 0.15;
      cue = Math.min(1, cue);
      let score = 0.6 * (maxCent ? it.cent / maxCent : 0) + 0.3 * cue + (it.index === first ? 0.1 : 0);
      if (VAGUE_START_RE.test(s)) score -= 0.15;
      if (/\?\s*["'”’)]*$/.test(s)) score -= 0.2;
      it.score = Math.max(0, score);
    }
    return items;
  }

  // Top n sentences by score, without near duplicates, returned in document order.
  function keySentences(text, n, stats) {
    n = n == null ? 3 : n;
    stats = stats || docStats(text);
    const items = scoreSentences(text, stats).sort((a, b) => b.score - a.score);
    const picked = [];
    for (const it of items) {
      if (picked.length >= n) break;
      if (picked.some(p => cosine(p.v, it.v) > 0.5)) continue;
      picked.push(it);
    }
    return picked.sort((a, b) => a.index - b.index)
      .map(it => ({ text: it.text, score: Math.round(it.score * 1000) / 1000, index: it.index }));
  }

  function keyIdeas(text, n) {
    return keySentences(text, n == null ? 3 : n, docStats(text)).map(s => s.text);
  }

  // ---------- Cloze ----------

  const NOUNISH_RE = /(tion|sion|ment|ness|ity|ance|ence|ism|ist|ure|ogy|sis|ics|age|ship|hood|dom|er|or|ant|ent|ide|ate|ine|ium|um)s?$/i;
  const NOT_HEAD_RE = /(ly|ing|ed|ful|ous|ive|able|ible|less|ic|ical)$/i;
  const VERBISH = new Set((
    "is are was were be been being has have had do does did can could will would should may might must shall " +
    "remain remains reduce reduces require requires required provide provides allow allows set sets add adds form forms " +
    "follow follows pass passes keep keeps take takes run runs cover covers leave leaves cause causes face faces " +
    "settle settles matters depend depends leads occur occurs appear appears seem seems become becomes include includes " +
    "involve involves produce produces enters protect protects contain contains indicate indicates suggest suggests " +
    "describe describes create creates helps tend tends vary varies affect affects exceed exceeds maintain maintains " +
    "receive receives apply applies rely relies carry carries comes goes gives makes"
  ).split(/\s+/));

  function hintFor(answer) {
    const words = answer.split(/\s+/).filter(Boolean);
    const pattern = words.map(w => {
      if (isNumber(w)) return w.replace(/\p{N}/gu, "#");
      const chars = Array.from(w);
      return chars[0] + chars.slice(1).map(c => (/[\p{L}\p{N}]/u.test(c) ? "_" : c)).join("");
    }).join(" ");
    const lens = words.map(w => Array.from(w).length).join(" ");
    return pattern + " (" + lens + ")";
  }

  function makeCloze(sentence, stats) {
    const s = String(sentence || "").trim();
    if (!s) return null;
    const cjk = (s.match(CJK_RE) || []).length;
    if (cjk > s.length / 4) return null; // no reliable word boundaries
    const toks = tokens(s);
    if (toks.length < 6) return null;
    stats = stats || docStats(s);
    const keys = toks.map(t => termKey(t.w));
    const contentCount = toks.filter(t => isContent(t.w)).length;
    const cands = [];
    const blocked = new Set();

    function push(i, j, base, kind) {
      const answer = s.slice(toks[i].start, toks[j].end);
      if (/[,;:()]/.test(answer)) return;
      cands.push({ i, j, answer, score: base, kind });
    }

    // Proper nouns and acronyms: capitalized runs, allowing "of" and "and" inside.
    for (let i = 0; i < toks.length; i++) {
      const w = toks[i].w;
      if (!(isCapitalized(w) || isAcronym(w)) || isStop(w)) continue;
      let j = i;
      while (j + 1 < toks.length) {
        const nw = toks[j + 1].w;
        if (isCapitalized(nw) && !isStop(nw)) { j++; continue; }
        if (/^(of|and|for)$/.test(nw) && j + 2 < toks.length && isCapitalized(toks[j + 2].w) && !isStop(toks[j + 2].w)) { j += 2; continue; }
        if (isNumber(nw) && /^(tier|stage|level|phase|title|part|section)$/i.test(toks[j].w)) { j++; continue; }
        break;
      }
      const len = j - i + 1;
      const opener = i === 0 && len === 1 && !isAcronym(w);
      // A lone capitalized first word is usually just a sentence opener: leave it to the phrase pass.
      if (opener) continue;
      for (let x = i; x <= j; x++) blocked.add(x);
      if (len <= 3) {
        const ws = toks.slice(i, j + 1).map(t => t.w).filter(isContent);
        const wsum = ws.reduce((a, x) => a + weight(termKey(x), stats), 0) / Math.max(1, ws.length);
        push(i, j, 0.35 + 0.5 * wsum, "proper");
      } else {
        // Long names: offer any acronym inside, skip the rest.
        for (let x = i; x <= j; x++) if (isAcronym(toks[x].w)) push(x, x, 0.6, "proper");
      }
      i = j;
    }

    // Numbers, with a unit when one follows.
    for (let i = 0; i < toks.length; i++) {
      if (!isNumber(toks[i].w) || blocked.has(i)) continue;
      blocked.add(i);
      let j = i;
      const n1 = toks[i + 1] && toks[i + 1].w.toLowerCase();
      if (n1 && (UNITS.has(n1) || UNITS.has(termKey(n1)))) {
        j = i + 1;
        const n2 = toks[i + 2] && toks[i + 2].w.toLowerCase();
        const n3 = toks[i + 3] && toks[i + 3].w.toLowerCase();
        if (n2 === "per" && n3 && UNITS.has(termKey(n3))) j = i + 3;
        else if ((n1 === "parts") && n2 === "per" && n3) j = i + 3;
      }
      for (let x = i; x <= j; x++) blocked.add(x);
      if (/^(1[5-9]|20)\d\d$/.test(toks[i].w) && j === i) push(i, j, 0.5, "year");
      else push(i, j, j > i ? 0.72 : 0.45, "number");
    }

    // Content runs: noun phrase approximations, 1 to 3 words, scored by term weight.
    const verbAt = x => VERBISH.has(toks[x].w.toLowerCase()) ||
      (x > 0 && MODALS.has(toks[x - 1].w.toLowerCase()) && !/[,;:()]/.test(s.slice(toks[x - 1].end, toks[x].start)));
    let r = 0;
    while (r < toks.length) {
      if (blocked.has(r) || !isContent(toks[r].w) || verbAt(r)) { r++; continue; }
      let e = r;
      while (e + 1 < toks.length && !blocked.has(e + 1) && isContent(toks[e + 1].w) && !verbAt(e + 1)) {
        // Stop the run at punctuation between words.
        if (/[,;:()]/.test(s.slice(toks[e].end, toks[e + 1].start))) break;
        e++;
      }
      for (let i = r; i <= e; i++) {
        for (let j = i; j <= Math.min(e, i + 2); j++) {
          const ws = toks.slice(i, j + 1).map(t => t.w);
          const head = ws[ws.length - 1];
          if (NOT_HEAD_RE.test(head) && !NOUNISH_RE.test(head)) continue;
          if (/ly$/i.test(ws[0])) continue;
          const wts = ws.map(x => weight(termKey(x), stats));
          if (Math.min.apply(null, wts) < 0.25 && ws.length > 1) continue; // every word must earn its place
          let sc = wts.reduce((a, x) => a + x, 0) / wts.length;
          if (ws.length === 2) sc *= 1.08;
          if (ws.length === 3) sc *= 0.95;
          if (NOUNISH_RE.test(head)) sc *= 1.1;
          if (ws.every(x => GENERIC.has(termKey(x)) || GENERIC.has(x.toLowerCase()))) sc *= 0.3;
          else if (GENERIC.has(termKey(head))) sc *= 0.75;
          // Everyday words rank below the text's own technical vocabulary.
          const common = ws.filter(x => COMMON.has(x.toLowerCase()) || COMMON.has(termKey(x))).length / ws.length;
          sc *= 1 - 0.3 * common;
          if (Array.from(head).length >= 9) sc *= 1.08;
          // Recurring in the document means the reader has met it more than once.
          const recur = ws.reduce((a, x) => a + ((stats.tf && stats.tf[termKey(x)]) || 0), 0) / ws.length;
          if (stats.tf && recur < 2) sc *= 0.85;
          // Blanking the front of a compound leaves its head behind ("maximum _____ level").
          if (j < e) sc *= 0.6;
          push(i, j, sc, "phrase");
        }
      }
      r = e + 1;
    }

    let best = null;
    for (const c of cands) {
      let sc = c.score;
      const words = c.j - c.i + 1;
      // Numbers keep a compound unit ("4.0 milligrams per liter"); everything else is 1 to 3 words.
      if (words > (c.kind === "number" ? 4 : 3)) continue;
      if (isStop(toks[c.i].w) || isStop(toks[c.j].w)) continue;
      if (c.answer.replace(/[^\p{L}\p{N}]/gu, "").length < 2) continue;
      // The term a sentence defines is the best thing to recall.
      const before = s.slice(0, toks[c.i].start).toLowerCase();
      const after = s.slice(toks[c.j].end).toLowerCase();
      const named = /\b(called|known as|defined as|termed|referred to as|named)\s+(the\s+|a\s+|an\s+)?["'“‘]?$/.test(before);
      const defines = /^(,\s*which)?\s+(is|are)\s+(a|an|the|defined)\b|^\s+(means|refers to)\b/.test(after);
      if (named) sc *= 1.6;
      if (defines) sc *= 1.5;
      if (c.i === 0 && !defines) sc *= 0.5;
      // The answer must not be given away elsewhere in the sentence.
      const own = new Set(keys.slice(c.i, c.j + 1).filter((k, x) => isContent(toks[c.i + x].w)));
      for (let x = 0; x < toks.length; x++) {
        if (x >= c.i && x <= c.j) continue;
        if (own.has(keys[x])) { sc *= 0.35; break; }
      }
      // Leave enough of the sentence to recall from.
      const answerContent = toks.slice(c.i, c.j + 1)
        .filter(t => isContent(t.w) && !(c.kind === "number" && UNITS.has(termKey(t.w)))).length;
      if (contentCount - answerContent < 4) sc *= 0.4;
      if (!best || sc > best.sc) best = { c, sc };
    }
    if (!best || best.sc < 0.3) return null;
    const c = best.c;
    const prompt = s.slice(0, toks[c.i].start) + "_____" + s.slice(toks[c.j].end);
    return { prompt, answer: c.answer, hint: hintFor(c.answer), context: s };
  }

  // ---------- Reading checkpoint ----------

  function checkpoint(sectionText, stats, opts) {
    opts = opts || {};
    const max = opts.max == null ? 2 : Math.max(0, opts.max);
    const seen = opts.seen instanceof Set ? opts.seen : new Set();
    const now = typeof opts.now === "number" ? opts.now : Date.now();
    const source = opts.source || {};
    if (!max) return [];
    stats = stats || docStats(sectionText);
    const keys = keySentences(sectionText, Math.max(4, max * 2), stats);
    if (!keys.length) return [];
    const byScore = keys.slice().sort((a, b) => b.score - a.score);
    const gistSent = byScore[0];
    const wantGist = opts.gist !== false && max >= 2;
    const clozeSlots = wantGist ? max - 1 : max;
    const cards = [];
    // Prefer cloze sentences other than the gist's model answer.
    const order = byScore.slice(1).concat(byScore.slice(0, 1));
    for (const ks of order) {
      if (cards.length >= clozeSlots) break;
      const cz = makeCloze(ks.text, stats);
      if (!cz) continue;
      const k = normalize(cz.answer);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      cards.push(newCard({ type: "cloze", prompt: cz.prompt, answer: cz.answer, hint: cz.hint, context: ks.text, source }, now));
    }
    if (wantGist || !cards.length) {
      const gk = "gist:" + normalize(gistSent.text);
      if (!seen.has(gk) && cards.length < max) {
        seen.add(gk);
        cards.push(newCard({
          type: "gist", prompt: "In one line, what was this part about?",
          answer: gistSent.text, hint: "", context: gistSent.text, source
        }, now));
      }
    }
    return cards;
  }

  // ---------- Optional on-device AI (Chrome built-in) ----------

  function host() { return typeof self !== "undefined" ? self : globalThis; }

  async function availability(api) {
    try {
      if (!api || typeof api.availability !== "function") return false;
      return (await api.availability()) === "available";
    } catch (e) {
      return false;
    }
  }

  const MAX_AI_CHARS = 12000;

  const ai = {
    async available() {
      const h = host();
      let summarizer = false, prompt = false;
      try { summarizer = await availability(h.Summarizer); } catch (e) { summarizer = false; }
      try { prompt = await availability(h.LanguageModel); } catch (e) { prompt = false; }
      return { summarizer, prompt };
    },

    async keyIdeas(text, n) {
      let sm = null;
      try {
        const S = host().Summarizer;
        if (!(await availability(S))) return null;
        sm = await S.create({ type: "key-points", format: "plain-text", length: "short", outputLanguage: "en" });
        const out = await sm.summarize(String(text || "").slice(0, MAX_AI_CHARS));
        const lines = String(out || "").split(/\n+/)
          .map(l => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
          .filter(Boolean);
        return lines.length ? lines.slice(0, n == null ? 3 : n) : null;
      } catch (e) {
        return null;
      } finally {
        try { if (sm && sm.destroy) sm.destroy(); } catch (e) { /* ignore */ }
      }
    },

    async questions(text, n) {
      let session = null;
      n = n == null ? 3 : n;
      try {
        const LM = host().LanguageModel;
        if (!(await availability(LM))) return null;
        const src = String(text || "").slice(0, MAX_AI_CHARS);
        const schema = {
          type: "array",
          maxItems: n,
          items: {
            type: "object",
            properties: { q: { type: "string" }, a: { type: "string" } },
            required: ["q", "a"],
            additionalProperties: false
          }
        };
        session = await LM.create({
          initialPrompts: [{
            role: "system",
            content: "You write short-answer study questions grounded only in the text the user gives. " +
              "Each answer must be a short phrase copied from the text, at most 6 words. Do not use outside knowledge."
          }]
        });
        const raw = await session.prompt(
          "Write " + n + " questions about this text. Return JSON only.\n\nTEXT:\n" + src,
          { responseConstraint: schema }
        );
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return null;
        const vocab = new Set(tokens(src).map(t => termKey(t.w)));
        const srcNorm = normalize(src);
        const out = [];
        for (const item of parsed) {
          if (!item || typeof item.q !== "string" || typeof item.a !== "string") continue;
          const q = item.q.trim(), a = item.a.trim();
          if (!q || !a || wordCount(a) > 12) continue;
          const content = tokens(a).filter(t => isContent(t.w) || isNumber(t.w));
          const grounded = content.length
            ? content.every(t => vocab.has(termKey(t.w)))
            : srcNorm.indexOf(normalize(a)) >= 0;
          if (grounded) out.push({ q, a });
          if (out.length >= n) break;
        }
        return out.length ? out : null;
      } catch (e) {
        return null;
      } finally {
        try { if (session && session.destroy) session.destroy(); } catch (e) { /* ignore */ }
      }
    }
  };

  // ---------- Storage ----------

  function area() {
    try {
      const c = globalThis.chrome;
      return c && c.storage && c.storage.local ? c.storage.local : null;
    } catch (e) {
      return null;
    }
  }

  function dedupeKey(card) { return normalize(card.prompt) + "|" + normalize(card.answer); }
  // Near duplicates: the same answer with a prompt that shares most of its words (the same
  // passage saved twice from a page and from the Reader), or the same quoted passage.
  function wordSet(t) { return new Set(normalize(t).split(" ").filter(w => w && w !== "_____")); }
  function nearDuplicate(a, b) {
    if (normalize(a.answer) !== normalize(b.answer) || !normalize(a.answer)) return false;
    if (a.type === "quote" && b.type === "quote") return true;
    const x = wordSet(a.prompt), y = wordSet(b.prompt);
    if (!x.size || !y.size) return false;
    let both = 0;
    for (const w of x) if (y.has(w)) both++;
    return both / (x.size + y.size - both) >= 0.8;
  }

  function cap(cards) {
    if (cards.length <= CAP) return cards;
    const extra = cards.length - CAP;
    const drop = new Set(
      cards.slice().sort((a, b) => ((b.tier === MAX_TIER) - (a.tier === MAX_TIER)) || (a.created - b.created))
        .slice(0, extra).map(c => c.id)
    );
    return cards.filter(c => !drop.has(c.id));
  }

  async function read() {
    const a = area();
    if (!a) return [];
    const got = await a.get(STORE_KEY);
    const v = got && got[STORE_KEY];
    if (!v || !Array.isArray(v.cards)) return [];
    return v.cards.filter(c => c && c.id);
  }
  async function write(cards) {
    const a = area();
    if (!a) return cards;
    const kept = cap(cards);
    await a.set({ [STORE_KEY]: { schema: STORE_SCHEMA, cards: kept } });
    return kept;
  }

  // One chain for every read and write, so concurrent calls never lose an update.
  let chain = Promise.resolve();
  function queue(fn) {
    const p = chain.then(fn);
    chain = p.catch(() => {});
    return p;
  }

  function load() { return queue(read); }
  function save(cards) { return queue(() => write(Array.isArray(cards) ? cards : [])); }
  function addMany(newCards) {
    return queue(async () => {
      const cards = await read();
      const keys = new Set(cards.map(dedupeKey));
      const added = [];
      const byAnswer = new Map();
      for (const c of cards) { const n = normalize(c.answer); if (!byAnswer.has(n)) byAnswer.set(n, []); byAnswer.get(n).push(c); }
      for (const c of newCards || []) {
        const k = dedupeKey(c);
        if (keys.has(k)) continue;
        const same = byAnswer.get(normalize(c.answer)) || [];
        if (same.some(o => nearDuplicate(o, c))) continue;
        same.push(c);
        byAnswer.set(normalize(c.answer), same);
        keys.add(k);
        cards.push(c);
        added.push(c);
      }
      if (added.length) await write(cards);
      return added;
    });
  }
  function add(card) { return addMany([card]).then(list => list[0] || null); }
  function update(card) {
    return queue(async () => {
      const cards = await read();
      const i = cards.findIndex(c => c.id === card.id);
      if (i < 0) return null;
      cards[i] = card;
      await write(cards);
      return card;
    });
  }
  function remove(id) {
    return queue(async () => {
      const cards = await read();
      const kept = cards.filter(c => c.id !== id);
      if (kept.length === cards.length) return false;
      await write(kept);
      return true;
    });
  }

  globalThis.PolycarpMemory = {
    STORE_KEY, STORE_SCHEMA, CAP, DAY, TIERS, TYPES,
    LEECH, tierInfo, intervalMs, newCard, grade, due, counts, nextDue, nearDuplicate,
    sentences, keySentences, docStats, makeCloze, checkpoint, keyIdeas, normalize, wordCount,
    ai,
    load, save, add, addMany, update, remove
  };
})();
