// Silo Harness remote: follow and steer the app's sessions from a phone. Plain script, no framework, no build step,
// nothing from the network. Served by the app under /r/<token>/, so every URL here is relative.
//
// How the view stays exact: the page opens the event stream first, then loads a snapshot of the session
// (api/transcript: finished items plus what is in flight). The snapshot answers with the number of the last event it
// covers; streamed events carry their own numbers, so the page applies only those after the snapshot. Nothing is
// missed and nothing shows twice, on load, on a session switch and after a reconnect.
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const el = {
    title: $('title'),
    mark: $('mark'),
    model: $('model'),
    conn: $('conn'),
    scroll: $('scroll'),
    transcript: $('transcript'),
    input: $('input'),
    send: $('send'),
    stop: $('stop'),
    statusText: $('status-text'),
    queue: $('queue'),
    tasks: $('tasks'),
    toast: $('toast'),
    sheet: $('sheet'),
    list: $('session-list'),
  };

  // ---------------------------------------------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------------------------------------------

  const S = {
    sessions: [],
    /** The session on the Mac's screen */
    foreground: '',
    /** The session this page shows */
    current: '',
    /** Meta of the current session when the list does not hold it (a brand-new empty session) */
    localMeta: null,
    running: false,
    /** Events of the current session up to this number are already in the view; null while a snapshot loads */
    seq: null,
    buffered: [],
    loadId: 0,
    queue: [],
    dead: false,
  };

  /** The live parts of the view, reset with every snapshot */
  let V = freshView();
  function freshView() {
    // attempt: the reply and thinking nodes of the model call in flight (a failed attempt's go); retry: the status text
    // while a failed call waits to be tried again
    return { assistant: null, assistantText: '', thinking: null, thinkingText: '', attempt: [], retry: null, tools: new Map(), approvals: new Map(), questions: new Map(), plans: new Map(), compacting: null, pendingPrs: [], pendingDocs: [] };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------------------------------------------

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

  function h(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html !== undefined) n.innerHTML = html;
    return n;
  }

  const ICONS = {
    chevron: '<path d="m9 18 6-6-6-6"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    question: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
    shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
    plan: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
    list: '<path d="M13 5h8"/><path d="M13 12h8"/><path d="M13 19h8"/><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/>',
    think: '<path d="M12 18V5"/><path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4"/><path d="M17.6 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.6 1.5"/><path d="M18 18a4 4 0 0 0 2-7.46"/><path d="M6 18a4 4 0 0 1-2-7.46"/><path d="M6 18a4 4 0 0 0 6 2 4 4 0 0 0 6-2"/>',
  };
  const icon = (name, size = 16) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

  function parseArgs(args) {
    if (args && typeof args === 'object') return args;
    if (typeof args !== 'string') return {};
    try {
      const v = JSON.parse(args);
      return v && typeof v === 'object' ? v : {};
    } catch {
      return {};
    }
  }

  const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  function ago(ms) {
    const d = Date.now() - ms;
    if (d < 60_000) return 'just now';
    if (d < 3_600_000) return `${Math.floor(d / 60_000)} min ago`;
    if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} h ago`;
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Markdown: a small renderer of our own. Text is escaped before any markup is added, links only to http(s)/mailto.
  // ---------------------------------------------------------------------------------------------------------------

  function emphasis(html) {
    return html
      .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
      .replace(/__(?=\S)([\s\S]*?\S)__/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*\w])/g, '$1<em>$2</em>')
      .replace(/(^|[^_\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?![_\w])/g, '$1<em>$2</em>')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
  }

  const SAFE_URL = /^(https?:\/\/|mailto:)/i;
  const link = (url, labelHtml) => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${labelHtml}</a>`;

  /** Links and bare URLs in a stretch of raw text without code spans */
  function inlineText(src) {
    const re = /\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"\n]*")?\)|\bhttps?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]]/g;
    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(src))) {
      out += emphasis(esc(src.slice(last, m.index)));
      if (m[1] !== undefined) out += SAFE_URL.test(m[2]) ? link(m[2], emphasis(esc(m[1]))) : emphasis(esc(m[0]));
      else out += link(m[0], esc(m[0]));
      last = re.lastIndex;
    }
    return out + emphasis(esc(src.slice(last)));
  }

  function inline(src) {
    const re = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g;
    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(src))) {
      out += inlineText(src.slice(last, m.index)) + `<code>${esc(m[2].replace(/^ (.+) $/, '$1'))}</code>`;
      last = re.lastIndex;
    }
    return (out + inlineText(src.slice(last))).replace(/\n/g, '<br>');
  }

  const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;
  const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
  const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
  const QUOTE = /^\s{0,3}>/;
  const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const TABLE = /^\s*\|.*\|\s*$/;
  const indentOf = (s) => /^\s*/.exec(s)[0].replace(/\t/g, '    ').length;
  const startsBlock = (s) => FENCE.test(s) || HEADING.test(s) || HR.test(s) || QUOTE.test(s) || ITEM.test(s);

  function markdown(src) {
    return blocks(String(src).replace(/\r\n?/g, '\n').split('\n'));
  }

  function blocks(lines) {
    let html = '';
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      let m;
      if (!line.trim()) {
        i++;
      } else if ((m = FENCE.exec(line))) {
        const fence = m[1];
        const code = [];
        i++;
        // An unclosed fence runs to the end: that is what a code block looks like while it streams in.
        while (i < lines.length && !new RegExp(`^\\s{0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(lines[i])) code.push(lines[i++]);
        i++;
        html += `<pre${m[2] ? ` data-lang="${esc(m[2])}"` : ''}><code>${esc(code.join('\n'))}</code></pre>`;
      } else if ((m = HEADING.exec(line))) {
        html += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`;
        i++;
      } else if (HR.test(line)) {
        html += '<hr>';
        i++;
      } else if (QUOTE.test(line)) {
        const inner = [];
        while (i < lines.length && QUOTE.test(lines[i])) inner.push(lines[i++].replace(/^\s{0,3}> ?/, ''));
        html += `<blockquote>${blocks(inner)}</blockquote>`;
      } else if (ITEM.test(line)) {
        const [out, next] = list(lines, i);
        html += out;
        i = next;
      } else if (TABLE.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
        // Tables stay as aligned text in a scrollable block: readable on a narrow screen without a grid.
        const rows = [];
        while (i < lines.length && TABLE.test(lines[i])) rows.push(lines[i++].trim());
        html += `<pre>${esc(rows.join('\n'))}</pre>`;
      } else {
        const para = [];
        while (i < lines.length && lines[i].trim() && !(para.length && startsBlock(lines[i]))) para.push(lines[i++]);
        html += `<p>${inline(para.map((l) => l.trim()).join('\n'))}</p>`;
      }
    }
    return html;
  }

  function list(lines, i) {
    const first = ITEM.exec(lines[i]);
    const indent = indentOf(first[1]);
    const ordered = /\d/.test(first[2]);
    const items = [];
    while (i < lines.length) {
      const line = lines[i];
      const m = ITEM.exec(line);
      if (m && Math.abs(indentOf(m[1]) - indent) <= 1 && /\d/.test(m[2]) === ordered) {
        items.push([m[3]]);
        i++;
      } else if (!line.trim()) {
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j >= lines.length) break;
        const n = ITEM.exec(lines[j]);
        if (indentOf(lines[j]) > indent + 1 || (n && Math.abs(indentOf(n[1]) - indent) <= 1 && /\d/.test(n[2]) === ordered)) {
          if (indentOf(lines[j]) > indent + 1) items[items.length - 1].push('');
          i = j;
        } else break;
      } else if (indentOf(line) > indent + 1) {
        items[items.length - 1].push(line);
        i++;
      } else if (!m && !startsBlock(line)) {
        items[items.length - 1].push(line.trim()); // a lazy continuation line
        i++;
      } else break;
    }
    const body = items
      .map((lines) => {
        let text = lines.shift();
        while (lines.length && lines[0].trim() && !startsBlock(lines[0])) text += '\n' + lines.shift().trim();
        const pad = Math.min(...lines.filter((l) => l.trim()).map(indentOf), Infinity);
        const rest = lines.map((l) => l.slice(Number.isFinite(pad) ? pad : 0));
        const task = /^\[([ xX])\]\s+/.exec(text);
        const head = task ? `<span aria-hidden="true">${task[1] === ' ' ? '☐' : '☑'}</span> ${inline(text.slice(task[0].length))}` : inline(text);
        return `<li>${head}${rest.some((l) => l.trim()) ? blocks(rest) : ''}</li>`;
      })
      .join('');
    const start = ordered ? parseInt(first[2], 10) : 1;
    return [ordered ? `<ol${start !== 1 ? ` start="${start}"` : ''}>${body}</ol>` : `<ul>${body}</ul>`, i];
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Talking to the app
  // ---------------------------------------------------------------------------------------------------------------

  async function api(path, body) {
    const init = { cache: 'no-store', referrerPolicy: 'no-referrer', credentials: 'omit' };
    if (body !== undefined) {
      init.method = 'POST';
      init.headers = { 'content-type': 'application/json', 'x-silo-harness-remote': '1' };
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch('api/' + path, init);
    } catch {
      throw new Error('Could not reach your Mac.');
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* bare answers have no body */
    }
    if (!res.ok) {
      if (res.status === 404 && !data) linkDead();
      const err = new Error((data && data.error) || (res.status === 429 ? 'Too many tries. Wait a minute.' : `Request failed (${res.status}).`));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  let toastTimer = 0;
  function toast(text) {
    el.toast.textContent = text;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.toast.hidden = true), 5000);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Scrolling: follow the bottom while the reader is there, leave them alone when they scrolled up
  // ---------------------------------------------------------------------------------------------------------------

  // The view is pinned to the bottom until the reader scrolls up. Content growing (streamed text) and the viewport
  // shrinking (the keyboard, the tasks strip, a queued message) both keep a pinned view at the bottom.
  const atBottom = () => el.scroll.scrollHeight - el.scroll.scrollTop - el.scroll.clientHeight < 80;
  let pinned = true;
  el.scroll.addEventListener('scroll', () => (pinned = atBottom()), { passive: true });
  const toBottom = () => {
    if (pinned) el.scroll.scrollTop = el.scroll.scrollHeight;
  };
  const resized = new ResizeObserver(toBottom);
  resized.observe(el.scroll);
  resized.observe(el.transcript);
  function stick(fn) {
    fn();
    toBottom();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Transcript pieces
  // ---------------------------------------------------------------------------------------------------------------

  const ORIGIN_LABEL = { remote: 'Sent from this device', schedule: 'From a schedule', session: 'From another session', mod: 'From a mod', command: 'From a command' };

  // A sub-session's report, a message from another session, a merged summary and a scheduled prompt reach the
  // conversation inside a frame written for the model (the sender's id, which tools to use next). The page shows
  // what was said, as the desktop window does: these are the patterns of src/renderer/origin.ts there, and
  // test/live/remote-page.js runs the frames the app really writes through both.
  const FRAME = {
    report: /^\[Sub-session "([\s\S]*?)" \([\w-]+\) finished a turn: ([^\]\n]+)\]\n([\s\S]*?)\n\nNext: read more with session_read[^\n]*$/,
    message: /^\[Message from (?:another session|session "([\s\S]*?)" \([\w-]+\))[^\]\n]*\]\n([\s\S]*)$/,
    merged: /^\[Merged from "[\s\S]*?"\]\n\n([\s\S]*)$/,
    scheduled: /^\[Scheduled task "[\s\S]*?" \([^\n]*\)\. This message was sent automatically[^\n]*\]\n[^\n]*\n\n([\s\S]*)$/,
  };

  function unframe(origin, text) {
    const raw = String(text == null ? '' : text);
    let m = null;
    if (origin === 'session') {
      if ((m = FRAME.report.exec(raw))) return { text: m[3].trim(), note: m[2] === 'done' ? 'finished a turn' : m[2], sender: m[1] };
      if ((m = FRAME.message.exec(raw))) return { text: m[2].trim(), sender: m[1] };
    } else if (origin === 'command') {
      if ((m = FRAME.merged.exec(raw))) return { text: m[1].trim() };
    } else if (origin === 'schedule') {
      if ((m = FRAME.scheduled.exec(raw))) return { text: m[1].trim() };
    }
    return { text: raw };
  }

  // Messages between sessions, as on the desktop (src/renderer/session-messages.ts): one quiet line that opens to the
  // message. The other session's name switches the page to it while the page knows that session.
  function sessionLink(id, fallback) {
    const known = id && (S.sessions.find((x) => x.id === id) || (S.localMeta && S.localMeta.id === id ? S.localMeta : null));
    const n = h(known ? 'button' : 'span', known ? 'sm-link' : 'sm-name');
    n.textContent = (known && known.title) || fallback || 'another session';
    if (known) {
      n.type = 'button';
      n.dataset.session = id;
    }
    return n;
  }

  function lineEl(cls) {
    const d = h('details', 'session-msg ' + cls);
    const sum = h('summary');
    const words = h('span', 'sm-words');
    sum.append(words);
    sum.insertAdjacentHTML('beforeend', `<span class="chev">${icon('chevron', 14)}</span>`);
    const body = h('div', 'sm-body');
    d.append(sum, body);
    // The name switches the page to that session; the line does not open or shut for that tap
    sum.addEventListener('click', (e) => {
      const link = e.target.closest('.sm-link');
      if (!link) return;
      e.preventDefault();
      switchTo(link.dataset.session);
    });
    return { d, words, body };
  }

  function receivedEl(text, from) {
    const shown = unframe('session', text);
    const { d, words, body } = lineEl('received');
    words.append('Received message from ', sessionLink(from, shown.sender));
    if (shown.note && shown.note !== 'finished a turn') words.append(` · ${shown.note}`);
    body.append(h('div', 'md', markdown(shown.text)));
    return d;
  }

  /** session_send: "Messaging B…", then "Messaged B" or "Message to B not sent"; opens to the message and the outcome */
  function sendEl(args, result, ok) {
    const { d, words, body } = lineEl('sent');
    d._send = { args: parseArgs(args), words, body };
    setSendState(d, result, ok);
    return d;
  }

  function setSendState(d, result, ok) {
    const t = d._send;
    const to = typeof t.args.to === 'string' ? t.args.to : '';
    const message = typeof t.args.message === 'string' ? t.args.message.trim() : '';
    const m = ok ? /^Delivered to "(.*)" \(([^()\n]+)\)(?::\s*([^\n]*))?/.exec(result || '') : null;
    const known = S.sessions.find((x) => x.id === to);
    t.words.textContent = '';
    t.body.textContent = '';
    if (message) t.body.append(h('div', 'md', markdown(message)));
    let detail = '';
    if (ok === undefined) t.words.append('Messaging ', sessionLink(known ? to : '', (known && known.title) || to), '…');
    else if (m) {
      t.words.append('Messaged ', sessionLink(m[2], m[1]));
      const how = (/^[^.]*\.?/.exec(m[3] || '') || [''])[0].trim();
      detail = how ? `Delivered: ${how}` : 'Delivered.';
    } else {
      t.words.append('Message to ', sessionLink(known ? to : '', (known && known.title) || to), ' not sent');
      detail = String(result || '').replace(/^(?:Not sent|Error):\s*/, '').replace(/^Not permitted:\s*/, '');
    }
    if (detail) t.body.append(h('div', 'sm-note', esc(detail)));
  }

  function userEl(text, images, origin, from) {
    if (origin === 'session') return receivedEl(text, from);
    const wrap = h('div', 'msg user');
    const bubble = h('div', 'bubble');
    const shown = unframe(origin, text);
    // Another session's words and a merged summary were written by a model: Markdown, like a reply
    if (origin === 'session' || origin === 'command') {
      bubble.classList.add('md', 'rich');
      bubble.innerHTML = markdown(shown.text);
    } else bubble.textContent = shown.text;
    wrap.append(bubble);
    const notes = [];
    if (images) notes.push(images === 1 ? '1 image (on your Mac)' : `${images} images (on your Mac)`);
    const title = from && sessionName(from) !== from ? sessionName(from) : '';
    if (origin === 'session') notes.push(`${title ? `From session ${title}` : ORIGIN_LABEL.session}${shown.note ? ` · ${shown.note}` : ''}`);
    else if (origin === 'command' && title) notes.push(`Merged from ${title}`);
    else if (origin && ORIGIN_LABEL[origin]) notes.push(ORIGIN_LABEL[origin]);
    if (notes.length) wrap.append(h('div', 'from', esc(notes.join(' · '))));
    return wrap;
  }

  function assistantEl(text) {
    const wrap = h('div', 'msg assistant');
    wrap.append(h('div', 'md', markdown(text)));
    return wrap;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Chat cards: the pull requests and documents a reply or a tool result names go under the reply, as on the desktop
  // (src/renderer/chat-cards-model.ts has the rules; this is a small copy of them). Simpler here: a pull request card
  // has what its URL gives and opens it on GitHub; a document or an artifact says it is on the Mac.
  // ---------------------------------------------------------------------------------------------------------------

  const PR_RE = /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})\/pull\/(\d{1,9})(?!\d)/gi;
  const MAX_PR_CARDS = 3;
  const GH_PR = /(?:^|[\s;&|(])(?:[\w./~-]*\/)?gh\s+pr\s+(?:create|view|new|ready|merge|reopen|edit|status)\b/;
  const DOC_LABELS = { md: 'MD', markdown: 'MD', mdx: 'MD', html: 'HTML', htm: 'HTML', pdf: 'PDF', txt: 'TXT', text: 'TXT' };
  const NOT_DOCS = /^(requirements[\w.-]*|constraints|robots|cmakelists|llms)\.txt$/i;
  // A project's own files (README.md, CHANGELOG.md, CLAUDE.md, …) get no card: the agent keeps them as part of the work
  const PROJECT_FILES = new Set(['readme', 'changelog', 'changes', 'history', 'news', 'contributing', 'license', 'licence', 'notice', 'copying', 'authors', 'contributors', 'code_of_conduct', 'security', 'support', 'third_party_notices', 'claude', 'agents', 'gemini', 'copilot-instructions', 'pull_request_template']);
  // The desktop's own 16px icons (src/renderer/icons.ts): a pull request, a note, a globe, a file
  const CARD_ICONS = {
    pr: '<circle cx="4.5" cy="3.75" r="1.5"/><circle cx="4.5" cy="12.25" r="1.5"/><circle cx="11.5" cy="12.25" r="1.5"/><path d="M4.5 5.25v5.5M11.5 10.75V6.25c0-1.1-.9-2-2-2H7.25M8.75 2.5L7 4.25 8.75 6"/>',
    note: '<path d="M3.75 2.75h8.5c.55 0 1 .45 1 1v5.5l-4 4h-5.5c-.55 0-1-.45-1-1v-8.5c0-.55.45-1 1-1z"/><path d="M13.25 9.25h-3c-.55 0-1 .45-1 1v3"/>',
    globe: '<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c1.6 1.65 2.5 3.8 2.5 6s-.9 4.35-2.5 6c-1.6-1.65-2.5-3.8-2.5-6S6.4 3.65 8 2z"/>',
    file: '<path d="M9 1.75H4.25c-.83 0-1.5.67-1.5 1.5v9.5c0 .83.67 1.5 1.5 1.5h7.5c.83 0 1.5-.67 1.5-1.5V6L9 1.75z"/><path d="M9 1.75V6h4.25"/>',
    code: '<path d="M5.25 4.5L1.75 8l3.5 3.5M10.75 4.5l3.5 3.5-3.5 3.5"/>',
  };
  const cardIcon = (name) =>
    `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${CARD_ICONS[name]}</svg>`;

  /** Every pull request a text names, once each, in order */
  function findPrs(text) {
    const out = [];
    for (const m of String(text || '').matchAll(PR_RE)) {
      const [, owner, repo] = m;
      const number = Number(m[3]);
      if (repo === '.' || repo === '..' || /\.git$/i.test(repo) || !(number >= 1)) continue;
      const url = `https://github.com/${owner}/${repo}/pull/${number}`;
      if (!out.some((r) => r.url.toLowerCase() === url.toLowerCase())) out.push({ owner, repo, number, url });
    }
    return out;
  }

  /** The pull requests a finished call names: gh pr create / view through the shell, or a GitHub tool's */
  function toolPrs(name, args, result, ok) {
    if (!ok) return [];
    const text = String(result || '');
    if (name === 'bash' || name === 'terminal_run') {
      const command = String(parseArgs(args).command || '');
      if (!GH_PR.test(command) || failedExit(name, text)) return [];
      const found = findPrs(`${command}\n${text}`);
      return found.length > MAX_PR_CARDS ? [] : found;
    }
    if (/pull.?request/i.test(name) && !/^\s*Error\b/.test(text)) return findPrs(text).slice(0, 1);
    return [];
  }

  /** The document a write_file made: { name, title, label }, or null */
  function toolDoc(name, args, result, ok) {
    if (name !== 'write_file' || !ok || /^\s*Error\b/.test(String(result || ''))) return null;
    const p = String(parseArgs(args).path || '').trim();
    const file = p.split(/[\\/]/).pop() || '';
    const dot = file.lastIndexOf('.');
    const label = dot > 0 ? DOC_LABELS[file.slice(dot + 1).toLowerCase()] : null;
    if (!label || NOT_DOCS.test(file) || PROJECT_FILES.has(file.slice(0, file.indexOf('.')).toLowerCase()) || /(^|\/)(node_modules|\.git|\.[^/]+)\//.test(p.slice(0, p.length - file.length))) return null;
    const stem = file.slice(0, dot);
    const title = stem !== stem.toLowerCase() ? stem : stem.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
    return { path: p, title, label };
  }

  function fileCardEl(iconName, title, meta) {
    const c = h('div', 'chat-card file');
    c.innerHTML = `<span class="chat-card-tile">${cardIcon(iconName)}</span><span class="chat-card-text"><span class="chat-card-title">${esc(title)}</span><span class="chat-card-meta">${esc(meta)}</span></span>`;
    return c;
  }

  function prCardEl(ref) {
    const a = h('a', 'chat-card pr');
    a.href = ref.url;
    a.target = '_blank';
    a.rel = 'noreferrer';
    a.innerHTML = `<span class="chat-card-tile">${cardIcon('pr')}</span><span class="chat-card-text"><span class="chat-card-title">${esc(`${ref.owner}/${ref.repo} #${ref.number}`)}</span><span class="chat-card-meta">Pull request · opens on GitHub</span></span>`;
    return a;
  }

  const ARTIFACT_LABEL = { html: 'HTML', markdown: 'MD', svg: 'SVG', code: 'Code' };
  function artifactCardEl(a) {
    const block = h('div', 'chat-cards');
    block.append(fileCardEl(a.kind === 'html' ? 'globe' : a.kind === 'markdown' ? 'note' : a.kind === 'svg' ? 'file' : 'code', a.title || 'Untitled artifact', `Artifact · ${ARTIFACT_LABEL[a.kind] || 'Code'} · on your Mac`));
    return block;
  }

  /** A finished call: what it names waits for the next reply */
  function noteTool(name, args, result, ok) {
    for (const ref of toolPrs(name, args, result, ok)) if (!V.pendingPrs.some((r) => r.url === ref.url)) V.pendingPrs.push(ref);
    const doc = toolDoc(name, args, result, ok);
    if (doc && !V.pendingDocs.some((d) => d.path === doc.path)) V.pendingDocs.push(doc);
  }

  /** The block of cards for a reply that ended (with its text) or for calls no reply came after (no text), or null */
  function takeCards(text) {
    const prs = V.pendingPrs;
    const docs = V.pendingDocs;
    V.pendingPrs = [];
    V.pendingDocs = [];
    const named = findPrs(text);
    if (named.length <= MAX_PR_CARDS) for (const ref of named) if (!prs.some((r) => r.url === ref.url)) prs.push(ref);
    if (!prs.length && !docs.length) return null;
    const block = h('div', 'chat-cards');
    for (const ref of prs) block.append(prCardEl(ref));
    for (const d of docs) block.append(fileCardEl(d.label === 'HTML' ? 'globe' : d.label === 'PDF' ? 'file' : 'note', d.title, `Document · ${d.label} · on your Mac`));
    return block;
  }

  function note(text, cls = '') {
    const n = h('div', 'note' + (cls ? ' ' + cls : ''));
    if (cls === 'error') n.innerHTML = icon('alert', 14);
    n.append(document.createTextNode(text));
    return n;
  }

  function thinkingEl(live) {
    const d = h('details', 'thinking');
    d.innerHTML = `<summary><span class="chev">${icon('chevron', 14)}</span>${icon('think', 15)}<span class="label">${live ? 'Thinking…' : 'Thought'}</span></summary><div class="body"></div>`;
    return d;
  }

  function toolLabel(name, a) {
    const s = (k) => (typeof a[k] === 'string' ? a[k] : '');
    const first = () => Object.values(a).find((v) => typeof v === 'string') || '';
    const line = (k) => s(k).split('\n')[0];
    switch (name) {
      case 'read_file': return ['Read', s('path'), true];
      case 'write_file': return ['Write', s('path'), true];
      case 'edit_file': return ['Edit', s('path'), true];
      case 'list_directory': return ['List', s('path') || '.', true];
      case 'glob': return ['Glob', s('pattern'), true];
      case 'grep': return ['Search', s('pattern'), true];
      case 'bash': return ['Bash', line('command'), true];
      case 'terminal_run': return ['Terminal', line('command'), true];
      case 'terminal_read': return ['Read terminal', s('tab_id'), true];
      case 'skill': return ['Skill', '/' + s('name'), true];
      case 'update_tasks': return ['Tasks', '', false];
      case 'create_artifact': return ['Artifact', s('title'), false];
      case 'show_image': return ['Show image', s('path').split(/[\\/]/).pop() || '', true];
      case 'session_spawn': return ['Sub-session', s('title'), false];
      case 'session_send': return ['Message', s('to') ? 'to ' + sessionName(s('to')) : '', false];
      case 'session_list': return ['Sessions', s('query'), false];
      case 'session_read': return ['Read session', sessionName(s('id')), false];
      case 'session_merge': return ['Merge', sessionName(s('id')), false];
      case 'session_rename': return ['Rename session', s('name'), false];
      case 'schedule_create': return ['Schedule', s('name'), false];
      case 'schedule_list': return ['Schedules', '', false];
      // Without a new name in the call, the id stands in until the result names the schedule (scheduleName).
      case 'schedule_update': return ['Update schedule', s('name') || s('id'), false];
      case 'schedule_delete': return ['Delete schedule', s('id'), false];
      case 'mod_check': return ['Check mod', s('id'), true];
      case 'browser_navigate': return ['Open', s('url'), true];
      case 'browser_click': return ['Click', s('element') || s('text') || s('ref'), false];
      case 'browser_type': return ['Type', s('text'), false];
      case 'browser_screenshot': return ['Screenshot', '', false];
      case 'browser_get_text': return ['Read page text', '', false];
      case 'browser_read_page': return ['Read page outline', '', false];
    }
    const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
    if (mcp) return [mcp[2], short(first(), 80), false, mcp[1]];
    if (name.startsWith('browser_')) return [name.slice(8).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()), short(first(), 80), false];
    return [name, short(first(), 80), true];
  }

  /** A session's title from its id; the session tools also accept the exact title, which comes back as it is. */
  function sessionName(v) {
    const m = S.sessions.find((x) => x.id === v) || (S.localMeta && S.localMeta.id === v ? S.localMeta : null);
    return (m && m.title) || v;
  }

  /** The schedule a schedule_update / schedule_delete result names ('Deleted schedule "X" (id).', 'Updated: id  "X"  …') */
  function scheduleName(name, result) {
    if (name !== 'schedule_update' && name !== 'schedule_delete') return '';
    const m = /^(?:Deleted schedule|Updated: \S+ ) ?"([^"\n]+)"/.exec(result || '');
    return m ? m[1] : '';
  }

  /**
   * A shell command's exit code that says it failed, or null. Read the way the desktop reads it (src/renderer/tools.ts):
   * bash ends its result with "[exit code: N]" and any code but 0 is a failure; terminal_run's last line is the same,
   * and only a numeric code counts (it can also end in "still running", "the shell exited" or "exit code unknown").
   */
  function failedExit(name, result) {
    if (name !== 'bash' && name !== 'terminal_run') return null;
    const m = /(?:^|\n)\[exit code: ([^\]\n]+)\]\s*$/.exec(result || '');
    if (!m) return null;
    const code = m[1].trim();
    if (code === '0') return null;
    return name === 'bash' || /^-?\d+$/.test(code) ? code : null;
  }

  /** A one-line tool row; expands to the command and the result. ok: true/false, or undefined while it runs. */
  function toolEl(name, args, result, ok) {
    if (name === 'session_send') return sendEl(args, result, ok);
    const a = parseArgs(args);
    const [verb, arg, mono, server] = toolLabel(name, a);
    const d = h('details', 'tool');
    const sum = h('summary');
    sum.innerHTML =
      `<span class="chev">${icon('chevron', 14)}</span>` +
      `<span class="tool-status"></span>` +
      `<span class="tool-verb">${esc(verb)}</span>` +
      `<span class="tool-arg${mono ? ' mono' : ''}">${esc(arg)}</span>` +
      `<span class="tool-meta">${server ? esc(server) : ''}</span>`;
    d.append(sum);
    d._tool = { name, args: a, result, ok };
    d.addEventListener('toggle', () => d.open && fillTool(d));
    setToolState(d, result, ok);
    return d;
  }

  function setToolState(d, result, ok) {
    if (d._send) return setSendState(d, result, ok);
    d._tool.result = result;
    d._tool.ok = ok;
    const st = d.querySelector('.tool-status');
    if (ok === undefined) {
      st.className = 'tool-status';
      st.innerHTML = '<span class="spinner sm"></span>';
    } else {
      // A command that ran but exited non-zero failed too, as on the desktop: a red mark and "exit N".
      const code = ok ? failedExit(d._tool.name, result) : null;
      const bad = !ok || code !== null;
      d._tool.bad = bad;
      st.className = 'tool-status' + (bad ? ' err' : '');
      st.innerHTML = icon(bad ? 'x' : 'check', 14);
      if (bad) {
        const meta = d.querySelector('.tool-meta');
        meta.className = 'tool-meta err';
        meta.textContent = code !== null ? `exit ${short(code, 24)}` : /^User denied/.test(result || '') ? 'denied' : 'failed';
      }
      const named = scheduleName(d._tool.name, result);
      if (named) d.querySelector('.tool-arg').textContent = named;
    }
    if (d.open) fillTool(d);
  }

  function fillTool(d) {
    const t = d._tool;
    let body = d.querySelector('.tool-body');
    if (!body) d.append((body = h('div', 'tool-body')));
    body.textContent = '';
    const cmd = typeof t.args.command === 'string' ? t.args.command : '';
    if (cmd) body.append(h('pre', 'out', `<span class="label">Command</span>${esc(cmd)}`));
    else if (t.name === 'edit_file' || t.name === 'write_file' || !Object.keys(t.args).length) {
      /* the path is in the row; the result says what happened */
    } else body.append(h('pre', 'out', `<span class="label">Input</span>${esc(JSON.stringify(t.args, null, 2))}`));
    if (t.ok === undefined) body.append(h('pre', 'out', '<span class="label">Running…</span>'));
    else body.append(h('pre', 'out' + (t.bad ? ' error' : ''), esc(t.result || '(no output)')));
  }

  /**
   * A browser tool's card (approval_request.browser: the kind and the site), worded as the desktop words it
   * (tool-labels.ts browserApproval): the site's first approval, an act on a sensitive site, a browser_eval, a purchase,
   * a new account. null for any other card.
   */
  function browserCard(ev) {
    const b = ev && ev.browser && typeof ev.browser === 'object' && typeof ev.browser.card === 'string' ? ev.browser : null;
    if (!b) return null;
    const site = (typeof b.site === 'string' && b.site.trim()) || 'this page';
    switch (b.card) {
      case 'sensitive': return { title: 'Act on a sensitive site?', site };
      case 'eval': return { title: `Run JavaScript on ${site}?`, site };
      case 'purchase': return { title: 'Make a purchase?', site };
      case 'account': return { title: 'Create an account?', site };
      default: return { title: /^[~/]/.test(site) ? 'Let the agent read a local file?' : `Let the agent use ${site}?`, site };
    }
  }

  function approvalTitle(name, detail) {
    if (name === 'bash' || name === 'terminal_run') return 'Run this command?';
    if (name === 'session_send') {
      const to = /^Send to session "(.*)" \([^()\n]+\):/.exec(detail || '');
      return to ? `Send a message to “${to[1]}”?` : 'Send a message to another session?';
    }
    if (name === 'write_file') return 'Write this file?';
    if (name === 'edit_file') return 'Make this edit?';
    const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
    if (mcp) return `Use ${mcp[2]} from ${mcp[1]}?`;
    return `Allow ${name}?`;
  }

  /**
   * A browser card's body, as the desktop draws it: the action, the model's reason in grey under it, a browser_eval's
   * code after a blank line (the detail's own layout), then the amber note of a sensitive or sign-in page.
   */
  function browserBody(ev) {
    const detail = typeof ev.detail === 'string' ? ev.detail : '';
    const gap = detail.indexOf('\n\n');
    const [line, ...rest] = (gap < 0 ? detail : detail.slice(0, gap)).split('\n');
    const why = rest.join(' ').trim();
    const code = gap < 0 ? '' : detail.slice(gap + 2);
    const note = typeof ev.note === 'string' ? ev.note.trim() : '';
    return (
      `<p class="card-action">${esc(line || '')}</p>` +
      (why ? `<p class="card-why">${esc(why)}</p>` : '') +
      (code.trim() ? `<pre class="out">${esc(code)}</pre>` : '') +
      (note ? `<p class="card-note">${icon('alert', 14)}<span>${esc(note)}</span></p>` : '')
    );
  }

  function approvalEl(ev) {
    const card = h('div', 'card approval');
    const browser = browserCard(ev);
    if (browser) card.classList.add('browser');
    // An empty label is a card without that answer (a purchase, an account, a tool's own question): Allow and Deny only
    const sessionLabel = typeof ev.alwaysLabel === 'string' ? ev.alwaysLabel.trim() : 'Allow for this session';
    card.innerHTML =
      `<div class="card-head"><span class="card-icon">${icon(browser ? 'globe' : 'shield', 16)}</span><div class="card-heading">` +
      `<span class="card-kicker">Waiting for you</span><span class="card-title">${esc(browser ? browser.title : approvalTitle(ev.name, ev.detail))}</span></div></div>` +
      (ev.reason ? `<div class="card-reason">${icon('alert', 14)}<span>${esc(ev.reason[0].toUpperCase() + ev.reason.slice(1))}</span></div>` : '') +
      `<div class="card-body">${browser ? browserBody(ev) : `<pre class="out">${esc(ev.detail || '')}</pre>`}</div>` +
      `<div class="card-actions">` +
      `<button type="button" class="btn" data-a="deny">Deny</button>` +
      (sessionLabel ? `<button type="button" class="btn" data-a="session">${esc(sessionLabel)}</button>` : '') +
      `<button type="button" class="btn primary" data-a="once">Allow</button></div>`;
    card.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-a]');
      if (!b) return;
      const a = b.dataset.a;
      card.querySelectorAll('button').forEach((x) => (x.disabled = true));
      try {
        await api('approve', { id: ev.id, ok: a !== 'deny', always: a === 'session' });
        decideApproval(card, a !== 'deny', a === 'session' ? 'session' : 'once');
      } catch (err) {
        if (err.status === 404) decideApproval(card, null);
        else {
          card.querySelectorAll('button').forEach((x) => (x.disabled = false));
          toast(err.message);
        }
      }
    });
    if (browser) card.dataset.site = browser.site;
    return card;
  }

  /** What a browser card's answer reads as, as on the desktop: "Allowed once on example.com", "Denied on example.com". */
  function browserDecision(site, ok, scope) {
    if (!ok) return `Denied on ${site}`;
    if (scope === 'session') return `Allowed ${site} for this session`;
    if (scope === 'project') return `Always allowed ${site}`;
    return `Allowed once on ${site}`;
  }

  /** ok null: someone answered it elsewhere (on the Mac) */
  function decideApproval(card, ok, scope) {
    if (card.classList.contains('decided')) return;
    card.classList.add('decided');
    const site = card.dataset.site;
    const text = ok === null ? 'Answered on your Mac' : site ? browserDecision(site, ok, scope) : ok ? (scope === 'once' ? 'Allowed' : scope === 'project' ? 'Allowed for this project' : 'Allowed for this session') : 'Denied';
    const line = h('div', 'decision', ok === null ? '' : `<span class="${ok ? 'ok' : 'no'}">${icon(ok ? 'check' : 'x', 14)}</span>`);
    line.append(document.createTextNode(text));
    card.querySelector('.card-reason')?.remove();
    card.querySelector('.card-kicker').textContent = 'Approval';
    card.append(line);
  }

  /**
   * A call Auto mode's safety check blocked: one quiet line, as on the desktop ("Auto mode blocked git push --force ·
   * Allow"); `state` is 'allow', 'allowed' or null (a block from before the app started cannot be allowed).
   */
  function blockedEl(block, state) {
    const n = h('div', 'note blocked');
    n.dataset.id = block.id;
    n.title = block.reason || '';
    n.innerHTML = `${icon('shield', 14)}<span class="blocked-words">Auto mode blocked <code>${esc(block.what || block.name)}</code></span><span class="blocked-end"></span>`;
    setBlocked(n, state);
    return n;
  }

  function setBlocked(n, state) {
    const end = n.querySelector('.blocked-end');
    end.textContent = '';
    if (!state) return;
    end.append(document.createTextNode(' · '));
    if (state === 'allowed') {
      end.append(document.createTextNode('Allowed'));
      return;
    }
    const b = h('button', 'link', 'Allow');
    b.type = 'button';
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await api('allow', { session: S.current, id: n.dataset.id });
        setBlocked(n, 'allowed');
      } catch (err) {
        if (err.status === 404) setBlocked(n, null);
        else {
          b.disabled = false;
          toast(err.message);
        }
      }
    });
    end.append(b);
  }

  // A question card (ask_user). Questions with one answer each are buttons here; anything more (several answers, the
  // user's own words) is answered in the app.
  function questionEl(ev) {
    const qs = Array.isArray(ev.questions) ? ev.questions.filter((q) => q && Array.isArray(q.options)) : [];
    const card = h('div', 'card question');
    const single = qs.length > 0 && qs.every((q) => !q.multiSelect);
    const title = qs.length === 1 ? qs[0].question || qs[0].header : `${qs.length} questions`;
    card.innerHTML =
      `<div class="card-head"><span class="card-icon">${icon('question', 16)}</span><div class="card-heading">` +
      `<span class="card-kicker">Waiting for you</span><span class="card-title">${esc(title)}</span></div></div>`;
    const body = h('div', 'card-body');
    const picked = qs.map(() => null);
    qs.forEach((q, i) => {
      const block = h('div', 'q-block');
      if (qs.length > 1) block.append(h('div', 'q-question', `<span class="q-chip">${esc(q.header)}</span>${esc(q.question)}`));
      if (single) {
        const opts = h('div', 'q-options');
        for (const o of q.options) {
          const b = h('button', 'btn q-opt', `<span class="q-label">${esc(o.label)}</span>${o.description ? `<span class="q-desc">${esc(o.description)}</span>` : ''}`);
          b.type = 'button';
          b.dataset.q = String(i);
          b.dataset.label = o.label;
          opts.append(b);
        }
        block.append(opts);
      }
      body.append(block);
    });
    if (!single) body.append(h('div', 'q-elsewhere', 'Answer this one on your Mac.'));
    card.append(body);
    if (!single) return card;
    card.addEventListener('click', async (e) => {
      const b = e.target.closest('button.q-opt');
      if (!b || card.classList.contains('decided')) return;
      const i = Number(b.dataset.q);
      picked[i] = b.dataset.label;
      card.querySelectorAll(`button.q-opt[data-q="${i}"]`).forEach((x) => x.classList.toggle('on', x === b));
      if (picked.some((p) => p === null)) return;
      card.querySelectorAll('button').forEach((x) => (x.disabled = true));
      try {
        await api('answer', { id: ev.id, answers: picked.map((label) => ({ selected: [label] })) });
        decideQuestion(card, picked);
      } catch (err) {
        if (err.status === 404) decideQuestion(card, null);
        else {
          card.querySelectorAll('button').forEach((x) => (x.disabled = false));
          toast(err.message);
        }
      }
    });
    return card;
  }

  /** answers: the labels picked here; null: answered or skipped elsewhere (the Mac), or the run stopped */
  function decideQuestion(card, answers, skipped) {
    if (card.classList.contains('decided')) return;
    card.classList.add('decided');
    card.querySelector('.card-kicker').textContent = 'Question';
    card.querySelector('.q-elsewhere')?.remove();
    card.querySelectorAll('button').forEach((x) => (x.disabled = true));
    const text = answers ? answers.join(' · ') : skipped ? 'Skipped' : 'Answered on your Mac';
    const line = h('div', 'decision', answers ? `<span class="ok">${icon('check', 14)}</span>` : '');
    line.append(document.createTextNode(text));
    card.append(line);
  }

  const PLAN_CHIP = { proposed: 'Proposed', approved: 'Approved', rejected: 'Kept planning' };

  function planEl(plan) {
    const card = h('div', 'card plan');
    card.innerHTML =
      `<div class="card-head"><span class="card-icon">${icon('plan', 16)}</span><div class="card-heading">` +
      `<span class="card-kicker">Plan</span><span class="card-title">${esc(plan.title || 'Plan')}</span></div>` +
      `<span class="chip"></span></div>` +
      `<div class="card-body md">${markdown(plan.markdown || '')}</div>` +
      `<div class="card-actions"><button type="button" class="btn" data-d="keep">Keep planning</button>` +
      `<button type="button" class="btn primary" data-d="build-ask">Build</button></div>`;
    card._plan = plan;
    setPlanStatus(card, plan.status);
    card.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-d]');
      if (!b) return;
      card.querySelectorAll('button').forEach((x) => (x.disabled = true));
      try {
        await api('plan', { session: S.current, id: plan.id, decision: b.dataset.d });
        setPlanStatus(card, b.dataset.d === 'keep' ? 'rejected' : 'approved');
      } catch (err) {
        card.querySelectorAll('button').forEach((x) => (x.disabled = false));
        toast(err.message);
      }
    });
    return card;
  }

  function setPlanStatus(card, status) {
    const chip = card.querySelector('.chip');
    chip.className = 'chip ' + status;
    chip.textContent = PLAN_CHIP[status] || status;
    // A plan without an id (an old transcript's synthetic one) cannot be decided from here.
    card.querySelector('.card-actions').hidden = status !== 'proposed' || !card._plan.id;
  }

  function itemEl(item) {
    switch (item.role) {
      case 'user': return userEl(item.text, item.images, item.origin, item.from);
      case 'assistant': return assistantEl(item.text);
      case 'tool': return toolEl(item.name, item.args, item.result, item.ok);
      case 'plan': {
        const card = planEl(item.plan);
        if (item.plan.id) V.plans.set(item.plan.id, card);
        return card;
      }
      case 'artifact': return artifactCardEl(item.artifact);
      case 'image': return note(`Image: ${item.image.caption || item.image.name} (on your Mac)`);
      case 'compaction': return h('div', 'divider', 'Earlier messages summarised');
      case 'auto_blocked': return blockedEl(item.block, item.block.allowed ? 'allowed' : item.allowable ? 'allow' : null);
      default: return null;
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Snapshot
  // ---------------------------------------------------------------------------------------------------------------

  function renderSnapshot(data) {
    V = freshView();
    const t = el.transcript;
    t.textContent = '';
    const live = data.live;
    // The server leaves tool calls still in flight out of the items (api.ts); live.tools holds the running ones.
    for (const item of data.items) {
      const n = itemEl(item);
      if (n) t.append(n);
      if (item.role === 'tool') noteTool(item.name, item.args, item.result, item.ok);
      else if (item.role === 'assistant') {
        const cards = takeCards(item.text);
        if (cards) t.append(cards);
      }
    }
    // Calls no reply came after
    const left = takeCards('');
    if (left) t.append(left);
    if (live.thinking) {
      V.thinking = thinkingEl(live.running);
      V.thinkingText = live.thinking;
      V.thinking.querySelector('.body').textContent = live.thinking;
      t.append(V.thinking);
    }
    if (live.text) {
      V.assistant = assistantEl(live.text);
      V.assistant.classList.add('streaming');
      V.assistantText = live.text;
      t.append(V.assistant);
    }
    for (const tool of live.tools) {
      if (tool.name === 'submit_plan') continue; // the plan card stands for it, as with tool_start
      const row = toolEl(tool.name, tool.args, undefined, undefined);
      V.tools.set(tool.id, row);
      t.append(row);
    }
    for (const ap of live.approvals) {
      const card = approvalEl(ap);
      V.approvals.set(ap.id, card);
      t.append(card);
    }
    for (const q of live.questions || []) {
      const card = questionEl(q);
      V.questions.set(q.id, card);
      t.append(card);
    }
    if (!t.childElementCount) t.append(emptyEl());
    S.queue = live.queue.map((q) => ({ id: q.id, text: q.text }));
    renderQueue();
    setRunning(live.running);
    pinned = true;
    el.scroll.scrollTop = el.scroll.scrollHeight;
  }

  function emptyEl() {
    return h('div', 'empty', '<strong>Nothing here yet</strong>Send a message to start. It runs on your Mac.');
  }

  async function loadTranscript() {
    if (!S.current) {
      el.transcript.textContent = '';
      el.transcript.append(h('div', 'empty', '<strong>No sessions yet</strong>Send a message to start one on your Mac.'));
      setRunning(false);
      return;
    }
    const id = ++S.loadId;
    const session = S.current;
    S.seq = null;
    S.buffered = [];
    try {
      const data = await api('transcript?session=' + encodeURIComponent(session));
      if (id !== S.loadId) return;
      renderSnapshot(data);
      S.seq = data.seq;
      const held = S.buffered;
      S.buffered = [];
      for (const m of held) applyAgent(m);
    } catch (err) {
      if (id !== S.loadId) return;
      S.seq = -1;
      if (err.status === 404 && !S.dead) {
        // The session is gone (deleted on the Mac): fall back to the one on screen there.
        S.current = S.foreground && S.foreground !== session ? S.foreground : '';
        renderTop();
        return loadTranscript();
      }
      toast(err.message);
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Live events
  // ---------------------------------------------------------------------------------------------------------------

  function onAgent(msg) {
    if (msg.sessionId !== S.current) return;
    if (S.seq === null) S.buffered.push(msg);
    else applyAgent(msg);
  }

  function endStreaming() {
    if (V.assistant) V.assistant.classList.remove('streaming');
  }

  let paintQueued = false;
  function paintAssistant() {
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(() => {
      paintQueued = false;
      if (V.assistant) stick(() => (V.assistant.querySelector('.md').innerHTML = markdown(V.assistantText)));
    });
  }

  function append(node) {
    const empty = el.transcript.querySelector('.empty');
    if (empty) empty.remove();
    stick(() => el.transcript.append(node));
  }

  function applyAgent(msg) {
    if (msg.seq <= S.seq) return; // already in the snapshot
    S.seq = msg.seq;
    const ev = msg.ev;
    switch (ev.type) {
      case 'run_start':
        setRunning(true);
        break;
      case 'user_message':
        endStreaming();
        V.assistant = null;
        append(userEl(ev.text, ev.images, ev.origin, ev.from));
        break;
      case 'thinking_delta':
        if (!V.thinking) {
          V.thinking = thinkingEl(true);
          V.thinkingText = '';
          V.attempt.push(V.thinking);
          append(V.thinking);
        }
        V.thinkingText += ev.text;
        V.thinking.querySelector('.body').textContent = V.thinkingText;
        break;
      case 'thinking_done':
        if (V.thinking) V.thinking.querySelector('.label').textContent = 'Thought';
        V.thinking = null;
        // The model call completed: what it streamed is the reply
        V.attempt = [];
        break;
      case 'reply_discarded':
        // The call failed after it began to stream and is tried again: its text and thinking go
        for (const n of V.attempt) n.remove();
        V.attempt = [];
        V.assistant = null;
        V.assistantText = '';
        V.thinking = null;
        V.thinkingText = '';
        break;
      case 'retry_status':
        V.retry = ev.text || null;
        renderTop();
        break;
      case 'text_delta':
        if (!V.assistant) {
          V.assistant = assistantEl('');
          V.assistant.classList.add('streaming');
          V.assistantText = '';
          V.attempt.push(V.assistant);
          append(V.assistant);
        }
        V.assistantText += ev.text;
        paintAssistant();
        break;
      case 'text_done':
        endStreaming();
        break;
      case 'assistant_message':
        // The finished message is the authority: it replaces what streamed in, or appears if nothing did.
        if (V.assistant) {
          V.assistantText = ev.text;
          if (ev.text) V.assistant.querySelector('.md').innerHTML = markdown(ev.text);
          else V.assistant.remove();
          endStreaming();
        } else if (ev.text) append(assistantEl(ev.text));
        V.assistant = null;
        // The cards it names, and those the calls before it were waiting with, go under it
        if (ev.text) {
          const cards = takeCards(ev.text);
          if (cards) append(cards);
        }
        break;
      case 'tool_start': {
        endStreaming();
        V.assistant = null;
        if (ev.name === 'submit_plan') break; // the plan card stands for it
        const row = toolEl(ev.name, ev.args, undefined, undefined);
        V.tools.set(ev.id, row);
        append(row);
        break;
      }
      case 'tool_end': {
        const row = V.tools.get(ev.id);
        if (row) {
          setToolState(row, ev.result, ev.ok);
          V.tools.delete(ev.id);
        }
        noteTool(ev.name, row ? row._tool.args : null, ev.result, ev.ok);
        break;
      }
      case 'auto_blocked': {
        // The call's row gives way to the line
        const row = V.tools.get(ev.block.id);
        if (row) {
          row.remove();
          V.tools.delete(ev.block.id);
        }
        append(blockedEl(ev.block, 'allow'));
        break;
      }
      case 'auto_allowed':
        for (const n of el.transcript.querySelectorAll('.note.blocked')) if (n.dataset.id === ev.id) setBlocked(n, 'allowed');
        break;
      case 'approval_request': {
        endStreaming();
        const card = approvalEl(ev);
        V.approvals.set(ev.id, card);
        append(card);
        break;
      }
      case 'approval_resolved': {
        const card = V.approvals.get(ev.id);
        if (card) decideApproval(card, ev.ok, ev.scope);
        V.approvals.delete(ev.id);
        break;
      }
      case 'question_request': {
        endStreaming();
        const card = questionEl(ev);
        V.questions.set(ev.id, card);
        append(card);
        break;
      }
      case 'question_resolved': {
        const card = V.questions.get(ev.id);
        if (card) decideQuestion(card, ev.answers ? ev.answers.map((a) => [...(a.selected || []), ...(a.other ? [`“${a.other}”`] : [])].join(', ')) : null, ev.skipped);
        V.questions.delete(ev.id);
        break;
      }
      case 'plan_proposed': {
        endStreaming();
        const existing = V.plans.get(ev.plan.id);
        if (existing) setPlanStatus(existing, ev.plan.status);
        else {
          const card = planEl(ev.plan);
          V.plans.set(ev.plan.id, card);
          append(card);
        }
        break;
      }
      case 'tasks_updated':
        renderTasks(ev.tasks);
        break;
      case 'queue_delivered':
      case 'queue_dropped': {
        const q = S.queue.find((x) => x.id === ev.id);
        S.queue = S.queue.filter((x) => x.id !== ev.id);
        renderQueue();
        if (ev.type === 'queue_dropped' && q) {
          if (!el.input.value.trim()) setInput(q.text);
          toast('Your queued message was not sent. It is back in the box.');
        }
        break;
      }
      case 'error':
        endStreaming();
        append(note(ev.message, ev.kind === 'notice' ? '' : 'error'));
        break;
      case 'compact_start':
        V.compacting = note('Summarising the conversation…');
        append(V.compacting);
        break;
      case 'compact_end':
        if (V.compacting) V.compacting.remove();
        V.compacting = null;
        append(ev.compaction ? h('div', 'divider', 'Earlier messages summarised') : note(ev.error || 'Could not summarise.', 'error'));
        break;
      case 'artifact':
        append(artifactCardEl(ev.artifact));
        break;
      case 'image':
        append(note(`Image: ${ev.image.caption || ev.image.name} (on your Mac)`));
        break;
      case 'session_changed':
        upsertSession(ev.session);
        if (ev.session.plan) V.plans.get(ev.session.plan.id) && setPlanStatus(V.plans.get(ev.session.plan.id), ev.session.plan.status);
        break;
      case 'run_end':
        endStreaming();
        V.assistant = null;
        V.thinking = null;
        V.attempt = [];
        V.retry = null;
        // Rows that never got a result were cut off with the run.
        for (const row of V.tools.values()) setToolState(row, 'Interrupted', false);
        V.tools.clear();
        {
          // Cards of calls that no reply came after
          const cards = takeCards('');
          if (cards) append(cards);
        }
        // Cut by "Send now" on the Mac: the next run starts at once with that message, so no "Stopped"
        if (ev.continued) break;
        if (ev.reason === 'aborted') append(note('Stopped'));
        else if (ev.reason === 'max_turns') append(note('Stopped at the step limit'));
        setRunning(false);
        break;
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Sessions, the top bar and the sheet
  // ---------------------------------------------------------------------------------------------------------------

  const currentMeta = () => S.sessions.find((s) => s.id === S.current) || (S.localMeta && S.localMeta.id === S.current ? S.localMeta : null);

  function stateOf(meta) {
    const st = (meta && meta.status) || {};
    if (st.attention) return 'waiting';
    if (st.running) return 'running';
    return 'idle';
  }
  const STATE_LABEL = { waiting: 'Waiting for you', running: 'Running', idle: 'Idle' };

  function upsertSession(meta) {
    const i = S.sessions.findIndex((s) => s.id === meta.id);
    if (i >= 0) S.sessions[i] = { ...S.sessions[i], ...meta };
    else if (S.localMeta && S.localMeta.id === meta.id) S.localMeta = { ...S.localMeta, ...meta };
    renderTop();
    if (!el.sheet.hidden) renderSheet();
  }

  function onSessions(list) {
    S.sessions = list;
    if (S.localMeta && list.some((s) => s.id === S.localMeta.id)) S.localMeta = null;
    const meta = currentMeta();
    if (meta && meta.status) setRunning(!!meta.status.running);
    renderTop();
    if (!el.sheet.hidden) renderSheet();
  }

  function markEl(state) {
    const m = h('span', 'mark ' + state);
    m.setAttribute('role', 'img');
    m.setAttribute('aria-label', STATE_LABEL[state]);
    return m;
  }

  function renderTop() {
    const meta = currentMeta();
    el.title.textContent = meta ? meta.title : S.current ? 'Session' : 'Silo Harness';
    document.title = meta ? `${meta.title} · Silo Harness` : 'Silo Harness';
    let state = stateOf(meta);
    if (state === 'idle' && S.running) state = 'running';
    el.mark.className = 'mark ' + state;
    el.mark.setAttribute('aria-label', STATE_LABEL[state]);
    el.statusText.innerHTML = state === 'running' ? '<span class="spinner sm"></span>' : state === 'waiting' ? 'Waiting for you' : '';
    if (state === 'running') el.statusText.append(V.retry || 'Working…');
  }

  function renderSheet() {
    el.list.textContent = '';
    const list = [...S.sessions];
    if (S.localMeta && !list.some((s) => s.id === S.localMeta.id)) list.unshift(S.localMeta);
    if (!list.length) el.list.append(h('li', 'session-empty', 'No sessions yet.'));
    for (const s of list) {
      const li = h('li');
      const b = h('button');
      b.type = 'button';
      if (s.id === S.current) b.setAttribute('aria-current', 'true');
      const state = stateOf(s);
      b.append(markEl(state));
      const main = h('span', 's-main');
      const title = h('span', 's-title');
      title.textContent = s.title;
      const sub = h('span', 's-sub', state === 'idle' ? esc(ago(s.updatedAt)) : `<span class="${state}">${STATE_LABEL[state]}</span>`);
      main.append(title, sub);
      b.append(main);
      if (s.id === S.foreground) b.append(h('span', 'badge', 'On Mac'));
      b.addEventListener('click', () => {
        closeSheet();
        switchTo(s.id);
      });
      li.append(b);
      el.list.append(li);
    }
  }

  let lastFocus = null;
  function openSheet() {
    lastFocus = document.activeElement;
    renderSheet();
    el.sheet.hidden = false;
    el.sheet.querySelector('.sheet-head .icon-btn').focus({ preventScroll: true });
  }
  function closeSheet() {
    el.sheet.hidden = true;
    if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
  }

  function switchTo(id) {
    if (id === S.current) return;
    S.current = id;
    try {
      history.replaceState(null, '', '#' + id);
    } catch {
      /* not essential */
    }
    renderTasks((currentMeta() && currentMeta().tasks) || []);
    renderTop();
    loadTranscript();
  }

  async function newSession() {
    try {
      const meta = await api('new', {});
      S.localMeta = meta;
      closeSheet();
      switchTo(meta.id);
      el.input.focus();
    } catch (err) {
      toast(err.message);
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Composer
  // ---------------------------------------------------------------------------------------------------------------

  function setRunning(running) {
    S.running = running;
    el.stop.hidden = !running;
    el.send.setAttribute('aria-label', running ? 'Queue message' : 'Send');
    renderTop();
  }

  function setInput(text) {
    el.input.value = text;
    grow();
    updateSend();
  }

  function grow() {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, 168) + 'px';
  }
  const updateSend = () => (el.send.disabled = S.dead || !el.input.value.trim());

  function renderQueue() {
    el.queue.textContent = '';
    for (const q of S.queue) {
      const row = h('div', 'queued', '<span class="tag">Queued</span>');
      const t = h('span', 'text');
      t.textContent = q.text;
      row.append(t);
      el.queue.append(row);
    }
    el.queue.hidden = !S.queue.length;
  }

  function renderTasks(tasks) {
    if (!tasks || !tasks.length) {
      el.tasks.hidden = true;
      el.tasks.textContent = '';
      return;
    }
    const open = el.tasks.querySelector('details')?.open ?? false;
    const done = tasks.filter((t) => t.status === 'completed').length;
    const now = tasks.find((t) => t.status === 'in_progress');
    const d = h('details');
    d.open = open;
    d.innerHTML = `<summary>${icon('list', 15)}<span>${esc(now ? short(now.title, 48) : 'Tasks')}</span><span class="count">${done}/${tasks.length}</span></summary>`;
    const ul = h('ul');
    for (const t of tasks) {
      const li = h('li', t.status, '<span class="box"></span>');
      li.append(document.createTextNode(t.title));
      ul.append(li);
    }
    d.append(ul);
    el.tasks.textContent = '';
    el.tasks.append(d);
    el.tasks.hidden = false;
  }

  async function send() {
    const text = el.input.value.trim();
    if (!text || S.dead) return;
    el.send.disabled = true;
    try {
      if (!S.current) {
        const meta = await api('new', {});
        S.localMeta = meta;
        switchTo(meta.id);
      }
      setInput('');
      const res = await api('send', { session: S.current, text });
      if (!res.ok) {
        setInput(text);
        toast(res.error || 'Could not send.');
      } else if (res.queued) {
        S.queue.push({ id: res.id, text });
        renderQueue();
      }
    } catch (err) {
      if (!el.input.value) setInput(text);
      toast(err.message);
    } finally {
      updateSend();
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // The event stream, with backoff and a fresh snapshot after every reconnect
  // ---------------------------------------------------------------------------------------------------------------

  let es = null;
  let backoff = 1000;
  let retryTimer = 0;
  let connTimer = 0;

  function showConn(on) {
    clearTimeout(connTimer);
    // Quiet: a blip shorter than a second and a half is not worth a banner.
    if (on) connTimer = setTimeout(() => (el.conn.hidden = false), 1500);
    else el.conn.hidden = true;
  }

  function connect() {
    clearTimeout(retryTimer);
    if (es) es.close();
    if (S.dead) return;
    es = new EventSource('api/events');
    es.addEventListener('open', () => {
      backoff = 1000;
      showConn(false);
      refresh();
    });
    es.addEventListener('agent', (e) => onAgent(JSON.parse(e.data)));
    es.addEventListener('sessions', (e) => onSessions(JSON.parse(e.data)));
    es.addEventListener('error', () => {
      es.close();
      es = null;
      showConn(true);
      // Find out whether the link itself died (new link on the Mac) before trying again.
      api('state').catch(() => {});
      retryTimer = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 15000);
    });
  }

  /** Every (re)connect: the state, then a snapshot of the shown session; the stream is already open by now. */
  async function refresh() {
    try {
      const st = await api('state');
      S.sessions = st.sessions;
      S.foreground = st.foreground;
      // "@anthropic/claude-sonnet-5" → "claude-sonnet-5": the gateway prefix costs width and says little on a phone.
      el.model.textContent = String(st.model || '').replace(/^@[^/]+\//, '');
      el.model.title = st.model || '';
      if (!S.current || (!st.sessions.some((s) => s.id === S.current) && !(S.localMeta && S.localMeta.id === S.current))) {
        const fromHash = decodeURIComponent(location.hash.slice(1));
        S.current = (fromHash && st.sessions.some((s) => s.id === fromHash) && fromHash) || st.foreground || (st.sessions[0] && st.sessions[0].id) || '';
      }
      renderTasks((currentMeta() && currentMeta().tasks) || []);
      renderTop();
      await loadTranscript();
    } catch (err) {
      if (!S.dead) toast(err.message);
    }
  }

  function linkDead() {
    if (S.dead) return;
    S.dead = true;
    if (es) es.close();
    clearTimeout(retryTimer);
    showConn(false);
    el.transcript.textContent = '';
    el.transcript.append(h('div', 'empty', '<strong>This link no longer works</strong>Open the new link from your Mac.'));
    el.title.textContent = 'Silo Harness';
    el.mark.hidden = true;
    el.model.hidden = true;
    $('open-sessions').hidden = true;
    closeSheet();
    document.querySelector('.composer-wrap').hidden = true;
    updateSend();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------------------------------------------

  $('open-sessions').addEventListener('click', openSheet);
  $('new-session').addEventListener('click', newSession);
  el.sheet.addEventListener('click', (e) => e.target.closest('[data-close]') && closeSheet());
  document.addEventListener('keydown', (e) => e.key === 'Escape' && !el.sheet.hidden && closeSheet());
  el.send.addEventListener('click', send);
  el.stop.addEventListener('click', () => S.current && api('stop', { session: S.current }).catch((err) => toast(err.message)));
  el.input.addEventListener('input', () => {
    grow();
    updateSend();
  });
  // Enter sends with a real keyboard; on a phone it is a new line and the button sends.
  const fineKeyboard = window.matchMedia('(hover: hover) and (pointer: fine)');
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && fineKeyboard.matches) {
      e.preventDefault();
      send();
    }
  });
  // A phone that slept drops the connection without telling the page.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !S.dead && (!es || es.readyState === EventSource.CLOSED)) connect();
  });
  window.addEventListener('pageshow', (e) => e.persisted && connect());

  updateSend();
  connect();
})();
