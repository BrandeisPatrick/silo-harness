// Messages that were not typed in the window carry a frame written for the model (who sent it, its id, what to do
// next). The transcript shows them without it (src/renderer/origin.ts). This runs the real frames, as the main
// process writes them, through the window's side, so a change of wording in one shows up here.
// Run: node test/origin.js
const path = require('node:path');
const fs = require('node:fs');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { Subagents, messageHead, mergedText, NOTE_REPLY_CHARS } = require(path.join(projectDir, 'dist/main/subagents/service.js'));
const { frameMessage } = require(path.join(projectDir, 'dist/main/schedules/service.js'));
const { check, done } = require('./support/check.js');

(async () => {
  // The renderer compiles to ES modules; origin.js imports types only, so its source loads as a data: module.
  const src = fs.readFileSync(path.join(projectDir, 'dist/renderer/origin.js'), 'utf8');
  const { unframe } = await import('data:text/javascript,' + encodeURIComponent(src));

  const child = { id: '4cd9a99f-6f07-44cc-8f0a-89064bb48750', title: 'Load-test the limiter' };
  const note = (reason, text, c = child) => Subagents.prototype.noteText.call(null, c, { type: 'run_end', reason, text });

  // ---------- a sub-session's report ----------
  let u = unframe('session', note('done', 'Held at 100 a minute.\n\nNo client was blocked by mistake.'));
  check('a report shows what the sub-session said', u.text === 'Held at 100 a minute.\n\nNo client was blocked by mistake.', u);
  check('… and says it finished a turn in the label', u.note === 'finished a turn', u.note);
  check('no id or tool name is left in it', !/4cd9a99f|session_read|session_merge|\[Sub-session/.test(u.text));
  for (const [reason, words] of [['error', 'it ended with an error'], ['max_turns', 'it reached the turn limit'], ['plan', 'a plan waits for approval'], ['aborted', 'it was stopped']]) {
    u = unframe('session', note(reason, 'Partial.'));
    check(`a report that ended otherwise says so: ${words}`, u.text === 'Partial.' && u.note === words, u);
  }
  u = unframe('session', note('done', ''));
  check('a report without a reply keeps the placeholder', u.text === '(no reply text)', u);
  u = unframe('session', note('done', 'First line.\n\nNext: read more with care.\n\nLast line.'));
  check('a reply that itself has blank lines and a "Next:" line is kept whole', u.text === 'First line.\n\nNext: read more with care.\n\nLast line.', u);
  u = unframe('session', note('done', 'x'.repeat(NOTE_REPLY_CHARS + 50)));
  check('a clipped reply keeps its ellipsis', u.text.endsWith(' …') && u.text.length <= NOTE_REPLY_CHARS + 2, u.text.length);
  const odd = { id: 'abc-123', title: 'Fix "the" (odd) [title]' };
  u = unframe('session', note('done', 'Fine.', odd));
  check('a title with quotes, brackets and parentheses does not confuse it', u.text === 'Fine.' && u.note === 'finished a turn', u);

  // ---------- a message from another session ----------
  u = unframe('session', `${messageHead(child, 'sub-session')}\nThe replay is done: 429s only for one client.`);
  check('a message shows its text only', u.text === 'The replay is done: 429s only for one client.' && u.note === undefined, u);
  check('… and names its sender for the row ("Received message from …")', u.sender === child.title, u.sender);
  check('the head line says it is not from the user, in one line, and none of that reaches the row', /^\[[^\n]*Not from the user: [^\]\n]*\]$/.test(messageHead(child, 'peer session')) && !/Not from the user|session_send|no user authority/.test(u.text), messageHead(child, 'peer session'));
  u = unframe('session', `${messageHead(odd, 'peer session')}\nTwo\nlines.`);
  check('… with an odd title and a body of several lines', u.text === 'Two\nlines.', u);
  u = unframe('session', `${messageHead(undefined, '')}\nHello.`);
  check('… and from a session that is gone', u.text === 'Hello.' && u.sender === undefined, u);
  check('a report names its sub-session for the row too', unframe('session', note('aborted', 'Stopped early.')).sender === child.title);

  // ---------- a merged summary ----------
  u = unframe('command', mergedText(child.title, '## What it did\n\n- Replayed an hour of traffic.'));
  check('a merge shows the summary only', u.text === '## What it did\n\n- Replayed an hour of traffic.', u);

  // ---------- a scheduled task ----------
  const prompt = 'Run npm audit and summarise anything high or critical.\n\nKeep it short.';
  u = unframe('schedule', frameMessage({ name: 'Nightly dependency audit', describe: 'every day at 03:00', prompt }));
  check('a scheduled run shows the prompt the schedule holds', u.text === prompt, u);
  u = unframe('schedule', frameMessage({ name: 'Odd "name" (x)', describe: 'once on Nov 6 at 09:00 (in 2 hours)', prompt: 'One line.' }));
  check('… with an odd name and a description in parentheses', u.text === 'One line.', u);

  // ---------- anything else stays as it is ----------
  const plain = '[Sub-session "x" (y) finished a turn: done]\nnot quite the frame';
  check('a text that only looks like a frame is left alone', unframe('session', plain).text === plain);
  check('a typed message is never touched', unframe('user', note('done', 'Hi.')).text === note('done', 'Hi.') && unframe(undefined, 'Hello').text === 'Hello');
  check('a frame under another origin is left alone', unframe('remote', mergedText('T', 'r')).text === mergedText('T', 'r') && unframe('mod', 'x').text === 'x');
  check('nothing at all gives an empty text', unframe('session', undefined).text === '' && unframe('schedule', null).text === '');

  done();
})().catch((e) => {
  console.error('TEST CRASHED', e);
  process.exit(1);
});
