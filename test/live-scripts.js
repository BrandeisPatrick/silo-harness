// test/live/run.js judges a live script by its exit status alone, so every script it lists must end with its result
// as that status: a bare done() exits 0 whatever failed, and a FAIL line printed past check() is never counted.
// Reads the scripts only; runs none. Run: node test/live-scripts.js
const fs = require('node:fs');
const path = require('node:path');
const { check, done } = require('./support/check.js');

const dir = path.join(__dirname, 'live');
const names = [...fs.readFileSync(path.join(dir, 'run.js'), 'utf8').matchAll(/\{ name: '([^']+)'/g)].map((m) => m[1]);
check('the runner lists the live scripts', names.length > 50 && names.includes('smoke') && names.includes('remote-page'), names.length);
for (const name of names) {
  const src = fs.readFileSync(path.join(dir, `${name}.js`), 'utf8');
  const exits = /\.exit\((done\(\)|failures) \? 1 : 0\)|process\.exit\(ok \? 0 : 1\)/.test(src);
  const bare = /^\s*done\(\);/m.test(src);
  const uncounted = /check\(/.test(src) && /console\.(log|error)\(`FAIL/.test(src);
  check(`${name}: its result is its exit status`, exits && !bare && !uncounted, { exits, bare, uncounted });
}
done();
