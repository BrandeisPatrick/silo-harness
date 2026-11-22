// The installed silo command (bin/silo.js) runs in the packaged app's own binary in Node mode, where there is no
// electron package to require: nothing it loads may need electron at load time. Here a child node process makes
// resolving electron fail the same way, loads every dist module the command loads, and runs a real subcommand
// against throwaway folders. Run: npm run build && node test/silo-command.js
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { check, done } = require('./support/check.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-silo-command-'));
const silo = path.join(projectDir, 'bin', 'silo.js');
// The dist modules the command loads: every load('…') in bin/silo.js, and providers.js for its error text
const loaded = [...new Set([...fs.readFileSync(silo, 'utf8').matchAll(/load\('([\w.-]+\.js)'\)|DIST, '([\w.-]+\.js)'\)/g)].map((m) => m[1] || m[2]))];
const NO_ELECTRON = `const M = require('node:module'); const r = M._resolveFilename; M._resolveFilename = function (req, ...a) { if (req === 'electron') throw Object.assign(new Error("Cannot find module 'electron'"), { code: 'MODULE_NOT_FOUND' }); return r.call(this, req, ...a); };`;
const env = { ...process.env, SILO_HARNESS_USER_DATA: path.join(tmp, 'data'), SILO_HARNESS_CONFIG_DIR: path.join(tmp, 'config') };
delete env.ELECTRON_RUN_AS_NODE;
const run = (code, args = []) => spawnSync(process.execPath, ['-e', `${NO_ELECTRON}\n${code}`, '--', ...args], { encoding: 'utf8', env, timeout: 60_000 });

check('bin/silo.js loads app modules', loaded.length >= 4 && loaded.includes('providers.js'), loaded);
for (const name of loaded) {
  const r = run(`require(${JSON.stringify(path.join(projectDir, 'dist', 'main', name))});`);
  check(`${name} loads without electron`, r.status === 0, (r.stderr || '').split('\n').filter((l) => /^- /.test(l)).join(' ← '));
}
const r = run(`process.argv = [process.argv[0], ${JSON.stringify(silo)}, ...process.argv.slice(1)]; require(${JSON.stringify(silo)});`, ['provider', 'list', '--json']);
let list = null;
try {
  list = JSON.parse(r.stdout);
} catch {
  /* not JSON */
}
check('silo provider list --json runs without electron', r.status === 0 && list !== null, (r.stderr || r.stdout).slice(0, 400));

// A repackaged app's bundled defaults (SILO_HARNESS_DEFAULTS): still no electron, the bundled provider is listed and in
// use, and its shipped key is dropped
const bundle = path.join(tmp, 'defaults.json');
fs.writeFileSync(bundle, JSON.stringify({ provider: 'acme', providers: { acme: { type: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1', model: 'example/model-a', models: ['example/model-a'], apiKey: 'shipped-SECRET-0123456789' } } }));
env.SILO_HARNESS_DEFAULTS = bundle;
const b = run(`process.argv = [process.argv[0], ${JSON.stringify(silo)}, ...process.argv.slice(1)]; require(${JSON.stringify(silo)});`, ['provider', 'list', '--json']);
let blist = null;
try {
  blist = JSON.parse(b.stdout);
} catch {
  /* not JSON */
}
const acme = blist?.providers?.find((p) => p.name === 'acme');
check('with a bundle: silo provider list --json runs without electron and lists the bundled provider in use', b.status === 0 && blist?.active === 'acme' && acme?.model === 'example/model-a', (b.stderr || b.stdout).slice(0, 400));
check("… without the bundle's key", acme?.key === 'none' && !b.stdout.includes('shipped-SECRET'), acme);
check('… and writes nothing', !fs.existsSync(path.join(tmp, 'data', 'config.json')));
fs.rmSync(tmp, { recursive: true, force: true });
done();
