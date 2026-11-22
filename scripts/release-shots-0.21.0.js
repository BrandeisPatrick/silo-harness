// Makes the images for the 0.21.0 release notes, 1600 px wide, in the light theme:
//   settings-models.png  Settings → Models: the provider Ready, a model chosen, an API key saved here (dots and its
//                        last four characters, with Replace), Connection and Advanced closed, Add provider
//   session.png          one finished turn: the user's message, the line saying what happened opened to its card of
//                        steps (a read, an edit, a command, one action Auto mode blocked), a short reply, the
//                        next-step card with a question and two buttons, then Copy and the time
//
// The built app runs hidden on a throwaway profile in a made-up home (scripts/shots-kit.js) against scripted mock
// models; the tools really run on a small project. Nothing leaves the machine and nothing on the page is edited.
//
//   npm run build   (once; dist/ must be current)
//   node scripts/release-shots-0.21.0.js [out-dir]     default: docs/releases/0.21.0
const fs = require('node:fs');
const path = require('node:path');
const kit = require('./shots-kit.js');
const { startMock, classifierReply } = require('../test/support/mock-model.js');

const { F, sleep } = kit;
const OUT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'docs', 'releases', '0.21.0'));
const js = JSON.stringify;
const MARGIN = 24;

async function settingsModels() {
  const KEY = 'example-key-for-the-pictures-7f3a';
  const an = await startMock();
  an.state.anthropicModels = true;
  an.state.apiKey = KEY;
  an.state.models = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
  let s;
  try {
    s = await kit.start({
      size: { width: 1280, height: 900 },
      config: {
        theme: 'light',
        remote: { enabled: false, bind: 'localhost', port: 0 },
        provider: 'anthropic',
        ollama: { baseURL: 'http://127.0.0.1:9/v1', model: '', numCtx: 16384, think: 'auto' },
        providers: { anthropic: { type: 'anthropic', baseURL: `http://127.0.0.1:${an.port}/v1`, model: an.state.models[0] } },
      },
    });
    const { app } = s;
    await app.evaluate(`document.querySelector('#settings-btn').click()`);
    await app.click('#sp-nav-model');
    // The key is saved here, as a user would: pasted in the open field, then Save
    await app.waitFor(`!document.querySelector('#provider-apiKey-input').hidden`, 10_000, 'the open key field');
    await app.fill('#provider-apiKey-input', KEY);
    await app.evaluate(`[...document.querySelectorAll('#sp-row-provider-apiKey button')].find((b) => b.innerText.trim() === 'Save').click()`);
    await app.waitFor(`/7f3a$/.test(document.querySelector('#sp-row-provider-apiKey .sp-key-text')?.textContent || '') && /Ready/.test(document.querySelector('#sp-row-provider')?.innerText || '')`, 15_000, 'the saved key and Ready');
    await sleep(2500); // the Saved tick fades
    const r = await app.evaluate(`(() => { const sec = document.querySelector('#sp-sec-model'); sec.closest('#settings-body').scrollTop = 0; const c = sec.getBoundingClientRect(); const last = [...sec.children].filter((e) => !e.hidden).pop().getBoundingClientRect(); return { x: c.x - ${MARGIN}, y: c.y - 8, width: c.width + 2 * ${MARGIN}, height: last.bottom - c.y + 8 + ${MARGIN} }; })()`);
    await kit.capture(s, r, path.join(OUT, 'settings-models.png'));
  } finally {
    await kit.stop(s);
    an.close();
  }
}

const IMPORTER = `const fs = require('node:fs');

/** Imports every item of the feed, in order. */
async function importFeed(items, save) {
  for (const item of items) await save(item);
}

module.exports = { importFeed };
`;
const IMPORTER_TEST = `const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { importFeed } = require('../src/feed/importer');

test('resumes after the last item saved', async () => {
  const checkpoint = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'feed-')), 'checkpoint');
  fs.writeFileSync(checkpoint, '2');
  const saved = [];
  await importFeed(['a', 'b', 'c', 'd'], async (x) => saved.push(x), checkpoint);
  assert.deepStrictEqual(saved, ['c', 'd']);
});
`;
const REPLY = `## The importer resumes

It writes a checkpoint after each item, so a restart picks up where the crash left off.

- \`importFeed\` skips the items already in \`.feed-checkpoint\`
- \`test/importer.test.js\` covers a restart halfway through`;
const CARD = { recap: 'The importer resumes after a crash and its test passes. Nothing is pushed: Auto mode blocked the force-push.', question: 'Push it on a new branch instead?', replies: ['Yes, new branch', 'Not yet'] };

async function session() {
  let s;
  try {
    s = await kit.start({ size: { width: 1440, height: 1500 }, mode: 'auto', config: { theme: 'light', remote: { enabled: false, bind: 'localhost', port: 0 } } });
    const { app } = s;
    fs.mkdirSync(path.join(F.PROJECT, 'src', 'feed'), { recursive: true });
    fs.writeFileSync(path.join(F.PROJECT, 'src', 'feed', 'importer.js'), IMPORTER);
    fs.writeFileSync(path.join(F.PROJECT, 'test', 'importer.test.js'), IMPORTER_TEST);
    const { state } = app.mock;
    state.classifierDefault = { decision: 'allow', reason: '[Local Work] part of the task' };
    state.replies.push(classifierReply('block', '[Shared Branch] force-pushes to main, which the user did not ask for', { when: (p) => JSON.stringify(p.messages[p.messages.length - 1]).includes('git push --force origin main') }));
    const step = (r) => state.replies.push({ delayMs: 2500, ...r });
    step({ toolCalls: [F.call('read_file', { path: 'src/feed/importer.js' })] });
    step({
      toolCalls: [
        F.call('edit_file', {
          path: 'src/feed/importer.js',
          old_string: '/** Imports every item of the feed, in order. */\nasync function importFeed(items, save) {\n  for (const item of items) await save(item);\n}',
          new_string:
            "/** Imports the feed in order, resuming after the last item saved in `checkpoint`. */\nasync function importFeed(items, save, checkpoint = '.feed-checkpoint') {\n  const done = fs.existsSync(checkpoint) ? Number(fs.readFileSync(checkpoint, 'utf8')) : 0;\n  for (let i = done; i < items.length; i++) {\n    await save(items[i]);\n    fs.writeFileSync(checkpoint, String(i + 1));\n  }\n}",
        }),
      ],
    });
    step({ toolCalls: [F.call('bash', { command: 'node --test test/importer.test.js' })] });
    step({ toolCalls: [F.call('bash', { command: 'git push --force origin main' })] });
    step({ content: REPLY, toolCalls: [F.call('next_step', CARD)] });
    state.replies.push({ content: '' });
    if (await app.evaluate(`!document.querySelector('.shell').classList.contains('pane-hidden')`)) await app.click('#pane-toggle');
    await app.send('Make the feed importer resumable after a crash.');
    await app.waitFor(`(async () => (await oc.sessions.list()).every((m) => !m.status?.running))()`, 60_000, 'the turn to end');
    await app.waitFor(`Boolean(document.querySelector('#messages .next-step .next-step-reply'))`, 10_000, 'the next-step card');
    await app.evaluate(`[...document.querySelectorAll('#messages > .turn-head .turn-head-btn[aria-expanded="false"]')].forEach((b) => b.click())`);
    await sleep(1500);
    const r = await app.evaluate(`(() => { const m = document.querySelector('#messages'); m.scrollTop = 0; const c = m.getBoundingClientRect(); const u = document.querySelector('#messages > .msg.user').getBoundingClientRect(); const end = [...document.querySelectorAll('#messages > .msg.assistant')].pop().getBoundingClientRect(); return { x: c.x, y: u.top - ${MARGIN}, width: c.width - 10, height: end.bottom - u.top + 2 * ${MARGIN} }; })()`);
    await kit.capture(s, r, path.join(OUT, 'session.png'));
  } finally {
    await kit.stop(s);
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await settingsModels();
  await session();
})().then(
  () => process.exit(0),
  (e) => {
    console.error(e && e.stack);
    process.exit(1);
  },
);
