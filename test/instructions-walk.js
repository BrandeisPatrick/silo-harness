// Project instructions across folders: the walk from the git root, duplicates, @imports, the budget and refused
// imports. Temp folders only. Run: node test/instructions-walk.js
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { loadInstructions, gitRoot } = require(path.join(projectDir, 'dist/main/instructions.js'));
const { check, done } = require('./support/check.js');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-instr-walk-')));
const home = path.join(tmp, 'home');
const conf = path.join(home, '.silo-harness');
fs.mkdirSync(conf, { recursive: true });
const opts = { home, configDir: conf };
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

const repo = path.join(tmp, 'repo');
const web = path.join(repo, 'packages', 'web');
fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
write(path.join(repo, 'AGENTS.md'), 'Root agents rules.');
write(path.join(repo, 'CLAUDE.md'), 'Root claude rules. See @docs/style.md.');
write(path.join(repo, 'docs', 'style.md'), 'Use tabs. Also @nested/one.md');
write(path.join(repo, 'docs', 'nested', 'one.md'), 'Depth two.');
write(path.join(repo, '.claude', 'CLAUDE.md'), 'Dot-claude rules.');
write(path.join(repo, 'packages', 'AGENTS.md'), 'Packages rules.');
write(path.join(web, 'CLAUDE.local.md'), 'My local web notes.');
write(path.join(web, 'SILOHARNESS.md'), 'Web harness rules.');
write(path.join(web, 'OPENHARNESS.md'), 'Old-name web rules.');
write(path.join(tmp, 'AGENTS.md'), 'Above the git root.');
write(path.join(repo, 'packages', 'api', 'AGENTS.md'), 'Sibling folder.');

check('git root found from a nested folder', gitRoot(web, home) === repo);
let files = loadInstructions(web, opts);
const labels = files.map((f) => f.label);
check('root to session folder, outermost first, each name in a folder', JSON.stringify(labels) === JSON.stringify(['AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md', 'packages/AGENTS.md', 'packages/web/CLAUDE.local.md', 'packages/web/SILOHARNESS.md']), labels);
check('nothing above the git root, nothing from sibling folders', !files.some((f) => /Above the git root|Sibling folder/.test(f.text)));
check('only the first of the app\'s own names in a folder', !files.some((f) => /Old-name/.test(f.text)));
const claude = files.find((f) => f.label === 'CLAUDE.md');
check('@imports expanded, nested, relative to the importing file', claude.text.includes('See Use tabs. Also Depth two..'), claude.text);

// Duplicates: a symlink and an identical copy are read once
const dup = path.join(tmp, 'dup');
fs.mkdirSync(path.join(dup, '.git'), { recursive: true });
write(path.join(dup, 'AGENTS.md'), 'Same rules.');
fs.symlinkSync(path.join(dup, 'AGENTS.md'), path.join(dup, 'CLAUDE.md'));
write(path.join(dup, 'CLAUDE.local.md'), 'Same rules.\n');
files = loadInstructions(dup, opts);
check('symlink and identical copy read once', files.length === 1 && files[0].label === 'AGENTS.md', files.map((f) => f.label));
// CLAUDE.md that only imports AGENTS.md (already read) leaves the import as text instead of repeating it
write(path.join(dup, 'CLAUDE.local.md'), 'Local: @AGENTS.md');
files = loadInstructions(dup, opts);
check('an import of a file already read is not repeated', files.find((f) => f.label === 'CLAUDE.local.md').text === 'Local: @AGENTS.md');

// Cycles, depth, code and refusals
const imp = path.join(tmp, 'imp');
fs.mkdirSync(path.join(imp, '.git'), { recursive: true });
write(path.join(imp, 'a.md'), 'A then @b.md');
write(path.join(imp, 'b.md'), 'B then @a.md');
write(path.join(imp, 'd1.md'), '1 @d2.md');
write(path.join(imp, 'd2.md'), '2 @d3.md');
write(path.join(imp, 'd3.md'), '3 @d4.md');
write(path.join(imp, 'd4.md'), '4 @d5.md');
write(path.join(imp, 'd5.md'), '5');
write(path.join(imp, '.env'), 'SECRET=1');
write(path.join(imp, 'key.pem'), 'PEM');
write(path.join(imp, 'code.js'), 'js');
write(path.join(imp, 'notes'), 'extensionless notes');
write(path.join(imp, '.npmrc'), '//registry.npmjs.org/:_authToken=abc');
write(path.join(imp, '.git', 'config'), '[remote] url = https://user:token@example.com/x.git');
write(path.join(imp, '.cursorrules'), 'cursor rules');
write(path.join(imp, '.aws', 'credentials.txt'), 'aws');
write(path.join(tmp, 'outside.md'), 'outside the project');
write(path.join(home, '.claude', 'shared.md'), 'from ~/.claude');
write(path.join(home, 'Documents', 'private.md'), 'private');
write(
  path.join(imp, 'AGENTS.md'),
  [
    'Cycle: @a.md',
    'Depth: @d1.md',
    '```',
    '@a.md in a fence',
    '```',
    'Inline `@a.md` code.',
    'Secret: @.env and @key.pem',
    'Code: @code.js',
    'Plain: @notes',
    'Dot: @.npmrc and @.git/config and @.aws/credentials.txt',
    'Rules: @.cursorrules',
    'Outside: @../outside.md',
    'Home: @~/.claude/shared.md and @~/Documents/private.md',
    'Missing: @nope.md',
    'Mail: me@example.com',
  ].join('\n'),
);
const t = loadInstructions(imp, opts)[0].text;
const line = (p) => t.split('\n').find((l) => l.startsWith(p));
check('a cycle stops: A then B then the literal import', line('Cycle:') === 'Cycle: A then B then @a.md', line('Cycle:'));
check('imports nest at most 4 deep', line('Depth:') === 'Depth: 1 2 3 4 @d5.md', line('Depth:'));
check('no import inside a code fence', t.includes('```\n@a.md in a fence\n```'));
check('no import inside inline code', line('Inline') === 'Inline `@a.md` code.');
check('secret-looking files refused', line('Secret:') === 'Secret: @.env and @key.pem');
check('non-text extension refused, extension-less read', line('Code:') === 'Code: @code.js' && line('Plain:') === 'Plain: extensionless notes');
check('dotfiles, .git and secret folders refused', line('Dot:') === 'Dot: @.npmrc and @.git/config and @.aws/credentials.txt', line('Dot:'));
check('another tool\'s rule file is read', line('Rules:') === 'Rules: cursor rules', line('Rules:'));
check('outside the project refused', line('Outside:') === 'Outside: @../outside.md');
check('~/.claude allowed, other home folders refused', line('Home:') === 'Home: from ~/.claude and @~/Documents/private.md', line('Home:'));
check('missing import left as text; emails untouched', line('Missing:') === 'Missing: @nope.md' && line('Mail:') === 'Mail: me@example.com');

// No git root: the session folder only
const loose = path.join(tmp, 'loose', 'sub');
write(path.join(tmp, 'loose', 'AGENTS.md'), 'parent');
write(path.join(loose, 'AGENTS.md'), 'here');
files = loadInstructions(loose, opts);
check('no git root: session folder only', files.length === 1 && files[0].text === 'here');

// Never above home: a session under home whose parents up to home have no .git
const inHome = path.join(home, 'work', 'proj');
write(path.join(inHome, 'AGENTS.md'), 'in home');
fs.mkdirSync(path.join(tmp, 'home-git'), { recursive: true });
check('the walk under home stops below home', gitRoot(inHome, home) === null);

// The user file and the budget: outermost project files are cut first, the user file last
write(path.join(conf, 'SILOHARNESS.md'), 'User rules.');
const bud = path.join(tmp, 'bud');
const inner = path.join(bud, 'a', 'b');
fs.mkdirSync(path.join(bud, '.git'), { recursive: true });
write(path.join(bud, 'AGENTS.md'), 'R'.repeat(5000));
write(path.join(bud, 'a', 'AGENTS.md'), 'M'.repeat(5000));
write(path.join(inner, 'AGENTS.md'), 'N'.repeat(5000));
files = loadInstructions(inner, { ...opts, budget: 8000 });
const get = (l) => files.find((f) => f.label === l);
check('the user file comes first', files[0].label.endsWith('SILOHARNESS.md') && files[0].text === 'User rules.');
check('budget: outermost dropped, the next one cut, nearest whole', !get('AGENTS.md') && get('a/AGENTS.md').truncated && /cut to fit/.test(get('a/AGENTS.md').text) && get('a/b/AGENTS.md').text === 'N'.repeat(5000), files.map((f) => [f.label, f.text.length]));
check('budget: one line names what was left out', files.some((f) => f.text.includes('[Left out to fit the 8 KiB instructions budget: AGENTS.md]')));
const total = files.reduce((n, f) => n + f.text.length, 0);
check('budget: the total stays near the budget', total <= 8000 + 120, total);
done();
