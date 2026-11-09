// The CSS splitter and the scoping of looks (src/main/mods/css.ts): top-level statements found through strings,
// comments, escapes, url(…) and nested braces; the repairs that keep a look inside its @scope; hoisted and dropped
// at-rules; url() pointing at the mod's own files. Run: npm run build && node test/mods-css.js
const path = require('node:path');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { check, done } = require('./support/check.js');
const { splitCss, scopeCss, scopeTheme, cleanCss, modUrlRewriter, LOOK_ROOTS, LOOK_LAYER, PREVIEW_ROOTS } = require(path.join(projectDir, 'dist', 'main', 'mods', 'css.js'));

const texts = (css, opts) => splitCss(css, opts).map((s) => s.text);
/** Whether the text before a "(" ends with the identifier url (escapes resolved, as CSS reads it) */
function isUrl(before) {
  const ident = /(?:[\w-]|\\[0-9a-fA-F]{1,6}\s?|\\[^\n0-9a-fA-F])+$/.exec(before)?.[0] ?? '';
  return ident.replace(/\\([0-9a-fA-F]{1,6})\s?|\\(.)/g, (_m, hex, ch) => (hex ? String.fromCodePoint(parseInt(hex, 16) || 0xfffd) : ch)).toLowerCase() === 'url';
}
/** Braces outside strings balance and never go below zero: the property that keeps a look inside its scope. */
function balanced(css) {
  let depth = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '\\') i++;
    else if (c === '"' || c === "'") {
      const q = c;
      for (i++; i < css.length && css[i] !== q && css[i] !== '\n'; i++) if (css[i] === '\\') i++;
    } else if (c === '/' && css[i + 1] === '*') return false; // comments never survive
    else if (c === '(' && isUrl(css.slice(0, i)) && !/^\s*["']/.test(css.slice(i + 1))) {
      // An unquoted url(…) is one token up to ")", braces and all, as the browser reads it
      const close = css.indexOf(')', i);
      i = close < 0 ? css.length : close;
    } else if (c === '{') depth++;
    else if (c === '}' && --depth < 0) return false;
  }
  return depth === 0;
}
/** The scoped text ends with the app's own "}" closing "@scope (root) {", and everything scoped sits inside it. */
function scopedInside(out, root) {
  const at = out.indexOf(`@scope (${root}) {`);
  if (at < 0) return false;
  const inner = out.slice(at + `@scope (${root}) {`.length, out.lastIndexOf('}'));
  return out.trimEnd().endsWith('}') && balanced(inner) && balanced(out);
}

// --- splitting ---
check('rules and at-rules, one per statement', JSON.stringify(texts('a { color: red }  b{c:d}\n@media (x) { e { f: g } }')) === JSON.stringify(['a { color: red }', 'b{c:d}', '@media (x) { e { f: g } }']));
check('a statement at-rule ends at ";"', JSON.stringify(texts('@import "x.css"; a{}')) === JSON.stringify(['@import "x.css";', 'a{}']));
check('braces in strings do not count', JSON.stringify(texts('a { content: "}" } b { content: \'{\' }')) === JSON.stringify(['a { content: "}" }', "b { content: '{' }"]));
check('an escaped quote stays in its string', texts('a { content: "x\\"}" } b{}').length === 2);
check('an escaped brace is not a brace', JSON.stringify(texts('.a\\{b { x: y } c{}')) === JSON.stringify(['.a\\{b { x: y }', 'c{}']));
check('comments are removed, braces in them too', JSON.stringify(texts('/* } { */ a { /* } */ b: c }')) === JSON.stringify(['a {   b: c }']));
check('an unquoted url() may hold braces and quotes are its own', JSON.stringify(texts('a { background: url(data:image/svg+xml;utf8,<svg>{}</svg>) } b{}')).includes('<svg>{}</svg>') && texts('a { background: url(data:x{}) } b{}').length === 2);
check('a quoted url() keeps its quotes', texts('a{b:url( "x).png" )}')[0] === 'a{b:url("x).png")}');
check('url( after an identifier character is not a url', !splitCss('a{b:myurl(x)}', { url: () => 'Z' })[0].text.includes('Z') && splitCss('a{b:url(x)}', { url: () => 'Z' })[0].text.includes('"Z"'));
check('at-rule names in lower case, vendor prefix kept', splitCss('@MEDIA (x){} @-webkit-keyframes k{}').map((s) => s.name).join() === 'media,-webkit-keyframes');
check('prelude and body of a block at-rule', (() => { const s = splitCss('@media (w > 1px) { a { b: c } }')[0]; return s.prelude === '@media (w > 1px)' && s.body.trim() === 'a { b: c }'; })());
check('nothing but whitespace and comments: no statements', splitCss('  /* x */ \n ').length === 0);
check('a byte-order mark is skipped', texts('﻿a{}')[0] === 'a{}');

// --- repairs ---
check('a stray "}" is dropped', JSON.stringify(texts('a{} } b{}')) === JSON.stringify(['a{}', 'b{}']));
check('an unclosed block is closed', texts('a { b: c')[0] === 'a { b: c}' && texts('@media (x) { a { b: c')[0] === '@media (x) { a { b: c}}');
check('an unclosed comment ends the sheet, and is gone', JSON.stringify(texts('a{} /* b{}')) === JSON.stringify(['a{}']));
check('an unclosed string is closed at the end of its line, as CSS does', texts('a { content: "x\n } b{}')[0] === 'a { content: "x"\n }');
check('an unclosed url( is closed', texts('a { b: url(x')[0] === 'a { b: url(x)}');

// --- scoping ---
{
  const out = scopeCss('a { color: red } :scope { --x: 1 }', '#messages');
  check('everything goes inside @scope (root)', /^@scope \(#messages\) \{\na \{ color: red \}\n:scope \{ --x: 1 \}\n\}$/.test(out), out);
}
{
  const out = scopeCss('@keyframes k { from { opacity: 0 } } @font-face { font-family: "mod-holo Face"; src: url(x.woff2) } @property --mod-holo-p { syntax: "<number>"; inherits: false; initial-value: 0 } @counter-style c { system: cyclic; symbols: "*" } a { animation: k 1s }', '#messages', { prefix: 'holo' });
  const scopeAt = out.indexOf('@scope');
  check('@keyframes, @font-face, @property and @counter-style are hoisted in front of the scope', ['@keyframes k', '@font-face', '@property --mod-holo-p', '@counter-style c'].every((s) => out.indexOf(s) >= 0 && out.indexOf(s) < scopeAt), out);
  check('… inside the looks cascade layer, so the app\'s own names win a collision', out.startsWith(`@layer ${LOOK_LAYER} {\n@keyframes k`) && out.lastIndexOf('}', scopeAt) > out.indexOf('@counter-style c') && LOOK_LAYER === 'mod-looks', out);
  check('… and the rules stay inside it', out.slice(scopeAt).includes('a { animation: k 1s }'));
}
{
  const out = scopeCss('@import url(evil.css); @import "x.css" screen; @charset "utf-8"; @namespace svg url(http://www.w3.org/2000/svg); @page { margin: 0 } a{}', '#chatbar');
  check('@import, @charset, @namespace and @page are dropped', !/@import|@charset|@namespace|@page/.test(out) && out.includes('a{}'), out);
}
{
  const out = scopeCss('@media (prefers-reduced-motion: no-preference) { @keyframes k { to { opacity: 1 } } a { animation: k 1s } }', '#messages');
  check('a @keyframes inside @media is hoisted inside the same condition', /^@layer mod-looks \{\n@media \(prefers-reduced-motion: no-preference\) \{\n@keyframes k/.test(out) && /@scope \(#messages\) \{\n@media \(prefers-reduced-motion: no-preference\) \{\na \{ animation: k 1s \}/.test(out), out);
}
{
  // Global registrations: only in the namespace kept for mods (--mod-<id>-…, "mod-<id>…")
  const bad = scopeCss("@property --bg-100 { syntax: '<color>'; inherits: false; initial-value: red; } @property --mod-holo-glow { syntax: '<color>'; inherits: true; initial-value: blue; } @property --holo-plain { syntax: '*'; inherits: false } @font-face { font-family: \"SF Pro Text\"; src: local(Courier); } @font-face { font-family: -apple-system; src: local(Courier) } @font-face { font-family: 'mod-holo display'; src: url(f.woff2) } @font-face { font-family: 'holo plain'; src: url(g.woff2) } a{}", '#messages', { prefix: 'holo' });
  check('@property for an app token is dropped', !bad.includes('--bg-100'), bad);
  check('@property in the mod\'s namespace is kept', bad.includes('@property --mod-holo-glow'));
  check('@property under the bare mod id is dropped (a mod may be called bg or text)', !bad.includes('--holo-plain') && !scopeCss("@property --bg-100 { syntax: '<color>'; inherits: false; initial-value: red }", '#messages', { prefix: 'bg' }).includes('--bg-100'));
  check('@font-face for a family the app uses is dropped', !/SF Pro Text|apple-system/.test(bad), bad);
  check('@font-face in the mod\'s namespace is kept (any case, quoted or not)', bad.includes("'mod-holo display'") && !bad.includes('holo plain'));
  check('@font-face with a second font-family outside the namespace is dropped (the browser uses the last one)', !scopeCss('@font-face { font-family: "mod-holo a"; font-family: "SF Pro Text"; src: local(Courier) } a{}', '#messages', { prefix: 'holo' }).includes('@font-face'));
  check('… and so is one that spells the second with an escape', !scopeCss('@font-face { font-family: "mod-holo a"; font\\-family: BlinkMacSystemFont; src: local(Courier) } a{}', '#messages', { prefix: 'holo' }).includes('@font-face'));
  const none = scopeCss('@property --mod-holo-x { syntax: "*"; inherits: false } @font-face { font-family: mod-holo; src: url(a.woff) } a{}', '#messages');
  check('without a prefix, no @property or @font-face survives', !/@property|@font-face/.test(none), none);
  check('@property inside @media is checked too', !scopeCss('@media (x) { @property --bg-100 { syntax: "*"; inherits: false } }', '#messages', { prefix: 'holo' }).includes('--bg-100'));
  check('a look\'s @keyframes spin stays a layered rule (the app\'s unlayered spin wins)', /^@layer mod-looks \{\n@keyframes spin/.test(scopeCss('@keyframes spin { to { opacity: 0 } }', '#messages')));
  check('themes keep @property and @font-face', cleanCss('@property --bg-100 { syntax: "<color>"; inherits: true; initial-value: red } @font-face { font-family: X; src: local(Y) }').includes('@property --bg-100') );
}
check('a sheet of only hoisted rules has no empty scope', !scopeCss('@keyframes k {}', '#messages').includes('@scope'));
check('an empty sheet is empty', scopeCss('/* nothing */', '#messages') === '');
check('the region roots', LOOK_ROOTS.conversation === '#messages' && LOOK_ROOTS.composer === '#chatbar');

// Attempts to get out of the scope: whatever is written, the output is balanced and ends with the app's "}".
const escapes = [
  'a{} } } :root { --accent: red }',
  'a { color: red } } body { display: none }',
  '} } } html { filter: invert(1) }',
  'a { content: "}" } } .sidebar { display: none }',
  '/* */ } /* } */ .sidebar{display:none}',
  'a { b: url(x}) } } .sidebar{}',
  'a { b: url("x" } } .sidebar{}',
  '@media (x) { } } } .sidebar{}',
  'a { b: "unterminated\n} } .sidebar{}',
  'a { b: c /* unterminated',
  '@keyframes k { from { a: b } } } } .sidebar{}',
  '@keyframes k { from { a: b',
  'a\\}{} } .sidebar{}',
  '@scope (body) { .sidebar { display: none } }',
  '@media (x) { @keyframes k { } } } .sidebar{}',
];
for (const css of escapes) {
  const out = scopeCss(css, '#messages');
  check(`stays in scope: ${JSON.stringify(css).slice(0, 60)}`, scopedInside(out, '#messages') || (!out.includes('.sidebar') && !out.includes(':root') && balanced(out)), out);
}

// A rough fuzz: random mixes of the characters that matter always give balanced output that closes its scope.
{
  const bits = ['{', '}', '}', '"', "'", '\\', '/*', '*/', 'url(', ')', ';', '@media x', '@keyframes k', '@import x', 'a', ' ', '\n', ':root', ' .sidebar '];
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  let bad = null;
  for (let n = 0; n < 20000 && !bad; n++) {
    let css = '';
    const len = 1 + Math.floor(rnd() * 40);
    for (let i = 0; i < len; i++) css += bits[Math.floor(rnd() * bits.length)];
    const out = scopeCss(css, '#messages');
    // An @import left as a statement of its own, at the top or directly inside the scope (inside a rule it is garbage the browser drops)
    const top = splitCss(out);
    const imports = top.some((t) => t.name === 'import') || top.some((t) => t.name === 'scope' && splitCss(t.body).some((x) => x.name === 'import'));
    if (!balanced(out) || (out.includes('@scope') && !scopedInside(out, '#messages')) || imports) bad = { css, out };
  }
  check('20000 random sheets: always balanced, the scope always closed by the app, no @import left', !bad, bad);
}

// --- themes (contributes.styles) ---
check('a theme keeps its rules unscoped', cleanCss(':root { --accent: red }') === ':root { --accent: red }');
check('a theme loses its @import', cleanCss('@import url(x.css); :root{a:b}') === ':root{a:b}');

// --- previews in Settings: a look and a theme compiled for the preview's own root ---
{
  check('the preview roots: a miniature window with its own transcript and chat bar', PREVIEW_ROOTS.theme === '.lp-root' && PREVIEW_ROOTS.body === '.lp-body' && PREVIEW_ROOTS.conversation === '.lp-root #messages' && PREVIEW_ROOTS.composer === '.lp-root #chatbar');
  const look = scopeCss('.msg.user .bubble { color: red } :scope { --x: 1 }', PREVIEW_ROOTS.conversation, { prefix: 'teal' });
  check('a look for a preview is scoped to the preview\'s region, not the window\'s', look.startsWith('@scope (.lp-root #messages) {') && !/@scope \(#messages\)/.test(look), look);
  const t = scopeTheme(':root { --accent: red } @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --accent: blue } } :root[data-theme="dark"] { --accent: blue } html { background: black } body { background: transparent } :root.mod-bg .main, .sidebar, body > .x { color: red }', PREVIEW_ROOTS.theme, { body: PREVIEW_ROOTS.body });
  check('a theme for a preview: inside @scope (.lp-root), :root and html as :scope, body as .lp-body', t.startsWith('@scope (.lp-root) {') && /:scope \{ --accent: red \}/.test(t) && /:scope:not\(\[data-theme="light"\]\)/.test(t) && /:scope\[data-theme="dark"\]/.test(t) && /:scope \{ background: black \}/.test(t) && /\.lp-body \{ background: transparent \}/.test(t) && /:scope\.mod-bg \.main, \.sidebar, \.lp-body > \.x/.test(t) && !/:root|(?<![\w.-])html\b|(?<![\w-])body\b/.test(t), t);
  const kept = scopeTheme('@keyframes glow { to { opacity: 1 } } @font-face { font-family: Brand; src: url(b.woff2) } @import url(x.css); a[title="html body :root"] { b: c } .htmlish, #body { d: e }', '.lp-root', { body: '.lp-body' });
  check('a theme keeps its @keyframes and @font-face (in front of the scope), loses @import, and leaves strings and names alone', kept.indexOf('@keyframes glow') < kept.indexOf('@scope') && kept.indexOf('@font-face') < kept.indexOf('@scope') && !/@import/.test(kept) && /a\[title="html body :root"\]/.test(kept) && /\.htmlish, #body/.test(kept), kept);
  const evil = scopeTheme('} } :root { --a: 1 } } .x { y: z }', '.lp-root');
  check('a stray } cannot close the preview\'s scope early', (evil.match(/\{/g) || []).length === (evil.match(/\}/g) || []).length && evil.trim().endsWith('}') && evil.startsWith('@scope (.lp-root) {'), evil);
}

// --- url() ---
{
  const u = modUrlRewriter('mod://hyperspace.bundled', 'looks/holo.css');
  check('a relative url resolves against the stylesheet folder in the mod', u('img/a.png') === 'mod://hyperspace.bundled/looks/img/a.png' && u('../a.png') === 'mod://hyperspace.bundled/a.png');
  check('a url cannot climb out of the mod origin', u('../../../../etc/passwd') === 'mod://hyperspace.bundled/etc/passwd');
  check('a root-relative url is the mod root', u('/fonts/x.woff2') === 'mod://hyperspace.bundled/fonts/x.woff2');
  check('absolute urls, data: and #fragments stay as they are', u('https://x.org/a.png') === null && u('data:image/png;base64,AA') === null && u('#grad') === null && u('mod://other.user/a') === null);
  const top = modUrlRewriter('mod://x.user', 'a.css');
  check('a stylesheet at the mod root', top('b c.png') === 'mod://x.user/b%20c.png');
  const out = scopeCss('a { background: url(img/a.png), url("b.png"), url(https://x/y.png) }', '#messages', { url: u });
  check('scopeCss rewrites url()s it finds', out.includes('url("mod://hyperspace.bundled/looks/img/a.png")') && out.includes('url("mod://hyperspace.bundled/looks/b.png")') && out.includes('url(https://x/y.png)'), out);
  check('cleanCss rewrites them too', cleanCss('a{b:url(c.png)}', { url: top }) === 'a{b:url("mod://x.user/c.png")}');
}

done();
