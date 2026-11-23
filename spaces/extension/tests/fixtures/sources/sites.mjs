// Mock sites for tests/sources.spec.mjs. Each export builds a request handler for one
// origin. Handlers log every request with its start and end time so the spec can check
// crawl politeness.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fx = (f) => fs.readFileSync(path.join(HERE, f));

const page = (title, body, head = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

// ---------------------------------------------------------------------------
// API mocks for the built-in sources
// ---------------------------------------------------------------------------
export function apiSite() {
  return (req, res, url) => {
    const p = url.pathname;
    if (p === '/yt/results') return send(res, 200, 'text/html; charset=utf-8', fx('youtube.html'));
    if (p === '/wiki') return send(res, 200, 'application/json', fx('wikipedia.json'));
    if (p === '/gut') return send(res, 200, 'application/json', fx('gutenberg.json'));
    if (p === '/ol') return send(res, 200, 'application/json', fx('openlibrary.json'));
    if (p === '/ia') return send(res, 200, 'application/json', fx('archive.json'));
    if (p === '/arxiv') return send(res, 200, 'application/atom+xml; charset=utf-8', fx('arxiv.xml'));
    if (p === '/oa') return send(res, 200, 'application/json', fx('openalex.json'));
    if (p === '/lv') {
      const title = url.searchParams.get('title') || '';
      const author = url.searchParams.get('author') || '';
      if (/^\^moby/i.test(title) || /^melville$/i.test(author)) return send(res, 200, 'application/json', fx('librivox.json'));
      return send(res, 404, 'application/json', '{"error":"Audiobooks could not be found"}');
    }
    if (p === '/slow') return; // never answers
    if (p === '/err500') return send(res, 500, 'text/plain', 'boom');
    if (p === '/garbage') return send(res, 200, 'application/json', 'this is not json');
    send(res, 404, 'text/plain', 'not found');
  };
}

// ---------------------------------------------------------------------------
// Feeds, OpenSearch, OPDS and search pages
// ---------------------------------------------------------------------------
const rssItems = [
  ['The whale road', 'Notes on the whale road and the sea lanes of the north.', 'Ishmael Grey', '2024-03-01'],
  ['Lighthouse lamps', 'How lighthouse lamps changed from oil to electric light.', 'Ada Keeper', '2024-02-11'],
  ['Harbor maps', 'Old harbor maps and the people who drew them.', 'Ada Keeper', '2023-12-24'],
];

function rss(base, items, title = 'Sea Notes') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:media="http://search.yahoo.com/mrss/">
<channel><title>${title}</title><link>${base}/blog/</link><description>A small sea blog</description>
<image><url>${base}/img/logo.png</url><title>${title}</title><link>${base}/blog/</link></image>
${items.map(([t, d, a, date, n], i) => (i = (n || i + 1) - 1, `<item><title>${t}</title><link>${base}/blog/post-${i + 1}</link><guid>${base}/blog/post-${i + 1}</guid>
<description><![CDATA[<p>${d}</p>]]></description><content:encoded><![CDATA[<p>${d}</p><p>Full text of post ${i + 1} about ${t.toLowerCase()} and more.</p><img src="/img/p${i + 1}.jpg">]]></content:encoded>
<dc:creator>${a}</dc:creator><pubDate>${new Date(date).toUTCString()}</pubDate>${i === 0 ? `<enclosure url="${base}/audio/ep1.mp3" type="audio/mpeg" length="100"/>` : ''}</item>`)).join('\n')}
</channel></rss>`;
}

function atom(base, pageNo) {
  const entries = pageNo === 1
    ? [['Tide tables explained', 'Reading tide tables without tears.', 'Nell Harbor'], ['Knots for sailors', 'The bowline, the clove hitch and friends.', 'Nell Harbor']]
    : [['Old charts of the coast', 'A look at coastal charts from 1850.', 'Tom Reef']];
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Harbor Log</title><id>urn:harbor</id><icon>${base}/img/harbor.png</icon>
<link rel="self" href="${base}/feed.atom${pageNo > 1 ? '?page=' + pageNo : ''}"/>${pageNo === 1 ? `<link rel="next" href="${base}/feed.atom?page=2"/>` : ''}
<updated>2024-01-01T00:00:00Z</updated>
${entries.map(([t, s, a], i) => `<entry><title>${t}</title><id>urn:harbor:${pageNo}-${i}</id><link rel="alternate" type="text/html" href="${base}/log/${pageNo}-${i}"/>
<updated>2024-0${pageNo}-0${i + 1}T00:00:00Z</updated><author><name>${a}</name></author><summary>${s}</summary>
<content type="html">&lt;p&gt;${s} Longer body for ${t.toLowerCase()}.&lt;/p&gt;</content></entry>`).join('\n')}
</feed>`;
}

const jsonFeed = (base) => JSON.stringify({
  version: 'https://jsonfeed.org/version/1.1', title: 'Quiet Pages', home_page_url: base + '/', feed_url: base + '/feed.json', icon: base + '/img/q.png',
  items: [
    { id: 'q1', url: base + '/q/1', title: 'Reading slowly', content_html: '<p>Why reading slowly helps memory.</p>', date_published: '2022-05-01T00:00:00Z', authors: [{ name: 'May Page' }] },
    { id: 'q2', url: base + '/q/2', title: 'Margins and notes', content_text: 'Writing in the margins of a book.', date_published: '2021-01-01T00:00:00Z' },
  ],
});

// OPDS 1.2: a navigation root, a paged acquisition feed and an author feed.
const opdsHead = (base, self, kind, title, extra = '') => `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/terms/" xmlns:opds="http://opds-spec.org/2010/catalog">
<id>urn:opds:${self}</id><title>${title}</title><updated>2024-01-01T00:00:00Z</updated>
<link rel="self" href="${base}${self}" type="application/atom+xml;profile=opds-catalog;kind=${kind}"/>
<link rel="start" href="${base}/opds/" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>${extra}`;

const book = (base, id, title, author, year, summary) => `<entry><title>${title}</title><id>urn:book:${id}</id><updated>2024-01-01T00:00:00Z</updated>
<author><name>${author}</name></author><dc:issued>${year}</dc:issued><summary>${summary}</summary>
<link rel="http://opds-spec.org/image" href="${base}/covers/${id}.jpg" type="image/jpeg"/>
<link rel="http://opds-spec.org/image/thumbnail" href="${base}/covers/${id}-t.jpg" type="image/jpeg"/>
<link rel="http://opds-spec.org/acquisition" href="${base}/get/${id}.epub" type="application/epub+zip"/>
<link rel="http://opds-spec.org/acquisition" href="${base}/get/${id}.pdf" type="application/pdf"/>
<link rel="alternate" href="${base}/book/${id}" type="text/html"/></entry>`;

function opds(base, p, search) {
  if (p === '/opds/') {
    return opdsHead(base, '/opds/', 'navigation', 'Home Library') + `
<entry><title>New books</title><id>urn:nav:new</id><updated>2024-01-01T00:00:00Z</updated><content type="text">Recently added</content>
<link rel="subsection" href="${base}/opds/new" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/></entry>
<entry><title>Authors</title><id>urn:nav:authors</id><updated>2024-01-01T00:00:00Z</updated>
<link rel="subsection" href="${base}/opds/authors" type="application/atom+xml;profile=opds-catalog;kind=navigation"/></entry>
<entry><title>Elsewhere</title><id>urn:nav:else</id><updated>2024-01-01T00:00:00Z</updated>
<link rel="subsection" href="http://elsewhere.invalid/opds" type="application/atom+xml;profile=opds-catalog;kind=navigation"/></entry>
</feed>`;
  }
  if (p === '/opds/new') {
    if (search.get('page') === '2') {
      return opdsHead(base, '/opds/new?page=2', 'acquisition', 'New books, page 2') + book(base, 'b4', 'Typee', 'Herman Melville', '1846', 'A Polynesian adventure.') +
        book(base, 'b5', 'The Sea-Wolf', 'Jack London', '1904', 'A brutal captain and a castaway critic.') + '</feed>';
    }
    return opdsHead(base, '/opds/new', 'acquisition', 'New books', `<link rel="next" href="${base}/opds/new?page=2" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>`) +
      book(base, 'b1', 'Moby-Dick', 'Herman Melville', '1851', 'The white whale and the captain who hunts it.') +
      book(base, 'b2', 'Treasure Island', 'Robert Louis Stevenson', '1883', 'Pirates, maps and buried gold.') +
      book(base, 'b3', 'Captains Courageous', 'Rudyard Kipling', '1897', 'A rich boy learns the fishing trade.') + '</feed>';
  }
  if (p === '/opds/authors') {
    return opdsHead(base, '/opds/authors', 'navigation', 'Authors') + `
<entry><title>Herman Melville</title><id>urn:author:melville</id><updated>2024-01-01T00:00:00Z</updated>
<link rel="subsection" href="${base}/opds/author/melville" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/></entry></feed>`;
  }
  if (p === '/opds/author/melville') {
    return opdsHead(base, '/opds/author/melville', 'acquisition', 'Herman Melville') + book(base, 'b1', 'Moby-Dick', 'Herman Melville', '1851', 'The white whale and the captain who hunts it.') +
      book(base, 'b6', 'Bartleby, the Scrivener', 'Herman Melville', '1853', 'A clerk who would prefer not to.') + '</feed>';
  }
  return null;
}

const resultsPage = (base, q) => page(`Results for ${q}`, `
<header><a href="/">Home of the sea archive</a><nav><a href="/about-the-archive">About the sea archive</a><a href="/contact-the-team">Contact the archive team</a></nav></header>
<div class="layout">
  <aside><h3>Filters</h3><a href="/filter/by-date-range">Filter results by date range</a><a href="/filter/by-author-name">Filter results by author name</a></aside>
  <div class="content">
    <p class="count">5 results for <b>${q}</b></p>
    <ol class="results">
      ${[1, 2, 3, 4, 5].map((i) => `<li class="result ${i === 1 ? 'first' : ''}"><h3><a href="/doc/${i}">Result number ${i} about ${q} and ships</a></h3>
        <p>Snippet ${i}: a passage that mentions ${q} in passing, with enough words to be useful.</p><a href="/doc/${i}#more">Read more</a><a href="/doc/${i}">Result number ${i} about ${q} and ships</a></li>`).join('\n')}
    </ol>
    <div class="pager"><a href="?q=${q}&page=2">Next page</a><a href="?q=${q}&page=3">Page 3</a></div>
    <a href="https://other.example/elsewhere-on-the-web">A link to another site entirely</a>
  </div>
</div>
<footer><a href="/privacy-policy-page">Privacy policy for this archive</a><a href="/terms-of-service">Terms of service for this archive</a></footer>`);

export function feedSite() {
  return (req, res, url) => {
    const base = url.origin;
    const p = url.pathname;
    const q = url.searchParams.get('q') || '';
    if (p === '/feed.rss') return send(res, 200, 'application/rss+xml; charset=utf-8', rss(base, rssItems));
    if (p === '/feed.atom') return send(res, 200, 'application/atom+xml; charset=utf-8', atom(base, url.searchParams.get('page') === '2' ? 2 : 1));
    if (p === '/feed.json') return send(res, 200, 'application/feed+json', jsonFeed(base));
    if (p === '/blog/') return send(res, 200, 'text/html', page('Sea Notes blog', '<main><h1>Sea Notes</h1><p>Posts about the sea.</p></main>',
      `<link rel="alternate" type="application/rss+xml" title="Sea Notes" href="/feed.rss"><link rel="icon" href="/img/fav.png">`));
    if (p === '/osd/') return send(res, 200, 'text/html', page('Sea Archive', '<main><p>Search the sea archive.</p></main>',
      `<link rel="search" type="application/opensearchdescription+xml" title="Sea Archive" href="/osd/opensearch.xml"><meta property="og:site_name" content="Sea Archive">`));
    if (p === '/osd/opensearch.xml') return send(res, 200, 'application/opensearchdescription+xml', `<?xml version="1.0"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/"><ShortName>Sea Archive</ShortName><Description>Sea archive search</Description>
<Image height="16" width="16" type="image/png">${base}/img/sea.png</Image>
<Url type="text/html" template="${base}/osd/find?q={searchTerms}"/>
<Url type="application/x-suggestions+json" template="${base}/osd/suggest?q={searchTerms}"/>
<Url type="application/rss+xml" template="/osd/search?q={searchTerms}&amp;count={count?}&amp;start={startIndex}&amp;format=rss"/>
</OpenSearchDescription>`);
    if (p === '/osd/search') {
      const hits = rssItems.map((it, i) => [...it, i + 1]).filter(([t, d]) => (t + ' ' + d).toLowerCase().includes(q.toLowerCase()));
      return send(res, 200, 'application/rss+xml', rss(base, hits, 'Sea Archive results'));
    }
    if (p === '/htmlsearch/') return send(res, 200, 'text/html', page('Find', '<p>Find things</p>',
      `<link rel="search" type="application/opensearchdescription+xml" href="/htmlsearch/osd.xml">`));
    if (p === '/htmlsearch/osd.xml') return send(res, 200, 'application/xml', `<?xml version="1.0"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/"><ShortName>Find It</ShortName>
<Url type="text/html" method="get" template="${base}/tsearch?q={searchTerms}"/></OpenSearchDescription>`);
    if (p === '/tsearch') return send(res, 200, 'text/html; charset=utf-8', resultsPage(base, q));
    if (p === '/jsearch') return send(res, 200, 'application/json', JSON.stringify({ meta: { total: 2 }, data: { hits: [
      { id: 'j1', title: `JSON hit about ${q}`, url: '/j/1', summary: '<b>Bold</b> summary text' },
      { id: 'j2', name: `Second JSON hit for ${q}`, link: base + '/j/2', description: 'Plain description' },
    ] } }));
    if (p === '/opds/' || p.startsWith('/opds/')) {
      const body = opds(base, p, url.searchParams);
      if (body) return send(res, 200, p === '/opds/' ? 'application/atom+xml;profile=opds-catalog;kind=navigation' : 'application/atom+xml;profile=opds-catalog;kind=acquisition', body);
    }
    if (p === '/opds-plain.xml') return send(res, 200, 'application/xml', opds(base, '/opds/', url.searchParams));
    if (p === '/books/') return send(res, 200, 'text/html', page('My Calibre', '<p>Books</p>',
      `<link rel="alternate" type="application/atom+xml;profile=opds-catalog;kind=navigation" href="/opds/" title="OPDS catalog"><link rel="alternate" type="application/rss+xml" href="/feed.rss">`));
    send(res, 404, 'text/plain', 'not found');
  };
}

// ---------------------------------------------------------------------------
// A site with robots.txt naming a sitemap index
// ---------------------------------------------------------------------------
export function sitemapSite() {
  const docs = ['one', 'two', 'three', 'four', 'five'];
  return (req, res, url) => {
    const base = url.origin;
    const p = url.pathname;
    if (p === '/robots.txt') return send(res, 200, 'text/plain', `User-agent: *\nDisallow: /docs/hidden\n\nSitemap: ${base}/sitemap_index.xml\n`);
    if (p === '/sitemap_index.xml') return send(res, 200, 'application/xml', `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${base}/sitemap-docs.xml</loc></sitemap><sitemap><loc>${base}/sitemap-blog.xml</loc></sitemap></sitemapindex>`);
    if (p === '/sitemap-docs.xml') return send(res, 200, 'application/xml', `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${docs.map((d) => `<url><loc>${base}/docs/${d}</loc></url>`).join('')}<url><loc>${base}/docs/hidden/x</loc></url><url><loc>${base}/blog/post</loc></url></urlset>`);
    if (p === '/sitemap-blog.xml') return send(res, 200, 'application/xml', `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${base}/blog/a</loc></url><url><loc>${base}/blog/b</loc></url></urlset>`);
    if (p === '/docs/') return send(res, 200, 'text/html', page('Docs home', '<main><h1>Docs</h1><p>The docs home page.</p></main>'));
    const m = /^\/docs\/(\w+)$/.exec(p);
    if (m && docs.includes(m[1])) return send(res, 200, 'text/html', page(`Doc ${m[1]}`, `<main><h1>Doc ${m[1]}</h1><p>Doc page ${m[1]} talks about ${m[1] === 'three' ? 'barnacles and hull cleaning' : 'general topics'}.</p></main>`));
    if (p.startsWith('/blog/') || p.startsWith('/docs/hidden')) return send(res, 200, 'text/html', page('Should not be read', '<p>Out of scope</p>'));
    send(res, 404, 'text/plain', 'not found');
  };
}

// ---------------------------------------------------------------------------
// A plain site to crawl: nav links, a disallowed path, a noindex page, many pages
// ---------------------------------------------------------------------------
export function crawlSite() {
  const nav = '<header><nav>NAVTEXT <a href="/">Home</a> <a href="/about">About</a> <a href="/docs/a">A</a> <a href="/docs/b">B</a></nav></header>';
  const foot = '<footer>FOOTTEXT <a href="/legal">Legal</a></footer>';
  return (req, res, url) => {
    const p = url.pathname;
    if (p === '/robots.txt') return send(res, 200, 'text/plain', 'User-agent: badbot\nDisallow: /\n\nUser-agent: *\nDisallow: /docs/private/\nAllow: /docs/private/open.html\n');
    if (p === '/docs/' || p === '/docs') {
      const gen = Array.from({ length: 30 }, (_, i) => `<li><a href="/docs/gen/${i + 1}">Generated ${i + 1}</a></li>`).join('');
      return send(res, 200, 'text/html', page('Handbook', `${nav}<main><h1>Handbook</h1><p>Welcome to the handbook.</p><ul>
        <li><a href="/docs/a#top">A again</a></li><li><a href="/docs/b?utm_source=x">B again</a></li><li><a href="/docs/private/secret">Secret</a></li>
        <li><a href="/docs/private/open.html">Open</a></li><li><a href="/docs/manual.pdf">PDF</a></li><li><a href="/other/x">Other</a></li>
        <li><a href="http://elsewhere.invalid/docs/x">Elsewhere</a></li><li><a href="mailto:a@b.c">Mail</a></li>${gen}</ul></main>${foot}`));
    }
    if (p === '/docs/a') return send(res, 200, 'text/html', page('Lighthouse keepers', `${nav}<aside>ASIDETEXT</aside><main><article><h1>Lighthouse keepers</h1>
      <img src="/img/lamp.jpg" alt=""><p>The lighthouse keepers trimmed the wicks every night.</p><p>Second paragraph about fog signals.</p></article></main>${foot}<script>var SCRIPTTEXT = 1;</script>`));
    if (p === '/docs/b') return send(res, 200, 'text/html', page('Not for the index', `<main><p>Hidden from search engines.</p><a href="/docs/c">C</a></main>`, '<meta name="robots" content="noindex">'));
    if (p === '/docs/c') return send(res, 200, 'text/html', page('Page C', '<main><p>Page C text.</p></main>'));
    if (p === '/docs/private/open.html') return send(res, 200, 'text/html', page('Open private page', '<main><p>Explicitly allowed by robots.</p></main>'));
    const g = /^\/docs\/gen\/(\d+)$/.exec(p);
    if (g) return send(res, 200, 'text/html', page(`Generated ${g[1]}`, `<main><p>Generated page ${g[1]} filler text.</p></main>`));
    if (p === '/docs/manual.pdf') return send(res, 200, 'application/pdf', '%PDF-1.4');
    if (p.startsWith('/docs/private/') || p === '/about' || p === '/' || p.startsWith('/other')) return send(res, 200, 'text/html', page('Out of scope', '<p>Out of scope</p>'));
    send(res, 404, 'text/plain', 'not found');
  };
}
