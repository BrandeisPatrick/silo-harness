// Skills: the frontmatter reader, the checks, where skills are read from, /name arguments, the skill tool and the
// model's list. Temp folders only: user folders come from an injected home. Run: node test/skills.js
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { parseFrontmatter } = require(path.join(projectDir, 'dist/main/frontmatter.js'));
const S = require(path.join(projectDir, 'dist/main/skills.js'));
const { skillTool, skillToolResult } = require(path.join(projectDir, 'dist/main/tools/skill.js'));
const { check, done } = require('./support/check.js');

// Never the real config folder
delete process.env.SILO_HARNESS_CONFIG_DIR;
delete process.env.OPEN_HARNESS_CONFIG_DIR;
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-skills-')));
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- Frontmatter ----------
const fmCases = [
  ['plain key/values', '---\nname: a\ndescription: Does x. Use when y.\n---\nbody', { name: 'a', description: 'Does x. Use when y.' }, 'body'],
  ['double quotes with a colon and escapes', '---\ndescription: "Say: \\"hi\\"\\n"\n---\n', { description: 'Say: "hi"\n' }],
  ["single quotes with ''", "---\ndescription: 'it''s: fine'\n---\n", { description: "it's: fine" }],
  ['folded > block', '---\ndescription: >\n  one\n  two\n\n  three\nname: x\n---\n', { description: 'one two\nthree\n', name: 'x' }],
  ['literal | block, strip', '---\ndescription: |-\n  one\n    two\n  three\n---\n', { description: 'one\n  two\nthree' }],
  ['plain value over indented lines', '---\ndescription: starts here\n  and goes on\n---\n', { description: 'starts here and goes on' }],
  ['booleans, numbers, null', '---\na: true\nb: False\nc: 12\nd: ~\ne: yes\n---\n', { a: true, b: false, c: 12, d: null, e: 'yes' }],
  ['inline list and - list', '---\nt: [a, "b, c"]\nu:\n  - x\n  - y\n---\n', { t: ['a', 'b, c'], u: ['x', 'y'] }],
  ['nested map', '---\nmetadata:\n  version: 1.0\n  author: me\n---\n', { metadata: { version: 1, author: 'me' } }],
  ['comments', '---\n# top\nname: a # trailing\nurl: http://x#y\n---\n', { name: 'a', url: 'http://x#y' }],
  ['CRLF and BOM', '\uFEFF---\r\nname: a\r\ndescription: b\r\n---\r\nbody\r\n', { name: 'a', description: 'b' }, 'body\n'],
  ['quoted value over two lines', '---\ndescription: "one\n  two"\n---\n', { description: 'one two' }],
];
for (const [label, src, data, body] of fmCases) {
  const r = parseFrontmatter(src);
  check(`frontmatter: ${label}`, r.present && !r.error && eq(r.data, data) && (body === undefined || r.body === body), JSON.stringify(r));
}
const junk = parseFrontmatter('---\nname: a\nthis is not yaml\ndescription: b\n---\nx');
check('frontmatter: junk line reported with its file line, the rest still read', junk.error && junk.error.line === 3 && junk.data.description === 'b', JSON.stringify(junk));
const open = parseFrontmatter('---\nname: a\nno end');
check('frontmatter: no closing --- is an error', open.error && open.present);
check('frontmatter: none', !parseFrontmatter('# Title\ntext').present);
let threw = false;
try {
  for (const s of ['---\n:\n---', '---\n"\n---', '---\na: "x\n---', '---\na: [x\n---', '---\n\ta: 1\n---', null, '---\n---']) parseFrontmatter(s);
} catch {
  threw = true;
}
check('frontmatter: bad input never throws', !threw);

// ---------- Checks ----------
const P = (raw, dir = 'my-skill') => S.parseSkill(raw, dir, `/x/${dir}/SKILL.md`, 'project');
const ok = P('---\nname: my-skill\ndescription: Does it. Use when asked.\n---\nStep 1.');
check('a valid skill has no problems', ok.problems.length === 0 && ok.userInvocable && ok.modelInvocable && ok.name === 'my-skill', ok.problems);
const bad = P('---\nname: My Skill\n---\nx');
check('bad name reported, folder name used', bad.problems.includes('name "My Skill" must be lower-case letters, digits and hyphens') && bad.name === 'my-skill', bad.problems);
check('missing description reported', bad.problems.includes('no description'));
const mism = P('---\nname: other\ndescription: d\n---\nx');
check('name does not match folder', mism.problems.includes('name does not match folder "my-skill"') && mism.name === 'other', mism.problems);
const long = P(`---\ndescription: ${'x'.repeat(1100)}\n---\nx`);
check('long description reported', long.problems.includes('description is longer than 1,024 characters'));
check('long name reported', P(`---\nname: ${'a'.repeat(70)}\ndescription: d\n---\nx`).problems.includes('name is longer than 64 characters'));
check('unreadable frontmatter reported by line', P('---\ndescription: d\n???\n---\nx').problems.includes('frontmatter could not be read (line 3)'));
check('no frontmatter reported', P('Just text').problems[0] === 'no frontmatter (a --- block at the top)');
check('empty body reported', P('---\ndescription: d\n---\n').problems.includes('no instructions after the frontmatter'));
check('folder name breaking the rule reported', S.parseSkill('---\ndescription: d\n---\nx', 'My_Skill', '/x/My_Skill/SKILL.md', 'user').problems.includes('folder name "My_Skill" must be lower-case letters, digits and hyphens'));
const flags = P('---\ndescription: d\nargument-hint: [file]\ndisable-model-invocation: true\nuser-invocable: false\nallowed-tools: Read, Grep\nlicense: MIT\n---\nx');
check('flags and argument-hint read; unknown keys ignored', flags.problems.length === 0 && !flags.modelInvocable && !flags.userInvocable && flags.argumentHint === '[file]', flags);
check('a non-boolean flag reported', P('---\ndescription: d\nuser-invocable: "no"\n---\nx').problems.includes('user-invocable must be true or false'));
const folded = P('---\nname: my-skill\ndescription: >\n  Reviews code.\n  Use when asked.\n---\nx');
check('folded description read whole', folded.description === 'Reviews code. Use when asked.' && !folded.problems.length, folded);

// ---------- Discovery ----------
const home = path.join(tmp, 'home');
const repo = path.join(tmp, 'repo');
const cwd = path.join(repo, 'packages', 'web');
fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
fs.mkdirSync(cwd, { recursive: true });
const skill = (base, name, desc, extra = '') => write(path.join(base, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n${extra}---\nBody of ${name} from ${desc}.`);
skill(path.join(repo, '.claude/skills'), 'shared', 'root claude');
skill(path.join(repo, '.agents/skills'), 'shared', 'root agents');
skill(path.join(repo, '.claude/skills'), 'root-only', 'root claude');
skill(path.join(cwd, '.claude/skills'), 'shared', 'nearest claude');
skill(path.join(cwd, '.silo-harness/skills'), 'mine', 'nearest silo');
skill(path.join(cwd, '.claude/skills'), 'mine', 'nearest claude');
skill(path.join(home, '.claude/skills'), 'root-only', 'user claude');
skill(path.join(home, '.claude/skills'), 'user-claude', 'user claude');
skill(path.join(home, '.agents/skills'), 'user-agents', 'user agents');
skill(path.join(home, '.silo-harness/skills'), 'user-agents', 'user silo');
skill(path.join(tmp, '.claude/skills'), 'above-root', 'above the git root');
skill(path.join(repo, 'packages', 'api', '.claude/skills'), 'sibling', 'sibling folder');
write(path.join(repo, '.claude/commands/deploy.md'), '---\ndescription: Deploy it\nargument-hint: <env>\n---\nDeploy to $1.');
write(path.join(repo, '.claude/commands/git/sync.md'), '# Sync the branch\nRun git pull.');
write(path.join(home, '.claude/commands/mine.md'), 'Do mine: $ARGUMENTS');
const appRoot = path.join(tmp, 'app');
skill(path.join(appRoot, 'skills'), 'review', 'bundled');
skill(path.join(appRoot, 'skills'), 'user-claude', 'bundled');

const list = S.loadSkills(cwd, appRoot, { home });
const by = (n) => list.find((s) => s.name === n);
check('nearest folder wins over the git root', by('shared').description === 'nearest claude', by('shared'));
check('.silo-harness wins over .claude in the same folder', by('mine').description === 'nearest silo');
check('the git root is read', by('root-only') && by('root-only').source === 'project' && by('root-only').description === 'root claude');
check('nothing above the git root or in sibling folders', !by('above-root') && !by('sibling'));
check('user ~/.claude/skills and ~/.agents/skills read', by('user-claude').source === 'user' && by('user-claude').description === 'user claude');
check('~/.silo-harness wins over ~/.agents', by('user-agents').description === 'user silo');
check('bundled read last', by('review').source === 'bundled');
check('dir is the absolute skill folder', by('mine').dir === path.join(cwd, '.silo-harness/skills/mine'));
const deploy = by('deploy');
check('.claude/commands file read as a user-only command', deploy && deploy.kind === 'command' && !deploy.modelInvocable && deploy.argumentHint === '<env>' && deploy.description === 'Deploy it', deploy);
check('nested command named ns:name, first line as description', by('git:sync') && by('git:sync').description === 'Sync the branch');
check('user command read', by('mine') && list.some((s) => s.name === 'mine') && by('mine').kind === 'skill' && S.loadSkills(cwd, appRoot, { home }).some((s) => s.name === 'mine'));
check('~/.claude/commands read', list.some((s) => s.name === 'mine') && S.loadSkills(path.join(tmp, 'elsewhere'), '', { home }).some((s) => s.name === 'mine' && s.kind === 'command'));

const loose = path.join(tmp, 'loose', 'sub');
fs.mkdirSync(loose, { recursive: true });
skill(path.join(tmp, 'loose', '.claude/skills'), 'parent', 'parent of a folder with no git');
skill(path.join(loose, '.claude/skills'), 'here', 'here');
const looseList = S.loadSkills(loose, '', { home });
check('no git root: the session folder only', looseList.some((s) => s.name === 'here') && !looseList.some((s) => s.name === 'parent'));

// ---------- /name arguments ----------
const mk = (body, extra = {}) => ({ name: 'fix', description: 'd', body, dir: '/sk/fix', path: '/sk/fix/SKILL.md', source: 'project', argumentHint: '', userInvocable: true, modelInvocable: true, problems: [], kind: 'skill', ...extra });
const ex = (text, body, extra) => S.expandSlashCommand(text, [mk(body, extra)]).content;
check('$ARGUMENTS', ex('/fix a b', 'Fix $ARGUMENTS now.').endsWith('<skill name="fix">\nFix a b now.\n</skill>'));
check('$ARGUMENTS[n] from 0', ex('/fix "two words" b', 'First [$ARGUMENTS[0]] second [$ARGUMENTS[1]] none [$ARGUMENTS[5]]').includes('First [two words] second [b] none []'));
check('$1 $2 from 1', ex('/fix x y', 'A=$1 B=$2 C=$3.').includes('A=x B=y C=.'));
check('no placeholder: ARGUMENTS appended', ex('/fix x y', 'Do it.').includes('Do it.\n\nARGUMENTS: x y\n</skill>'));
check('no placeholder, no arguments: nothing appended', !ex('/fix', 'Do it.').includes('ARGUMENTS'));
check('${SKILL_DIR} and ${CLAUDE_SKILL_DIR}', ex('/fix', 'Run ${SKILL_DIR}/a.sh and ${CLAUDE_SKILL_DIR}/b.sh').includes('Run /sk/fix/a.sh and /sk/fix/b.sh'));
check('case-insensitive lookup, user line kept', ex('/FIX now', 'x').startsWith('/FIX now\n\n<skill name="fix">'));
check('user-invocable: false is not expanded', ex('/fix', 'x', { userInvocable: false }) === '/fix');
check('ns:name commands expand', S.expandSlashCommand('/git:sync', list).content.includes('Run git pull.'));
check('unknown name left as typed', S.expandSlashCommand('/nope x', list).content === '/nope x');

// ---------- The skill tool ----------
(async () => {
  write(path.join(cwd, '.silo-harness/skills/mine/reference.md'), 'ref');
  write(path.join(cwd, '.silo-harness/skills/mine/scripts/run.sh'), 'echo');
  const ctx = { cwd, skills: S.loadSkills(cwd, appRoot, { home }) };
  const res = await skillTool.run({ name: 'mine' }, ctx);
  check('tool result: body, base directory, relative-path note, files', res.content.includes('Body of mine') && res.content.includes(`Base directory: ${path.join(cwd, '.silo-harness/skills/mine')}`) && /relative to that folder/.test(res.content) && res.content.includes('Files: reference.md, scripts/run.sh'), res.content);
  check('tool result: no problems section for a clean skill', !/Problems with this skill/.test(res.content));
  for (let i = 0; i < 25; i++) write(path.join(cwd, `.silo-harness/skills/mine/f${String(i).padStart(2, '0')}.md`), 'x');
  const many = skillToolResult(S.loadSkills(cwd, appRoot, { home }).find((s) => s.name === 'mine'));
  check('tool result: at most 20 files, with a count of the rest', /\(and 7 more\)/.test(many) && (many.match(/Files: (.*)/)[1].split(', ').length === 20), many);
  // Written during the session: found by the re-scan, problems listed
  write(path.join(cwd, '.silo-harness/skills/fresh/SKILL.md'), '---\nname: Fresh\n---\nNew steps.');
  const fresh = await skillTool.run({ name: 'fresh' }, ctx);
  check('re-scan on a miss finds a skill written mid-session', fresh.content.includes('New steps.') && ctx.skills.some((s) => s.name === 'fresh'));
  check('…and lists its problems', fresh.content.includes('- name "Fresh" must be lower-case letters, digits and hyphens') && fresh.content.includes('- no description'), fresh.content);
  let err = '';
  try {
    await skillTool.run({ name: 'missing-one' }, ctx);
  } catch (e) {
    err = e.message;
  }
  check('unknown after a re-scan still fails', /Unknown skill "missing-one"/.test(err));
  err = '';
  try {
    await skillTool.run({ name: 'deploy' }, ctx);
  } catch (e) {
    err = e.message;
  }
  check('a user-only skill is refused, with its problems state', /run by the user only, with \/deploy\. It has no problems\./.test(err), err);

  // ---------- The model's list ----------
  const L = [mk('b', { name: 'aaa', description: 'short' }), mk('b', { name: 'bbb', description: 'y'.repeat(2000) }), mk('b', { name: 'hidden', description: 'h', modelInvocable: false }), mk('b', { name: 'nodesc', description: '' })];
  const full = S.skillsPrompt(L, 100000);
  check('list wrapped in <available_skills>, one line per skill', /<available_skills>\naaa: short\nbbb: y+…\n<\/available_skills>$/.test(full), full);
  check('description cut at 1,024', full.split('\n').find((l) => l.startsWith('bbb')).length <= 'bbb: '.length + 1024 + 1);
  check('disable-model-invocation and no-description skills left out', !full.includes('hidden') && !full.includes('nodesc'));
  const small = S.skillsPrompt(L, 300);
  check('budget: longest cut first, short one kept, total within budget', small.length <= 300 && small.includes('aaa: short') && /bbb: y+…/.test(small), small);
  const tiny = S.skillsPrompt(L, 10);
  check('budget too small: names kept', tiny.includes('\naaa\nbbb\n'), tiny);
  check('empty list: empty string', S.skillsPrompt([], 1000) === '');
  check('budget helper ~2% of the window', S.skillListBudget(200000) === 16000);

  // ---------- Bundled skills ----------
  const bundled = S.loadSkills(path.join(tmp, 'empty-cwd'), projectDir, { home: path.join(tmp, 'empty-home') }).filter((s) => s.source === 'bundled');
  check('bundled skills found', bundled.length >= 5 && bundled.some((s) => s.name === 'create-skill') && bundled.some((s) => s.name === 'create-mod'), bundled.map((s) => s.name));
  for (const s of bundled) check(`bundled skill ${s.name} has no problems`, s.problems.length === 0 && s.description.length > 40 && /\buse when\b/i.test(s.description), s.problems);
  const cs = bundled.find((s) => s.name === 'create-skill');
  check('create-skill is under ~120 lines and names its supporting file', cs && cs.body.split('\n').length < 120 && fs.existsSync(path.join(cs.dir, 'format.md')));
  done();
})();
