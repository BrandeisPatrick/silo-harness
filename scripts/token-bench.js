#!/usr/bin/env node
// Token benchmark: what the harness itself sends to the model, per request, in fixed scenarios with real tool use.
//
// It starts a small recording proxy on 127.0.0.1 that forwards every request to the real API (Anthropic's
// OpenAI-compatible endpoint, https://api.anthropic.com/v1) and records, per request: the model, what kind of call it
// is (an agent turn, Auto mode's safety check, a session title, a compaction summary), the size of each part of the
// request (tool definitions, system prompt, user and assistant history, tool results, images) and the response's
// usage (prompt, completion and cached tokens). The app is launched hidden through the live rig (test/live/rig.js) on
// a throwaway profile, with its provider pointed at the proxy, in a temp project with a few files. Each scenario runs
// in a fresh app and session:
//   Q  "What does this project do?": answered after reading files (bypass mode)
//   E  an edit plus running the project's tests (Auto mode, so the safety check's side calls are counted)
//   B  reading a local fixture page in the built-in browser, then a screenshot and a follow-up (bypass mode,
//      screenshots sent to the model)
//   L  a six-turn conversation on one task, to see how the history grows (Auto mode)
// Session titles are on, so their calls are counted too.
//
// The split of a request's input into parts uses the provider's prompt_tokens as the total: images are estimated
// from their pixel size (width x height / 750, after the API's resize), and the rest is shared out by characters,
// which is one consistent chars-per-token ratio per request. Costs use Claude Haiku 5.5's prices (PRICES below).
//
// With --native, the agent and safety-check requests of each scenario are replayed afterwards, in order, through
// Anthropic's native Messages API with cache_control breakpoints on the tools, the system prompt and the last message,
// to measure what prompt caching would save (max_tokens 1, thinking off: only the input side is measured).
//
// The key is read from ANTHROPIC_API_KEY and only ever sent upstream: request headers are never recorded, and any
// occurrence of the key in a body or a reply is replaced before anything is written.
//
//   npm run build
//   set -a; . /path/to/api.env; set +a
//   node scripts/token-bench.js [--runs 2] [--scenarios Q,E,B,L] [--out DIR] [--label baseline] [--native]
//
// Writes report.md (the tables), results.json (every request's record, without bodies) and requests.jsonl (the
// request bodies, for a closer look) to the output folder (default: a new temp folder), and prints the report.
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { launch, sleep, LIVE_MODEL } = require('../test/live/rig.js');

const KEY = process.env.ANTHROPIC_API_KEY || '';
const UPSTREAM = (process.env.TOKEN_BENCH_UPSTREAM || 'https://api.anthropic.com').replace(/\/+$/, '');

/** USD per million tokens, Claude Haiku 5.5, prompts up to 100K tokens (above: input 0.50, output 2.50). */
const PRICES = { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01, longInput: 0.5, longOutput: 2.5, longFrom: 100_000 };

/** Marks of the side calls' system prompts (src/main/agent/classifier.ts, titles.ts, compact.ts). */
const KINDS = [
  ['classifier', 'You are the safety check of Auto mode'],
  ['title', 'You name chat sessions'],
  ['compaction', 'You compact the older part'],
];

// ---------- Arguments ----------

function parseArgs(argv) {
  const o = { runs: 1, scenarios: ['Q', 'E', 'B', 'L'], out: '', label: '', native: false, model: LIVE_MODEL };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--runs') o.runs = Math.max(1, Number(next()) || 1);
    else if (a === '--scenarios') o.scenarios = next().split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    else if (a === '--out') o.out = path.resolve(next());
    else if (a === '--label') o.label = next();
    else if (a === '--native') o.native = true;
    else if (a === '--model') o.model = next();
    else if (a === '--help' || a === '-h') {
      console.log(fs.readFileSync(__filename, 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
      process.exit(0);
    } else throw new Error(`Unknown argument: ${a}`);
  }
  return o;
}

// ---------- Secrets ----------

/** The text with the key replaced, so nothing written to disk can hold it. */
function scrub(s) {
  const t = String(s);
  return KEY && KEY.length >= 8 ? t.split(KEY).join('[REDACTED]') : t;
}

// ---------- Request anatomy ----------

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);

/** Pixel size of a PNG or JPEG data URL, or null. */
function imageSize(dataUrl) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(String(dataUrl));
  if (!m) return null;
  const b = Buffer.from(m[2].slice(0, 200_000), 'base64');
  if (b.length > 24 && b.toString('ascii', 12, 16) === 'IHDR') return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), bytes: Math.floor((m[2].length * 3) / 4) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length; ) {
      if (b[i] !== 0xff) break;
      const marker = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5), bytes: Math.floor((m[2].length * 3) / 4) };
      i += 2 + len;
    }
  }
  return null;
}

/** Tokens an image costs the model: the API scales it to at most 1568 px on the long edge and about 1.15 MP. */
function imageTokens(size) {
  if (!size) return 1600;
  let { w, h } = size;
  const s1 = Math.min(1, 1568 / Math.max(w, h));
  w *= s1;
  h *= s1;
  if (w * h > 1_150_000) {
    const s2 = Math.sqrt(1_150_000 / (w * h));
    w *= s2;
    h *= s2;
  }
  return Math.ceil((w * h) / 750);
}

function contentText(content) {
  if (typeof content === 'string') return { text: content, images: [] };
  let text = '';
  const images = [];
  for (const p of Array.isArray(content) ? content : []) {
    if (p && p.type === 'text') text += String(p.text ?? '');
    else if (p && p.type === 'image_url') images.push(String(p.image_url?.url ?? ''));
  }
  return { text, images };
}

/** The parts of a chat-completions request, in characters (images: count and estimated tokens). */
function anatomy(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const sys = msgs.filter((m) => m.role === 'system').map((m) => contentText(m.content).text).join('\n');
  const tools = Array.isArray(body.tools) && body.tools.length ? JSON.stringify(body.tools) : '';
  const chars = { tools: tools.length, system: sys.length, user: 0, assistant: 0, toolResults: 0 };
  let images = 0;
  let imageTok = 0;
  for (const m of msgs) {
    if (m.role === 'system') continue;
    const { text, images: imgs } = contentText(m.content);
    if (m.role === 'user') chars.user += text.length;
    else if (m.role === 'tool') chars.toolResults += text.length;
    else if (m.role === 'assistant') {
      chars.assistant += text.length;
      for (const tc of m.tool_calls ?? []) chars.assistant += String(tc.function?.name ?? '').length + String(tc.function?.arguments ?? '').length;
    }
    for (const url of imgs) {
      images++;
      imageTok += imageTokens(imageSize(url));
    }
  }
  const kind = (KINDS.find(([, mark]) => sys.startsWith(mark)) || [])[0] || (body.tools?.length ? 'agent' : 'other');
  const perTool = (body.tools ?? []).map((t) => ({ name: t.function?.name, chars: JSON.stringify(t).length, description: String(t.function?.description ?? '').length }));
  return { kind, chars, images, imageTok, toolsHash: tools ? sha(tools) : '', systemHash: sys ? sha(sys) : '', system: sys, perTool, messages: msgs.length };
}

/** Shares the provider's prompt_tokens out over the parts: images by their estimate, the rest by characters. */
function split(rec) {
  const total = rec.usage?.prompt_tokens;
  const c = rec.chars;
  const textChars = c.tools + c.system + c.user + c.assistant + c.toolResults;
  if (!Number.isFinite(total) || total <= 0) return null;
  const img = Math.min(rec.imageTok, total);
  const per = textChars / Math.max(1, total - img);
  const t = (n) => n / per;
  return { tools: t(c.tools), system: t(c.system), user: t(c.user), assistant: t(c.assistant), toolResults: t(c.toolResults), images: img, charsPerToken: per };
}

function cached(u) {
  return Number(u?.prompt_tokens_details?.cached_tokens ?? u?.cache_read_input_tokens ?? 0) || 0;
}

function cost(u) {
  if (!u) return 0;
  const p = Number(u.prompt_tokens) || 0;
  const long = p > PRICES.longFrom;
  const read = cached(u);
  const write = Number(u.cache_creation_input_tokens ?? u.prompt_tokens_details?.cache_creation_tokens ?? 0) || 0;
  const plain = Math.max(0, p - read - write);
  const inP = long ? PRICES.longInput : PRICES.input;
  return (plain * inP + read * PRICES.cacheRead * (long ? 5 : 1) + write * PRICES.cacheWrite * (long ? 5 : 1) + (Number(u.completion_tokens) || 0) * (long ? PRICES.longOutput : PRICES.output)) / 1e6;
}

// ---------- The recording proxy ----------

function startProxy(state) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    let body = null;
    try {
      body = raw.length ? JSON.parse(raw.toString('utf8')) : null;
    } catch {
      body = null;
    }
    // Forwarded as they came (the key travels in them), recorded never.
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (/^(host|content-length|connection|accept-encoding|keep-alive|transfer-encoding)$/i.test(k)) continue;
      headers[k] = v;
    }
    headers['accept-encoding'] = 'identity';
    const started = Date.now();
    const ctl = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) ctl.abort();
    });
    state.inflight++;
    state.lastAt = Date.now();
    const rec = { seq: ++state.seq, at: new Date().toISOString(), run: state.run, scenario: state.scenario, method: req.method, path: req.url, model: body?.model ?? null, stream: Boolean(body?.stream) };
    let text = '';
    try {
      const up = await fetch(UPSTREAM + req.url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw, signal: ctl.signal });
      rec.status = up.status;
      res.writeHead(up.status, { 'content-type': up.headers.get('content-type') || 'application/json', 'cache-control': 'no-cache' });
      const dec = new TextDecoder();
      if (up.body) {
        for await (const c of up.body) {
          res.write(c);
          text += dec.decode(c, { stream: true });
        }
      }
      res.end();
    } catch (err) {
      rec.error = scrub(err && err.message ? err.message : String(err));
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'token-bench proxy: upstream failed' } }));
    } finally {
      state.inflight--;
      state.lastAt = Date.now();
    }
    rec.ms = Date.now() - started;
    if (body && /chat\/completions$/.test(req.url.split('?')[0])) {
      const a = anatomy(body);
      Object.assign(rec, { kind: a.kind, chars: a.chars, images: a.images, imageTok: a.imageTok, toolsHash: a.toolsHash, systemHash: a.systemHash, messages: a.messages, tools: a.perTool.length });
      const reply = parseReply(text, rec.stream);
      rec.usage = reply.usage;
      rec.reply = { text: scrub(reply.text).slice(0, 600), toolCalls: reply.toolCalls.map((c) => ({ name: c.name, args: scrub(c.args).slice(0, 300) })) };
      if (rec.status >= 400) rec.errorBody = scrub(text).slice(0, 500);
      rec.split = split(rec);
      rec.cost = cost(rec.usage);
      state.perToolByHash.set(a.toolsHash, a.perTool);
      state.systems.set(rec.seq, a.system);
      state.bodies.push(scrub(JSON.stringify({ seq: rec.seq, run: rec.run, scenario: rec.scenario, kind: a.kind, body })));
    } else rec.kind = 'non-chat';
    state.records.push(rec);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

/** The usage, text and tool calls of a streamed (SSE) or plain JSON reply. */
function parseReply(text, stream) {
  let usage = null;
  let out = '';
  const calls = new Map();
  const take = (o) => {
    if (o?.usage) usage = { ...(usage || {}), ...o.usage };
    const ch = o?.choices?.[0];
    const d = ch?.delta ?? ch?.message;
    if (!d) return;
    if (typeof d.content === 'string') out += d.content;
    for (const [i, tc] of (d.tool_calls ?? []).entries()) {
      const k = tc.index ?? i;
      const c = calls.get(k) || { name: '', args: '' };
      if (tc.function?.name) c.name += tc.function.name;
      if (typeof tc.function?.arguments === 'string') c.args += tc.function.arguments;
      calls.set(k, c);
    }
  };
  if (stream) {
    for (const line of text.split('\n')) {
      const m = /^data:\s*(.*)$/.exec(line.trim());
      if (!m || m[1] === '[DONE]') continue;
      try {
        take(JSON.parse(m[1]));
      } catch {
        /* a partial line */
      }
    }
  } else {
    try {
      take(JSON.parse(text));
    } catch {
      /* not JSON */
    }
  }
  return { usage, text: out, toolCalls: [...calls.values()] };
}

// ---------- The fixture project and page ----------

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-bench-project-'));
  const w = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  w('package.json', JSON.stringify({ name: 'tally', version: '1.2.0', description: 'Small text utilities: word counts, reading time and URL slugs.', main: 'src/index.js', scripts: { test: 'node test.js' }, license: 'MIT' }, null, 2) + '\n');
  w(
    'README.md',
    `# tally

Small, dependency-free text utilities for Node.js, used by the blog's build step.

- \`countWords(text)\`: the number of words in a text (letters, digits and apostrophes count as word characters).
- \`countSentences(text)\`: the number of sentences, ending in ., ! or ?.
- \`readingTime(text, wpm = 220)\`: minutes to read the text, rounded up, at least 1.
- \`slugify(title)\`: a URL slug for a post title: lower case, ASCII letters and digits, words joined by dashes.

## Usage

\`\`\`js
const { slugify, readingTime } = require('tally');
slugify('Hello, World!'); // 'hello-world'
readingTime(post.body); // 4
\`\`\`

## Development

Run the tests with \`npm test\`. There is no build step.

## Changelog

See CHANGELOG.md. Version 1.2.0 added readingTime.
`,
  );
  w(
    'CHANGELOG.md',
    `# Changelog\n\n## 1.2.0\n- readingTime(text, wpm)\n\n## 1.1.0\n- countSentences\n- slugify strips accents (é becomes e)\n\n## 1.0.0\n- countWords and slugify\n`,
  );
  w(
    'src/index.js',
    `'use strict';\n\nconst { countWords, countSentences, readingTime } = require('./count');\nconst { slugify } = require('./slug');\n\nmodule.exports = { countWords, countSentences, readingTime, slugify };\n`,
  );
  w(
    'src/count.js',
    `'use strict';

/** Words: runs of letters, digits and apostrophes. */
const WORD = /[\\p{L}\\p{N}']+/gu;

/** The number of words in a text. */
function countWords(text) {
  if (!text) return 0;
  const m = String(text).match(WORD);
  return m ? m.length : 0;
}

/** The number of sentences: runs of text that end in ., ! or ? (a text without one is one sentence). */
function countSentences(text) {
  const t = String(text || '').trim();
  if (!t) return 0;
  const parts = t.split(/[.!?]+(?:\\s+|$)/).filter((s) => s.trim());
  return Math.max(1, parts.length);
}

/** Minutes to read a text at \`wpm\` words per minute, rounded up, at least 1. */
function readingTime(text, wpm = 220) {
  const words = countWords(text);
  return Math.max(1, Math.ceil(words / wpm));
}

module.exports = { countWords, countSentences, readingTime };
`,
  );
  w(
    'src/slug.js',
    `'use strict';

/** Characters with accents, folded to ASCII (é becomes e). */
function fold(s) {
  return s.normalize('NFKD').replace(/[\\u0300-\\u036f]/g, '');
}

/** A URL slug for a post title: lower case, ASCII letters and digits, words joined by dashes. */
function slugify(title) {
  return fold(title)
    .toLowerCase()
    .replace(/[^a-z0-9\\s-]/g, '')
    .trim()
    .replace(/\\s/g, '-');
}

module.exports = { slugify };
`,
  );
  w(
    'test.js',
    `'use strict';

const assert = require('node:assert');
const { countWords, countSentences, readingTime, slugify } = require('./src');

const tests = [
  ['countWords: empty', () => assert.strictEqual(countWords(''), 0)],
  ['countWords: two words', () => assert.strictEqual(countWords('hello world'), 2)],
  ['countWords: apostrophes', () => assert.strictEqual(countWords("it's fine"), 2)],
  ['countSentences: three', () => assert.strictEqual(countSentences('One. Two! Three?'), 3)],
  ['countSentences: no stop', () => assert.strictEqual(countSentences('just words'), 1)],
  ['readingTime: short text is one minute', () => assert.strictEqual(readingTime('a b c'), 1)],
  ['readingTime: 500 words at 220 wpm', () => assert.strictEqual(readingTime('w '.repeat(500)), 3)],
  ['slugify: simple', () => assert.strictEqual(slugify('Hello World'), 'hello-world')],
  ['slugify: punctuation', () => assert.strictEqual(slugify('Hello, World!'), 'hello-world')],
  ['slugify: accents', () => assert.strictEqual(slugify('Café au lait'), 'cafe-au-lait')],
];

let failed = 0;
tests.forEach(([name, fn], i) => {
  try {
    fn();
    console.log(\`ok \${i + 1} - \${name}\`);
  } catch (err) {
    failed++;
    console.log(\`not ok \${i + 1} - \${name}\\n  \${err.message.split('\\n')[0]}\`);
  }
});
console.log(\`\\n\${tests.length - failed}/\${tests.length} passed\`);
process.exit(failed ? 1 : 0);
`,
  );
  // A log of a few thousand lines (about 100 KB) with three slugify crashes in it: big enough that reading it whole
  // meets the tool-result cap.
  const lines = [];
  const routes = ['/posts', '/posts/hello-world', '/feed.xml', '/about', '/posts/cafe-au-lait', '/tags/node'];
  for (let i = 0; i < 1400; i++) {
    const ts = new Date(Date.UTC(2026, 10, 2, 8, 0, 0) + i * 7000).toISOString();
    if (i === 311 || i === 802 || i === 1207) {
      lines.push(`${ts} ERROR build: slugify failed for post #${400 + i}: TypeError: Cannot read properties of undefined (reading 'normalize') at fold (src/slug.js:5:12) input=undefined (post has no title)`);
    } else if (i % 97 === 0) lines.push(`${ts} WARN  cache: entry ${i} expired before use, rebuilding`);
    else lines.push(`${ts} INFO  http: GET ${routes[i % routes.length]} 200 ${(i * 37) % 900 + 12}ms ua=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)`);
  }
  w('logs/app.log', lines.join('\n') + '\n');
  w('docs/notes.md', '# Notes\n\nThe blog build calls slugify for every post title and readingTime for every post body.\nPosts are Markdown files with a front-matter title; drafts may have no title yet.\n');
  return dir;
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Tally release notes</title>
<style>
body { font: 16px/1.5 -apple-system, sans-serif; margin: 0; color: #1f2933; }
.banner { background: #0f766e; color: #fff; padding: 28px 40px; }
main { padding: 24px 40px; max-width: 760px; }
table { border-collapse: collapse; } td, th { border: 1px solid #ccd; padding: 4px 10px; }
footer { padding: 16px 40px; border-top: 1px solid #dde; }
</style></head>
<body>
<div class="banner"><h1>Tally release notes</h1><p>Small text utilities for Node.js</p></div>
<main>
<h2>Version 2.0 (planned for December)</h2>
<p>Version 2.0 drops support for Node 18 and makes slugify return an empty string for a missing title instead of throwing.
It also adds <code>truncateWords(text, n)</code>, which cuts a text after n words and adds an ellipsis.</p>
<h2>Version 1.2</h2>
<p>Added readingTime(text, wpm). The default speed is 220 words per minute.</p>
<h3>Download sizes</h3>
<table><tr><th>Version</th><th>Size</th><th>Files</th></tr>
<tr><td>1.0</td><td>3.1 kB</td><td>3</td></tr><tr><td>1.1</td><td>3.4 kB</td><td>3</td></tr><tr><td>1.2</td><td>3.9 kB</td><td>4</td></tr></table>
<p>${'Tally is maintained by the blog team and used in every build of the site. '.repeat(6)}</p>
</main>
<footer><a href="/docs">Documentation</a> · <a href="/changelog">Full changelog</a> · <a href="/issues">Report an issue</a></footer>
</body></html>`;

function startSite() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(req.url === '/' ? PAGE : `<!doctype html><title>${req.url}</title><p>Nothing here yet: ${req.url}</p>`);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

// ---------- Scenarios ----------

const SCENARIOS = {
  Q: { mode: 'bypass', name: 'Q: question after reading files', turns: () => ['What does this project do?'] },
  E: {
    mode: 'auto',
    name: 'E: edit plus tests (Auto mode)',
    turns: () => ['In src/slug.js, make slugify collapse runs of dashes and spaces into a single dash, so "a -- b" becomes "a-b". Then run the tests with npm test.'],
  },
  B: {
    mode: 'bypass',
    name: 'B: local page in the browser',
    config: { sendScreenshotsToModel: true },
    turns: (site) => [
      `Open http://127.0.0.1:${site}/ in the browser and tell me what the release notes say about version 2.0.`,
      'Take a screenshot of the page and tell me what colour the banner at the top is.',
      'Which links are at the bottom of the page?',
    ],
  },
  L: {
    mode: 'auto',
    name: 'L: six turns on one task (Auto mode)',
    turns: () => [
      'I want to improve the slug helper in this project. First, read src/slug.js and explain briefly what slugify does.',
      'Check logs/app.log for errors that involve slugify and tell me what input caused them.',
      'Fix slugify so it handles that input: it should return an empty string.',
      'Add a test for this case to test.js.',
      'Run the tests and tell me the result.',
      'Summarise what we changed in two sentences.',
    ],
  },
};

/** Did the agent do the job? A cheap check per scenario, so a saving is not bought with a worse agent. */
function outcome(id, project, replies) {
  const last = replies.join('\n');
  const { spawnSync } = require('node:child_process');
  // The agent's code runs in a child process of its own, never in this one
  const slug = (expr) => {
    const r = spawnSync(process.execPath, ['-e', `try { console.log(JSON.stringify(require('./src/slug.js').slugify(${expr}))) } catch (e) { console.log(JSON.stringify('throws ' + e.message)) }`], { cwd: project, encoding: 'utf8', timeout: 10_000 });
    try {
      return JSON.parse(r.stdout.trim());
    } catch {
      return `no answer (${r.stderr.trim().split('\n')[0]})`;
    }
  };
  const tests = () => spawnSync(process.execPath, ['test.js'], { cwd: project, encoding: 'utf8', timeout: 30_000 }).status === 0;
  try {
    if (id === 'Q') return /slug/i.test(last) && /(word|reading)/i.test(last) ? 'ok' : 'answer misses what the library does';
    if (id === 'E') return slug('"a -- b"') === 'a-b' && tests() ? 'ok' : `slugify("a -- b") = ${JSON.stringify(slug('"a -- b"'))}, tests ${tests() ? 'pass' : 'fail'}`;
    if (id === 'B') return /node 18|truncateWords|empty string/i.test(replies[0] || '') && /(teal|green|#0f766e|turquoise|cyan)/i.test(replies[1] || '') && /documentation/i.test(replies[2] || '') ? 'ok' : 'a reply misses the page content';
    if (id === 'L') {
      const v = slug('undefined');
      const added = /undefined|null|empty/i.test(fs.readFileSync(path.join(project, 'test.js'), 'utf8').split('const tests')[1] || '');
      return v === '' && tests() && added ? 'ok' : `slugify(undefined) = ${JSON.stringify(v)}, tests ${tests() ? 'pass' : 'fail'}, test added: ${added}`;
    }
  } catch (err) {
    return `check failed: ${err.message}`;
  }
  return 'n/a';
}

const BUSY = `(() => { const s = document.querySelector('#status-line'); return Boolean(s && !s.hidden) || Boolean(document.querySelector('.session-item.running')); })()`;

/** One user turn: send, answer any approval card with Allow, wait until the run ends. Returns the reply. */
async function turn(app, text, counters) {
  const before = await app.count('.msg.assistant');
  await app.send(text);
  await app.waitFor(BUSY, 15_000, 'the run to start').catch(() => undefined);
  const until = Date.now() + 300_000;
  for (;;) {
    if (await app.exists('.approval:not(.decided) .btn.primary')) {
      counters.approvals++;
      await app.approve('allow');
    }
    if (!(await app.evaluate(BUSY))) break;
    if (Date.now() > until) throw new Error(`turn timed out: ${text.slice(0, 60)}`);
    await sleep(300);
  }
  await sleep(400);
  const replies = await app.evaluate(`[...document.querySelectorAll('.msg.assistant')].slice(${before}).map((e) => e.innerText.trim()).join('\\n')`);
  return replies;
}

async function settle(state) {
  // Titles are made after a run ends, without waiting: give them time to arrive.
  const until = Date.now() + 20_000;
  await sleep(1500);
  while (Date.now() < until && (state.inflight > 0 || Date.now() - state.lastAt < 2500)) await sleep(250);
}

async function runScenario(id, run, opts, state) {
  const sc = SCENARIOS[id];
  const project = makeProject();
  const site = id === 'B' ? await startSite() : null;
  state.run = run;
  state.scenario = id;
  const counters = { approvals: 0 };
  const replies = [];
  const config = {
    portkey: { baseURL: `http://127.0.0.1:${state.port}/v1`, apiKey: '', model: opts.model, virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 200000 },
    autoTitles: true,
    ...(sc.config || {}),
  };
  const app = await launch({ mode: sc.mode, project, config });
  let error = null;
  try {
    if (!app.live) throw new Error('The rig is on the mock model: set ANTHROPIC_API_KEY');
    for (const t of sc.turns(site?.port)) replies.push(await turn(app, t, counters));
    await settle(state);
  } catch (err) {
    error = scrub(err.message);
  } finally {
    await app.close();
    site?.server.close();
  }
  const result = { id, run, name: sc.name, mode: sc.mode, approvals: counters.approvals, outcome: error ? `error: ${error}` : outcome(id, project, replies), replies: replies.map((r) => scrub(r).slice(0, 400)) };
  fs.rmSync(project, { recursive: true, force: true });
  state.scenario = null;
  return result;
}

// ---------- Native caching replay ----------

/** An OpenAI chat-completions body as a native Messages request with cache breakpoints (tools, system, last message). */
function toNative(body) {
  const system = [];
  const messages = [];
  const push = (role, blocks) => {
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else messages.push({ role, content: [...blocks] });
  };
  for (const m of body.messages) {
    if (m.role === 'system') {
      system.push({ type: 'text', text: contentText(m.content).text });
      continue;
    }
    if (m.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: contentText(m.content).text || '(empty)' }]);
      continue;
    }
    const blocks = [];
    if (typeof m.content === 'string') {
      if (m.content) blocks.push({ type: 'text', text: m.content });
    } else
      for (const p of m.content ?? []) {
        if (p.type === 'text' && p.text) blocks.push({ type: 'text', text: p.text });
        else if (p.type === 'image_url') {
          const mm = /^data:([^;]+);base64,(.*)$/s.exec(p.image_url.url);
          if (mm) blocks.push({ type: 'image', source: { type: 'base64', media_type: mm[1], data: mm[2] } });
        }
      }
    if (m.role === 'assistant')
      for (const tc of m.tool_calls ?? []) {
        let input = {};
        try {
          input = JSON.parse(tc.function.arguments || '{}');
        } catch {
          input = {};
        }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
      }
    if (!blocks.length) blocks.push({ type: 'text', text: '(empty)' });
    push(m.role === 'assistant' ? 'assistant' : 'user', blocks);
  }
  const tools = (body.tools ?? []).map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters || { type: 'object', properties: {} } }));
  if (tools.length) tools[tools.length - 1].cache_control = { type: 'ephemeral' };
  if (system.length) system[system.length - 1].cache_control = { type: 'ephemeral' };
  const lastMsg = messages[messages.length - 1];
  if (lastMsg) lastMsg.content[lastMsg.content.length - 1].cache_control = { type: 'ephemeral' };
  return { model: body.model, max_tokens: 1, thinking: { type: 'disabled' }, system, messages, ...(tools.length ? { tools } : {}) };
}

async function nativeReplay(bodies) {
  const out = [];
  for (const b of bodies) {
    const req = toNative(b.body);
    const r = await fetch(`${UPSTREAM}/v1/messages`, { method: 'POST', headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify(req) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      out.push({ seq: b.seq, run: b.run, scenario: b.scenario, kind: b.kind, error: scrub(JSON.stringify(j)).slice(0, 300) });
      continue;
    }
    const u = j.usage || {};
    out.push({ seq: b.seq, run: b.run, scenario: b.scenario, kind: b.kind, input: u.input_tokens || 0, write: u.cache_creation_input_tokens || 0, read: u.cache_read_input_tokens || 0 });
  }
  return out;
}

// ---------- Report ----------

const n0 = (v) => Math.round(v).toLocaleString('en-US');
const usd = (v) => `$${v.toFixed(4)}`;
const PARTS = ['tools', 'system', 'user', 'assistant', 'toolResults', 'images'];
const PART_LABEL = { tools: 'Tools', system: 'System', user: 'User', assistant: 'Assistant', toolResults: 'Tool results', images: 'Images' };

function sum(recs) {
  const s = { requests: recs.length, agent: 0, classifier: 0, title: 0, compaction: 0, other: 0, input: 0, output: 0, cached: 0, cost: 0, parts: Object.fromEntries(PARTS.map((p) => [p, 0])) };
  for (const r of recs) {
    s[r.kind in s ? r.kind : 'other']++;
    s.input += Number(r.usage?.prompt_tokens) || 0;
    s.output += Number(r.usage?.completion_tokens) || 0;
    s.cached += cached(r.usage);
    s.cost += r.cost || 0;
    if (r.split) for (const p of PARTS) s.parts[p] += r.split[p];
  }
  return s;
}

function tables(records, results, ids) {
  const lines = [];
  const chat = records.filter((r) => r.kind !== 'non-chat');
  lines.push('| Scenario | Requests (agent / check / title / other) | Input | Output | Cached | Cost |', '|---|---|--:|--:|--:|--:|');
  const rows = [...ids.map((id) => [id, chat.filter((r) => r.scenario === id)]), ['Total', chat]];
  for (const [id, recs] of rows) {
    const s = sum(recs);
    lines.push(`| ${id} | ${s.requests} (${s.agent} / ${s.classifier} / ${s.title} / ${s.compaction + s.other}) | ${n0(s.input)} | ${n0(s.output)} | ${n0(s.cached)} | ${usd(s.cost)} |`);
  }
  lines.push('', 'Input split by part (tokens):', '', `| Scenario | ${PARTS.map((p) => PART_LABEL[p]).join(' | ')} |`, `|---|${PARTS.map(() => '--:').join('|')}|`);
  for (const [id, recs] of rows) {
    const s = sum(recs);
    lines.push(`| ${id} | ${PARTS.map((p) => `${n0(s.parts[p])} (${s.input ? Math.round((100 * s.parts[p]) / s.input) : 0}%)`).join(' | ')} |`);
  }
  const side = chat.filter((r) => r.kind !== 'agent');
  if (side.length) {
    lines.push('', 'Side calls:', '', '| Scenario | Kind | Requests | Input | Output | Cost |', '|---|---|--:|--:|--:|--:|');
    for (const id of ids)
      for (const kind of ['classifier', 'title', 'compaction', 'other']) {
        const recs = side.filter((r) => r.scenario === id && r.kind === kind);
        if (!recs.length) continue;
        const s = sum(recs);
        lines.push(`| ${id} | ${kind} | ${s.requests} | ${n0(s.input)} | ${n0(s.output)} | ${usd(s.cost)} |`);
      }
  }
  if (results) {
    lines.push('', '| Scenario | Outcome | Approvals answered |', '|---|---|--:|');
    for (const r of results) lines.push(`| ${r.id} | ${r.outcome.replace(/\|/g, '/')} | ${r.approvals} |`);
  }
  return lines;
}

function prefixReport(records, state) {
  const lines = ['| Scenario | Agent requests | Distinct tool lists | Distinct system prompts | First change in the system prompt |', '|---|--:|--:|--:|---|'];
  for (const id of [...new Set(records.map((r) => `${r.run}:${r.scenario}`))]) {
    const recs = records.filter((r) => `${r.run}:${r.scenario}` === id && r.kind === 'agent');
    if (!recs.length) continue;
    const tools = new Set(recs.map((r) => r.toolsHash));
    const sys = new Set(recs.map((r) => r.systemHash));
    let change = '';
    for (let i = 1; i < recs.length && !change; i++) {
      const a = state.systems.get(recs[i - 1].seq) || '';
      const b = state.systems.get(recs[i].seq) || '';
      if (a === b) continue;
      let k = 0;
      while (k < a.length && a[k] === b[k]) k++;
      change = `char ${k} of ${b.length}: \`${b.slice(Math.max(0, k - 30), k + 40).replace(/\n/g, ' ').replace(/`/g, "'")}\``;
    }
    lines.push(`| run ${id.replace(':', ' ')} | ${recs.length} | ${tools.size} | ${sys.size} | ${change || 'none'} |`);
  }
  // Across sessions: how long a prefix the system prompts of different scenarios share
  const firsts = [];
  for (const id of [...new Set(records.map((r) => `${r.run}:${r.scenario}`))]) {
    const r = records.find((x) => `${x.run}:${x.scenario}` === id && x.kind === 'agent');
    if (r) firsts.push({ id, sys: state.systems.get(r.seq) || '', tools: r.toolsHash });
  }
  if (firsts.length > 1) {
    let common = firsts[0].sys.length;
    for (const f of firsts.slice(1)) {
      let k = 0;
      while (k < common && f.sys[k] === firsts[0].sys[k]) k++;
      common = k;
    }
    lines.push('', `Across the ${firsts.length} sessions: ${new Set(firsts.map((f) => f.tools)).size} distinct tool lists; the system prompts share their first ${common} characters (of ${firsts[0].sys.length}).`);
  }
  return lines;
}

function toolTable(state) {
  const lines = [];
  for (const [hash, list] of state.perToolByHash) {
    if (!hash) continue;
    const total = list.reduce((a, t) => a + t.chars, 0);
    lines.push('', `Tool list ${hash}: ${list.length} tools, ${n0(total)} characters (about ${n0(total / 3.6)} tokens at 3.6 characters per token).`, '', '| Tool | Characters | of which description |', '|---|--:|--:|');
    for (const t of [...list].sort((a, b) => b.chars - a.chars)) lines.push(`| ${t.name} | ${n0(t.chars)} | ${n0(t.description)} |`);
  }
  return lines;
}

function nativeTable(replay, records) {
  const lines = ['| Scenario | Requests | Input total | Cache writes | Cache reads | Uncached | Cost without caching | Cost with caching | Saving |', '|---|--:|--:|--:|--:|--:|--:|--:|--:|'];
  const ok = replay.filter((r) => !r.error);
  const groups = [...new Set(ok.map((r) => r.scenario))];
  const row = (label, recs) => {
    const tot = recs.reduce((a, r) => a + r.input + r.write + r.read, 0);
    const w = recs.reduce((a, r) => a + r.write, 0);
    const rd = recs.reduce((a, r) => a + r.read, 0);
    const inp = recs.reduce((a, r) => a + r.input, 0);
    const seqs = new Set(recs.map((r) => r.seq));
    const out = records.filter((r) => seqs.has(r.seq)).reduce((a, r) => a + (Number(r.usage?.completion_tokens) || 0), 0);
    const without = (tot * PRICES.input + out * PRICES.output) / 1e6;
    const withC = (inp * PRICES.input + w * PRICES.cacheWrite + rd * PRICES.cacheRead + out * PRICES.output) / 1e6;
    lines.push(`| ${label} | ${recs.length} | ${n0(tot)} | ${n0(w)} | ${n0(rd)} | ${n0(inp)} | ${usd(without)} | ${usd(withC)} | ${without ? Math.round((100 * (without - withC)) / without) : 0}% |`);
  };
  for (const g of groups) row(g, ok.filter((r) => r.scenario === g));
  row('Total', ok);
  const errs = replay.filter((r) => r.error);
  if (errs.length) lines.push('', `${errs.length} replayed request(s) failed, e.g. ${errs[0].error}`);
  lines.push('', 'Output tokens are those of the recorded run (the replay asks for one token); input cost uses the same token counts the native API reported.');
  return lines;
}

// ---------- Main ----------

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  if (!KEY) throw new Error('Set ANTHROPIC_API_KEY (the benchmark talks to the real API).');
  const unknown = opts.scenarios.filter((s) => !SCENARIOS[s]);
  if (unknown.length) throw new Error(`Unknown scenario(s): ${unknown.join(', ')}`);
  const out = opts.out || fs.mkdtempSync(path.join(os.tmpdir(), 'token-bench-'));
  fs.mkdirSync(out, { recursive: true });
  const state = { seq: 0, run: 0, scenario: null, inflight: 0, lastAt: 0, records: [], bodies: [], perToolByHash: new Map(), systems: new Map(), port: 0 };
  const proxy = await startProxy(state);
  state.port = proxy.port;
  const results = [];
  for (let run = 1; run <= opts.runs; run++) {
    for (const id of opts.scenarios) {
      const t0 = Date.now();
      process.stderr.write(`run ${run} ${id} … `);
      const r = await runScenario(id, run, opts, state);
      results.push(r);
      process.stderr.write(`${r.outcome} (${Math.round((Date.now() - t0) / 1000)} s)\n`);
    }
  }
  proxy.server.close();

  let replay = null;
  if (opts.native) {
    process.stderr.write('native caching replay … ');
    const bodies = state.bodies.map((l) => JSON.parse(l)).filter((b) => b.kind === 'agent' || b.kind === 'classifier');
    replay = await nativeReplay(bodies);
    process.stderr.write('done\n');
  }

  const chatRecs = state.records.filter((r) => r.kind !== 'non-chat');
  const ratios = chatRecs.map((r) => r.split?.charsPerToken).filter(Number.isFinite);
  const md = [
    `# Token benchmark${opts.label ? `: ${opts.label}` : ''}`,
    '',
    `${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · model ${opts.model} via ${UPSTREAM}/v1 (OpenAI-compatible) · ${opts.runs} run(s) · scenarios ${opts.scenarios.join(', ')}`,
    '',
    `Prices (USD per million tokens, Claude Haiku 5.5, prompts up to 100K): input ${PRICES.input}, output ${PRICES.output}, cache write ${PRICES.cacheWrite}, cache read ${PRICES.cacheRead}. Characters per token in these requests: ${ratios.length ? `${Math.min(...ratios).toFixed(2)}–${Math.max(...ratios).toFixed(2)} (median ${ratios.sort((a, b) => a - b)[Math.floor(ratios.length / 2)].toFixed(2)})` : 'n/a'}.`,
    '',
  ];
  for (let run = 1; run <= opts.runs; run++) {
    md.push(`## Run ${run}`, '', ...tables(chatRecs.filter((r) => r.run === run), results.filter((r) => r.run === run), opts.scenarios), '');
  }
  if (opts.runs > 1) {
    md.push('## Across runs (mean, min–max)', '', '| Scenario | Requests | Input | Output | Cost |', '|---|--:|--:|--:|--:|');
    for (const id of [...opts.scenarios, 'Total']) {
      const per = [];
      for (let run = 1; run <= opts.runs; run++) per.push(sum(chatRecs.filter((r) => r.run === run && (id === 'Total' || r.scenario === id))));
      const f = (k, fmt) => {
        const v = per.map((p) => p[k]);
        return `${fmt(v.reduce((a, b) => a + b, 0) / v.length)} (${fmt(Math.min(...v))}–${fmt(Math.max(...v))})`;
      };
      md.push(`| ${id} | ${f('requests', (v) => v.toFixed(1).replace(/\.0$/, ''))} | ${f('input', n0)} | ${f('output', n0)} | ${f('cost', usd)} |`);
    }
    md.push('');
  }
  md.push('## Prefix stability', '', ...prefixReport(chatRecs, state), '');
  md.push('## Tool definitions', ...toolTable(state), '');
  if (replay) md.push('## Native prompt caching (replay through the Messages API)', '', ...nativeTable(replay, chatRecs), '');
  const nonChat = state.records.filter((r) => r.kind === 'non-chat');
  if (nonChat.length) md.push(`Other requests through the proxy: ${nonChat.map((r) => `${r.method} ${r.path} (${r.status})`).join(', ')}`, '');

  const report = scrub(md.join('\n'));
  fs.writeFileSync(path.join(out, 'report.md'), report);
  fs.writeFileSync(path.join(out, 'results.json'), scrub(JSON.stringify({ opts: { ...opts }, prices: PRICES, results, records: state.records, replay }, null, 2)));
  fs.writeFileSync(path.join(out, 'requests.jsonl'), state.bodies.join('\n') + '\n');
  console.log(report);
  console.error(`\nwritten to ${out}`);
  process.exit(0);
})().catch((err) => {
  console.error('token-bench failed:', scrub(err && err.stack ? err.stack : String(err)));
  process.exit(1);
});
