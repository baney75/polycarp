// Site fixtures shared by sites.spec.mjs and contact.mjs: YouTube, X and Audible pages,
// an endless feed and a list page.
export const VID = 'abc123DEF45';
export const YT = `<!doctype html><html><head><meta charset="utf-8"><title>How rivers shape valleys - YouTube</title></head><body style="font-family:Roboto,Arial;margin:0">
<div id="masthead-container" style="height:56px;border-bottom:1px solid #ddd"><input id="search" placeholder="Search"> <span>Home Shorts Subscriptions You</span></div>
<div style="display:flex;gap:24px;padding:24px"><div style="flex:1">
<div id="movie_player" style="background:#000;aspect-ratio:16/9;position:relative"><video class="html5-main-video" style="width:100%;height:100%"></video>
<div class="ytp-chrome-bottom" style="position:absolute;bottom:0;color:#fff"><span class="ytp-time-display">Zero minutes played of eight total minutes</span></div></div>
<ytd-watch-metadata><div id="title"><h1 class="ytd-watch-metadata"><yt-formatted-string>How rivers shape valleys</yt-formatted-string></h1></div>
<div id="owner"><div id="channel-name"><a href="/@geochannel">Geo Channel</a></div></div>
<div id="description-inline-expander"><yt-attributed-string>0:00 Intro<br>1:30 Erosion basics<br>A short film about water and rock, filmed on the Colorado.</yt-attributed-string></div></ytd-watch-metadata>
<div id="comments"><div id="contenteditable-root" contenteditable="true">Draft comment words here</div>
<ytd-comment-thread-renderer><a id="author-text">@sam</a> <span id="published-time-text"><a href="/watch?v=${VID}&lc=c1">2 days ago</a></span><yt-attributed-string id="content-text">Great explanation of oxbow lakes and floodplains for my class.</yt-attributed-string></ytd-comment-thread-renderer>
<ytd-comment-thread-renderer><a id="author-text">@lee</a> <span id="published-time-text"><a href="/watch?v=${VID}&lc=c2">1 day ago</a></span><yt-attributed-string id="content-text">The drone shots of the canyon walls were beautiful.</yt-attributed-string></ytd-comment-thread-renderer></div>
</div><div id="panels" style="width:360px">
<ytd-transcript-segment-renderer><div class="segment-timestamp">0:05</div><yt-formatted-string class="segment-text">Rivers carve valleys over thousands of years.</yt-formatted-string></ytd-transcript-segment-renderer>
<ytd-transcript-segment-renderer><div class="segment-timestamp">0:48</div><yt-formatted-string class="segment-text">Fast water lifts sand and stones off the bed.</yt-formatted-string></ytd-transcript-segment-renderer>
<ytd-transcript-segment-renderer><div class="segment-timestamp">1:42</div><yt-formatted-string class="segment-text">On flat ground the river starts to meander in wide loops.</yt-formatted-string></ytd-transcript-segment-renderer>
<ytd-transcript-segment-renderer><div class="segment-timestamp">2:30</div><yt-formatted-string class="segment-text">A loop cut off from the river becomes an oxbow lake.</yt-formatted-string></ytd-transcript-segment-renderer>
</div></div>
<script>window.kHits = 0; document.addEventListener('keydown', (e) => { if (e.key === 'k') window.kHits++; });</script>
</body></html>`;

const post = (id, name, handle, text, extra = '') => `<article data-testid="tweet" role="article" style="border-bottom:1px solid #eee;padding:12px">
<div data-testid="User-Name"><span>${name}</span> <span>@${handle}</span></div>
<a href="/${handle}/status/${id}"><time datetime="2026-11-0${(id % 9) + 1}T10:00:00.000Z">Nov ${(id % 9) + 1}</time></a>
<div data-testid="tweetText" lang="en">${text}</div>${extra}</article>`;
export const XPAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Alice on X: "Tidal energy storage"</title></head><body style="font-family:system-ui;margin:0;display:flex">
<nav style="width:220px"><a href="/home">Home</a> <a href="/explore">Explore</a> <a href="/notifications">Notifications</a></nav>
<main id="tl" style="width:600px">
${post(111, 'Alice', 'alice', 'Main post about tidal energy storage and why coastal grids need it.')}
${post(112, 'Alice', 'alice', 'Second part of the thread: pumped seawater works at night too.')}
${post(222, 'Bob', 'bob', 'Reply about the turbines rusting in salt water, a real worry.')}
<div data-testid="tweetTextarea_0" contenteditable="true" role="textbox">My reply draft text</div>
</main>
<script>window.kHits = 0; document.addEventListener('keydown', (e) => { if (e.key === 'k') window.kHits++; });
// Like X, drop posts that scroll away and add new ones.
setTimeout(() => { document.querySelector('a[href="/bob/status/222"]').closest('article').remove();
  document.getElementById('tl').insertAdjacentHTML('beforeend', ${JSON.stringify(post(333, 'Cara', 'cara', 'Late post about kelp farms that loads after scrolling.'))}); }, 1500);
</script></body></html>`;

const row = (asin, title, author, narr) => `<div id="adbl-library-content-row-${asin}" class="adbl-library-content-row">
<img src="https://m.media-amazon.com/images/${asin}.jpg" alt=""><span class="bc-size-headline3">${title}</span>
<span class="authorLabel">By: <a href="/author/x">${author}</a></span><span class="narratorLabel">Narrated by: <a href="/n/x">${narr}</a></span>
<span class="bc-text bc-color-secondary runtime">10h 2m left</span></div>`;
export const AUDIBLE = `<!doctype html><html><head><meta charset="utf-8"><title>Library | Audible.com</title></head><body><h1>Library</h1>
${row('B000000001', 'The Hobbit', 'J. R. R. Tolkien', 'Andy Serkis')}
${row('B000000002', 'Mere Christianity', 'C. S. Lewis', 'Geoffrey Howard')}
${row('B000000003', 'The Count of Monte Cristo', 'Alexandre Dumas', 'Bill Homewood')}</body></html>`;

export const FEED = `<!doctype html><html><head><meta charset="utf-8"><title>Endless feed</title></head><body style="font-family:Georgia;max-width:40em;margin:auto">
<div id="feed"></div><x-card id="card"></x-card>
<script>
customElements.define('x-card', class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<p>Inside a shadow root lives a paragraph that should be readable too.</p>'; } });
window.longTasks = [];
new PerformanceObserver((l) => { for (const e of l.getEntries()) window.longTasks.push(e.duration); }).observe({ type: 'longtask', buffered: true });
const feed = document.getElementById('feed'); let n = 0;
window.feedDone = false;
const t = setInterval(() => {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 200; i++, n++) { const p = document.createElement('p'); p.textContent = 'Feed item ' + n + ' tells a short story about rivers, roads and the people who travel them each morning.'; frag.appendChild(p); }
  feed.appendChild(frag);
  while (feed.children.length > 600) feed.firstElementChild.remove();
  if (n >= 10000) { clearInterval(t); window.feedDone = true; }
}, 100);
</script></body></html>`;

export const LIST = `<!doctype html><html><head><meta charset="utf-8"><title>Reading list</title></head><body><header><a href="/">Home</a> <a href="/about">About</a></header><main>
${['Pilgrim Progress', 'Paradise Lost', 'The Confessions', 'Orthodoxy Today', 'The Screwtape Letters', 'Brothers Karamazov'].map((t, i) =>
  `<div class="card"><a href="https://books.example/b${i}">${t}</a><p>A classic worth reading slowly, number ${i + 1}.</p></div>`).join('\n')}
</main></body></html>`;

