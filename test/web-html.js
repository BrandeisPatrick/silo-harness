// web_fetch's HTML to Markdown (src/main/web/html.ts), headless: nested lists, tables, links made absolute (and
// javascript:/data: links dropped), entities, pre/code, quotes, images as alt text, <main>/<article> preferred, and a
// script-heavy page whose scripts, styles, templates, SVG, frames, forms, comments and hidden parts all go; and hostile
// pages (tags that never close, deep nesting, unterminated comments and raw elements, amplifying markup) that must
// convert in time, without throwing, and not much bigger than they came in.
// Run: npm run build && node test/web-html.js
const path = require('node:path');
const fs = require('node:fs');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { htmlToMarkdown, decodeEntities, parseHtml } = require(path.join(projectDir, 'dist/main/web/html.js'));
const { check, done } = require('./support/check.js');

const md = (html, url = 'https://example.com/docs/page.html') => htmlToMarkdown(html, url).markdown;

// Entities
check('entities: named, decimal, hex, and unknown ones left alone', decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x1F600; &copy; &hellip; &notanentity; &#0;') === 'a & b <c> "d" \'e\' 😀 © … &notanentity; �');
check('nbsp is a space after collapsing', md('<p>a&nbsp;&nbsp;b</p>') === 'a b', md('<p>a&nbsp;&nbsp;b</p>'));

// Lists
const lists = md(`<ul><li>one<ul><li>one.a<ol><li>deep</li><li>deeper</li></ol></li><li>one.b</li></ul></li><li>two</li></ul><ol start="4"><li>four<li>five</ol>`);
check(
  'nested lists keep their levels and numbering',
  lists === ['- one', '  - one.a', '    1. deep', '    2. deeper', '  - one.b', '- two', '', '4. four', '5. five'].join('\n'),
  lists,
);
const loose = md('<ul><li><p>first para</p><p>second para</p></li><li>x</li></ul>');
check('a list item with paragraphs stays one item', loose === '- first para\n  second para\n- x', loose);

// Tables
const table = md('<table><caption>Plans</caption><thead><tr><th>Plan</th><th>Price</th></tr></thead><tbody><tr><td>Free</td><td>$0</td></tr><tr><td>Pro | Team</td><td><b>$10</b></td></tr><tr><td>Odd</td></tr></tbody></table>');
check('tables as rows: a header line, pipes escaped, short rows padded', table === ['Plans', '', '| Plan | Price |', '| --- | --- |', '| Free | $0 |', '| Pro \\| Team | **$10** |', '| Odd | |'].join('\n'), table);
const noHead = md('<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>');
check('a table without header cells has no separator line', noHead === '| a | b |\n| c | d |', noHead);

// Links
const links = md('<p><a href="/abs">root</a> <a href="rel/x?y=1#frag">relative</a> <a href="https://other.example/a b">other</a> <a href="javascript:alert(1)">js</a> <a href="data:text/html,x">data</a> <a href="#top">anchor</a> <a href="mailto:a@b.example">mail</a> <a href="/empty"></a></p>');
check(
  'links are absolute; javascript:, data: and anchors keep only their text; empty links vanish',
  links === '[root](https://example.com/abs) [relative](https://example.com/docs/rel/x?y=1#frag) [other](https://other.example/a%20b) js data anchor [mail](mailto:a@b.example)',
  links,
);
const based = md('<head><base href="https://cdn.example/base/"></head><p><a href="x">x</a></p>');
check('<base href> is honoured', based === '[x](https://cdn.example/base/x)', based);
check('inline marks keep the spaces around them', md('<p>Hello<b> world</b>, <em>you</em>!</p>') === 'Hello **world**, *you*!', md('<p>Hello<b> world</b>, <em>you</em>!</p>'));

// Code, quotes, headings, images
const code = md('<p>Use <code>a`b</code> or <code>x &lt; y</code>.</p><pre><code class="language-ts">if (a &lt; b) {\n  run();\n}\n</code></pre>');
check('inline code and pre blocks (language kept, whitespace kept, entities decoded)', code === 'Use `` a`b `` or `x < y`.\n\n```ts\nif (a < b) {\n  run();\n}\n```', code);
const quote = md('<blockquote><p>one</p><p>two <i>it</i></p></blockquote><h3>Title <small>x</small></h3><img alt="A cat"><img src="x.png">');
check('quotes, headings, and images as their alt text', quote === '> one\n>\n> two *it*\n\n### Title x\n\nA cat', quote);
check('breaks and rules', md('<p>a<br>b</p><hr><p>c</p>') === 'a\nb\n\n---\n\nc', md('<p>a<br>b</p><hr><p>c</p>'));

// Broken markup never throws
const broken = ['<p>unclosed <b>bold <i>both', '<<<>>> < p>', '<div><span></div></span>', '<a href="x>no end', '<!-- never closed', '<table><td>cell', '</p></p></div>', '<script>never closed'];
let threw = null;
const outs = [];
for (const b of broken) {
  try {
    outs.push(md(b));
  } catch (e) {
    threw = `${b}: ${e.message}`;
  }
}
check('broken markup is read as well as it can be, never throws', !threw && outs[0] === 'unclosed **bold *both***' && outs[5] === '| cell |', { threw, outs });
check('a large page converts quickly', (() => {
  const big = '<html><body>' + '<div class="row"><p>Paragraph with <a href="/x">a link</a> and <b>bold</b>.</p><script>var x = "<p>";</script></div>'.repeat(20000) + '</body></html>';
  const t0 = Date.now();
  const out = md(big);
  return out.length > 100000 && Date.now() - t0 < 4000;
})());

// The script-heavy page
const heavy = fs.readFileSync(path.join(__dirname, 'support/web/script-heavy.html'), 'utf8');
const h = htmlToMarkdown(heavy, 'https://widget.example/news/2.0/');
const gone = ['not content', 'written', 'JSON-LD', 'styled', 'enable JavaScript', 'template text', 'We use cookies', 'Accept all', 'newsletter', 'decorative', 'svg text', 'iframe fallback', 'secret@example.com', 'typed text', 'Subscribe', 'one', 'trackPageView', 'markup', 'console.log', 'Home', 'Widget Inc.'];
const leaked = gone.filter((g) => h.markdown.includes(g));
check('scripts, styles, noscript, templates, SVG, iframes, form controls, comments and hidden parts are dropped; <main> wins over the chrome', leaked.length === 0, { leaked, md: h.markdown });
check('the title comes from <title>, entities decoded', h.title === 'Release notes – Widget 2.0', h.title);
check(
  'the article reads as Markdown',
  h.markdown ===
    [
      '# Widget 2.0 is out',
      '',
      'Widget 2.0 brings **faster** builds, a new [plugin API](https://widget.example/news/plugins/index.html) and *fewer* surprises.',
      '',
      '## Changes',
      '',
      '- Builds are 2× faster',
      '- New: `widget.use(plugin)`',
      '',
      'Email',
      '',
      'Read the fake link and the data link.',
      '',
      'Build times chart',
    ].join('\n'),
  h.markdown,
);

// No <main>: the largest <article>, else the body
const two = md('<body><nav>menu</nav><article><p>short</p></article><article><p>' + 'long text '.repeat(40) + '</p></article></body>');
check('without <main>, the largest <article> is read', two.startsWith('long text') && !two.includes('menu') && !two.includes('short'), two.slice(0, 80));
const thin = md('<body><nav>menu</nav><main><p>tiny</p></main><p>rest of page</p></body>');
check('a <main> with almost no text is not trusted: the body is read', thin.includes('menu') && thin.includes('rest of page'), thin);
check('the tree survives a page of only text', parseHtml('just text').children[0] === 'just text');

// A deep but ordinary page renders as it always has
const deepPage =
  '<html><head><title>Deep page</title></head><body><nav>menu</nav>' +
  '<div class="wrap">'.repeat(40) +
  '<article><h1>Field notes</h1><p>Intro with <a href="/guide">a guide</a> and <b>bold</b> text.</p>' +
  '<h2>Steps</h2><ul><li>One<ul><li>One.a<ol><li>Deep</li><li>Deeper</li></ol></li></ul></li><li>Two</li></ul>' +
  '<blockquote><p>Outer</p><blockquote><p>Inner <i>quote</i></p></blockquote></blockquote><p>The end.</p></article>' +
  '</div>'.repeat(40) +
  '<footer>foot</footer></body></html>';
const deep = htmlToMarkdown(deepPage, 'https://example.com/notes/');
check(
  'a page 40 divs deep with nested lists and quotes reads as before',
  deep.title === 'Deep page' &&
    deep.markdown ===
      [
        '# Field notes',
        '',
        'Intro with [a guide](https://example.com/guide) and **bold** text.',
        '',
        '## Steps',
        '',
        '- One',
        '  - One.a',
        '    1. Deep',
        '    2. Deeper',
        '- Two',
        '',
        '> Outer',
        '>',
        '> > Inner *quote*',
        '',
        'The end.',
      ].join('\n'),
  deep,
);

// Hostile pages: each must convert without throwing and in time. The budgets are generous (the conversions take
// tens of milliseconds) but far below what quadratic work on these sizes would take.
const timed = (html) => {
  const t0 = Date.now();
  try {
    return { out: md(html), ms: Date.now() - t0 };
  } catch (e) {
    return { threw: String(e).slice(0, 120), ms: Date.now() - t0 };
  }
};
const fast = (label, html, ok = () => true, budget = 2000) => {
  const r = timed(html);
  check(`${label} (${html.length} chars)`, !r.threw && r.ms < budget && ok(r.out), { ms: r.ms, threw: r.threw, out: r.out?.slice(0, 80) });
};

const unclosed = '<a'.repeat(500_000) + '" >';
fast('a million "<a" that never close are text, read once', unclosed, (out) => out === unclosed);
check(
  'after a tag that never ends, the text goes on and later tags still count',
  md('<p>before <a href="x>after <b>bold</b></p>') === 'before <a href="x>after **bold**' && md("<p>a<b, it's fine.</p><p>next <i>para</i></p>") === "a<b, it's fine.\n\nnext *para*",
  [md('<p>before <a href="x>after <b>bold</b></p>'), md("<p>a<b, it's fine.</p><p>next <i>para</i></p>")],
);
fast('300,000 nested <i>', '<i>'.repeat(300_000) + 'x', (out) => out.includes('x'));
fast('200,000 nested <div>', '<div>'.repeat(200_000) + 'x', (out) => out === 'x');
fast('125,000 nested <ul><li>', '<ul><li>'.repeat(125_000) + 'x', (out) => out.includes('x'));
fast('80,000 nested <blockquote>', '<blockquote>'.repeat(80_000) + 'x', (out) => out.includes('x'));
fast('300,000 stray end tags in a deep tree', '<i>'.repeat(2000) + '</b>'.repeat(300_000));
fast('300,000 unterminated comments', '<!--'.repeat(300_000), (out) => out === '');
fast('200,000 unterminated <script>', '<script>'.repeat(200_000), (out) => out === '');
fast('200,000 unterminated <title>', '<title>'.repeat(200_000), (out) => out === '');
const tiny = '<b>x</b>'.repeat(625_000);
fast('5 MB of tiny elements, no bigger out than in', tiny, (out) => out.length > 0 && out.length <= 2 * tiny.length, 5000);

// Bounds on the tree and on what nesting adds
let maxDepth = 0;
for (const stack = [parseHtml('<span>'.repeat(1000) + 'x')]; stack.length; ) {
  const e = stack.pop();
  maxDepth = Math.max(maxDepth, e.depth);
  for (const c of e.children) if (typeof c !== 'string') stack.push(c);
}
check('the tree is never deeper than 256', maxDepth === 256, maxDepth);
// Past the limits an element is not opened, but what it hides is still left out
const deepHidden = md('<div>'.repeat(300) + 'a <div hidden>SECRET <div>INNER</div> <script>"</div>"</script>MORE</div> b <p style="display: none">SECRET</p> c <select><option>SECRET</option></select> d <svg/> e');
check('past the depth cap, hidden and never-shown elements keep their content out', deepHidden.replace(/\s+/g, ' ') === 'a b c d e', deepHidden);
const overBudget = md('<b></b>'.repeat(300_000) + 'a <span aria-hidden="true">SECRET <span>INNER</span> MORE</span> b <button>SECRET</button> c');
check('past the element budget, hidden and never-shown elements keep their content out', overBudget === 'a b c', overBudget.slice(-80));
const impliedEnd = md('<div>'.repeat(300) + 'a <p hidden>SECRET<p>after an implied end');
check('past the depth cap, a hidden element ends only at its own end tag', impliedEnd === 'a', impliedEnd);
const quotes = md('<blockquote>q'.repeat(10));
check('quotes add their prefix for 8 levels at most', quotes.split('\n').pop() === '> > > > > > > > q', quotes);
const bolds = md('<b>'.repeat(10) + 'x');
check('nested emphasis is marked for 8 levels at most', bolds === `${'*'.repeat(16)}x${'*'.repeat(16)}`, bolds);
const deepLink = md('<table><tr><td>'.repeat(10) + '<a href="/docs">Docs</a>');
check('a link past the nesting cap keeps its address', deepLink.includes('[Docs](https://example.com/docs)'), deepLink);
fast('100,000 nested links', '<a href="/x">'.repeat(100_000) + 'x', (out) => out === '[x](https://example.com/x)');
const longBase = '<base href="https://a.example/' + 'p'.repeat(100_000) + '/">' + '<a href=x>y</a>'.repeat(50_000);
fast('a long <base> under many short links does not multiply the page', longBase, (out) => out.length <= 2 * longBase.length);
const padded = '<table><tr>' + '<td>a'.repeat(20_000) + '<tr><td>b'.repeat(100_000) + '</table>';
fast('one wide row over many short ones is not padded out', padded, (out) => out.length <= 2 * padded.length);

done();
