/*
 * The playground's mock world: what the app would know (sessions, transcript, tasks, plan, outputs, context, skills,
 * config, schedules, remote). PlaygroundFixture.build('empty' | 'busy' | 'full') returns a fresh, editable copy.
 */
(function (root) {
  'use strict';

  var HOME = '/Users/patrick';
  var MIN = 60 * 1000;

  function session(id, title, o) {
    var now = Date.now();
    return Object.assign({ id: id, title: title, cwd: HOME + '/code/silo-harness', origin: 'user', messageCount: 0, createdAt: now - 3 * 3600 * 1000, updatedAt: now - 2 * MIN, running: false }, o || {});
  }

  var LABELS = { system: 'System prompt', instructions: 'Instructions', skills: 'Skills', tools: 'Built-in tools', mcpTools: 'MCP tools', summary: 'Summary', messages: 'Messages', toolResults: 'Tool calls', reserve: 'Reserved for compaction', free: 'Free' };

  /** A ContextBreakdown whose slices add up to `limit`; `parts` are the used slices by key (tokens or { tokens, items }). */
  function context(limit, parts, o) {
    o = o || {};
    var order = ['system', 'instructions', 'skills', 'tools', 'mcpTools', 'summary', 'messages', 'toolResults'];
    var slices = [];
    var used = 0;
    order.forEach(function (k) {
      var p = parts[k];
      if (p === undefined) return;
      var tokens = typeof p === 'number' ? p : p.tokens;
      var s = { key: k, label: LABELS[k], tokens: tokens };
      if (p && p.items) s.items = p.items.map(function (i) { return { label: i[0], tokens: i[1] }; });
      slices.push(s);
      used += tokens;
    });
    var reserve = Math.max(8000, Math.round(limit * 0.05));
    slices.push({ key: 'reserve', label: LABELS.reserve, tokens: reserve });
    slices.push({ key: 'free', label: LABELS.free, tokens: Math.max(0, limit - used - reserve) });
    return {
      tokens: used, limit: limit, threshold: o.threshold || 0.8, autoCompact: o.autoCompact !== false, basis: o.basis || 'reported',
      slices: slices, messages: o.messages || 0, compactable: (o.messages || 0) >= 4, compactions: o.compactions || 0, lastCompaction: o.lastCompaction, updatedAt: o.updatedAt || Date.now(),
    };
  }

  var SKILLS = [
    { name: 'create-mod', description: 'Write a Silo Harness mod: manifest, pages and a check with mod_check.', path: '/app/skills/create-mod/SKILL.md', source: 'bundled' },
    { name: 'git-commit', description: 'Stage and commit with a message that says what changed and why.', path: HOME + '/.silo-harness/skills/git-commit/SKILL.md', source: 'user' },
    { name: 'pdf', description: 'Read, fill and merge PDF files.', path: '/app/skills/pdf/SKILL.md', source: 'bundled' },
    { name: 'review', description: 'Review the current diff for correctness bugs before you commit.', path: HOME + '/.silo-harness/skills/review/SKILL.md', source: 'user' },
    { name: 'release-notes', description: 'Draft release notes from the commits since the last tag.', path: HOME + '/code/silo-harness/.silo-harness/skills/release-notes/SKILL.md', source: 'project' },
    { name: 'xlsx', description: 'Create and edit spreadsheets, formulas included.', path: '/app/skills/xlsx/SKILL.md', source: 'bundled' },
    { name: 'webapp-testing', description: 'Drive a local web app in the built-in browser and check what it shows.', path: '/app/skills/webapp-testing/SKILL.md', source: 'bundled' },
  ];

  var PLAN_MD = [
    '## Goal',
    'Load `settings.json` from the user folder and the project, layered over `config.json`, without ever writing an override back.',
    '',
    '## Steps',
    '1. Read both files in `src/main/settings.ts` and merge them key by key.',
    '2. Expand `${VAR}` references from the `env` block.',
    '3. Mark every key a settings file owns, so the Settings page can show it as managed.',
    '4. Strip owned keys in `withoutSettings()` before `config.json` is saved.',
    '',
    '## Verification',
    '- `node test/settings.js` covers precedence, the env block and the round trip.',
    '- Open Settings and check that managed fields are read-only.',
    '',
    '## Open questions',
    '- Should a project file be able to change the provider?',
  ].join('\n');

  function base() {
    var now = Date.now();
    return {
      scheme: 'light',
      app: { name: 'Silo Harness', version: '0.1.0 (playground)' },
      home: HOME,
      config: { provider: 'ollama', model: 'qwen3:8b', workingDirectory: HOME, permissionMode: 'ask', theme: 'system', autoCompact: true, compactThreshold: 0.8, keepAwake: 'off', notifications: true, background: null, contextLimit: 200000 },
      git: { root: HOME + '/code/atlas-api', repository: 'patrick/atlas-api', branch: 'main' },
      remote: { enabled: false, running: false, bind: 'lan', port: null, urls: [], clients: 0 },
      // How the playground's model answers: ok, slow, hold (streams a little, then waits for a cancel), nokey, unreachable
      model: { mode: 'ok' },
      sessions: {},
      currentId: 's-main',
      skills: SKILLS.slice(),
      skillsAll: {},
      schedules: [],
      now: now,
    };
  }

  function addSession(w, s, data) {
    w.sessions[s.id] = Object.assign({ session: s, transcript: [], tasks: [], plan: null, outputs: [], skillUsage: {}, context: context(w.config.contextLimit, { system: 2900, instructions: 1200, skills: 900, tools: 4100 }, { messages: 0 }) }, data || {});
    return w.sessions[s.id];
  }

  var HOUR = 60 * MIN;
  var DAY = 24 * HOUR;
  /** One schedule of every kind and state the Scheduled mod has to show. */
  function schedules(now, cwd) {
    var at = function (t) { var d = new Date(t); var off = -d.getTimezoneOffset(); var pad = function (n) { return (n < 10 ? '0' : '') + n; };
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':00' + (off >= 0 ? '+' : '-') + pad(Math.floor(Math.abs(off) / 60)) + ':' + pad(Math.abs(off) % 60); };
    var soon = new Date(now + 26 * HOUR); soon.setMinutes(0, 0, 0);
    var past = new Date(now - 2 * DAY); past.setHours(14, 30, 0, 0);
    var base = { cwd: cwd, enabled: true, createdBy: 'user', target: 'new', runs: 0 };
    var mk = function (o) { return Object.assign({}, base, o); };
    return [
      mk({ id: 'sch1', name: 'Morning summary', prompt: 'Summarise what changed in the repo since yesterday: commits, open PRs and anything that failed in CI.', when: { kind: 'cron', expr: '0 9 * * 1-5' }, createdAt: now - 7 * DAY, nextRunAt: now + 15 * HOUR + 12 * MIN, lastRunAt: now - 9 * HOUR, lastStatus: 'ok', lastSessionId: 's-other', runs: 5, describe: 'weekdays at 09:00' }),
      mk({ id: 'sch3', name: 'Check CI', prompt: 'Look at the last CI run on main and fix what broke.', when: { kind: 'every', minutes: 30 }, target: 'session', sessionId: 's-main', createdBy: 'agent', createdInSession: 's-main', createdAt: now - DAY, nextRunAt: now + 12 * MIN, lastRunAt: now - 18 * MIN, lastStatus: 'error', lastSessionId: 's-main', runs: 12, describe: 'every 30 minutes' }),
      mk({ id: 'sch4', name: 'Dependency audit', prompt: 'Run npm audit and open a PR for anything with a fix.', when: { kind: 'every', minutes: 1440 }, createdAt: now - 3 * DAY, nextRunAt: now + 5 * HOUR, lastRunAt: now - 19 * HOUR, lastStatus: 'skipped', runs: 3, describe: 'every day' }),
      mk({ id: 'sch5', name: 'Release notes draft', prompt: 'Draft release notes from the commits since the last tag.', when: { kind: 'cron', expr: '0 16 * * 5' }, createdAt: now - 20 * DAY, nextRunAt: now + 2 * DAY + 3 * HOUR, lastRunAt: now - 5 * DAY, lastStatus: 'missed', runs: 2, describe: 'Fridays at 16:00' }),
      mk({ id: 'sch6', name: 'Remind me to rotate the staging key', prompt: 'Remind me that the staging API key expires this week and list where it is used.', when: { kind: 'at', at: at(soon.getTime()) }, createdAt: now - 2 * HOUR, nextRunAt: soon.getTime(), runs: 0, describe: 'once on ' + soon.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' at ' + String(soon.getHours()).padStart(2, '0') + ':00' }),
      mk({ id: 'sch7', name: 'Nightly flaky-test sweep', prompt: 'Run the test suite five times and list the tests that failed at least once.', when: { kind: 'cron', expr: '30 2 * * *' }, enabled: false, createdAt: now - 12 * DAY, nextRunAt: null, lastRunAt: now - 4 * DAY, lastStatus: 'ok', runs: 8, describe: 'every day at 02:30' }),
      mk({ id: 'sch8', name: 'Look at the benchmark once the cache lands', prompt: 'Run the startup benchmark and compare it with last week.', when: { kind: 'at', at: at(past.getTime()) }, createdAt: now - 3 * DAY, nextRunAt: null, lastRunAt: past.getTime(), lastStatus: 'ok', lastSessionId: 's-other', runs: 1, describe: 'once on ' + past.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' at 14:30' }),
    ];
  }

  function build(state) {
    var w = base();
    var now = w.now;
    if (state === 'busy') {
      w.config = Object.assign(w.config, { provider: 'ollama', model: 'qwen3-coder:30b', workingDirectory: HOME + '/code/silo-harness', permissionMode: 'acceptEdits', keepAwake: 'running' });
      w.remote = { enabled: true, running: true, bind: 'lan', port: 7788, urls: ['http://192.168.1.23:7788/?t=7f3a9c2e81d44b0f'], clients: 0, startedAt: now - 4 * MIN };
      addSession(w, session('s-main', 'Refactor the settings loader', { cwd: HOME + '/code/silo-harness', messageCount: 6, running: true, updatedAt: now - 10 * 1000 }), {
        transcript: [
          { role: 'user', text: 'Load settings.json from the user folder and the project, layered over config.json.' },
          { role: 'assistant', text: 'I will read the current loader first.' },
          { role: 'tool', name: 'Read', args: '{"path":"src/main/config.ts"}', text: '214 lines', ok: true },
          { role: 'plan', text: PLAN_MD },
        ],
        tasks: [
          { id: 't1', title: 'Read the current config loader', status: 'completed' },
          { id: 't2', title: 'Merge user and project settings.json over config.json', status: 'in_progress' },
          { id: 't3', title: 'Expand ${VAR} references from the env block', status: 'pending' },
          { id: 't4', title: 'Run node test/settings.js', status: 'pending' },
        ],
        plan: { id: 'p1', title: 'Layered settings.json', markdown: PLAN_MD, status: 'proposed', createdAt: now - 3 * MIN },
        outputs: [
          { kind: 'file', id: 'src/main/settings.ts', title: 'src/main/settings.ts', detail: '+86 −12', updatedAt: now - 30 * 1000 },
          { kind: 'file', id: 'src/main/config.ts', title: 'src/main/config.ts', detail: '+4 −1', updatedAt: now - 90 * 1000 },
        ],
        skillUsage: { 'git-commit': { count: 1, lastUsedAt: now - 5 * MIN } },
        context: context(200000, {
          system: 2900, instructions: { tokens: 3100, items: [['SILOHARNESS.md', 1900], ['CLAUDE.md', 1200]] }, skills: 900, tools: 4100,
          mcpTools: { tokens: 11200, items: [['github', 11200]] }, messages: 9800, toolResults: 30400,
        }, { messages: 14, updatedAt: now - 40 * 1000 }),
      });
      addSession(w, session('s-c2', 'Audit mod permissions', { parentId: 's-main', origin: 'agent', running: true, messageCount: 3, createdAt: now - 6 * MIN, updatedAt: now - 20 * 1000 }));
      w.skillsAll = { 'git-commit': { count: 14, lastUsedAt: now - 5 * MIN }, review: { count: 6, lastUsedAt: now - 26 * 3600 * 1000 } };
      w.schedules = schedules(now, HOME + '/code/silo-harness').filter(function (x) { return x.id === 'sch1' || x.id === 'sch3'; });
    } else if (state === 'full') {
      w.config = Object.assign(w.config, { provider: 'portkey', model: '@anthropic/claude-sonnet-5', workingDirectory: HOME + '/Documents/claudecode/silo-harness', permissionMode: 'auto', keepAwake: 'always', contextLimit: 1000000 });
      w.remote = { enabled: true, running: true, bind: 'lan', port: 7788, urls: ['http://192.168.1.23:7788/?t=7f3a9c2e81d44b0f', 'http://patricks-mac.local:7788/?t=7f3a9c2e81d44b0f'], clients: 2, startedAt: now - 52 * MIN };
      addSession(w, session('s-main', 'Build the mod kit and the first seven mods', { cwd: HOME + '/Documents/claudecode/silo-harness', parentId: 's-parent', messageCount: 48, updatedAt: now - 2 * MIN }), {
        transcript: [
          { role: 'user', text: 'Build the client side of the mod system.' },
          { role: 'assistant', text: 'Starting with the kit: harness.js and harness.css.' },
          { role: 'tool', name: 'Write', args: '{"path":"modkit/harness.js"}', text: 'Wrote 312 lines', ok: true },
          { role: 'artifact', text: 'Mod playground' },
          { role: 'image', text: 'context-dark.png' },
          { role: 'compaction', text: 'Summary of the first part: kit written, playground started.' },
          { role: 'assistant', text: 'The kit and the playground are in place; next the seven mods.' },
        ],
        tasks: [
          { id: 't1', title: 'Write harness.js and harness.css', status: 'completed' },
          { id: 't2', title: 'Build the playground and its fixture', status: 'completed' },
          { id: 't3', title: 'Write the seven bundled mods, each in the rail with a compact, quiet layout that works at 300 px', status: 'in_progress' },
          { id: 't4', title: 'Screenshot every mod in light and dark', status: 'pending' },
          { id: 't5', title: 'Headless test for the wire protocol', status: 'pending' },
        ],
        plan: { id: 'p2', title: 'Mod kit, playground and bundled mods', markdown: PLAN_MD, status: 'approved', createdAt: now - 70 * MIN },
        outputs: [
          { kind: 'artifact', id: 'a1', title: 'Mod playground', detail: 'HTML · v3', updatedAt: now - 3 * MIN },
          { kind: 'image', id: 'i1', title: 'context-dark.png', detail: 'PNG · 600×480', updatedAt: now - 9 * MIN },
          { kind: 'file', id: 'modkit/harness.js', title: 'modkit/harness.js', detail: '+312', updatedAt: now - 12 * MIN },
          { kind: 'file', id: 'modkit/harness.css', title: 'modkit/harness.css', detail: '+248', updatedAt: now - 14 * MIN },
          { kind: 'file', id: 'mods/environment/panel.html', title: 'mods/environment/panel.html', detail: '+190 −22', updatedAt: now - 30 * MIN },
          { kind: 'artifact', id: 'a2', title: 'A very long artifact title that will not fit in the rail at three hundred pixels', detail: 'HTML · v1', updatedAt: now - 45 * MIN },
          { kind: 'image', id: 'i2', title: 'playground.png', detail: 'PNG · 1400×900', updatedAt: now - 50 * MIN },
        ],
        skillUsage: { 'create-mod': { count: 4, lastUsedAt: now - 3 * MIN }, 'git-commit': { count: 3, lastUsedAt: now - 20 * MIN }, review: { count: 1, lastUsedAt: now - 40 * MIN } },
        context: context(1000000, {
          system: 3100,
          instructions: { tokens: 4200, items: [['SILOHARNESS.md', 2900], ['~/.claude/CLAUDE.md', 1300]] },
          skills: { tokens: 1800, items: [['bundled', 900], ['user', 600], ['project', 300]] },
          tools: 12400,
          mcpTools: { tokens: 18700, items: [['github', 11200], ['playwright', 7500]] },
          summary: 6300, messages: 41200, toolResults: 46300,
        }, { messages: 48, compactions: 1, updatedAt: now - 2 * MIN - 10 * 1000, lastCompaction: { at: now - 40 * MIN, reason: 'auto', tokensBefore: 812000, tokensAfter: 61000 } }),
      });
      addSession(w, session('s-parent', 'Plan the mod system', { cwd: HOME + '/Documents/claudecode/silo-harness', messageCount: 31, updatedAt: now - 3 * 3600 * 1000 }));
      addSession(w, session('s-c1', 'Write the harness wire tests', { parentId: 's-main', origin: 'agent', messageCount: 12, createdAt: now - 50 * MIN, updatedAt: now - 25 * MIN }));
      addSession(w, session('s-c2', 'Audit mod permissions against the docs', { parentId: 's-main', origin: 'agent', running: true, messageCount: 7, createdAt: now - 8 * MIN, updatedAt: now - 15 * 1000 }));
      addSession(w, session('s-c3', 'Check that every icon name exists', { parentId: 's-main', origin: 'agent', attention: 'approval', messageCount: 4, createdAt: now - 6 * MIN, updatedAt: now - 60 * 1000 }));
      addSession(w, session('s-f1', 'Try a CSS-only theme instead', { forkedFrom: 's-main', messageCount: 22, createdAt: now - 35 * MIN, updatedAt: now - 18 * MIN }));
      w.skillsAll = { 'create-mod': { count: 9, lastUsedAt: now - 3 * MIN }, 'git-commit': { count: 41, lastUsedAt: now - 20 * MIN }, review: { count: 17, lastUsedAt: now - 40 * MIN }, pdf: { count: 2, lastUsedAt: now - 9 * 86400 * 1000 }, 'release-notes': { count: 3, lastUsedAt: now - 14 * 86400 * 1000 } };
      w.schedules = schedules(now, HOME + '/Documents/claudecode/silo-harness');
    } else {
      addSession(w, session('s-main', 'New session', { cwd: HOME, messageCount: 0, createdAt: now - 20 * 1000, updatedAt: now - 20 * 1000 }));
      w.skills = [];
    }
    // A second top-level session, for "switch session"
    addSession(w, session('s-other', 'Fix the flaky terminal test', { cwd: HOME + '/code/silo-harness', messageCount: 9, updatedAt: now - 26 * 3600 * 1000 }), {
      transcript: [{ role: 'user', text: 'The terminal test fails one run in five.' }, { role: 'assistant', text: 'It races the shell prompt; waiting for the first output fixes it.' }],
      tasks: [{ id: 'o1', title: 'Reproduce the failure', status: 'completed' }, { id: 'o2', title: 'Wait for the prompt before typing', status: 'completed' }],
      outputs: [{ kind: 'file', id: 'test/terminal-manager.js', title: 'test/terminal-manager.js', detail: '+6 −2', updatedAt: now - 26 * 3600 * 1000 }],
      skillUsage: { review: { count: 1, lastUsedAt: now - 26 * 3600 * 1000 } },
      context: context(w.config.contextLimit, { system: 2900, instructions: 1200, skills: 900, tools: 4100, messages: 5200, toolResults: 8800 }, { messages: 9, updatedAt: now - 26 * 3600 * 1000 }),
    });
    return w;
  }

  /** Recomputes `tokens` and the free slice after a slice changed. */
  function retotal(ctx) {
    var used = 0;
    var free = null;
    ctx.slices.forEach(function (s) {
      if (s.key === 'free') free = s;
      else if (s.key !== 'reserve') used += s.tokens;
    });
    var reserve = ctx.slices.filter(function (s) { return s.key === 'reserve'; })[0];
    if (free) free.tokens = Math.max(0, ctx.limit - used - (reserve ? reserve.tokens : 0));
    ctx.tokens = used;
    return ctx;
  }

  var api = { build: build, context: context, retotal: retotal, LABELS: LABELS, STATES: ['empty', 'busy', 'full'] };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlaygroundFixture = api;
})(typeof self !== 'undefined' ? self : this);
