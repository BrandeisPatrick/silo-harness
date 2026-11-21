// next_step, headless: the tool's checks, the spec, the system prompt's sentence, and a call through the runtime with
// the mock model (no approval, returns at once, the stored card with the reply the user chose; a sub-session is not
// offered the tool).
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { nextStep, parseNextStep, nextStepOrNull, SHOWN, NEXT_STEP_NUDGE } = require(path.join(projectDir, 'dist/main/tools/next-step.js'));
const { allTools } = require(path.join(projectDir, 'dist/main/tools/index.js'));
const { systemPrompt } = require(path.join(projectDir, 'dist/main/agent/prompt.js'));
const { toTranscript } = require(path.join(projectDir, 'dist/main/sessions.js'));
const { createApp } = require(path.join(projectDir, 'dist/main/app.js'));
const { ArtifactStore } = require(path.join(projectDir, 'dist/main/artifacts.js'));
const { startMock } = require('./support/mock-model.js');
const { check, done } = require('./support/check.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 5000, what = 'condition') {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await sleep(15);
  }
}
const throws = (fn) => {
  try {
    fn();
    return '';
  } catch (err) {
    return String(err.message || err);
  }
};

const CARD = { recap: 'The importer resumes after a crash and its tests pass. Nothing is pushed yet.', question: 'Push it on a new branch instead?', replies: ['Yes, new branch', 'Not yet'] };

(async () => {
  // ---------- The checks ----------
  const ok = parseNextStep(CARD);
  check('a good card passes as it is', JSON.stringify(ok) === JSON.stringify(CARD), ok);
  check('the arguments as JSON text pass too', parseNextStep(JSON.stringify(CARD)).replies[1] === 'Not yet');
  check('a recap alone is a card (no question, no replies)', JSON.stringify(parseNextStep({ recap: 'Done.' })) === JSON.stringify({ recap: 'Done.', question: '', replies: [] }));
  check('no recap: refused, saying it is required', /recap is required/.test(throws(() => parseNextStep({ question: 'Ship?' }))) && /recap is required/.test(throws(() => parseNextStep('nope'))));
  check('a recap of 300 characters passes, 301 is refused', parseNextStep({ recap: 'a'.repeat(300) }).recap.length === 300 && /301 characters; keep it to 300/.test(throws(() => parseNextStep({ recap: 'a'.repeat(301) }))));
  check('a question of 100 characters passes, 101 is refused', parseNextStep({ recap: 'r', question: 'q'.repeat(100) }).question.length === 100 && /keep it to 100/.test(throws(() => parseNextStep({ recap: 'r', question: 'q'.repeat(101) }))));
  check('a reply of 40 characters passes, 41 is refused with the length and the limit', parseNextStep({ recap: 'r', question: 'q?', replies: ['x'.repeat(40)] }).replies[0].length === 40 && /is 41 characters; keep each to 40/.test(throws(() => parseNextStep({ recap: 'r', question: 'q?', replies: ['x'.repeat(41)] }))));
  check('a 30-character reply passes', parseNextStep({ recap: 'r', question: 'q?', replies: ['Add ESLint and tsc to the CI'.padEnd(30, '!')] }).replies[0].length === 30);
  const rec = parseNextStep({ recap: 'r', question: 'Which checks?', replies: ['ESLint + tsc (Recommended)', 'Only tsc (recommended) '] });
  check('a trailing "(Recommended)" is dropped before measuring', JSON.stringify(rec.replies) === JSON.stringify(['ESLint + tsc', 'Only tsc']) && parseNextStep({ recap: 'r', question: 'q?', replies: ['x'.repeat(40) + ' (Recommended)'] }).replies[0].length === 40, rec.replies);
  check('three replies: refused', /at most 2 replies/.test(throws(() => parseNextStep({ ...CARD, replies: ['A', 'B', 'C'] }))));
  check('replies that are not a list: refused', /must be a list/.test(throws(() => parseNextStep({ ...CARD, replies: 'Yes' }))));
  check('a reply that starts with /, #, @ or ! (after trimming): refused, as it would run a command, a note or a mention', ['/dream', ' /effort max', '#remember', '@file', '!ls'].every((r) => /starts with/.test(throws(() => parseNextStep({ ...CARD, replies: [r] })))) && parseNextStep({ ...CARD, replies: ['Yes /now'] }).replies[0] === 'Yes /now');
  check('an empty reply: refused', /needs a label/.test(throws(() => parseNextStep({ ...CARD, replies: ['Yes', '  '] }))) && /needs a label/.test(throws(() => parseNextStep({ ...CARD, replies: [3] }))));
  check('the same reply twice: refused', /the same/.test(throws(() => parseNextStep({ ...CARD, replies: ['Yes', 'yes'] }))));
  check('replies without a question: refused', /add the question/.test(throws(() => parseNextStep({ recap: 'r', replies: ['Yes'] }))));
  const odd = parseNextStep({ recap: 'Line one\n\nline\ttwo‮', question: ' <b>Ship</b>​ it? ', replies: ['  Yes\n now '] });
  check('plain text on one line: control, zero-width and direction characters go; markup stays text', odd.recap === 'Line one line two' && odd.question === '<b>Ship</b> it?' && odd.replies[0] === 'Yes now', odd);
  check('length counts characters, not UTF-16 units', parseNextStep({ recap: '🚀'.repeat(300) }).recap === '🚀'.repeat(300));
  check('nextStepOrNull: null for a refused card', nextStepOrNull({}) === null && nextStepOrNull(CARD).question === CARD.question);

  // ---------- The spec ----------
  for (const mode of ['ask', 'acceptEdits', 'auto', 'plan', 'bypass']) check(`offered in ${mode} mode`, allTools(mode).some((t) => t.name === 'next_step'));
  const props = nextStep.parameters.properties;
  check('the schema: recap required, replies at most 2', nextStep.parameters.required.join() === 'recap' && props.replies.maxItems === 2 && props.recap.type === 'string' && props.question.type === 'string');
  check('the spec: call it when the work is done, then write the reply; the first reply is the recommended one, unmarked', /decision or a step/.test(nextStep.description) && /then write your reply to the user in full/.test(nextStep.description) && /does not replace it/.test(nextStep.description) && /first reply is the recommended one; do not mark it/.test(nextStep.description));
  check('the tool returns at once with the fixed text', (await nextStep.run(CARD, {})).content === SHOWN && /write your reply to the user in full/.test(SHOWN) && /without asking the card's question again/.test(SHOWN) && !/End your turn/.test(SHOWN));
  check('the tool refuses a bad card with the reason', /add the question/.test(await nextStep.run({ recap: 'r', replies: ['Yes'] }, {}).then(() => '', (e) => e.message)));

  // ---------- The system prompt ----------
  const cfg = { permissionMode: 'ask', workingDirectory: os.tmpdir(), systemPromptExtra: '', mcpServers: {} };
  const prompt = systemPrompt(cfg, [], null);
  const line = prompt.split('\n').find((l) => l.includes('next_step')) ?? '';
  check('the prompt has one sentence on next_step, next to the closing rule', / When you have next_step and the turn leaves the user a decision or a step to take, call it once when the work is done, then write that closing reply; otherwise do not\.$/.test(line) && line.startsWith('- Keep going until the task is complete') && line.includes('Then close briefly'), line);
  check('a session with its own tools (a dream) is not told about it', !systemPrompt(cfg, [], null, '', ['remember', 'recall']).includes('next_step'));

  // ---------- Through the runtime ----------
  const mock = await startMock();
  const { state } = mock;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-nextstep-'));
  process.env.SILO_HARNESS_CONFIG_DIR = path.join(tmp, 'home-config');
  let config = {
    provider: 'portkey',
    ollama: { baseURL: `http://127.0.0.1:${mock.port}/v1`, model: 'mock', numCtx: 4096, think: 'auto' },
    portkey: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'test', model: 'mock', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 128000 },
    workingDirectory: tmp, permissionMode: 'ask', autoApprove: false, maxTurns: 12, sendScreenshotsToModel: false, systemPromptExtra: '', theme: 'system', autoTitles: false,
    mcpServers: {}, mcpTrusted: {}, autoCompact: false, notifications: false, allowRules: {}, recentDirs: [],
  };
  const app = createApp({
    userData: tmp,
    appRoot: projectDir,
    loadConfig: () => config,
    saveConfig: (c) => (config = c),
    browser: () => ({ navigate: async () => '' }),
    artifacts: new ArtifactStore({ root: path.join(tmp, 'artifacts'), rendererDir: path.join(projectDir, 'dist/renderer') }),
  });
  const rt = app.runtime;
  let events = [];
  app.events.on((sid, ev) => events.push({ sid, ev }));
  const of = (type) => events.filter((e) => e.ev.type === type).map((e) => e.ev);
  const A = rt.foregroundId();
  const idle = (id = A) => waitFor(() => !rt.isRunning(id), 15000, 'the run to end');
  const offered = (req) => (req?.payload.tools ?? []).map((t) => t.function.name);
  const streamed = () => state.requests.filter((q) => q.url === '/v1/chat/completions' && q.payload.stream);

  // 1. The reply first, the call last (some models do it that way): no approval, the tool returns at once, and the
  // empty message after it ends the turn (the reply is written)
  state.replies.push({ content: 'The importer now resumes.', toolCalls: [{ id: 'n1', name: 'next_step', args: CARD }] });
  state.replies.push({ content: '' });
  rt.send(A, 'Make the importer resumable.');
  await idle();
  check('1: a top-level session is offered next_step', offered(streamed()[0]).includes('next_step'), offered(streamed()[0]));
  check('1: no approval card', !of('approval_request').length);
  const end = of('tool_end').find((e) => e.name === 'next_step');
  check('1: the call ends ok with the fixed text', end && end.ok && end.result === SHOWN, end);
  const msgs1 = app.store.get(A).messages;
  check('1: the reply came before the call: the empty message after it ends the turn, no nudge, no second answer', !JSON.stringify(msgs1).includes('empty response') && streamed().length === 2, msgs1.slice(-2));
  let items = toTranscript(app.store.get(A));
  let card = items.find((i) => i.role === 'next_step');
  check('1: the stored transcript has the card, not a tool row', card && JSON.stringify(card.step) === JSON.stringify(CARD) && !card.chosen && !items.some((i) => i.role === 'tool' && i.name === 'next_step'), items);
  const at = items.indexOf(card);
  const answerAt = items[at - 1]?.at;
  check('1: the stored reply has the time it was written', typeof answerAt === 'number' && Math.abs(Date.now() - answerAt) < 60_000 && items.filter((i) => i.role === 'user').every((u) => typeof u.at !== 'number'), answerAt);
  check('1: the last card with no user message after it is stored open (it keeps its buttons)', card.open === true, card);
  check('1: the model never gets when a reply was written', state.requests.length > 1 && !state.requests.some((q) => JSON.stringify(q.payload?.messages ?? []).includes('written_at')));
  check('1: the card comes right after the reply it closes', items[at - 1]?.role === 'assistant' && items[at - 1].text === 'The importer now resumes.');

  // 2. The user's next message is a reply's label: the stored card marks it
  state.replies.push({ content: 'Pushed to a new branch.' });
  rt.send(A, 'Yes, new branch');
  await idle();
  items = toTranscript(app.store.get(A));
  card = items.find((i) => i.role === 'next_step');
  check('2: the stored card marks the chosen reply, and is open no more', card?.chosen === 'Yes, new branch' && !card.open, card);

  // 1b. The call first, then the reply (as the tool asks): the card's turn has its reply after the card
  state.replies.push({ content: '', toolCalls: [{ id: 'n1b', name: 'next_step', args: { recap: 'Lint is not set up yet.', question: 'Which checks should CI run?', replies: ['ESLint + tsc (Recommended)', 'Only tsc'] } }] });
  state.replies.push({ content: 'I looked at the CI config: nothing lints the code today. Adding ESLint and tsc would catch both style and type errors.' });
  rt.send(A, 'What should CI check?');
  await idle();
  items = toTranscript(app.store.get(A));
  const c1b = items.filter((i) => i.role === 'next_step').pop();
  const after1b = items[items.indexOf(c1b) + 1];
  check('1b: the call first, then the reply: no nudge, the reply after the card, the "(Recommended)" mark dropped', !JSON.stringify(app.store.get(A).messages).includes('empty response') && !JSON.stringify(app.store.get(A).messages).includes(NEXT_STEP_NUDGE) && after1b?.role === 'assistant' && /nothing lints/.test(after1b.text) && c1b.step.replies.join('|') === 'ESLint + tsc|Only tsc', { c1b, after1b });
  check('1b: the model read that the card is ready and the reply is owed', state.requests.some((q) => JSON.stringify(q.payload.messages ?? []).includes('Now write your reply to the user in full')));

  // 1c. The call first, then nothing: asked once for the reply; still nothing, the recap is the reply (and counted)
  events = [];
  state.requests.length = 0;
  state.replies.push({ content: '', toolCalls: [{ id: 'n1c', name: 'next_step', args: { recap: 'The build passes; nothing is deployed.', question: 'Deploy now?', replies: ['Deploy', 'Wait'] } }] });
  state.replies.push({ content: '' });
  state.replies.push({ content: '' });
  rt.send(A, 'Build it.');
  await idle();
  const msgs1c = app.store.get(A).messages;
  const nudges = msgs1c.filter((m) => m.role === 'user' && m.content === NEXT_STEP_NUDGE).length;
  check('1c: the empty message after the card is nudged once, for the reply', nudges === 1 && streamed().length === 3, { nudges, n: streamed().length });
  const last1c = msgs1c[msgs1c.length - 1];
  check('1c: still empty, the recap is the reply (stored, and shown as text)', last1c.role === 'assistant' && last1c.content === 'The build passes; nothing is deployed.' && of('text_delta').some((e) => e.text === 'The build passes; nothing is deployed.'), last1c);
  const fallbacks = (rt.agentFor(A).lastTiming()?.turns ?? []).flatMap((t) => t.fallbacks);
  check('1c: the timing record counts it as a recap_reply fallback', fallbacks.includes('recap_reply'), fallbacks);
  items = toTranscript(app.store.get(A));
  const c1c = items.filter((i) => i.role === 'next_step').pop();
  check('1c: in the transcript the recap reply follows the card', items[items.indexOf(c1c) + 1]?.role === 'assistant' && items[items.indexOf(c1c) + 1].text === 'The build passes; nothing is deployed.');

  // 3. A refused card stays a tool row with the reason the model read
  events = [];
  state.replies.push({ content: 'Done.', toolCalls: [{ id: 'n2', name: 'next_step', args: { recap: 'r', replies: ['Yes'] } }] });
  state.replies.push({ content: '' });
  rt.send(A, 'Again.');
  await idle();
  const bad = of('tool_end').find((e) => e.name === 'next_step');
  check('3: a refused card ends the call failed, saying why', bad && !bad.ok && /add the question/.test(bad.result), bad);
  items = toTranscript(app.store.get(A));
  check('3: and stays a tool row in the stored transcript', items.some((i) => i.role === 'tool' && i.name === 'next_step' && !i.ok));

  // 4. A sub-session is not offered the tool
  const child = app.store.create({ cwd: tmp, parentId: A, origin: 'spawn', title: 'Child' });
  app.store.save(child);
  state.requests.length = 0;
  state.replies.push({ content: 'child done' });
  rt.send(child.id, 'Count the things.');
  await idle(child.id);
  const childReq = streamed()[0];
  check('4: a sub-session is not offered next_step', childReq && !offered(childReq).includes('next_step') && offered(childReq).includes('read_file'), offered(childReq));
  check('4: its prompt still has the sentence (it only applies "when you have" the tool)', JSON.stringify(childReq.payload.messages[0]).includes('When you have next_step'));

  await mock.close?.();
  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
