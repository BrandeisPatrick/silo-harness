// Scheduled tasks and keep-awake, headless: cron parsing and next runs (daylight saving in America/New_York),
// describe, the store, firing against a fake App with an injected clock and manual ticks, missed runs at
// start-up, the model's tools and the power state machine. Run: node test/schedules.js [projectDir]
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const projectDir = process.argv[2] || path.join(__dirname, '..');

// Local-time assertions must not depend on the machine: rerun this file in a child pinned to New York
if (process.env.TZ !== 'America/New_York') {
  const r = spawnSync(process.execPath, [__filename, projectDir], { env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8', timeout: 120_000 });
  process.stdout.write(r.stdout || '');
  process.stderr.write(r.stderr || '');
  process.exit(r.status === null ? 1 : r.status);
}

const dist = (p) => require(path.join(projectDir, 'dist/main', p));
const { parseCron, nextCron } = dist('schedules/cron.js');
const { describeWhen, nextAfter, parseAt, formatLocal } = dist('schedules/when.js');
const { ScheduleStore } = dist('schedules/store.js');
const { frameMessage } = dist('schedules/service.js');
const { setupSchedules } = dist('schedules.js');
const { setupPower } = dist('power.js');
const { check, done } = require('./support/check.js');

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const L = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const iso = (t) => new Date(t).toISOString();
const errCode = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e.code || e.message;
  }
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'oa-sched-'));

check('child runs in America/New_York', new Date(2026, 0, 15).getTimezoneOffset() === 300 && new Date(2026, 6, 15).getTimezoneOffset() === 240);

// --- cron parsing matrix -----------------------------------------------------
{
  const ok = (expr, field, want) => {
    let s;
    try {
      s = parseCron(expr);
    } catch (e) {
      return check(`cron parses: ${expr}`, false, e.message);
    }
    if (field) check(`cron ${expr}: ${field} = ${want}`, s[field].join(',') === want, s[field].join(','));
    else check(`cron parses: ${expr}`, true);
  };
  ok('0 9 * * 1-5', 'weekdays', '1,2,3,4,5');
  ok('*/15 * * * *', 'minutes', '0,15,30,45');
  ok('*/5 * * * *', 'minutes', '0,5,10,15,20,25,30,35,40,45,50,55');
  ok('0,30 * * * *', 'minutes', '0,30');
  ok('10-50/20 * * * *', 'minutes', '10,30,50');
  ok('5/15 * * * *', 'minutes', '5,20,35,50');
  ok('0 9-17/2 * * *', 'hours', '9,11,13,15,17');
  ok('0 9 * * MON-FRI', 'weekdays', '1,2,3,4,5');
  ok('0 9 * * mon,Wed,FRI', 'weekdays', '1,3,5');
  ok('0 0 1 JAN,jul *', 'months', '1,7');
  ok('0 0 1 mar-may *', 'months', '3,4,5');
  ok('0 9 * * 0', 'weekdays', '0');
  ok('0 9 * * 7', 'weekdays', '0');
  ok('0 9 * * SUN', 'weekdays', '0');
  ok('0 9 * * 5-7', 'weekdays', '0,5,6');
  ok('0 9 * * 0,7', 'weekdays', '0');
  ok('58,2 9 * * *', 'minutes', '2,58');
  ok('0 0 29 2 *', 'days', '29');
  ok('0 0 31 2 1', 'days', '31');
  ok('  0   9  *  *  1  ', null);
  const s1 = parseCron('0 9 13 * 5');
  check('both day fields restricted: neither is a star', !s1.domStar && !s1.dowStar);
  const s2 = parseCron('0 9 */2 * 5');
  check('a day field starting with * counts as unrestricted', s2.domStar && !s2.dowStar);

  const bad = (expr, code) => check(`cron rejects "${expr}" with ${code}`, errCode(() => parseCron(expr)) === code, errCode(() => parseCron(expr)));
  bad('0 0 * *', 'bad_cron');
  bad('0 0 * * * *', 'bad_cron');
  bad('', 'bad_cron');
  bad('60 * * * *', 'bad_cron');
  bad('0 24 * * *', 'bad_cron');
  bad('0 0 0 * *', 'bad_cron');
  bad('0 0 32 * *', 'bad_cron');
  bad('0 0 * 13 *', 'bad_cron');
  bad('0 0 * * 8', 'bad_cron');
  bad('5-1 * * * *', 'bad_cron');
  bad('*/0 * * * *', 'bad_cron');
  bad('0 0 * FOO *', 'bad_cron');
  bad('0 0 * * FUNDAY', 'bad_cron');
  bad('a b c d e', 'bad_cron');
  bad('1,,2 * * * *', 'bad_cron');
  bad('1-2-3 * * * *', 'bad_cron');
  bad('@daily', 'bad_cron');
  // The 5-minute floor
  bad('* * * * *', 'frequency_too_high');
  bad('*/4 * * * *', 'frequency_too_high');
  bad('0,3 * * * *', 'frequency_too_high');
  bad('58,2 * * * *', 'frequency_too_high'); // 23:58 then 00:02 across the hour
  bad('0-10 9 * * *', 'frequency_too_high');
  check('58 9,10 * * * is an hour apart: allowed', errCode(() => parseCron('58 9,10 * * *')) === null);
  // Never fires
  bad('0 0 31 2 *', 'bad_cron');
  bad('0 0 30 2 *', 'bad_cron');
  bad('0 0 31 4,6,9,11 *', 'bad_cron');
  check('never-firing message says so', /never fire/.test((() => { try { parseCron('0 0 30 2 *'); } catch (e) { return e.message; } })()));
  check('errors start with their code', /^frequency_too_high: /.test((() => { try { parseCron('* * * * *'); } catch (e) { return e.message; } })()));
}

// --- next runs from fixed start times ----------------------------------------
{
  const from = L(2026, 1, 15, 10, 7); // Thursday 15 Jan 2026, 10:07
  const cases = [
    ['0 9 * * 1-5', from, L(2026, 1, 16, 9, 0)],
    ['*/15 * * * *', from, L(2026, 1, 15, 10, 15)],
    ['30 14 * * MON', from, L(2026, 1, 19, 14, 30)],
    ['0 0 1 * *', from, L(2026, 2, 1, 0, 0)],
    ['0 0 29 2 *', from, L(2028, 2, 29, 0, 0)],
    ['0 12 13 * 5', from, L(2026, 1, 16, 12, 0)], // either day field: Friday comes before the 13th
    ['0 12 13 * *', from, L(2026, 2, 13, 12, 0)],
    ['0 9 * * 0', from, L(2026, 1, 18, 9, 0)],
    ['0 9 * * 7', from, L(2026, 1, 18, 9, 0)],
    ['0 0 * JUL *', from, L(2026, 7, 1, 0, 0)],
    ['45 23 31 12 *', from, L(2026, 12, 31, 23, 45)],
    ['0,30 9-10 * * *', from, L(2026, 1, 15, 10, 30)],
    ['0 10 * * *', from, L(2026, 1, 16, 10, 0)],
    ['7 10 * * *', from, L(2026, 1, 16, 10, 7)], // strictly after
    ['0 9 1-7 * 1', from, L(2026, 1, 19, 9, 0)],
    ['0 0 31 2 1', from, L(2026, 2, 2, 0, 0)],
    ['*/15 * * * *', L(2026, 12, 31, 23, 50), L(2027, 1, 1, 0, 0)],
    ['0 9 */2 * 5', from, L(2026, 1, 23, 9, 0)], // dom starts with *, so both must match: odd day and Friday
  ];
  for (const [expr, start, want] of cases) {
    const got = nextCron(parseCron(expr), start);
    check(`next ${expr} from ${formatLocal(start)} = ${formatLocal(want)}`, got === want, got && formatLocal(got));
  }
}

// --- daylight saving (America/New_York: 8 Mar 2026 02:00 -> 03:00; 1 Nov 2026 02:00 -> 01:00) ------------------
{
  const Z = (s) => Date.parse(s);
  const seq = (expr, start, n) => {
    const sp = parseCron(expr);
    const out = [];
    let t = start;
    for (let i = 0; i < n; i++) out.push(iso((t = nextCron(sp, t))));
    return out;
  };
  // Spring forward: 02:30 does not exist on 8 March, so that day is skipped
  check('spring: 30 2 * * * skips the missing 02:30', seq('30 2 * * *', L(2026, 3, 7, 12), 2).join() === ['2026-03-09T06:30:00.000Z', '2026-03-10T06:30:00.000Z'].join(), seq('30 2 * * *', L(2026, 3, 7, 12), 2));
  check('spring: hourly goes 01:00 EST -> 03:00 EDT', seq('0 * * * *', Z('2026-03-08T06:00:00Z'), 2).join() === ['2026-03-08T07:00:00.000Z', '2026-03-08T08:00:00.000Z'].join(), seq('0 * * * *', Z('2026-03-08T06:00:00Z'), 2));
  check('spring: */30 runs 01:30 EST then 03:00 EDT', seq('*/30 * * * *', Z('2026-03-08T06:00:00Z'), 3).join() === ['2026-03-08T06:30:00.000Z', '2026-03-08T07:00:00.000Z', '2026-03-08T07:30:00.000Z'].join(), seq('*/30 * * * *', Z('2026-03-08T06:00:00Z'), 3));
  const d1 = nextCron(parseCron('0 9 * * *'), L(2026, 3, 7, 9));
  check('spring: daily 09:00 stays at 09:00 local (23 h later)', d1 === L(2026, 3, 8, 9) && d1 - L(2026, 3, 7, 9) === 23 * HOUR);
  // Fall back: 01:00-01:59 happens twice; each wall-clock time fires once
  check('fall: 30 1 * * * fires once on 1 Nov', seq('30 1 * * *', L(2026, 10, 31, 12), 2).join() === ['2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z'].join(), seq('30 1 * * *', L(2026, 10, 31, 12), 2));
  const fall = seq('*/30 * * * *', Z('2026-11-01T04:45:00Z'), 4);
  check('fall: */30 runs 01:00, 01:30 EDT then 02:00 EST', fall.join() === ['2026-11-01T05:00:00.000Z', '2026-11-01T05:30:00.000Z', '2026-11-01T07:00:00.000Z', '2026-11-01T07:30:00.000Z'].join(), fall);
  check('fall: the repeated 01:00 and 01:30 are not run again', !fall.includes('2026-11-01T06:00:00.000Z') && !fall.includes('2026-11-01T06:30:00.000Z'));
  check('fall: from inside the repeated hour, next is 02:00 EST', iso(nextCron(parseCron('*/30 * * * *'), Z('2026-11-01T06:10:00Z'))) === '2026-11-01T07:00:00.000Z');
  const d2 = nextCron(parseCron('0 9 * * *'), L(2026, 10, 31, 9));
  check('fall: daily 09:00 stays at 09:00 local (25 h later)', d2 === L(2026, 11, 1, 9) && d2 - L(2026, 10, 31, 9) === 25 * HOUR);
  // every: plain elapsed minutes, unaffected by the wall clock
  const every = { kind: 'every', minutes: 30 };
  check('every 30 across spring forward is 30 real minutes', nextAfter(every, Z('2026-03-08T06:30:00Z'), Z('2026-03-08T06:30:00Z')) === Z('2026-03-08T07:00:00Z'));
  check('every 30 across fall back is 30 real minutes', nextAfter(every, Z('2026-11-01T05:30:00Z'), Z('2026-11-01T05:30:00Z')) === Z('2026-11-01T06:00:00Z'));
  check('every keeps its phase after a late tick', nextAfter(every, Z('2026-11-01T05:30:00Z'), Z('2026-11-01T05:41:00Z')) === Z('2026-11-01T06:00:00Z'));
}

// --- describe -----------------------------------------------------------------
{
  const now = L(2026, 11, 5, 12);
  const d = (when, want) => check(`describe ${JSON.stringify(when)} = "${want}"`, describeWhen(when, now) === want, describeWhen(when, now));
  d({ kind: 'every', minutes: 30 }, 'every 30 minutes');
  d({ kind: 'every', minutes: 5 }, 'every 5 minutes');
  d({ kind: 'every', minutes: 60 }, 'every hour');
  d({ kind: 'every', minutes: 120 }, 'every 2 hours');
  d({ kind: 'every', minutes: 90 }, 'every 90 minutes');
  d({ kind: 'every', minutes: 1440 }, 'every day');
  d({ kind: 'every', minutes: 2880 }, 'every 2 days');
  d({ kind: 'cron', expr: '0 9 * * *' }, 'every day at 09:00');
  d({ kind: 'cron', expr: '0 9 * * 1-5' }, 'weekdays at 09:00');
  d({ kind: 'cron', expr: '0 9 * * MON-FRI' }, 'weekdays at 09:00');
  d({ kind: 'cron', expr: '0 10 * * 0,6' }, 'weekends at 10:00');
  d({ kind: 'cron', expr: '30 14 * * 1' }, 'Mondays at 14:30');
  d({ kind: 'cron', expr: '0 9 * * 1,4' }, 'Mondays and Thursdays at 09:00');
  d({ kind: 'cron', expr: '0 9 * * 7' }, 'Sundays at 09:00');
  d({ kind: 'cron', expr: '0 9,17 * * *' }, 'every day at 09:00 and 17:00');
  d({ kind: 'cron', expr: '*/15 * * * *' }, 'every 15 minutes');
  d({ kind: 'cron', expr: '5 * * * *' }, 'every hour at :05');
  d({ kind: 'cron', expr: '0 */2 * * *' }, 'every 2 hours at :00');
  d({ kind: 'cron', expr: '0 9 1 * *' }, 'monthly on the 1st at 09:00');
  d({ kind: 'cron', expr: '0 9 22 * *' }, 'monthly on the 22nd at 09:00');
  d({ kind: 'cron', expr: '0 9 1-7 * 1' }, '0 9 1-7 * 1');
  d({ kind: 'at', at: '2026-11-06T09:00:00-05:00' }, 'once on Nov 6 at 09:00');
  d({ kind: 'at', at: '2026-11-06T14:00:00Z' }, 'once on Nov 6 at 09:00');
  d({ kind: 'at', at: '2027-01-02T09:00:00-05:00' }, 'once on Jan 2, 2027 at 09:00');
  check('at accepts +hhmm offsets', parseAt('2026-11-06T09:00:00+0100') === Date.parse('2026-11-06T08:00:00Z'));
  for (const bad of ['2026-11-06 09:00', '2026-11-06T09:00:00', '2026-02-30T09:00:00Z', '2026-13-01T09:00:00Z', 'tomorrow', ''])
    check(`at rejects "${bad}" with bad_time`, errCode(() => parseAt(bad)) === 'bad_time');
}

// --- the fake App -------------------------------------------------------------
function fakeApp(userData, cfg = {}) {
  const listeners = [];
  const configCbs = [];
  const sessions = new Map();
  const running = new Set();
  const h = {
    pushes: [],
    tools: {},
    prompts: {},
    commands: {},
    rpc: {},
    services: {},
    quit: [],
    created: [],
    sent: [],
    sendFails: false,
    sessions,
    running,
    config: { workingDirectory: '/work', keepAwake: 'running', ...cfg },
    emit: (id, ev) => listeners.slice().forEach((l) => l(id, ev)),
    start(id) {
      running.add(id);
      h.emit(id, { type: 'run_start' });
    },
    end(id, reason = 'done') {
      running.delete(id);
      h.emit(id, { type: 'run_end', reason, text: 'report' });
    },
    pushed: (ch) => h.pushes.filter((p) => p.ch === ch),
    async runQuit() {
      for (const fn of h.quit.slice().reverse()) await fn();
    },
  };
  h.app = {
    userData,
    appRoot: '/',
    config: () => h.config,
    updateConfig(change) {
      const prev = h.config;
      h.config = { ...prev, ...(typeof change === 'function' ? change(prev) : change) };
      configCbs.forEach((cb) => cb(h.config, prev));
      return h.config;
    },
    onConfig(cb) {
      configCbs.push(cb);
      return () => configCbs.splice(configCbs.indexOf(cb), 1);
    },
    window: () => null,
    push: (ch, p) => h.pushes.push({ ch, p }),
    rpc: { handle: (m, fn) => ((h.rpc[m] = fn), () => delete h.rpc[m]) },
    store: { get: (id) => sessions.get(id) },
    runtime: {
      create(o) {
        const s = { id: `s${sessions.size + 1}`, messages: [], ...o };
        sessions.set(s.id, s);
        h.created.push(o);
        return s;
      },
      send(id, text, attachments, opts) {
        h.sent.push({ id, text, attachments, opts });
        if (h.sendFails) return { ok: false, error: 'no model' };
        if (running.has(id)) return { ok: true, queued: true, id: 'q1' };
        h.start(id);
        return { ok: true };
      },
      isRunning: (id) => running.has(id),
      running: () => [...running],
      list: () => [...sessions.values()],
    },
    events: {
      on(cb) {
        listeners.push(cb);
        return () => listeners.splice(listeners.indexOf(cb), 1);
      },
    },
    tools: { register: (t) => ((h.tools[t.name] = t), () => delete h.tools[t.name]), list: () => Object.values(h.tools) },
    prompt: { add: (id, fn) => ((h.prompts[id] = fn), () => delete h.prompts[id]) },
    commands: { register: (c) => ((h.commands[c.name] = c), () => delete h.commands[c.name]), list: () => Object.values(h.commands) },
    provide: (name, s) => ((h.services[name] = s), () => delete h.services[name]),
    service: (name) => h.services[name],
    onQuit: (fn) => h.quit.push(fn),
  };
  return h;
}

/** A scheduler on a fake App with a manual clock; `advance` moves time and ticks */
function rig(opts = {}) {
  const dir = opts.dir || tmp();
  const h = fakeApp(dir);
  const clock = { t: opts.t ?? L(2026, 11, 5, 10, 0) };
  let tickFn = null;
  let tickMs = null;
  const svc = setupSchedules(h.app, {
    now: () => clock.t,
    setInterval: (fn, ms) => ((tickFn = fn), (tickMs = ms), 'timer'),
    clearInterval: () => (tickFn = null),
  });
  return {
    h,
    svc,
    clock,
    dir,
    tickMs: () => tickMs,
    tick: () => tickFn && tickFn(),
    advance(ms) {
      clock.t += ms;
      tickFn && tickFn();
    },
  };
}

// --- store --------------------------------------------------------------------
{
  const dir = tmp();
  const file = path.join(dir, 'schedules.json');
  const store = new ScheduleStore(file);
  check('missing file loads empty', store.load().length === 0);
  const list = [{ id: 'sch_1', name: 'a', prompt: 'p', when: { kind: 'every', minutes: 30 }, target: 'new', cwd: '/w', enabled: true, createdAt: 1, createdBy: 'user', nextRunAt: 5, runs: 0, describe: 'every 30 minutes' }];
  store.save(list);
  check('round trip', JSON.stringify(new ScheduleStore(file).load()) === JSON.stringify(list));
  check('no temp file left after a save', fs.readdirSync(dir).join() === 'schedules.json', fs.readdirSync(dir));

  // A crash between writing the temp file and the rename: the old list is intact
  const crashing = new ScheduleStore(file, { rename: () => { throw new Error('simulated crash'); } });
  let threw = false;
  try {
    crashing.save([...list, { ...list[0], id: 'sch_2' }]);
  } catch {
    threw = true;
  }
  check('failed rename surfaces as an error', threw);
  check('old file survives the failed rename', new ScheduleStore(file).load().map((s) => s.id).join() === 'sch_1');
  // A hard crash leaves the temp file behind: it is ignored and swept
  fs.writeFileSync(`${file}.tmp-999-abc`, '{"version":1,"schedules":[{"id":"half');
  check('a leftover temp file is ignored', new ScheduleStore(file).load().map((s) => s.id).join() === 'sch_1');
  check('and swept', !fs.readdirSync(dir).some((n) => n.includes('.tmp-')));

  // Corrupt file: empty list, no throw, file kept aside
  fs.writeFileSync(file, '{ not json');
  let loaded;
  let ok = true;
  const warn = console.warn;
  console.warn = () => {};
  try {
    loaded = new ScheduleStore(file).load();
  } catch {
    ok = false;
  }
  console.warn = warn;
  check('corrupt file loads empty without throwing', ok && loaded.length === 0);
  const aside = fs.readdirSync(dir).filter((n) => n.startsWith('schedules.json.corrupt-'));
  check('corrupt file is kept aside', aside.length === 1 && fs.readFileSync(path.join(dir, aside[0]), 'utf8') === '{ not json', aside);
  check('corrupt file moved out of the way', !fs.existsSync(file));

  // The scheduler on a corrupt file starts empty and can save again
  fs.writeFileSync(file, '[]');
  console.warn = () => {};
  const r = rig({ dir });
  console.warn = warn;
  check('scheduler on a corrupt file starts empty', r.svc.list().length === 0);
  r.svc.create({ name: 'x', prompt: 'y', when: { kind: 'every', minutes: 10 } }, 'user');
  check('and saves to schedules.json in userData', JSON.parse(fs.readFileSync(file, 'utf8')).schedules.length === 1);
}

// --- limits -------------------------------------------------------------------
{
  const { svc } = rig();
  const base = { prompt: 'p', when: { kind: 'every', minutes: 60 } };
  check('name of 80 chars ok', errCode(() => svc.create({ ...base, name: 'n'.repeat(80) }, 'user')) === null);
  check('name of 81 chars: too_long', errCode(() => svc.create({ ...base, name: 'n'.repeat(81) }, 'user')) === 'too_long');
  check('prompt of 8000 chars ok', errCode(() => svc.create({ ...base, name: 'p8000', prompt: 'x'.repeat(8000) }, 'user')) === null);
  check('prompt of 8001 chars: too_long', errCode(() => svc.create({ ...base, name: 'p', prompt: 'x'.repeat(8001) }, 'user')) === 'too_long');
  for (let i = svc.list().length; i < 50; i++) svc.create({ ...base, name: `s${i}` }, 'user');
  check('50 schedules stored', svc.list().length === 50);
  check('the 51st: too_many', errCode(() => svc.create({ ...base, name: 'one more' }, 'user')) === 'too_many');
  check('every below 5 minutes: frequency_too_high', errCode(() => rig().svc.create({ name: 'x', prompt: 'p', when: { kind: 'every', minutes: 4 } }, 'user')) === 'frequency_too_high');
}

// --- firing -------------------------------------------------------------------
{
  const r = rig();
  const { h, svc } = r;
  check('timer checks about every 15 s', r.tickMs() === 15_000, r.tickMs());
  check('service provided as schedules', h.services.schedules === svc);
  for (const m of ['schedules.list', 'schedules.create', 'schedules.update', 'schedules.remove', 'schedules.runNow', 'schedules.preview', 'schedules.chooseFolder']) check(`rpc ${m} registered`, typeof h.rpc[m] === 'function');

  const pushesBefore = h.pushed('schedules:changed').length;
  const s = h.rpc['schedules.create']({ name: 'Triage', prompt: 'Summarise new issues.', when: { kind: 'every', minutes: 30 }, cwd: '/proj' });
  check('rpc create: by the user, no approval, enabled', s.createdBy === 'user' && s.enabled && s.runs === 0);
  check('recurring defaults to a new session', s.target === 'new' && s.sessionId === undefined);
  check('first run is 30 minutes out', s.nextRunAt === r.clock.t + 30 * MIN);
  check('describe stored', s.describe === 'every 30 minutes');
  check('create pushes the full list', h.pushed('schedules:changed').length === pushesBefore + 1 && h.pushed('schedules:changed').at(-1).p.length === 1);
  check('rpc create default cwd is the working directory', h.rpc['schedules.create']({ name: 'd', prompt: 'p', when: { kind: 'every', minutes: 60 } }).cwd === '/work');
  svc.remove(svc.list()[1].id);

  r.advance(29 * MIN);
  check('not due yet: nothing sent', h.sent.length === 0);
  r.advance(MIN);
  check('due: a new session is created', h.created.length === 1 && JSON.stringify(h.created[0]) === JSON.stringify({ cwd: '/proj', origin: 'schedule', title: 'Triage', foreground: false }), h.created);
  const msg = h.sent[0];
  check('sent with origin schedule and from = name', msg && msg.opts.origin === 'schedule' && msg.opts.from === 'Triage' && msg.id === 's1', msg && msg.opts);
  check('framing: says it was sent by an approved schedule', /sent automatically by a schedule the user approved/.test(msg.text) && /did not type it just now/.test(msg.text));
  check('framing: name and rhythm', msg.text.includes('"Triage"') && msg.text.includes('every 30 minutes'));
  check('framing: asks for a short report', /end with a short report/.test(msg.text));
  check('framing: prompt last', msg.text.endsWith('\n\nSummarise new issues.'));
  check('frameMessage is the same text', frameMessage(svc.list()[0]) === msg.text);
  let cur = svc.list()[0];
  check('running, runs counted, session recorded', cur.lastStatus === 'running' && cur.runs === 1 && cur.lastSessionId === 's1' && cur.lastRunAt === r.clock.t);
  check('next run keeps the rhythm', cur.nextRunAt === s.nextRunAt + 30 * MIN);
  const afterFire = h.pushed('schedules:changed').length;
  r.tick();
  check('a second tick at the same time does nothing', h.sent.length === 1 && h.pushed('schedules:changed').length === afterFire);

  r.advance(30 * MIN);
  cur = svc.list()[0];
  check('previous run still going: skipped', h.sent.length === 1 && cur.lastStatus === 'skipped' && cur.runs === 1);
  check('skip pushes too', h.pushed('schedules:changed').length === afterFire + 1);
  h.end('s1', 'done');
  check('run_end done -> ok', svc.list()[0].lastStatus === 'ok' && svc.list()[0].lastSessionId === 's1');
  check('status change pushes', h.pushed('schedules:changed').length === afterFire + 2);
  r.advance(30 * MIN);
  check('next occurrence runs in a fresh session', h.created.length === 2 && h.sent[1].id === 's2');
  h.end('s2', 'aborted');
  check('run_end aborted -> stopped', svc.list()[0].lastStatus === 'stopped');
  r.advance(30 * MIN);
  h.end('s3', 'error');
  check('run_end error -> error', svc.list()[0].lastStatus === 'error' && svc.list()[0].runs === 3);
  h.end('s3', 'done');
  check('a run_end not for a schedule run changes nothing', svc.list()[0].lastStatus === 'error');
  const hist = svc.list()[0].history;
  check('history: one entry per run, oldest first, with its session and how it ended', Array.isArray(hist) && hist.map((x) => `${x.sessionId}:${x.status}`).join() === 's1:ok,s2:stopped,s3:error' && hist.every((x) => !x.continued && typeof x.at === 'number'), hist);
  hist[0].status = 'tampered';
  check('history: the list hands out copies', svc.list()[0].history[0].status === 'ok');
  check('rpc schedules.preview describes a rhythm and its first run, storing nothing', (() => { const p = h.rpc['schedules.preview']({ kind: 'cron', expr: '0 9 * * 1-5' }); return p.describe === 'weekdays at 09:00' && typeof p.nextRunAt === 'number' && svc.list().length === 1; })());
  check('rpc schedules.preview refuses a bad rhythm', errCode(() => h.rpc['schedules.preview']({ kind: 'every', minutes: 2 })) === 'frequency_too_high');

  // A run whose end was never heard does not block the schedule forever
  r.advance(30 * MIN);
  h.running.delete('s4');
  r.advance(30 * MIN);
  check('lost run_end: the next occurrence still runs', h.sent.length === 5);
  h.end('s5');

  // Same-session target
  h.sessions.set('chat', { id: 'chat' });
  const one = svc.create({ name: 'Ping', prompt: 'Check the build.', when: { kind: 'at', at: iso(r.clock.t + 10 * MIN) }, sessionId: 'chat' }, 'user');
  check('one-shot defaults to the session', one.target === 'session' && one.sessionId === 'chat');
  h.running.add('chat'); // the user is mid-run there: the runtime queues the message
  const created = h.created.length;
  r.advance(10 * MIN);
  const oneNow = svc.get(one.id);
  check('same-session: sent into that session, no new session', h.sent.at(-1).id === 'chat' && h.created.length === created);
  check('one-shot disables itself and stays listed', oneNow && oneNow.enabled === false && oneNow.nextRunAt === null && oneNow.runs === 1);
  h.end('chat', 'done');
  check('queued run ends with the session run: ok', svc.get(one.id).lastStatus === 'ok');
  check('history: a run into an existing session is marked continued', JSON.stringify(svc.get(one.id).history.map((x) => [x.sessionId, x.status, x.continued])) === JSON.stringify([['chat', 'ok', true]]));
  r.advance(DAY);
  check('a fired one-shot never fires again', svc.get(one.id).runs === 1);

  // Session gone
  h.sessions.set('old', { id: 'old' });
  const gone = svc.create({ name: 'Gone', prompt: 'x', when: { kind: 'every', minutes: 15 }, target: 'session', sessionId: 'old' }, 'user');
  h.sessions.delete('old');
  const sentBefore = h.sent.length;
  r.advance(15 * MIN);
  const g = svc.get(gone.id);
  check('session gone: disabled with error, nothing sent', g.enabled === false && g.nextRunAt === null && g.lastStatus === 'error' && h.sent.length === sentBefore, g);

  // Disabled never fires
  const off = svc.create({ name: 'Off', prompt: 'x', when: { kind: 'every', minutes: 5 }, enabled: false }, 'user');
  check('disabled: no next run', off.nextRunAt === null);
  const n0 = h.sent.length;
  for (let i = 0; i < 12; i++) r.advance(5 * MIN);
  check('disabled schedule never fires', h.sent.filter((m) => m.opts.from === 'Off').length === 0 && svc.get(off.id).runs === 0);
  // Re-enabling starts its rhythm from now
  const on = svc.update(off.id, { enabled: true });
  check('re-enabled: next run 5 minutes out', on.nextRunAt === r.clock.t + 5 * MIN);
  svc.update(off.id, { enabled: false });

  // runNow
  const later = svc.create({ name: 'Later', prompt: 'x', when: { kind: 'cron', expr: '0 9 * * 1' } }, 'user');
  const p0 = h.pushed('schedules:changed').length;
  const ran = h.rpc['schedules.runNow'](later.id);
  check('runNow fires at once', ran.runs === 1 && h.sent.at(-1).opts.from === 'Later' && ran.lastStatus === 'running');
  check('runNow keeps the scheduled time', ran.nextRunAt === later.nextRunAt);
  check('runNow pushes', h.pushed('schedules:changed').length === p0 + 1);
  check('runNow of an unknown id: not_found', errCode(() => svc.runNow('nope')) === 'not_found');
  void n0;

  // send refused
  h.sendFails = true;
  const failing = svc.create({ name: 'Fails', prompt: 'x', when: { kind: 'every', minutes: 5 } }, 'user');
  const warn = console.warn;
  console.warn = () => {};
  r.advance(5 * MIN);
  console.warn = warn;
  check('send refused: error', svc.get(failing.id).lastStatus === 'error');
  h.sendFails = false;

  // update and remove push the list, and persist
  const p1 = h.pushed('schedules:changed').length;
  const up = h.rpc['schedules.update'](later.id, { name: 'Later 2', when: { kind: 'cron', expr: '30 14 * * MON' } });
  check('update: describe and next run recomputed', up.name === 'Later 2' && up.describe === 'Mondays at 14:30' && new Date(up.nextRunAt).getHours() === 14);
  const after = h.rpc['schedules.remove'](later.id);
  check('rpc remove returns the list without it', Array.isArray(after) && !after.some((x) => x.id === later.id));
  check('update and remove each push the full list', h.pushed('schedules:changed').length === p1 + 2 && h.pushed('schedules:changed').at(-1).p.length === svc.list().length);
  check('update of an unknown id: not_found', errCode(() => svc.update('nope', { name: 'x' })) === 'not_found');
  check('update to a past one-shot: not_future', errCode(() => svc.update(failing.id, { when: { kind: 'at', at: iso(r.clock.t - MIN) } })) === 'not_future');
  const disk = JSON.parse(fs.readFileSync(path.join(r.dir, 'schedules.json'), 'utf8')).schedules;
  check('the file matches the list', JSON.stringify(disk) === JSON.stringify(svc.list()));

  // quit stops the timer
  h.runQuit();
  const sentQ = h.sent.length;
  r.advance(HOUR);
  check('after quit the timer is gone', h.sent.length === sentQ);
}

// --- every across daylight saving, through the scheduler ---------------------------
{
  const start = Date.parse('2026-11-01T04:00:00Z'); // 00:00 EDT
  const r = rig({ t: start });
  r.svc.create({ name: 'Half-hourly', prompt: 'x', when: { kind: 'every', minutes: 30 } }, 'user');
  const times = [];
  for (let i = 0; i < 4 * 60 * 4; i++) {
    r.advance(15_000);
    if (r.h.sent.length > times.length) {
      times.push(r.clock.t);
      r.h.end(r.h.sent.at(-1).id);
    }
  }
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  check('every 30 across fall back: 8 runs in 4 h, 30 real minutes apart', times.length === 8 && gaps.every((g) => g === 30 * MIN), times.map(iso));
}

// --- missed runs at start-up -----------------------------------------------------
{
  const T0 = L(2026, 11, 5, 9, 0); // Thursday
  const seed = (dir, schedules) => new ScheduleStore(path.join(dir, 'schedules.json')).save(schedules);
  const mk = (id, when, nextRunAt, extra = {}) => ({ id, name: id, prompt: 'p', when, target: 'new', cwd: '/w', enabled: true, createdAt: T0 - 30 * DAY, createdBy: 'user', nextRunAt, runs: 0, describe: describeWhen(when), ...extra });
  const dir = tmp();
  seed(dir, [
    mk('hourly', { kind: 'every', minutes: 60 }, T0 - 3 * DAY), // newest missed: < 1 h ago
    mk('daily', { kind: 'cron', expr: '0 9 * * *' }, L(2026, 11, 2, 9)), // newest missed: today 09:00
    mk('weekly', { kind: 'cron', expr: '0 9 * * 1' }, L(2026, 11, 2, 9)), // newest missed: Monday, > 24 h
    mk('twoday', { kind: 'every', minutes: 2880 }, T0 - 30 * HOUR + HOUR), // newest missed 30 h before start
    mk('soon', { kind: 'at', at: iso(T0 - HOUR) }, T0 - HOUR, { target: 'session', sessionId: 'chat' }),
    mk('stale', { kind: 'at', at: iso(T0 - 30 * HOUR) }, T0 - 30 * HOUR),
    mk('wasRunning', { kind: 'every', minutes: 60 }, T0 + 2 * HOUR, { lastStatus: 'running', history: [{ at: T0 - HOUR, sessionId: 'x1', status: 'ok' }, { at: T0, sessionId: 'x2', status: 'running' }] }),
    mk('disabled', { kind: 'every', minutes: 60 }, null, { enabled: false }),
  ]);
  const h = fakeApp(dir);
  h.sessions.set('chat', { id: 'chat' });
  const t = T0 + HOUR; // 10:00
  let tickFn;
  const svc = setupSchedules(h.app, { now: () => t, setInterval: (fn) => (tickFn = fn), clearInterval: () => {} });
  const by = (id) => svc.get(id);
  const sentTo = (name) => h.sent.filter((m) => m.opts.from === name).length;
  check('recurring, newest missed < 24 h: runs once', sentTo('hourly') === 1 && by('hourly').runs === 1);
  check('recurring: next run back on the rhythm, in the future', by('hourly').nextRunAt === T0 + 2 * HOUR, by('hourly').nextRunAt && formatLocal(by('hourly').nextRunAt));
  check('daily cron missed for 3 days: one catch-up run, not a backlog', sentTo('daily') === 1 && by('daily').nextRunAt === L(2026, 11, 6, 9));
  check('recurring, newest missed > 24 h: missed, no run', sentTo('weekly') === 0 && by('weekly').lastStatus === 'missed' && by('weekly').nextRunAt === L(2026, 11, 9, 9));
  check('every 2 days, newest missed 30 h ago: missed', sentTo('twoday') === 0 && by('twoday').lastStatus === 'missed' && by('twoday').nextRunAt === T0 - 29 * HOUR + 2 * DAY);
  check('one-shot missed by 2 h: runs, then disabled', sentTo('soon') === 1 && by('soon').enabled === false && by('soon').nextRunAt === null && h.sent.find((m) => m.opts.from === 'soon').id === 'chat');
  check('one-shot missed by 30 h: missed and disabled', sentTo('stale') === 0 && by('stale').lastStatus === 'missed' && by('stale').enabled === false && by('stale').nextRunAt === null);
  check('a run the app quit during is marked stopped', by('wasRunning').lastStatus === 'stopped' && sentTo('wasRunning') === 0);
  check('… and so is its entry in the history', by('wasRunning').history.map((x) => x.status).join() === 'ok,stopped');
  check('disabled stays quiet', sentTo('disabled') === 0);
  tickFn();
  tickFn();
  check('further ticks add no catch-up runs', h.sent.length === 3, h.sent.map((m) => m.opts.from));
  check('start-up catch-up pushes the list', h.pushed('schedules:changed').length >= 1);
}

// --- tools -------------------------------------------------------------------------
(async () => {
  const r = rig();
  const { h, svc } = r;
  h.sessions.set('main', { id: 'main' });
  const approvals = [];
  let answer = { ok: true };
  const ctx = { sessionId: 'main', cwd: '/proj', mode: 'ask', approve: async (...a) => (approvals.push(a), answer) };
  const run = (name, args) => h.tools[name].run(args, ctx);
  for (const n of ['schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete']) check(`tool ${n} registered`, !!h.tools[n]);
  check('schedule_list is read-only', h.tools.schedule_list.readOnly === true);
  check('the changing tools are not read-only', !h.tools.schedule_create.readOnly && !h.tools.schedule_update.readOnly && !h.tools.schedule_delete.readOnly);

  // Validation codes: no card, nothing stored
  const codes = [
    [{ name: 'a', prompt: 'p', every_minutes: 3 }, 'frequency_too_high'],
    [{ name: 'a', prompt: 'p', cron: '*/2 * * * *' }, 'frequency_too_high'],
    [{ name: 'a', prompt: 'p', at: iso(r.clock.t - MIN) }, 'not_future'],
    [{ name: 'a', prompt: 'p', in_minutes: 0 }, 'not_future'],
    [{ name: 'a', prompt: 'p', at: '2026-11-06 09:00' }, 'bad_time'],
    [{ name: 'a', prompt: 'p', at: '2026-11-06T09:00:00' }, 'bad_time'],
    [{ name: 'a', prompt: 'p', in_minutes: 5, cron: '0 9 * * *' }, 'bad_time'],
    [{ name: 'a', prompt: 'p' }, 'bad_time'],
    [{ name: 'a', prompt: 'p', cron: 'every monday' }, 'bad_cron'],
    [{ name: 'a', prompt: 'p', cron: '0 0 31 2 *' }, 'bad_cron'],
    [{ name: 'n'.repeat(81), prompt: 'p', every_minutes: 60 }, 'too_long'],
    [{ name: 'a', prompt: 'x'.repeat(8001), every_minutes: 60 }, 'too_long'],
    [{ name: 'a', prompt: '', every_minutes: 60 }, 'bad_input'],
    [{ name: 'a', prompt: 'p', every_minutes: 60, target: 'elsewhere' }, 'bad_input'],
  ];
  for (const [args, code] of codes) {
    const res = await run('schedule_create', args);
    check(`schedule_create ${JSON.stringify(args).slice(0, 70)} -> ${code}`, res.content.startsWith(`Error: ${code}: `), res.content);
  }
  check('validation errors ask nothing and store nothing', approvals.length === 0 && svc.list().length === 0);

  // Approved create
  const pushes = h.pushed('schedules:changed').length;
  const res = await run('schedule_create', { name: 'Standup notes', prompt: 'Write the standup notes from yesterday’s commits.', cron: '0 9 * * 1-5' });
  check('approval asked once', approvals.length === 1);
  const [tool, detail, target, opts] = approvals[0];
  check('approval: schedule_create, custom + alwaysAsk, no target', tool === 'schedule_create' && target === undefined && opts.custom === true && opts.alwaysAsk === true, opts);
  check('approval card: name, rhythm in words, where, full prompt', detail.includes('Standup notes') && detail.includes('weekdays at 09:00') && detail.includes('a new session each time, in /proj') && detail.includes('Write the standup notes from yesterday’s commits.'), JSON.stringify(detail));
  const made = svc.list()[0];
  check('created by the agent in the calling session and folder', made && made.createdBy === 'agent' && made.createdInSession === 'main' && made.cwd === '/proj' && made.target === 'new');
  check('result tells the model the id and next run', res.content.includes(made.id) && res.content.includes('weekdays at 09:00') && /next run (Mon|Tue|Wed|Thu|Fri) /.test(res.content), res.content);
  check('create pushes once (validation pushes nothing)', h.pushed('schedules:changed').length === pushes + 1);

  // Default target for a one-shot is this session; in_minutes counts from approval
  approvals.length = 0;
  let slowApproval = null;
  ctx.approve = async (...a) => {
    approvals.push(a);
    r.clock.t += 3 * MIN; // the user takes three minutes to answer
    return answer;
  };
  const t0 = r.clock.t;
  await run('schedule_create', { name: 'Remind', prompt: 'Check the deploy.', in_minutes: 10 });
  const remind = svc.list().find((s) => s.name === 'Remind');
  check('one-shot defaults to this session', remind.target === 'session' && remind.sessionId === 'main');
  check('in_minutes counts from the approval', remind.nextRunAt === t0 + 13 * MIN, remind.nextRunAt - t0);
  check('the card says where it runs', approvals[0][1].includes('this session'));
  ctx.approve = async (...a) => (approvals.push(a), answer);
  void slowApproval;
  await run('schedule_create', { name: 'Hourly here', prompt: 'x', every_minutes: 60, target: 'this_session' });
  check('explicit this_session for a recurring one', svc.list().find((s) => s.name === 'Hourly here').target === 'session');

  // Refusal stores nothing
  answer = { ok: false, message: 'The user denied this.' };
  const n = svc.list().length;
  const p2 = h.pushed('schedules:changed').length;
  const refused = await run('schedule_create', { name: 'Nope', prompt: 'x', every_minutes: 30 });
  check('refused: nothing stored, nothing pushed', refused.content.startsWith('Not scheduled: The user denied this.') && svc.list().length === n && h.pushed('schedules:changed').length === p2, refused.content);
  answer = { ok: true };

  // list
  const listed = await run('schedule_list', {});
  check('schedule_list shows id, name, rhythm, next run, last result', listed.content.includes(made.id) && listed.content.includes('"Standup notes"') && listed.content.includes('weekdays at 09:00') && /next: \w{3} \w{3} \d+ \d\d:\d\d/.test(listed.content) && listed.content.includes('last: not run yet'), JSON.stringify(listed.content));

  // update: re-timing asks; disabling does not
  approvals.length = 0;
  const upd = await run('schedule_update', { id: made.id, cron: '30 14 * * MON' });
  check('update re-timing asks, custom + alwaysAsk', approvals.length === 1 && approvals[0][0] === 'schedule_update' && approvals[0][3].custom && approvals[0][3].alwaysAsk && approvals[0][1].includes('Mondays at 14:30'));
  check('update applied', upd.content.startsWith('Updated:') && svc.get(made.id).describe === 'Mondays at 14:30');
  const dis = await run('schedule_update', { id: made.id, enabled: false });
  check('disabling needs no approval', approvals.length === 1 && svc.get(made.id).enabled === false && dis.content.startsWith('Updated:'));
  await run('schedule_update', { id: made.id, enabled: true });
  check('enabling asks', approvals.length === 2 && svc.get(made.id).enabled === true);
  answer = { ok: false, message: 'denied' };
  const refusedUpd = await run('schedule_update', { id: made.id, prompt: 'Something else' });
  check('refused update changes nothing', refusedUpd.content.startsWith('Not changed:') && svc.get(made.id).prompt.startsWith('Write the standup'));
  answer = { ok: true };
  const badUpd = await run('schedule_update', { id: made.id, every_minutes: 2 });
  check('update validation: frequency_too_high before any card', badUpd.content.startsWith('Error: frequency_too_high:') && approvals.length === 3);
  check('update unknown id: not_found', (await run('schedule_update', { id: 'nope', name: 'x' })).content.startsWith('Error: not_found:'));
  const moved = await run('schedule_update', { id: made.id, target: 'this_session' });
  check('update target to this session', moved.content.startsWith('Updated:') && svc.get(made.id).target === 'session' && svc.get(made.id).sessionId === 'main');

  // delete: no approval
  const before = approvals.length;
  const del = await run('schedule_delete', { id: made.id });
  check('delete: gone, no approval', del.content.startsWith('Deleted') && !svc.get(made.id) && approvals.length === before);
  check('delete unknown id: not_found', (await run('schedule_delete', { id: made.id })).content.startsWith('Error: not_found:'));

  // too_many through the tool
  while (svc.list().length < 50) svc.create({ name: 'filler', prompt: 'p', when: { kind: 'every', minutes: 60 } }, 'user');
  const full = await run('schedule_create', { name: 'one more', prompt: 'p', every_minutes: 60 });
  check('schedule_create at 50: too_many, no card', full.content.startsWith('Error: too_many:') && approvals.length === before);

  // prompt section and /schedules
  const section = h.prompts.schedules({ cwd: '/proj', mode: 'ask', sessionId: 'main' });
  check('prompt section: schedule_create, user approves, while the app is open', section.includes('schedule_create') && /approves every schedule/.test(section) && /while the app is open/.test(section) && section.split('\n').length <= 4, JSON.stringify(section));
  const cmd = h.commands.schedules;
  check('/schedules is an app command', cmd && cmd.source === 'app');
  const out = await cmd.run('', { sessionId: 'main' });
  check('/schedules lists schedules with their next run', out.notice.includes('Remind') && out.notice.includes('next:') && out.notice.startsWith('50 schedules'), JSON.stringify(out.notice.slice(0, 120)));
  const empty = rig();
  check('/schedules with none says so', /No schedules/.test((await empty.h.commands.schedules.run('', { sessionId: 'x' })).notice));
})()
  .then(powerTests)
  .then(done, (err) => {
    check('suite crashed', false, err && err.stack);
    done();
  });

// --- power ---------------------------------------------------------------------------
async function powerTests() {
  const mk = (mode, running = []) => {
    const h = fakeApp(tmp(), { keepAwake: mode });
    running.forEach((id) => h.running.add(id));
    const b = { next: 1, active: new Set(), starts: 0, stops: 0, maxActive: 0 };
    const blocker = {
      start() {
        const id = b.next++;
        b.active.add(id);
        b.starts++;
        b.maxActive = Math.max(b.maxActive, b.active.size);
        return id;
      },
      stop(id) {
        if (!b.active.delete(id)) throw new Error(`stop of unknown id ${id}`);
        b.stops++;
      },
    };
    setupPower(h.app, { blocker });
    const status = () => h.rpc['power.status']();
    return { h, b, status };
  };

  {
    const { h, b, status } = mk('running');
    check('power.status registered', typeof h.rpc['power.status'] === 'function');
    check('running mode, idle: not held', b.starts === 0 && status().active === false && status().mode === 'running');
    h.start('a');
    check('first run_start holds once', b.starts === 1 && status().active === true);
    h.start('b');
    h.start('a');
    check('more runs: no second blocker', b.starts === 1 && b.active.size === 1);
    h.end('a');
    check('one run ends, another still going: still held', b.stops === 0 && status().active);
    h.end('b');
    check('last run_end releases', b.stops === 1 && b.active.size === 0 && status().active === false);
    h.emit('c', { type: 'text_delta', text: 'x' });
    check('other events do nothing', b.starts === 1);
    const changes = h.pushed('power:changed').map((p) => p.p.active);
    check('power:changed pushed on each change only', changes.join() === 'false,true,false', changes);
    h.start('d');
    h.end('d');
    check('starts again on the next run', b.starts === 2 && b.stops === 2 && b.maxActive === 1);
  }
  {
    const { h, b } = mk('running', ['busy']);
    check('a session already running at start-up holds at once', b.starts === 1);
    h.start('x');
    h.running.delete('busy'); // its run_end was lost
    h.end('x');
    check('a lost run_end does not keep it held', b.active.size === 0);
  }
  {
    const { h, b, status } = mk('off');
    h.start('a');
    check('off: never held', b.starts === 0 && !status().active);
    h.app.updateConfig({ keepAwake: 'running' });
    check('off -> running mid-run: held', b.starts === 1 && status().active && status().mode === 'running');
    h.app.updateConfig({ keepAwake: 'off' });
    check('running -> off mid-run: released', b.stops === 1 && !status().active && status().mode === 'off');
    h.app.updateConfig({ keepAwake: 'always' });
    check('-> always: held', b.active.size === 1 && status().mode === 'always');
    h.end('a');
    check('always: run_end does not release', b.active.size === 1);
    h.app.updateConfig({ keepAwake: 'running' });
    check('always -> running with nothing running: released', b.active.size === 0 && status().mode === 'running');
    h.app.updateConfig({ theme: 'dark' });
    const modes = h.pushed('power:changed').map((p) => `${p.p.mode}/${p.p.active}`);
    check('pushes on mode or active changes, not on unrelated config', modes.join() === 'off/false,running/true,off/false,always/true,running/false', modes);
    check('never more than one blocker', b.maxActive === 1);
  }
  {
    const { h, b, status } = mk('always');
    check('always: held while idle', b.starts === 1 && status().active);
    h.start('a');
    check('always + run: still one', b.starts === 1);
    await h.runQuit();
    check('quit releases', b.active.size === 0 && b.stops === 1 && !status().active);
    h.start('b');
    check('nothing is held after quit', b.active.size === 0);
  }
}
