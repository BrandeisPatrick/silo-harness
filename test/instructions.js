// Project instructions: loading order, truncation and the "#" shortcut's append. Run: node test/instructions.js
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { loadInstructions, instructionsPrompt, appendInstruction } = require(path.join(projectDir, 'dist/main/instructions.js'));
const { check, done } = require('./support/check.js');
// Never the real config folder
process.env.SILO_HARNESS_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-instr-noconf-'));

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-instr-'));
const read = (name) => fs.readFileSync(path.join(cwd, name), 'utf8');

let r = appendInstruction(cwd, '  always run   npm test  ');
check('append creates SILOHARNESS.md with a header and the bullet', r.label === 'SILOHARNESS.md' && read('SILOHARNESS.md') === '# Project instructions\n\nNotes for the agent working in this project.\n- always run npm test\n', read('SILOHARNESS.md'));
r = appendInstruction(cwd, 'prefer small commits');
check('append adds to the existing file', read('SILOHARNESS.md').endsWith('- always run npm test\n- prefer small commits\n') && r.path === path.join(cwd, 'SILOHARNESS.md'));
let threw = false;
try { appendInstruction(cwd, '   '); } catch (e) { threw = /Nothing to add/.test(e.message); }
check('empty text rejected', threw);

const cwd2 = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-instr2-'));
fs.writeFileSync(path.join(cwd2, 'AGENTS.md'), '# Rules\nBe brief');
r = appendInstruction(cwd2, 'use tabs');
check('append goes to the existing project file and adds the missing newline', r.label === 'AGENTS.md' && fs.readFileSync(path.join(cwd2, 'AGENTS.md'), 'utf8') === '# Rules\nBe brief\n- use tabs\n');
const files = loadInstructions(cwd2);
check('loader picks AGENTS.md and the prompt names it', files.some((f) => f.label === 'AGENTS.md' && /use tabs/.test(f.text)) && /Instructions from AGENTS\.md/.test(instructionsPrompt(files)));
fs.writeFileSync(path.join(cwd2, 'SILOHARNESS.md'), 'x'.repeat(40000));
const all2 = loadInstructions(cwd2);
const big = all2.find((f) => f.label === 'SILOHARNESS.md');
check('AGENTS.md and SILOHARNESS.md are both read; over the 32 KiB budget the earlier file goes first', big && big.truncated && big.text.length < 32 * 1024 + 200 && !all2.some((f) => f.label === 'AGENTS.md' && f.text) && /Left out to fit the 32 KiB instructions budget: AGENTS\.md/.test(big.text), all2.map((f) => [f.label, f.text.length]));

// Names from before the renames are still read: the app was Open Harness, OpenAgent, and OpenCoder before that.
const { loadSkills } = require(path.join(projectDir, 'dist/main/skills.js'));
const cwd3 = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-instr3-'));
fs.writeFileSync(path.join(cwd3, 'OPENAGENT.md'), 'Old name, still mine');
check('a project OPENAGENT.md is still read', loadInstructions(cwd3).some((f) => f.label === 'OPENAGENT.md' && /still mine/.test(f.text)));
r = appendInstruction(cwd3, 'keep going');
check('…and "#" appends to it instead of starting a new file', r.label === 'OPENAGENT.md' && !fs.existsSync(path.join(cwd3, 'SILOHARNESS.md')));
fs.writeFileSync(path.join(cwd3, 'OPENHARNESS.md'), 'Open Harness name');
check('a project OPENHARNESS.md wins over OPENAGENT.md', loadInstructions(cwd3).some((f) => f.label === 'OPENHARNESS.md') && !loadInstructions(cwd3).some((f) => f.label === 'OPENAGENT.md'));
r = appendInstruction(cwd3, 'still going');
check('…and "#" appends to OPENHARNESS.md', r.label === 'OPENHARNESS.md' && !fs.existsSync(path.join(cwd3, 'SILOHARNESS.md')));
fs.writeFileSync(path.join(cwd3, 'SILOHARNESS.md'), 'New name wins');
check('the new name wins when both exist', loadInstructions(cwd3).some((f) => f.label === 'SILOHARNESS.md') && !loadInstructions(cwd3).some((f) => f.label === 'OPENHARNESS.md'));
const skillFile = (dir, name) => {
  fs.mkdirSync(path.join(cwd3, dir, 'skills', name), { recursive: true });
  fs.writeFileSync(path.join(cwd3, dir, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: from ${dir}\n---\nDo it.`);
};
skillFile('.openagent', 'old-skill');
skillFile('.open-harness', 'new-skill');
skillFile('.openagent', 'both');
skillFile('.open-harness', 'both');
skillFile('.open-harness', 'three');
const skills = loadSkills(cwd3, path.join(cwd3, 'no-app-root'), { home: path.join(cwd3, 'home') });
const by = (n) => skills.find((k) => k.name === n);
check('skills in .openagent/skills are still found', by('old-skill') && by('old-skill').source === 'project' && by('new-skill'));
check('…and .open-harness/skills wins a name clash', by('both') && by('both').description === 'from .open-harness', by('both'));
skillFile('.silo-harness', 'three');
skillFile('.silo-harness', 'newest');
const skills2 = loadSkills(cwd3, path.join(cwd3, 'no-app-root'), { home: path.join(cwd3, 'home') });
const by2 = (n) => skills2.find((k) => k.name === n);
check('.silo-harness/skills is read, and wins a name clash with .open-harness', by2('newest') && by2('three').description === 'from .silo-harness', by2('three'));
check('…while .open-harness/skills is still read beside it', by2('new-skill') && by2('new-skill').source === 'project' && by2('old-skill'));

// The user-level file: SILOHARNESS.md in the config folder, OPENHARNESS.md (its name before the rename) when only that is there
const { userInstructionsFile } = require(path.join(projectDir, 'dist/main/instructions.js'));
const conf = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-instr-conf-'));
check('no user file: SILOHARNESS.md is the one to write', userInstructionsFile(conf).path === path.join(conf, 'SILOHARNESS.md'));
fs.writeFileSync(path.join(conf, 'OPENHARNESS.md'), 'old user file');
check('only OPENHARNESS.md: it is the one read', userInstructionsFile(conf).path === path.join(conf, 'OPENHARNESS.md'));
fs.writeFileSync(path.join(conf, 'SILOHARNESS.md'), 'new user file');
check('both: SILOHARNESS.md wins', userInstructionsFile(conf).path === path.join(conf, 'SILOHARNESS.md'));
process.env.SILO_HARNESS_CONFIG_DIR = conf;
const cwd4 = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-instr4-'));
check('loadInstructions reads the user file from the config folder', loadInstructions(cwd4).some((f) => f.text === 'new user file'));
fs.rmSync(path.join(conf, 'SILOHARNESS.md'));
check('…and OPENHARNESS.md there when it is the only one', loadInstructions(cwd4).some((f) => f.text === 'old user file' && /OPENHARNESS\.md$/.test(f.label)));
done();
