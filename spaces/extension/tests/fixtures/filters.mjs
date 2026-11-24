// Feed fixtures for filters.spec.mjs: X, YouTube with Shorts, new and old Reddit, and Mastodon with a boosted post.
// Each mirrors the site's own hooks (data-testid, element names, classes) as of 2026-11.
const page = (title, body, script = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:system-ui;margin:0">${body}<script>${script}</script></body></html>`;

// X wraps each post in a list cell.
export const tweet = (handle, text, extra = '') => `<div data-testid="cellInnerDiv"><article data-testid="tweet" role="article" style="padding:12px;border-bottom:1px solid #ddd">${extra}
<div data-testid="UserAvatar-Container-${handle}"></div>
<div data-testid="User-Name"><a href="/${handle}"><span>${handle}</span></a> <a href="/${handle}/status/1"><time datetime="2026-11-20T10:00:00Z">1h</time></a></div>
<div data-testid="tweetText" lang="en">${text}</div></article></div>`;
export const XFEED = page('Home / X', `<div style="display:flex"><main style="width:600px"><div id="tl" aria-label="Timeline">
${tweet('alice', 'Bitcoin and CRYPTO news for the week')}
${tweet('bob', 'A quiet walk by the river this morning')}
${tweet('spammer', 'Buy my course now')}
${tweet('carol', 'My gardening notes for November')}
${tweet('dan', 'Big sale this weekend', '<div data-testid="socialContext">Eve reposted</div>')}
${tweet('shop', 'Our new phone is here', '<span>Ad</span>')}
</div></main><div data-testid="sidebarColumn" style="width:300px">What is happening: trends and more</div></div>`,
`window.addPost = (h, t) => document.getElementById('tl').insertAdjacentHTML('beforeend', ${JSON.stringify(tweet('HANDLE', 'TEXT'))}.replaceAll('HANDLE', h).replace('TEXT', t));
window.errors = []; addEventListener('error', (e) => errors.push(String(e.message)));`);

const ytItem = (id, title, href, channel) => `<ytd-rich-item-renderer id="${id}" style="display:block;width:300px;padding:8px">
<div id="content"><a id="thumbnail" href="${href}">thumb</a><h3><a id="video-title-link" href="${href}"><span id="video-title">${title}</span></a></h3>
<a href="/@${channel}">${channel}</a></div></ytd-rich-item-renderer>`;
export const YTHOME = page('YouTube', `<ytd-rich-grid-renderer><div id="contents" style="display:flex;flex-wrap:wrap">
${ytItem('v1', 'Best running shorts review', '/watch?v=1', 'gearguy')}
${ytItem('v2', 'Funny cat', '/shorts/abc', 'cats')}
<ytd-rich-section-renderer><ytd-rich-shelf-renderer id="shelf" is-shorts><h2><span id="title">Shorts</span></h2>
<ytd-rich-item-renderer id="s1"><a href="/shorts/x1">A short</a></ytd-rich-item-renderer></ytd-rich-shelf-renderer></ytd-rich-section-renderer>
${ytItem('v3', 'How rivers shape valleys', '/watch?v=3', 'geochannel')}
<ytd-rich-item-renderer id="ad1"><ytd-ad-slot-renderer><a href="https://ads.example/">Sponsored phone</a></ytd-ad-slot-renderer></ytd-rich-item-renderer>
</div></ytd-rich-grid-renderer>`);

const shreddit = (id, author, sub, title, extra = '') => `<article id="${id}"><shreddit-post author="${author}" subreddit-prefixed-name="${sub}" post-title="${title}" ${extra}>
<a slot="title" href="/${sub}/comments/${id}">${title}</a></shreddit-post></article>`;
export const REDDIT = page('Reddit', `<main id="feed">
${shreddit('a1', 'spez', 'r/announcements', 'An update on the app')}
${shreddit('a2', 'alice', 'r/Politics', 'Vote on Tuesday')}
${shreddit('a3', 'bob', 'r/aww', 'My puppy learned to sit')}
${shreddit('a4', 'carl', 'r/sports', 'NBA trade deadline thread')}
</main>`);

const oldThing = (id, author, sub, title) => `<div class="thing link" id="${id}" data-author="${author}" data-subreddit="${sub}">
<p class="title"><a class="title" href="/r/${sub}/comments/${id}">${title}</a></p><p class="tagline">submitted by <a class="author" href="/user/${author}">${author}</a></p></div>`;
export const OLDREDDIT = page('reddit: the front page', `<div id="siteTable">
${oldThing('t1', 'alice', 'politics', 'Debate tonight')}
${oldThing('t2', 'bob', 'aww', 'Kitten nap')}
${oldThing('t3', 'carl', 'nba', 'NBA finals odds')}
</div>`);

// Mastodon's web app: the root is #mastodon; a boost names the booster in .status__prepend above the author.
const toot = (id, author, text, prepend = '') => `<article id="${id}"><div class="status">${prepend}
<div class="status__info"><a href="/@${author}" class="status__display-name"><bdi>${author}</bdi></a></div>
<div class="status__content"><p>${text}</p></div></div></article>`;
export const MASTODON = page('Mastodon', `<div id="mastodon"><div class="column" id="col">
${toot('m1', 'alice', 'Hello <a href="/@bob" class="mention">@bob</a>, nice to see you')}
${toot('m2', 'bob', 'My own post about trains')}
${toot('m3', 'dave', 'Dave writes about bread', '<div class="status__prepend"><a href="/@bob" class="status__display-name"><bdi>bob</bdi></a> boosted</div>')}
${toot('m4', 'erin', 'Just a normal post')}
</div></div>`);

// Hacker News: the byline and a spacer are the next table rows.
const hn = (id, title, user) => `<tr class="athing" id="${id}"><td class="title"><span class="titleline"><a href="https://ex.com/${id}">${title}</a></span></td></tr>
<tr id="${id}s"><td class="subtext"><a class="hnuser" href="user?id=${user}">${user}</a> 1 hour ago</td></tr><tr class="spacer" id="${id}p" style="height:5px"></tr>`;
export const HN = page('Hacker News', `<table id="hnmain"><tbody>
${hn('1', 'Show HN: a crypto wallet', 'pg')}${hn('2', 'Rust 2.0 released', 'dang')}${hn('3', 'Gardening with sensors', 'tptacek')}
</tbody></table>`);

// Bluesky names the author on the feed item; a repost carries a "Reposted by" line.
const sky = (id, by, body, extra = '') => `<div data-testid="feedItem-by-${by}" id="${id}">${extra}<a href="/profile/${by}">${by}</a><div>${body}</div></div>`;
export const BSKY = page('Bluesky', `<main>
${sky('b1', 'alice.bsky.social', 'hey <a href="/profile/bob.bsky.social">@bob.bsky.social</a> look')}
${sky('b2', 'bob.bsky.social', 'my own post')}
${sky('b3', 'carol.bsky.social', 'a reposted thought', '<a href="/profile/dan.bsky.social" aria-label="Reposted by Dan">Reposted by Dan</a>')}
</main>`);

// LinkedIn: the actor block names the author; an ad says Promoted under the name.
const li = (id, who, text, sub = '1d') => `<div class="feed-shared-update-v2" data-urn="urn:li:activity:${id}" id="${id}">
<div class="update-components-actor"><a href="/in/${who}/">${who}</a><span class="update-components-actor__sub-description">${sub}</span></div>
<div class="update-components-text">${text}</div></div>`;
export const LINKEDIN = page('Feed | LinkedIn', `<main>
${li('l1', 'alice', 'Thrilled to announce my new role')}
${li('l2', 'acme', 'Try our new CRM today', 'Promoted')}
${li('l3', 'bob', 'Notes from the conference')}
</main>`);
