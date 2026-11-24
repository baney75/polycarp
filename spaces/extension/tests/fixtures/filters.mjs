// Feed fixtures for filters.spec.mjs.
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
