// The time under a reply (src/renderer/reply-time.ts replyTimeText): "Just now", "N min ago", the clock earlier
// today, "Yesterday HH:MM", then the date (with the year when it is not this one).
const path = require('node:path');
const fs = require('node:fs');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { check, done } = require('./support/check.js');

(async () => {
  const src = fs.readFileSync(path.join(projectDir, 'dist/renderer/reply-time.js'), 'utf8');
  const { replyTimeText: t } = await import('data:text/javascript,' + encodeURIComponent(src));
  const now = new Date(2026, 10, 20, 15, 30).getTime();
  const at = (y, mo, d, h, mi) => new Date(y, mo, d, h, mi).getTime();
  check('under a minute: "Just now"', t(now - 59_000, now) === 'Just now' && t(now, now) === 'Just now');
  check('a minute to an hour: "N min ago"', t(now - 60_000, now) === '1 min ago' && t(now - 5 * 60_000 - 10_000, now) === '5 min ago' && t(now - 59 * 60_000, now) === '59 min ago');
  check('earlier today: the clock', t(at(2026, 10, 20, 9, 5), now) === '09:05' && t(at(2026, 10, 20, 0, 0), now) === '00:00');
  check('yesterday: "Yesterday HH:MM"', t(at(2026, 10, 19, 14, 2), now) === 'Yesterday 14:02' && t(at(2026, 10, 19, 0, 1), now) === 'Yesterday 00:01');
  check('older this year: the date', t(at(2026, 10, 18, 23, 59), now) === '18 Nov' && t(at(2026, 0, 3, 8, 0), now) === '3 Jan');
  check('another year: the date with the year', t(at(2025, 11, 31, 12, 0), now) === '31 Dec 2025');
  // The stored time of a reply (src/main/sessions.ts toTranscript): its own, written when it was; none when unknown
  const { toTranscript } = require(path.join(projectDir, 'dist/main/sessions.js'));
  const T0 = at(2026, 10, 20, 9, 0);
  const call = { id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } };
  const stored = toTranscript({ id: 's', title: '', createdAt: T0, updatedAt: T0, turns: [{ at: 0, createdAt: T0 }], messages: [
    { role: 'user', content: 'Go' },
    { role: 'assistant', content: 'Looking first.', tool_calls: [call], written_at: T0 + 5_000 },
    { role: 'tool', tool_call_id: 'c1', content: 'a b' },
    { role: 'assistant', content: 'Done.', written_at: T0 + 90_000 },
  ] });
  const replyTimes = stored.filter((i) => i.role === 'assistant').map((i) => i.at);
  check('stored: each reply has its own time, an interim one too, also when the turn\'s worked time was never recorded', JSON.stringify(replyTimes) === JSON.stringify([T0 + 5_000, T0 + 90_000]), replyTimes);
  const old = toTranscript({ id: 's', title: '', createdAt: T0, updatedAt: T0, turns: [{ at: 0, createdAt: T0 }], turnTimes: { 0: 60_000 }, messages: [{ role: 'user', content: 'Go' }, { role: 'assistant', content: 'Interim.' }, { role: 'assistant', content: 'Done.' }] });
  check('an old session without them shows no time rather than one made up from the turn', old.filter((i) => i.role === 'assistant').every((i) => i.at === undefined), old);
  check('just after midnight, an hour-old reply from yesterday reads "Yesterday"', t(at(2026, 10, 19, 23, 10), at(2026, 10, 20, 0, 20)) === 'Yesterday 23:10');
  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
