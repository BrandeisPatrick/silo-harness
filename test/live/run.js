// Runs the live checks one after another. Each launches the real app hidden, on a throwaway profile, so nothing
// here touches your own sessions or settings. With ANTHROPIC_API_KEY set they talk to the real API (a few cents
// of the cheapest model in all); without it they fall back to the mock model and skip what needs a real one.
//
//   npm run build && npm run test:live            every script
//   npm run test:live -- mods sidebar             only those whose name contains one of the words
//   SHOTS=/some/folder npm run test:live          keep the screenshots there (default: a temp folder)
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
if (!fs.existsSync(path.join(root, 'dist', 'main', 'index.js'))) {
  console.error('Build first: npm run build');
  process.exit(1);
}

/**
 * shots: how the script takes its screenshot folder. electron: it is itself an Electron main script.
 * needsApi: every check in it needs a model that calls tools, so without a key it is skipped.
 */
const SCRIPTS = [
  { name: 'smoke' },
  { name: 'concurrent' },
  { name: 'regression', needsApi: true },
  { name: 'settings' },
  { name: 'settings-page' },
  { name: 'providers' },
  { name: 'sidebar' },
  { name: 'images' },
  { name: 'history' },
  { name: 'carry-over', shots: 'none' },
  { name: 'compaction', needsApi: true },
  { name: 'subagents' },
  { name: 'names' },
  { name: 'tool-rows' },
  { name: 'quiet' },
  { name: 'mods', shots: 'env' },
  { name: 'mods-look', shots: 'env' },
  { name: 'type-scale' },
  { name: 'mods-protocol', shots: 'none' },
  { name: 'mods-panes' },
  { name: 'looks', shots: 'env' },
  { name: 'look-tabs' },
  { name: 'palette' },
  { name: 'glass' },
  { name: 'dreaming' },
  { name: 'pages' },
  { name: 'hooks', shots: 'env' },
  { name: 'questions' },
  { name: 'remote-page', electron: true },
  { name: 'browser-safety' },
  { name: 'browser-permissions' },
  { name: 'browser-cert' },
  { name: 'browser-downloads' },
  { name: 'browser-tabs' },
  { name: 'browser-oauth' },
  { name: 'browser-approvals' },
  { name: 'browser-polish' },
];

const words = process.argv.slice(2);
const chosen = SCRIPTS.filter((s) => !words.length || words.some((w) => s.name.includes(w)));
const shotsRoot = process.env.SHOTS ? path.resolve(process.env.SHOTS) : fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-'));
console.log(`model: ${process.env.ANTHROPIC_API_KEY ? 'the real API' : 'the mock model (set ANTHROPIC_API_KEY for the real one)'}; screenshots: ${shotsRoot}\n`);

let failed = 0;
let skipped = 0;
for (const s of chosen) {
  if (s.needsApi && !process.env.ANTHROPIC_API_KEY) {
    skipped++;
    console.log(`SKIP  ${s.name.padEnd(16)} needs the real API (set ANTHROPIC_API_KEY)`);
    continue;
  }
  const file = path.join(__dirname, `${s.name}.js`);
  const shots = path.join(shotsRoot, s.name);
  fs.mkdirSync(shots, { recursive: true });
  const bin = s.electron ? require(path.join(root, 'node_modules', 'electron')) : process.execPath;
  const args = s.shots === 'env' || s.shots === 'none' ? [file] : [file, shots];
  // Profiles, projects and whatever else a script makes go into a temp folder of its own, removed when it ends.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-live-'));
  const env = { ...process.env, TMPDIR: tmp, ...(s.shots === 'env' ? { SHOTS: shots } : {}) };
  delete env.ELECTRON_RUN_AS_NODE;
  const started = Date.now();
  const r = spawnSync(bin, args, { cwd: root, env, encoding: 'utf8', timeout: 30 * 60_000, maxBuffer: 64 * 1024 * 1024 });
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  const out = (r.stdout || '') + (r.stderr || '');
  const ok = r.status === 0;
  if (!ok) failed++;
  const checks = (out.match(/^ok {2}/gm) || []).length;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${s.name.padEnd(16)} ${String(checks).padStart(3)} checks  (${((Date.now() - started) / 1000).toFixed(0)}s)`);
  if (!ok) {
    const lines = out.split('\n').filter((l) => /^FAIL|CRASH|Error|Timed out/.test(l)).slice(0, 12);
    console.log(lines.length ? lines.map((l) => '      ' + l.slice(0, 400)).join('\n') : '      ' + (r.error ? String(r.error) : out.trim().split('\n').slice(-6).join('\n      ')));
  }
}
console.log(failed ? `\n${failed} live script(s) failed` : `\nall ${chosen.length - skipped} live scripts passed${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(failed ? 1 : 0);
