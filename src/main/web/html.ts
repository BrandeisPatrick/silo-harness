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
  /** Levels below the root (the root is 0); never more than MAX_DEPTH */
  depth: number;
}
type Node = El | string;

// Limits that keep a hostile page from freezing the main process. Real pages stay far inside them.
/** Deepest an element sits in the tree: one opened deeper is kept, but its content goes to its parent */
const MAX_DEPTH = 256;
/** Elements in one tree: past this, start tags are ignored and their text flows into the open element */
const MAX_ELEMENTS = 300_000;

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
/** CLOSED_BY turned round: the open elements a start tag closes */
const CLOSES = new Map<string, Set<string>>();
for (const [open, by] of Object.entries(CLOSED_BY)) {
  for (const t of by) {
    if (!CLOSES.has(t)) CLOSES.set(t, new Set());
    CLOSES.get(t)!.add(open);
  }
}
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

const NAME_RE = /[A-Za-z][A-Za-z0-9:-]*/y;
const TAG_END_RE = /[>"']/g;

/**
 * Where tags end. From a tag's name on, the first ">" ends it, but a quote, wherever it stands, runs to the next
 * quote of its kind and a ">" inside does not count; a quote with no partner means the tag never ends. Scanned by
 * hand rather than by one regex, which on a failed match backtracks over the rest of the page, and with what failed
 * remembered: a "<" that starts no tag is text and the scan goes on from the next "<", so without that memory every
 * "<" before an unpartnered quote would scan the rest of the page again.
 */
class TagEnds {
  /** Quotes from which the scan is known to fail (made on the first failure) */
  private failed: Uint8Array | null = null;
  /** The last search from a tag's name: from where, and the first ">" or quote it found (-1: none to the end) */
  private from = -1;
  private found = -1;
  constructor(private readonly s: string) {}

  private special(from: number): number {
    TAG_END_RE.lastIndex = from;
    return TAG_END_RE.exec(this.s)?.index ?? -1;
  }

  /** The ">" ending a tag whose name ends at `from`, or -1 when it never ends */
  find(from: number): number {
    // Names are found in page order, so one search answers every name between its start and what it found
    let q: number;
    if (this.from >= 0 && from >= this.from && (this.found < 0 || from <= this.found)) q = this.found;
    else {
      q = this.special(from);
      this.from = from;
      this.found = q;
    }
    const passed: number[] = [];
    for (;;) {
      if (q < 0 || this.failed?.[q]) break;
      const ch = this.s[q];
      if (ch === '>') return q;
      passed.push(q);
      const close = this.s.indexOf(ch, q + 1);
      if (close < 0) break;
      q = this.special(close + 1);
    }
    // Every quote this scan passed leads to the same failure
    if (passed.length) {
      this.failed ??= new Uint8Array(this.s.length);
      for (const p of passed) this.failed[p] = 1;
    }
    return -1;
  }
}

/** The tag at `i` (a "<" then a name, "/" first for an end tag): its name, its attribute text and where it ends */
function scanTag(s: string, i: number, ends: TagEnds): { end: boolean; name: string; attrs: string; next: number } | null {
  const end = s[i + 1] === '/';
  NAME_RE.lastIndex = i + (end ? 2 : 1);
  const name = NAME_RE.exec(s)?.[0];
  if (!name) return null;
  const from = NAME_RE.lastIndex;
  const gt = ends.find(from);
  return gt < 0 ? null : { end, name, attrs: s.slice(from, gt), next: gt + 1 };
}

/** The open elements, root first, with where each tag name and each scope boundary stands, so no step walks them */
class OpenStack {
  readonly els: El[];
  private readonly at = new Map<string, number[]>();
  private readonly scopes: number[] = [];
  constructor(root: El) {
    this.els = [root];
  }
  get cur(): El {
    return this.els[this.els.length - 1];
  }
  push(el: El): void {
    const k = this.els.length;
    this.els.push(el);
    let list = this.at.get(el.tag);
    if (!list) this.at.set(el.tag, (list = []));
    list.push(k);
    if (SCOPE.has(el.tag)) this.scopes.push(k);
  }
  /** Closes everything from index `k` up */
  popTo(k: number): void {
    while (this.els.length > Math.max(k, 1)) {
      const el = this.els.pop()!;
      this.at.get(el.tag)!.pop();
      if (SCOPE.has(el.tag)) this.scopes.pop();
    }
  }
  /** An end tag: closes the nearest open element of that name, not crossing a scope boundary of another kind */
  end(tag: string): void {
    const k = this.at.get(tag)?.at(-1);
    if (k === undefined) return;
    if (!SCOPE.has(tag) && (this.scopes.at(-1) ?? 0) > k) return;
    this.popTo(k);
  }
  /**
   * Implied end tags for a start tag: from the current element down to the first scope boundary it does not close,
   * the outermost element it closes is closed, with everything inside it.
   */
  implyEnd(tag: string): void {
    const closes = CLOSES.get(tag);
    if (!closes) return;
    let s = this.scopes.length - 1;
    while (s >= 0 && closes.has(this.els[this.scopes[s]].tag)) s--;
    const bound = s >= 0 ? this.scopes[s] : 0;
    let outer = -1;
    for (const t of closes) {
      const list = this.at.get(t);
      if (!list) continue;
      for (let j = list.length - 1; j >= 0 && list[j] > bound; j--) if (outer < 0 || list[j] < outer) outer = list[j];
    }
    if (outer > 0) this.popTo(outer);
  }
}

/** Parses HTML into a tree under a synthetic root. Never throws: broken markup becomes text or is closed where it can. */
export function parseHtml(html: string): El {
  const root: El = { tag: '#root', attrs: {}, children: [], parent: null, depth: 0 };
  const stack = new OpenStack(root);
  // The renderer's own markers (pre blocks, list indentation) never come from the page
  const s = String(html ?? '').replace(/[\u0000\u0001]/g, '');
  const ends = new TagEnds(s);
  let i = 0;
  let count = 0;
  const text = (t: string) => {
    if (t) stack.cur.children.push(decodeEntities(t));
  };
  /** Where a raw element's text ends and the tag after it: one scan, to the end of the page at worst */
  const rawEnd = (tag: string, from: number): { body: number; next: number } => {
    if (tag === 'plaintext') return { body: s.length, next: s.length };
    const close = new RegExp(`</${tag}\\s*>`, 'ig');
    close.lastIndex = from;
    const cm = close.exec(s);
    return cm ? { body: cm.index, next: cm.index + cm[0].length } : { body: s.length, next: s.length };
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
      stack.cur.children.push(s.slice(i + 9, end < 0 ? s.length : end));
      i = end < 0 ? s.length : end + 3;
      continue;
    }
    if (s[i + 1] === '!' || s[i + 1] === '?') {
      const end = s.indexOf('>', i);
      i = end < 0 ? s.length : end + 1;
      continue;
    }
    const m = scanTag(s, i, ends);
    if (!m) {
      // A lone "<", or one whose tag never ends: text
      text('<');
      i++;
      continue;
    }
    i = m.next;
    const tag = m.name.toLowerCase();
    if (m.end) {
      stack.end(tag);
      continue;
    }
    if (count >= MAX_ELEMENTS) {
      // Over budget: the tag is ignored, but a raw element's text is still not read as markup
      if (RAW.has(tag)) i = rawEnd(tag, i).next;
      continue;
    }
    count++;
    stack.implyEnd(tag);
    const parent = stack.cur;
    const el: El = { tag, attrs: parseAttrs(m.attrs), children: [], parent, depth: parent.depth + 1 };
    parent.children.push(el);
    const selfClosing = /\/\s*$/.test(m.attrs);
    if (VOID.has(tag) || (selfClosing && (tag === 'svg' || tag.includes(':') || tag === 'path'))) continue;
    if (RAW.has(tag)) {
      const r = rawEnd(tag, i);
      const body = s.slice(i, r.body);
      if (body) el.children.push(tag === 'title' || tag === 'textarea' ? decodeEntities(body) : body);
      i = r.next;
      continue;
    }
    // At the depth cap the element stays in the tree, but what follows goes into its parent
    if (el.depth < MAX_DEPTH) stack.push(el);
  }
  return root;
}

// ---------- Finding things ----------

/** Every element under `el`, in document order. With `skip`, an element it matches is left out with all it holds. */
export function* walk(el: El, skip?: (e: El) => boolean): Generator<El> {
  // An explicit stack of child lists and positions: no recursion however deep the tree
  const lists: Node[][] = [el.children];
  const at: number[] = [0];
  while (lists.length) {
    const top = lists.length - 1;
    const kids = lists[top];
    if (at[top] >= kids.length) {
      lists.pop();
      at.pop();
      continue;
    }
    const c = kids[at[top]++];
    if (typeof c === 'string' || skip?.(c)) continue;
    yield c;
    if (c.children.length) {
      lists.push(c.children);
      at.push(0);
    }
  }
}

function find(root: El, pred: (e: El) => boolean): El | null {
  for (const e of walk(root)) if (pred(e)) return e;
  return null;
}

/** The text under an element, in document order, leaving out what is never shown */
export function textOf(el: El): string {
  let out = '';
  const lists: Node[][] = [el.children];
  const at: number[] = [0];
  while (lists.length) {
    const top = lists.length - 1;
    if (at[top] >= lists[top].length) {
      lists.pop();
      at.pop();
      continue;
    }
    const c = lists[top][at[top]++];
    if (typeof c === 'string') out += c;
    else if (!DROP.has(c.tag)) {
      lists.push(c.children);
      at.push(0);
    }
  }
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
  /** Quotes, lists and definitions being rendered inside one another (each prefixes or re-tidies all it holds) */
  blockNest: number;
  /** Emphasis, links, headings and tables being rendered inside one another (each re-cleans all it holds) */
  markNest: number;
  /** Characters links may still add over their href as written (making a short href absolute can add a lot) */
  linkRoom: number;
}

/**
 * Levels of one kind of nesting that are formatted: deeper ones render as plain content, so the work and the
 * prefixes added per line stop growing with the depth.
 */
const NEST_CAP = 8;

/** Renders with `full` while under the cap for that kind of nesting, else with `plain` */
function nested(ctx: Ctx, kind: 'blockNest' | 'markNest', full: () => string, plain: () => string): string {
  if (ctx[kind] >= NEST_CAP) return plain();
  ctx[kind]++;
  try {
    return full();
  } finally {
    ctx[kind]--;
  }
}

/** Whether a string ends in whitespace, without a regex that tries every position */
const endsInSpace = (s: string): boolean => s.length > 0 && /\s/.test(s[s.length - 1]);

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
  const trail = endsInSpace(raw) ? ' ' : '';
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

/** A list past the nesting cap: its items as plain blocks, without markers (the levels around it indent them) */
function plainList(el: El, ctx: Ctx): string {
  let out = '';
  for (const c of el.children) {
    if (typeof c === 'string') out += c.replace(/[\s\u00a0]+/g, ' ');
    else if (c.tag === 'li') out += isHidden(c) ? '' : block(renderChildren(c, ctx));
    else out += renderEl(c, ctx);
  }
  return block(out);
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
  // Short rows are padded to the widest, unless that would add more empty cells than the table has cells: one wide
  // row over many short ones would otherwise multiply the table's size
  let width = 0;
  let cellCount = 0;
  for (const r of rows) {
    width = Math.max(width, r.cells.length);
    cellCount += r.cells.length;
  }
  const padTo = width * rows.length - cellCount <= cellCount ? width : 0;
  const line = (cells: string[]) => `| ${[...cells, ...Array(Math.max(0, padTo - cells.length)).fill('')].join(' | ')} |`;
  const out: string[] = [];
  rows.forEach((r, i) => {
    out.push(line(r.cells));
    if (i === 0 && r.head) out.push(line(Array(Math.max(padTo, r.cells.length)).fill('---')));
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
    case 'h6':
      return nested(
        ctx,
        'markNest',
        () => {
          const t = inline(el, ctx);
          return t ? `\n\n${'#'.repeat(Number(tag[1]))} ${t}\n\n` : '';
        },
        () => block(renderChildren(el, ctx)),
      );
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
      return nested(ctx, 'blockNest', () => renderList(el, ctx), () => plainList(el, ctx));
    case 'li':
      return block(`- ${renderChildren(el, ctx).trim()}`);
    case 'dl':
      return block(renderChildren(el, ctx));
    case 'dt':
      return nested(ctx, 'markNest', () => `\n\n**${inline(el, ctx)}**\n`, () => block(renderChildren(el, ctx)));
    case 'dd':
      return nested(ctx, 'blockNest', () => `\n${tidy(renderChildren(el, ctx))}\n`, () => `\n${renderChildren(el, ctx)}\n`);
    case 'blockquote':
      return nested(
        ctx,
        'blockNest',
        () => {
          const body = tidy(renderChildren(el, ctx));
          return body ? `\n\n${body.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n')}\n\n` : '';
        },
        () => block(renderChildren(el, ctx)),
      );
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
      return nested(ctx, 'markNest', () => wrap(renderChildren(el, ctx), '**'), () => renderChildren(el, ctx));
    case 'em':
    case 'i':
    case 'cite':
      return nested(ctx, 'markNest', () => wrap(renderChildren(el, ctx), '*'), () => renderChildren(el, ctx));
    case 'del':
    case 's':
    case 'strike':
      return nested(ctx, 'markNest', () => wrap(renderChildren(el, ctx), '~~'), () => renderChildren(el, ctx));
    case 'a':
      return nested(ctx, 'markNest', () => renderLink(el, ctx), () => renderChildren(el, ctx));
    case 'table':
      return nested(ctx, 'markNest', () => renderTable(el, ctx), () => block(renderChildren(el, ctx)));
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

function renderLink(el: El, ctx: Ctx): string {
  const was = ctx.inLink;
  ctx.inLink = true;
  const raw = renderChildren(el, ctx);
  ctx.inLink = was;
  const t = cleanInline(raw);
  const lead = /^\s/.test(raw) ? ' ' : '';
  const trail = endsInSpace(raw) ? ' ' : '';
  const asText = t ? `${lead}${t}${trail}` : lead || trail;
  // What the URL adds over the href as written comes out of a budget the size of the page: a long <base> under
  // many short links would otherwise make the Markdown many times the page, and resolving each one against it
  // would take as long. Once a link does not fit, the rest are text too.
  if (was || !t || !el.attrs.href || ctx.linkRoom <= 0) return asText;
  const href = absoluteUrl(el.attrs.href, ctx);
  if (!href) return asText;
  const dest = href.replace(/\)/g, '%29').replace(/ /g, '%20');
  const growth = Math.max(0, dest.length - el.attrs.href.length);
  if (growth > ctx.linkRoom) {
    ctx.linkRoom = 0;
    return asText;
  }
  ctx.linkRoom -= growth;
  return `${lead}[${escapeLinkText(t)}](${dest})${trail}`;
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

/**
 * The last guard on size: what is left of the ways markup can grow (list numbers, quote prefixes, header lines) is
 * bounded per level, but a page made of nothing else could still come out a few times its size. Cut at a line end.
 */
function capLength(md: string, max: number): string {
  if (md.length <= max) return md;
  const cut = md.lastIndexOf('\n', max);
  return md.slice(0, cut > max / 2 ? cut : max).trimEnd();
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
  // Visible means neither the element nor anything around it is dropped or hidden: a walk that skips those subtrees
  const unseen = (e: El): boolean => DROP.has(e.tag) || isHidden(e);
  let content: El | null = null;
  for (const e of walk(root, unseen)) {
    if (e.tag === 'main' || e.attrs.role === 'main') {
      content = e;
      break;
    }
  }
  if (!content) {
    // An article inside another never has more text than it, so only the outermost are measured, each once
    const articles = [...walk(root, (e) => unseen(e) || e.parent?.tag === 'article')].filter((e) => e.tag === 'article');
    let most = -1;
    for (const a of articles) {
      const n = textOf(a).length;
      if (n > most) [content, most] = [a, n];
    }
  }
  // A <main> with next to no text (a shell the page fills by script) is not trusted: the body is read instead
  if (content && cleanInline(textOf(content)).length < 40) content = null;
  content ??= find(root, (e) => e.tag === 'body') ?? root;
  const size = String(html ?? '').length;
  const ctx: Ctx = { base, pres: [], inPre: false, inLink: false, blockNest: 0, markNest: 0, linkRoom: size };
  let md = tidy(renderEl(content === root ? { ...root, tag: 'div' } : content, ctx));
  md = md.replace(/\u0001/g, ' ');
  md = md.replace(/\u0000(\d+)\u0000/g, (_m, n: string) => ctx.pres[Number(n)] ?? '');
  md = capLength(md, 2 * size + 1000);
  let title = cleanInline(titleEl ? textOf(titleEl) : '') || cleanInline(ogTitle?.attrs.content ?? '');
  if (!title) {
    const h1 = find(content, (e) => e.tag === 'h1');
    title = h1 ? cleanInline(textOf(h1)) : '';
  }
  return { title, markdown: md };
}
