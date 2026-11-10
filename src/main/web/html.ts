// HTML to Markdown for web_fetch, in-house and tolerant: a tokenizer that never throws on broken markup, a small tree
// with the usual implied end tags, and a renderer that keeps what a reader needs (headings, paragraphs, links as
// absolute URLs, lists, code, quotes, tables as rows, images as their alt text) and drops what is not content
// (scripts, styles, templates, SVG, frames, form controls, comments, hidden elements). When the page has a <main>
// or an <article>, only that is rendered.

// ---------- Entities ----------

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  zwnj: '‌', zwj: '‍', shy: '', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„', laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›',
  bull: '•', middot: '·', times: '×', divide: '÷', deg: '°', plusmn: '±', para: '¶', sect: '§', euro: '€', pound: '£',
  yen: '¥', cent: '¢', curren: '¤', micro: 'µ', frac12: '½', frac14: '¼', frac34: '¾', sup1: '¹', sup2: '²', sup3: '³',
  iexcl: '¡', iquest: '¿', larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', lArr: '⇐', rArr: '⇒', hArr: '⇔',
  le: '≤', ge: '≥', ne: '≠', asymp: '≈', equiv: '≡', infin: '∞', minus: '−', prime: '′', Prime: '″', dagger: '†', Dagger: '‡',
  permil: '‰', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', lambda: 'λ', mu: 'μ', pi: 'π', sigma: 'σ',
  omega: 'ω', Omega: 'Ω', Delta: 'Δ', Sigma: 'Σ', Pi: 'Π', check: '✓', hearts: '♥', star: '☆', starf: '★',
  Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä', Aring: 'Å', AElig: 'Æ', Ccedil: 'Ç', Egrave: 'È', Eacute: 'É',
  Ecirc: 'Ê', Euml: 'Ë', Igrave: 'Ì', Iacute: 'Í', Icirc: 'Î', Iuml: 'Ï', Ntilde: 'Ñ', Ograve: 'Ò', Oacute: 'Ó', Ocirc: 'Ô',
  Otilde: 'Õ', Ouml: 'Ö', Oslash: 'Ø', Ugrave: 'Ù', Uacute: 'Ú', Ucirc: 'Û', Uuml: 'Ü', Yacute: 'Ý', szlig: 'ß',
  agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å', aelig: 'æ', ccedil: 'ç', egrave: 'è', eacute: 'é',
  ecirc: 'ê', euml: 'ë', igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï', ntilde: 'ñ', ograve: 'ò', oacute: 'ó', ocirc: 'ô',
  otilde: 'õ', ouml: 'ö', oslash: 'ø', ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü', yacute: 'ý', yuml: 'ÿ',
};

/** Decodes character references: named (the common ones), decimal and hex; anything else stays as written. */
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[A-Za-z][A-Za-z0-9]{1,31});?/g, (m, ref: string) => {
    if (ref[0] === '#') {
      const n = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return '�';
      return String.fromCodePoint(n);
    }
    return Object.prototype.hasOwnProperty.call(NAMED, ref) ? NAMED[ref] : m;
  });
}

// ---------- Tokenizer and tree ----------

export interface El {
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
  parent: El | null;
}
type Node = El | string;

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', 'keygen']);
/** Elements whose content is raw text up to their end tag */
const RAW = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext']);
/** An open element of the first kind is closed by a start tag of the second */
const CLOSED_BY: Record<string, Set<string>> = {
  p: new Set(['address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul']),
  li: new Set(['li']),
  dt: new Set(['dt', 'dd']),
  dd: new Set(['dt', 'dd']),
  tr: new Set(['tr', 'tbody', 'thead', 'tfoot']),
  td: new Set(['td', 'th', 'tr', 'tbody', 'thead', 'tfoot']),
  th: new Set(['td', 'th', 'tr', 'tbody', 'thead', 'tfoot']),
  thead: new Set(['tbody', 'tfoot']),
  tbody: new Set(['tbody', 'tfoot']),
  option: new Set(['option', 'optgroup']),
};
/** Elements a closing end tag search does not cross (an </li> inside a nested list closes only that list's item) */
const SCOPE = new Set(['ul', 'ol', 'table', 'td', 'th', 'blockquote', 'div', 'section', 'article', 'main', 'body', 'html']);

function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const name = m[1].toLowerCase();
    if (!(name in attrs)) attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

const TAG_RE = /<(\/?)([A-Za-z][A-Za-z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/y;

/** Parses HTML into a tree under a synthetic root. Never throws: broken markup becomes text or is closed where it can. */
export function parseHtml(html: string): El {
  const root: El = { tag: '#root', attrs: {}, children: [], parent: null };
  let cur = root;
  // The renderer's own markers (pre blocks, list indentation) never come from the page
  const s = String(html ?? '').replace(/[\u0000\u0001]/g, '');
  let i = 0;
  const text = (t: string) => {
    if (t) cur.children.push(decodeEntities(t));
  };
  const open = (tag: string, attrs: Record<string, string>): El => {
    // Implied end tags
    for (let n: El | null = cur; n && n !== root; ) {
      if (CLOSED_BY[n.tag]?.has(tag)) {
        cur = n.parent ?? root;
        n = cur;
        continue;
      }
      if (SCOPE.has(n.tag)) break;
      n = n.parent;
    }
    const el: El = { tag, attrs, children: [], parent: cur };
    cur.children.push(el);
    return el;
  };
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) {
      text(s.slice(i));
      break;
    }
    text(s.slice(i, lt));
    i = lt;
    if (s.startsWith('<!--', i)) {
      const end = s.indexOf('-->', i + 4);
      i = end < 0 ? s.length : end + 3;
      continue;
    }
    if (s.startsWith('<![CDATA[', i)) {
      const end = s.indexOf(']]>', i);
      cur.children.push(s.slice(i + 9, end < 0 ? s.length : end));
      i = end < 0 ? s.length : end + 3;
      continue;
    }
    if (s[i + 1] === '!' || s[i + 1] === '?') {
      const end = s.indexOf('>', i);
      i = end < 0 ? s.length : end + 1;
      continue;
    }
    TAG_RE.lastIndex = i;
    const m = TAG_RE.exec(s);
    if (!m) {
      // A lone "<": text
      text('<');
      i++;
      continue;
    }
    i += m[0].length;
    const tag = m[2].toLowerCase();
    if (m[1]) {
      // End tag: close the nearest open element of that name, not crossing a scope boundary of another kind
      for (let n: El | null = cur; n && n !== root; n = n.parent) {
        if (n.tag === tag) {
          cur = n.parent ?? root;
          break;
        }
        if (SCOPE.has(n.tag) && !SCOPE.has(tag)) break;
      }
      continue;
    }
    const attrs = parseAttrs(m[3]);
    const el = open(tag, attrs);
    const selfClosing = /\/\s*$/.test(m[3]);
    if (VOID.has(tag) || (selfClosing && (tag === 'svg' || tag.includes(':') || tag === 'path'))) continue;
    if (RAW.has(tag)) {
      const close = new RegExp(`</${tag}\\s*>`, 'ig');
      close.lastIndex = i;
      const cm = tag === 'plaintext' ? null : close.exec(s);
      const body = s.slice(i, cm ? cm.index : s.length);
      if (body) el.children.push(tag === 'title' || tag === 'textarea' ? decodeEntities(body) : body);
      i = cm ? cm.index + cm[0].length : s.length;
      continue;
    }
    cur = el;
  }
  return root;
}

// ---------- Finding things ----------

export function* walk(el: El): Generator<El> {
  for (const c of el.children) {
    if (typeof c === 'string') continue;
    yield c;
    yield* walk(c);
  }
}

function find(root: El, pred: (e: El) => boolean): El | null {
  for (const e of walk(root)) if (pred(e)) return e;
  return null;
}

export function textOf(el: El): string {
  let out = '';
  for (const c of el.children) out += typeof c === 'string' ? c : DROP.has(c.tag) ? '' : textOf(c);
  return out;
}

/** Elements whose content is never shown */
const DROP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'math', 'iframe', 'frame', 'frameset', 'object', 'embed', 'canvas', 'audio', 'video', 'map', 'head', 'link', 'meta', 'base', 'input', 'select', 'option', 'optgroup', 'textarea', 'button', 'datalist', 'output', 'progress', 'meter', 'dialog', 'title', 'noembed', 'noframes', 'xmp', 'plaintext']);

function isHidden(el: El): boolean {
  const a = el.attrs;
  if ('hidden' in a) return true;
  if ((a['aria-hidden'] ?? '').toLowerCase() === 'true') return true;
  const style = (a.style ?? '').toLowerCase().replace(/\s+/g, '');
  return style.includes('display:none') || style.includes('visibility:hidden');
}

// ---------- Rendering ----------

interface Ctx {
  base: URL | null;
  /** Pre blocks, kept out of the whitespace pass: \u0000<index>\u0000 in the text */
  pres: string[];
  inPre: boolean;
  inLink: boolean;
}

const BLOCK = new Set(['address', 'article', 'aside', 'blockquote', 'body', 'center', 'dd', 'details', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'html', 'legend', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'ul', 'tr', 'caption']);

function absoluteUrl(href: string, ctx: Ctx): string | null {
  const h = href.trim().replace(/[\u0000-\u001f]+/g, '');
  if (!h || h.startsWith('#')) return null;
  let u: URL;
  try {
    u = ctx.base ? new URL(h, ctx.base) : new URL(h);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'mailto:' && u.protocol !== 'ftp:') return null;
  return u.href;
}

const escapeLinkText = (s: string): string => s.replace(/([[\]])/g, '\\$1');

function renderChildren(el: El, ctx: Ctx): string {
  let out = '';
  for (const c of el.children) out += typeof c === 'string' ? (ctx.inPre ? c : c.replace(/[\s ]+/g, ' ')) : renderEl(c, ctx);
  return out;
}

/** Inline content of an element on one line (headings, table cells, link text) */
function inline(el: El, ctx: Ctx): string {
  return cleanInline(renderChildren(el, ctx));
}

function cleanInline(s: string): string {
  return s.replace(/\n+/g, ' ').replace(/[ \t]+/g, ' ').trim();
}

/** Inline emphasis around content, keeping the whitespace at its edges outside the markers */
function wrap(raw: string, mark: string): string {
  const t = cleanInline(raw);
  const lead = /^\s/.test(raw) ? ' ' : '';
  const trail = /\s$/.test(raw) ? ' ' : '';
  return t ? `${lead}${mark}${t}${mark}${trail}` : lead || trail;
}

function block(s: string): string {
  const t = s.trim();
  return t ? `\n\n${t}\n\n` : '';
}

function renderList(el: El, ctx: Ctx): string {
  const ordered = el.tag === 'ol';
  let n = Number.parseInt(el.attrs.start ?? '1', 10);
  if (!Number.isFinite(n)) n = 1;
  const items: string[] = [];
  for (const c of el.children) {
    if (typeof c === 'string') {
      if (c.trim()) items.push(`- ${c.trim()}`);
      continue;
    }
    if (DROP.has(c.tag) || isHidden(c)) continue;
    if (c.tag !== 'li') {
      // A stray element in a list (a nested list without an li, a div): render it as an item of its own
      const body = renderEl(c, ctx).trim();
      if (body) items.push(indentAfterFirst(body.startsWith('- ') || /^\d+\. /.test(body) ? body : `- ${body}`, INDENT.repeat(2)));
      continue;
    }
    const marker = ordered ? `${n++}. ` : '- ';
    const body = tidy(renderChildren(c, ctx)).replace(/\n{2,}/g, '\n');
    items.push(marker + indentAfterFirst(body || '', INDENT.repeat(marker.length)));
  }
  return items.length ? `\n\n${items.join('\n')}\n\n` : '';
}

/** List indentation: a character the whitespace pass leaves alone, made spaces at the end */
const INDENT = '\u0001';

function indentAfterFirst(s: string, pad: string): string {
  return s
    .split('\n')
    .map((l, i) => (i > 0 && l ? pad + l : l))
    .join('\n');
}

function renderTable(el: El, ctx: Ctx): string {
  const rows: { cells: string[]; head: boolean }[] = [];
  let caption = '';
  const cellText = (td: El) => inline(td, ctx).replace(/\|/g, '\\|');
  const visit = (e: El) => {
    // Cells written without a <tr> make a row of their own
    let stray: string[] = [];
    const flush = () => {
      if (stray.length) rows.push({ cells: stray, head: false });
      stray = [];
    };
    for (const c of e.children) {
      if (typeof c === 'string' || DROP.has(c.tag) || isHidden(c)) continue;
      if (c.tag === 'td' || c.tag === 'th') {
        stray.push(cellText(c));
        continue;
      }
      flush();
      if (c.tag === 'caption') caption = inline(c, ctx);
      else if (c.tag === 'tr') {
        const cells: string[] = [];
        let head = true;
        for (const td of c.children) {
          if (typeof td === 'string' || (td.tag !== 'td' && td.tag !== 'th')) continue;
          if (td.tag === 'td') head = false;
          cells.push(cellText(td));
        }
        if (cells.length) rows.push({ cells, head: head && cells.length > 0 });
      } else if (c.tag === 'thead' || c.tag === 'tbody' || c.tag === 'tfoot') visit(c);
    }
    flush();
  };
  visit(el);
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.cells.length));
  const line = (cells: string[]) => `| ${[...cells, ...Array(width - cells.length).fill('')].join(' | ')} |`;
  const out: string[] = [];
  rows.forEach((r, i) => {
    out.push(line(r.cells));
    if (i === 0 && r.head) out.push(line(Array(width).fill('---')));
  });
  return `\n\n${caption ? `${caption}\n\n` : ''}${out.join('\n')}\n\n`;
}

function renderEl(el: El, ctx: Ctx): string {
  if (DROP.has(el.tag) || isHidden(el)) return '';
  const tag = el.tag;
  switch (tag) {
    case 'br':
      return ctx.inPre ? '\n' : '\n';
    case 'hr':
      return '\n\n---\n\n';
    case 'img': {
      const alt = cleanInline(el.attrs.alt ?? '');
      return alt ? ` ${alt} ` : '';
    }
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      const t = inline(el, ctx);
      return t ? `\n\n${'#'.repeat(Number(tag[1]))} ${t}\n\n` : '';
    }
    case 'p':
    case 'div':
    case 'section':
    case 'article':
    case 'main':
    case 'header':
    case 'footer':
    case 'nav':
    case 'aside':
    case 'figure':
    case 'figcaption':
    case 'address':
    case 'center':
    case 'details':
    case 'summary':
    case 'fieldset':
    case 'legend':
    case 'form':
    case 'hgroup':
    case 'caption':
      return block(renderChildren(el, ctx));
    case 'ul':
    case 'ol':
    case 'menu':
      return renderList(el, ctx);
    case 'li':
      return block(`- ${renderChildren(el, ctx).trim()}`);
    case 'dl':
      return block(renderChildren(el, ctx));
    case 'dt':
      return `\n\n**${inline(el, ctx)}**\n`;
    case 'dd':
      return `\n${tidy(renderChildren(el, ctx))}\n`;
    case 'blockquote': {
      const body = tidy(renderChildren(el, ctx));
      return body ? `\n\n${body.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n')}\n\n` : '';
    }
    case 'pre': {
      const code = find(el, (e) => e.tag === 'code');
      const cls = `${code?.attrs.class ?? ''} ${el.attrs.class ?? ''}`;
      const lang = /(?:^|\s)(?:language|lang)-([\w+#-]+)/.exec(cls)?.[1] ?? '';
      const raw = preText(el).replace(/^\n/, '').replace(/\s+$/, '');
      if (!raw.trim()) return '';
      const fence = raw.includes('```') ? '~~~~' : '```';
      ctx.pres.push(`${fence}${lang}\n${raw}\n${fence}`);
      return `\n\n\u0000${ctx.pres.length - 1}\u0000\n\n`;
    }
    case 'code':
    case 'kbd':
    case 'samp':
    case 'tt': {
      if (ctx.inPre) return textOf(el);
      const t = cleanInline(textOf(el));
      if (!t) return '';
      const tick = t.includes('`') ? '``' : '`';
      return `${tick}${tick === '``' ? ' ' : ''}${t}${tick === '``' ? ' ' : ''}${tick}`;
    }
    case 'strong':
    case 'b':
      return wrap(renderChildren(el, ctx), '**');
    case 'em':
    case 'i':
    case 'cite':
      return wrap(renderChildren(el, ctx), '*');
    case 'del':
    case 's':
    case 'strike':
      return wrap(renderChildren(el, ctx), '~~');
    case 'a': {
      const was = ctx.inLink;
      ctx.inLink = true;
      const raw = renderChildren(el, ctx);
      const t = cleanInline(raw);
      const href = el.attrs.href ? absoluteUrl(el.attrs.href, ctx) : null;
      const lead = /^\s/.test(raw) ? ' ' : '';
      const trail = /\s$/.test(raw) ? ' ' : '';
      if (!href || was || !t) {
        ctx.inLink = was;
        return t ? `${lead}${t}${trail}` : lead || trail;
      }
      ctx.inLink = was;
      return `${lead}[${escapeLinkText(t)}](${href.replace(/\)/g, '%29').replace(/ /g, '%20')})${trail}`;
    }
    case 'table':
      return renderTable(el, ctx);
    case 'tr':
    case 'td':
    case 'th':
    case 'thead':
    case 'tbody':
    case 'tfoot':
      // Outside a table: their text
      return block(renderChildren(el, ctx));
    default:
      return BLOCK.has(tag) ? block(renderChildren(el, ctx)) : renderChildren(el, ctx);
  }
}

/** A pre's text as written: tags dropped, line breaks kept. */
function preText(el: El): string {
  let out = '';
  for (const c of el.children) {
    if (typeof c === 'string') out += c;
    else if (c.tag === 'br') out += '\n';
    else if (!DROP.has(c.tag)) out += preText(c);
  }
  return out;
}

/** Whitespace tidied outside pre blocks: spaces collapsed, lines trimmed, at most one blank line in a row. */
function tidy(s: string): string {
  return s
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface Converted {
  title: string;
  markdown: string;
}

/**
 * Converts a page to Markdown. `url` makes links absolute (a <base href> on the page wins). The content is the
 * page's <main> (or role=main) when it has one, else its largest <article>, else its <body>.
 */
export function htmlToMarkdown(html: string, url?: string): Converted {
  const root = parseHtml(html);
  const titleEl = find(root, (e) => e.tag === 'title');
  const ogTitle = find(root, (e) => e.tag === 'meta' && (e.attrs.property === 'og:title' || e.attrs.name === 'og:title'));
  let base: URL | null = null;
  try {
    base = url ? new URL(url) : null;
  } catch {
    base = null;
  }
  const baseEl = find(root, (e) => e.tag === 'base' && !!e.attrs.href);
  if (baseEl) {
    try {
      const b = new URL(baseEl.attrs.href, base ?? undefined);
      if (b.protocol === 'http:' || b.protocol === 'https:') base = b;
    } catch {
      /* keep the page's own */
    }
  }
  const visible = (e: El): boolean => {
    for (let n: El | null = e; n; n = n.parent) if (DROP.has(n.tag) || isHidden(n)) return false;
    return true;
  };
  let content: El | null = find(root, (e) => (e.tag === 'main' || e.attrs.role === 'main') && visible(e));
  if (!content) {
    const articles = [...walk(root)].filter((e) => e.tag === 'article' && visible(e));
    if (articles.length) content = articles.reduce((a, b) => (textOf(b).length > textOf(a).length ? b : a));
  }
  // A <main> with next to no text (a shell the page fills by script) is not trusted: the body is read instead
  if (content && cleanInline(textOf(content)).length < 40) content = null;
  content ??= find(root, (e) => e.tag === 'body') ?? root;
  const ctx: Ctx = { base, pres: [], inPre: false, inLink: false };
  let md = tidy(renderEl(content === root ? { ...root, tag: 'div' } : content, ctx));
  md = md.replace(/\u0001/g, ' ');
  md = md.replace(/\u0000(\d+)\u0000/g, (_m, n: string) => ctx.pres[Number(n)] ?? '');
  let title = cleanInline(titleEl ? textOf(titleEl) : '') || cleanInline(ogTitle?.attrs.content ?? '');
  if (!title) {
    const h1 = find(content, (e) => e.tag === 'h1');
    title = h1 ? cleanInline(textOf(h1)) : '';
  }
  return { title, markdown: md };
}
