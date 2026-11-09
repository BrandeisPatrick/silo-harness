// What the model is sent of the stored conversation (agent/context-view.ts): long tool output keeps its start and
// end (read_file is cut after a whole line, with the offset to go on from), old screenshots are left out, and the
// stored messages are never changed. Run: node test/context-view.js
const path = require('node:path');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const view = require(path.join(projectDir, 'dist/main/agent/context-view.js'));
const { check, done } = require('./support/check.js');

const { modelMessages, MODEL_RESULT_CHARS, KEEP_SCREENSHOTS } = view;
const call = (id, name, args = {}) => ({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const result = (id, content) => ({ role: 'tool', tool_call_id: id, content });
const shot = (n) => ({ role: 'user', content: [{ type: 'text', text: `[Screenshot returned by browser_screenshot]` }, { type: 'image_url', image_url: { url: `data:image/png;base64,SHOT${n}` } }] });

// ---- 1: short output and other messages pass through unchanged, as the same objects ----
const small = [{ role: 'user', content: 'hi' }, call('a', 'bash', { command: 'ls' }), result('a', 'one\ntwo'), { role: 'assistant', content: 'done' }];
const same = modelMessages(small);
check('1: nothing to cut: the same messages, the same objects', same.length === small.length && same.every((m, i) => m === small[i]));

// ---- 2: a long read_file result is cut after a whole line, with the offset to continue ----
const lines = Array.from({ length: 3000 }, (_, i) => `${String(i + 1).padStart(4)}| ${'x'.repeat(40)} line ${i + 1}`);
const readText = `${lines.slice(0, 2000).join('\n')}\n…(3000 lines total; continue with offset=2001)`;
const reading = [{ role: 'user', content: 'read it' }, call('r', 'read_file', { path: 'big.ts' }), result('r', readText)];
const readOut = modelMessages(reading)[2].content;
const lastLine = /(\d+)\| [^\n]*\n…\(cut here/.exec(readOut);
check('2: read_file: under the cap, ends on a whole line', readOut.length <= MODEL_RESULT_CHARS + 200 && Boolean(lastLine), readOut.slice(-160));
check('2: …and says where to go on reading, and how long the file is', lastLine && readOut.includes(`continue with offset=${Number(lastLine[1]) + 1}`) && readOut.includes('the file has 3000 lines'), readOut.slice(-120));
check('2: the stored result is untouched', reading[2].content === readText);

// ---- 3: other long output keeps its start and its end (the exit code) ----
const out = `${'start '.repeat(4000)}${'middle '.repeat(6000)}${'end '.repeat(2000)}[exit code: 1]`;
const cmd = modelMessages([call('c', 'bash', { command: 'npm test' }), result('c', out)])[1].content;
check('3: a command: start and end kept, the middle left out with a note', cmd.length < MODEL_RESULT_CHARS + 300 && cmd.startsWith('start start') && cmd.endsWith('[exit code: 1]') && /characters of the middle left out to save context/.test(cmd), cmd.length);
check('3: output at the cap is not cut', modelMessages([call('d', 'grep'), result('d', 'y'.repeat(MODEL_RESULT_CHARS))])[1].content.length === MODEL_RESULT_CHARS);

// ---- 4: screenshots: the most recent ones keep their image, older ones are left out; the user's own images stay ----
const userImage = { role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,MINE' } }] };
const shots = [userImage, call('s1', 'browser_screenshot'), result('s1', 'Screenshot saved'), shot(1), call('s2', 'browser_screenshot'), result('s2', 'Screenshot saved'), shot(2), call('s3', 'browser_screenshot'), result('s3', 'Screenshot saved'), shot(3)];
const v = modelMessages(shots);
const images = (m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === 'image_url').map((p) => p.image_url.url) : []);
check(`4: the ${KEEP_SCREENSHOTS} newest screenshots keep their image`, images(v[9])[0]?.endsWith('SHOT3') && images(v[6])[0]?.endsWith('SHOT2'));
check('4: an older one is a line saying it was left out', images(v[3]).length === 0 && /earlier screenshot was left out/.test(JSON.stringify(v[3].content)));
check("4: the user's own image is always sent", images(v[0])[0]?.endsWith('MINE') && v[0] === userImage);
check('4: the stored screenshot keeps its image', images(shots[3])[0]?.endsWith('SHOT1'));

done();
