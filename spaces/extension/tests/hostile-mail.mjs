// Hostile HTML mail for the safe view. `H` is the base address of a local server the test runs; any request that
// reaches it means something loaded. Each payload also gets mutated variants (case, whitespace, entities, comments),
// since sanitizer bypasses usually live in the odd spelling of a known trick.

export function corpus(H) {
  return [
    ['script tag', `<p>hi</p><script>new Image().src="${H}/script"</script>`],
    ['script with src', `<script src="${H}/script.js"></script>`],
    ['img onerror', `<img src="x" onerror="new Image().src='${H}/onerror'">`],
    ['tracking pixel', `<img src="${H}/pixel.gif" width="1" height="1">`],
    ['pixel by srcset', `<img srcset="${H}/srcset.gif 1x">`],
    ['picture source', `<picture><source srcset="${H}/source.gif"><img alt="x"></picture>`],
    ['body background', `<table background="${H}/bg.gif"><tr><td>x</td></tr></table>`],
    ['inline style url', `<div style="background:url(${H}/style.gif)">x</div>`],
    ['inline style url escaped', `<div style="background:u\\72 l(${H}/esc.gif)">x</div>`],
    ['style tag url', `<style>body{background:url("${H}/css.gif")}</style><p>x</p>`],
    ['style tag import', `<style>@import "${H}/import.css";</style><p>x</p>`],
    ['style font face', `<style>@font-face{font-family:x;src:url(${H}/font.woff)}p{font-family:x}</style><p>x</p>`],
    ['link stylesheet', `<link rel="stylesheet" href="${H}/link.css"><p>x</p>`],
    ['link prefetch', `<link rel="prefetch" href="${H}/prefetch">`],
    ['meta refresh', `<meta http-equiv="refresh" content="0;url=${H}/refresh">`],
    ['base href', `<base href="${H}/base/"><img src="rel.gif"><a href="rel">x</a>`],
    ['iframe', `<iframe src="${H}/iframe"></iframe>`],
    ['iframe srcdoc', `<iframe srcdoc="<script>new Image().src='${H}/srcdoc'</script>"></iframe>`],
    ['object', `<object data="${H}/object"></object>`],
    ['embed', `<embed src="${H}/embed">`],
    ['video poster', `<video poster="${H}/poster.gif"></video>`],
    ['audio', `<audio src="${H}/audio.mp3" autoplay></audio>`],
    ['svg onload', `<svg onload="new Image().src='${H}/svg'"><circle r="5"/></svg>`],
    ['svg image', `<svg><image href="${H}/svgimg.gif"/></svg>`],
    ['svg use', `<svg><use href="${H}/use.svg#x"/></svg>`],
    ['math href', `<math><mtext><a href="javascript:void(new Image().src='${H}/math')">x</a></mtext></math>`],
    ['javascript link', `<a href="javascript:new Image().src='${H}/js'">click</a>`],
    ['data html link', `<a href="data:text/html,<script>new Image().src='${H}/data'</script>">click</a>`],
    ['vbscript link', `<a href="vbscript:msgbox(1)">click</a>`],
    ['form', `<form action="${H}/form"><input name="q" value="x"><button>Go</button></form>`],
    ['form action on button', `<button formaction="${H}/formaction">Go</button>`],
    ['ping', `<a href="https://example.com" ping="${H}/ping">x</a>`],
    ['mutation xss noscript', `<noscript><p title="</noscript><img src=x onerror=new Image().src='${H}/mxss1'>"></noscript>`],
    ['mutation xss svg style', `<svg></p><style><a id="</style><img src=x onerror=new Image().src='${H}/mxss2'>">`],
    ['mutation xss math', `<math><mi><mglyph><style><img src=x onerror=new Image().src='${H}/mxss3'></style></mglyph></mi></math>`],
    ['template', `<template><img src="${H}/template.gif"></template>`],
    ['details ontoggle', `<details open ontoggle="new Image().src='${H}/toggle'"><summary>x</summary></details>`],
    ['marquee onstart', `<marquee onstart="new Image().src='${H}/marquee'">x</marquee>`],
    ['body onload', `<body onload="new Image().src='${H}/bodyload'"><p>x</p></body>`],
    ['css expression', `<div style="width:expression(new Image().src='${H}/expr')">x</div>`],
    ['import in attribute', `<div style="@import '${H}/attrimport.css'">x</div>`],
    ['image-set', `<div style="background-image:image-set('${H}/set.gif' 1x)">x</div>`],
    ['cid image', `<img src="cid:part1@example.com">`],
    ['dns prefetch', `<link rel="dns-prefetch" href="${H}/dns">`],
    ['portal', `<portal src="${H}/portal"></portal>`],
    ['area href', `<map name="m"><area shape="rect" coords="0,0,10,10" href="javascript:new Image().src='${H}/area'"></map><img usemap="#m">`]
  ];
}

// Spellings of the same payload that a sanitizer has to treat the same way.
export function variants(html) {
  return [
    html,
    html.replace(/<(\/?)([a-z]+)/g, (m, s, t) => '<' + s + t.toUpperCase()),
    html.replace(/javascript:/g, 'java\tscript:').replace(/onerror=/g, 'onerror  =').replace(/url\(/g, 'url (' ),
    html.replace(/javascript:/g, '&#106;avascript:').replace(/"/g, "'"),
    html.replace(/javascript:/g, '  JaVaScRiPt:').replace(/<img/g, '<!-- c --><img'),
    html.replace(/http:\/\//g, '//')
  ];
}

// What must never be in cleaned output.
export const FORBIDDEN = {
  tags: ['script', 'iframe', 'frame', 'object', 'embed', 'form', 'input', 'button', 'base', 'link', 'meta', 'svg', 'math', 'audio', 'video', 'source', 'picture', 'portal', 'template', 'noscript'],
  attrs: /^(on|srcset$|background$|poster$|action$|formaction$|ping$|usemap$)/i
};
