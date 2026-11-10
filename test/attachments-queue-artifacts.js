// Image attachments, the message queue and artifacts through the agent with mock servers.
// Run: node smoke7.js <projectDir>   (after `npx tsc -p tsconfig.json`)
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { Agent } = require(path.join(projectDir, 'dist/main/agent.js'));
const { SessionStore, toTranscript, toMeta, displayText } = require(path.join(projectDir, 'dist/main/sessions.js'));
const { loadSkills } = require(path.join(projectDir, 'dist/main/skills.js'));
const { ArtifactStore } = require(path.join(projectDir, 'dist/main/artifacts.js'));
const { toOllamaMessages } = require(path.join(projectDir, 'dist/main/ollama.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${detail !== undefined ? ` | ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`.slice(0, 420));
};
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const img = (id = 'img-1') => ({ id, name: 'test.png', mime: 'image/png', dataUrl: PNG, width: 1, height: 1, size: 70 });

// ---- mock OpenAI-compatible server (streaming), with a per-reply delay ----
const requests = [];
const replies = [];
let delayMs = 0;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const payload = body ? JSON.parse(body) : {};
    requests.push({ url: req.url, payload });
    const json = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url === '/api/chat') {
      // Ollama native: NDJSON
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end(JSON.stringify({ model: payload.model, message: { role: 'assistant', content: 'I see the image.' }, done: true, prompt_eval_count: 5, eval_count: 3 }) + '\n');
      return;
    }
    if (req.url !== '/v1/chat/completions') return json(404, {});
    if (!payload.stream) return json(200, { id: 't', object: 'chat.completion', created: 0, model: payload.model, choices: [{ index: 0, message: { role: 'assistant', content: 'Mock Title' }, finish_reason: 'stop' }] });
    const reply = replies.shift() ?? { content: 'Done.' };
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (obj) => res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: payload.model, ...obj })}\n\n`);
      if (reply.content) send({ choices: [{ index: 0, delta: { role: 'assistant', content: reply.content } }] });
      if (reply.toolCalls) send({ choices: [{ index: 0, delta: { tool_calls: reply.toolCalls.map((c, i) => ({ index: i, id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: reply.toolCalls ? 'tool_calls' : 'stop' }] });
      res.write('data: [DONE]\n\n');
      res.end();
    }, delayMs);
  });
});

server.listen(0, async () => {
  const port = server.address().port;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-smoke7-'));
  const store = new SessionStore(path.join(tmp, 'sessions'));
  const artifacts = new ArtifactStore({ root: path.join(tmp, 'artifacts'), rendererDir: path.join(projectDir, 'dist/renderer') });
  const config = {
    provider: 'portkey',
    ollama: { baseURL: `http://127.0.0.1:${port}/v1`, model: 'mock', numCtx: 8192, think: 'auto' },
    portkey: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'test', model: 'mock', virtualKey: '', provider: '', providerApiKey: '', configId: '' },
    workingDirectory: tmp, permissionMode: 'bypass', autoApprove: true, maxTurns: 12, sendScreenshotsToModel: false, systemPromptExtra: '', theme: 'system', autoTitles: false,
  };
  let events = [];
  const navigated = [];
  const browser = { navigate: async (url) => { navigated.push(url); return `Now at ${url}`; } };
  const agent = new Agent(() => config, browser, store, () => loadSkills(tmp, projectDir), (ev) => events.push(ev), undefined, artifacts);
  let id = 0;
  const call = (name, args) => ({ id: `c${++id}`, name, args });
  // The last message from the user (the app's context notes left out)
  const isNote = (m) => typeof m.content === 'string' && m.content.startsWith('[Session context]');
  const lastUser = (payload) => [...payload.messages].reverse().find((m) => m.role === 'user' && !isNote(m));

  // ---- A: attachments become image parts ----
  events = []; requests.length = 0;
  replies.push({ content: 'A tiny red square.' });
  await agent.run('What is in this image?', [img()]);
  let u = lastUser(requests[0].payload);
  check('A: user message has text + image parts', Array.isArray(u.content) && u.content[0].type === 'text' && u.content[0].text === 'What is in this image?' && u.content[1].type === 'image_url' && u.content[1].image_url.url === PNG, JSON.stringify(u).slice(0, 160));
  const items = toTranscript(agent.session);
  check('A: transcript user item carries the image', items[0].role === 'user' && items[0].text === 'What is in this image?' && Array.isArray(items[0].images) && items[0].images[0] === PNG);
  check('A: displayText drops image placeholders', displayText(u.content) === 'What is in this image?');
  replies.push({ content: 'Only images.' });
  await agent.run('', [img('img-2'), img('img-3')]);
  u = lastUser(requests[1].payload);
  check('A: images without text are sent as image parts only', Array.isArray(u.content) && u.content.length === 2 && u.content.every((p) => p.type === 'image_url'));
  const om = toOllamaMessages(agent.session.messages);
  const ou = om.filter((m) => m.role === 'user' && !isNote(m));
  check('A: Ollama mapping strips the data URL prefix into images[]', ou[0].content === 'What is in this image?' && ou[0].images.length === 1 && ou[0].images[0] === PNG.split(',')[1] && ou[1].images.length === 2, JSON.stringify(ou[1]).slice(0, 120));

  // ---- B: queue ----
  events = []; requests.length = 0; delayMs = 300;
  replies.push({ toolCalls: [call('bash', { command: 'echo one' })] });
  replies.push({ content: 'Both handled.' });
  const run1 = agent.run('first');
  await sleep(60);
  let threw = '';
  const q1 = agent.enqueue('second', [img('q-img')]);
  check('B: enqueue during a run returns a queued message', q1 && q1.id && q1.text === 'second' && agent.queue().length === 1);
  await run1;
  const delivered = events.filter((e) => e.type === 'queue_delivered');
  const req2 = requests[1] && lastUser(requests[1].payload);
  check('B: queued message delivered before the next model call', delivered.length === 1 && delivered[0].id === q1.id && req2 && Array.isArray(req2.content) && req2.content[0].text === 'second' && req2.content[1].type === 'image_url', JSON.stringify(req2).slice(0, 120));
  check('B: queue empty after delivery, run ended done', agent.queue().length === 0 && events.filter((e) => e.type === 'run_end').pop().reason === 'done');
  check('B: transcript order: first, tool, second, reply', JSON.stringify(toTranscript(agent.session).slice(-4).map((i) => i.role)) === JSON.stringify(['user', 'tool', 'user', 'assistant']), toTranscript(agent.session).slice(-4).map((i) => i.role + ':' + (i.text || i.name || '').slice(0, 12)));
  // no tool calls, but a queued message keeps the run going
  events = []; requests.length = 0;
  replies.push({ content: 'Hello.' });
  replies.push({ content: 'And hello again.' });
  const run2 = agent.run('say hi');
  await sleep(60);
  const q2 = agent.enqueue('one more thing');
  await run2;
  check('B: a reply without tool calls continues the run for the queued message', requests.length === 2 && lastUser(requests[1].payload).content === 'one more thing' && events.some((e) => e.type === 'queue_delivered' && e.id === q2.id), requests.length);
  check('B: enqueue when idle throws', (() => { try { agent.enqueue('x'); return false; } catch (e) { return /No run is in progress/.test(e.message); } })());
  // unqueue
  events = []; requests.length = 0;
  replies.push({ toolCalls: [call('bash', { command: 'echo two' })] });
  replies.push({ content: 'Done.' });
  const run3 = agent.run('third');
  await sleep(60);
  const q3 = agent.enqueue('remove me');
  check('B: unqueue removes it', agent.unqueue(q3.id) === true && agent.queue().length === 0 && agent.unqueue(q3.id) === false);
  await run3;
  check('B: removed message never delivered', !events.some((e) => e.type === 'queue_delivered') && !requests.some((r) => JSON.stringify(r.payload).includes('remove me')));
  // dropped on stop
  events = []; requests.length = 0; delayMs = 1500;
  replies.push({ content: 'slow' });
  const run4 = agent.run('slow one');
  // Stop once the mock holds the request: one still on the wire would take the next reply
  for (let i = 0; i < 400 && !requests.length; i++) await sleep(5);
  const q4 = agent.enqueue('dropped?');
  agent.stop();
  await run4;
  const dropped = events.filter((e) => e.type === 'queue_dropped');
  check('B: stopping the run drops queued messages back to the renderer', dropped.length === 1 && dropped[0].id === q4.id && agent.queue().length === 0 && events.filter((e) => e.type === 'run_end').pop().reason === 'aborted', dropped);
  delayMs = 0;

  // ---- C: artifacts ----
  events = []; requests.length = 0; navigated.length = 0;
  replies.push({ toolCalls: [call('create_artifact', { title: 'Hello page', kind: 'html', content: '<!doctype html><html><body><h1>Hi</h1></body></html>' })] });
  replies.push({ content: 'Made a page.' });
  await agent.run('make a page');
  let list = artifacts.list(agent.session);
  const ev = events.find((e) => e.type === 'artifact');
  check('C: artifact created, stored and announced', list.length === 1 && list[0].id === 'art-1' && list[0].kind === 'html' && list[0].version === 1 && fs.existsSync(list[0].path) && ev && ev.action === 'created' && ev.artifact.id === 'art-1', list[0]);
  check('C: browser pane navigated to the artifact URL', navigated[0] === `artifact://view/${agent.session.id}/art-1`, navigated);
  const toolEnd = events.find((e) => e.type === 'tool_end' && e.name === 'create_artifact');
  check('C: tool result names the id', toolEnd && toolEnd.ok && /^Artifact "Hello page" created \(HTML, v1, \d+ B\) and shown in the Browser pane\. id: art-1/.test(toolEnd.result), toolEnd && toolEnd.result);
  let tr = toTranscript(agent.session);
  check('C: transcript shows an artifact item instead of the tool row', tr.some((i) => i.role === 'artifact' && i.artifact.id === 'art-1') && !tr.some((i) => i.role === 'tool' && i.name === 'create_artifact'));
  check('C: session meta counts artifacts', toMeta(agent.session).artifacts === 1);
  check('C: session persisted with the artifact', JSON.parse(fs.readFileSync(path.join(tmp, 'sessions', `${agent.session.id}.json`), 'utf8')).artifacts['art-1'].title === 'Hello page');
  // update + markdown + code + svg
  replies.push({ toolCalls: [call('create_artifact', { id: 'art-1', title: 'Hello page v2', kind: 'html', content: '<!doctype html><html><body><h1>Hi again</h1></body></html>' })] });
  replies.push({ toolCalls: [call('create_artifact', { title: 'Notes', kind: 'markdown', content: '# Notes\n\nSome **bold** text and `code`.\n\n```js\nconsole.log(1)\n```\n' })] });
  replies.push({ toolCalls: [call('create_artifact', { title: 'Snippet', kind: 'code', language: 'python', content: 'def f():\n    return 1\n' })] });
  replies.push({ toolCalls: [call('create_artifact', { title: 'Circle', kind: 'svg', content: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle cx="5" cy="5" r="4"/></svg>' })] });
  replies.push({ content: 'All made.' });
  events = [];
  await agent.run('more');
  list = artifacts.list(agent.session);
  check('C: update bumps the version and keeps the id', list[0].id === 'art-1' && list[0].version === 2 && list[0].title === 'Hello page v2' && fs.readFileSync(list[0].path, 'utf8').includes('Hi again') && events.some((e) => e.type === 'artifact' && e.action === 'updated'));
  check('C: four artifacts with sensible file names', list.length === 4 && path.basename(list[1].path) === 'art-2.md' && path.basename(list[2].path) === 'art-3.py' && path.basename(list[3].path) === 'art-4.svg', list.map((a) => path.basename(a.path)));
  // resolver
  const sid = agent.session.id;
  const r1 = artifacts.resolve(`artifact://view/${sid}/art-1`);
  check('C: resolve html → the file itself', r1 && r1.kind === 'file' && r1.path === list[0].path);
  const r2 = artifacts.resolve(`artifact://view/${sid}/art-2`);
  check('C: resolve markdown → viewer page importing the app renderer', r2 && r2.kind === 'page' && r2.html.includes('src="/_app/artifact-viewer.js"') && r2.html.includes('"kind":"markdown"') && r2.html.includes('<link rel="stylesheet" href="/_app/styles.css">') && r2.html.includes('Some **bold**') && !/<\/script>[^]*<\/script>[^]*<\/script>[^]*<\/script>/.test(r2.html.split('application/json')[1].split('</script>')[0]));
  const r3 = artifacts.resolve(`artifact://view/${sid}/art-3`);
  check('C: resolve code → viewer page with highlight and language', r3 && r3.kind === 'page' && r3.html.includes('src="/_app/artifact-viewer.js"') && r3.html.includes('"kind":"code"') && r3.html.includes('"language":"python"'));
  const r4 = artifacts.resolve(`artifact://view/${sid}/art-4`);
  check('C: resolve svg → viewer page with img to the file route', r4 && r4.kind === 'page' && r4.html.includes(`<img src="/${sid}/files/art-4.svg"`));
  const r5 = artifacts.resolve(`artifact://view/${sid}/files/art-4.svg`);
  check('C: resolve files route → the stored file only', r5 && r5.kind === 'file' && r5.path === list[3].path && artifacts.resolve(`artifact://view/${sid}/files/../../etc/passwd`) === null && artifacts.resolve(`artifact://view/${sid}/files/meta.json`) === null);
  const r6 = artifacts.resolve('artifact://view/_app/markdown.js');
  check('C: resolve app modules only from the allow-list', r6 && r6.kind === 'file' && r6.path.endsWith('dist/renderer/markdown.js') && artifacts.resolve('artifact://view/_app/renderer.js') === null && artifacts.resolve('artifact://view/_app/../package.json') === null);
  check('C: resolve rejects other hosts and sessions', artifacts.resolve('artifact://files/x/y') === null && artifacts.resolve('artifact://view/no-such-session/art-1') === null && artifacts.resolve('https://example.com/') === null);
  const md = artifacts.resolve(`artifact://view/${sid}/art-2`).html;
  check('C: viewer embeds the source as JSON without a raw "<"', !/<\/script>\s*<\/script>/.test(md) && /"source":"# Notes/.test(md) && !md.split('<script id="src"')[1].split('</script>')[0].includes('<'));
  // content / invalid input
  check('C: content() returns the source', artifacts.content(agent.session, 'art-3') === 'def f():\n    return 1\n');
  threw = '';
  try { artifacts.save(agent.session, { title: 'x', kind: 'pdf', content: 'x' }); } catch (e) { threw = e.message; }
  check('C: invalid kind rejected', /kind must be one of/.test(threw), threw);
  threw = '';
  try { artifacts.save(agent.session, { id: '../evil', title: 'x', kind: 'html', content: '<p>x</p>' }); } catch (e) { threw = e.message; }
  check('C: unsafe id rejected', /letters, digits/.test(threw), threw);
  // fork copies, delete removes
  const forked = store.fork(sid);
  artifacts.copy(agent.session, forked);
  const fl = artifacts.list(forked);
  check('C: fork copies artifacts with new paths and URLs', fl.length === 4 && fl[0].sessionId === forked.id && fl[0].url === `artifact://view/${forked.id}/art-1` && fs.existsSync(fl[0].path) && fl[0].path !== list[0].path, fl[0] && fl[0].path);
  check('C: forked artifacts resolve too', artifacts.resolve(`artifact://view/${forked.id}/art-2`)?.kind === 'page');
  artifacts.remove(forked.id);
  check('C: remove deletes the folder', !fs.existsSync(artifacts.dirFor(forked.id)) && fs.existsSync(list[0].path));

  // ---- Ollama native path with an image ----
  config.provider = 'ollama';
  events = []; requests.length = 0;
  await agent.run('describe', [img('o-1')]);
  const oreq = requests.find((r) => r.url === '/api/chat' && r.payload.stream !== false); // a long session may compact first (non-streaming summary request)
  const olast = oreq && [...oreq.payload.messages].reverse().find((m) => m.role === 'user' && !isNote(m));
  check('Ollama: /api/chat request carries images[] on the user message', olast && olast.content === 'describe' && Array.isArray(olast.images) && olast.images[0] === PNG.split(',')[1], olast && Object.keys(olast));
  check('Ollama: reply received', events.some((e) => e.type === 'text_delta' && /I see the image/.test(e.text)));

  server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL OK');
  process.exit(failures ? 1 : 0);
});
