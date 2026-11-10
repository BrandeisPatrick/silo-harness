// Writes the GitHub release notes for a version from CHANGELOG.md (see docs/releasing.md).
//
//   npm run dist                                   (the DMG and zip must be in release/)
//   node scripts/release-notes.js <version> [out]  default: prints the notes
//
// The notes are the "## <version> — <date>" section of the changelog (its format is in docs/releasing.md) with four
// changes: links to files in the repository point at the current commit, and its images are served from that commit,
// so both work in a draft before the tag exists; a release with Highlights and no image of its own gets the README's
// hero screenshot under its summary line; an Install section gives the size and SHA-256 of both downloads; and a Full
// changelog line links the comparison with the version before. The "Not notarized" line under Known issues is left
// out because Install says it.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const [version, out] = process.argv.slice(2);
if (!version) {
  console.error('usage: node scripts/release-notes.js <version> [out-file]');
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const slug = String(pkg.repository?.url ?? pkg.repository ?? '')
  .replace(/^github:/, '')
  .replace(/^(?:git\+)?https:\/\/github\.com\//, '')
  .replace(/\.git$/, '');
if (!/^[\w.-]+\/[\w.-]+$/.test(slug)) throw new Error('package.json has no GitHub repository');
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();

const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
const headingRe = new RegExp(`^## ${version.replace(/\./g, '\\.')}(?: — \\d{4}-\\d{2}-\\d{2})?\\n`, 'm');
const found = headingRe.exec(changelog);
if (!found) throw new Error(`CHANGELOG.md has no "## ${version}" section`);
const start = found.index;
const next = changelog.indexOf('\n## ', start + found[0].length);
let body = changelog.slice(start + found[0].length, next < 0 ? undefined : next).trim();
// The version before, for the Full changelog link: the next "## x.y.z" heading down the file
const prev = next < 0 ? null : /^## (\d+\.\d+\.\d+)/.exec(changelog.slice(next + 1))?.[1] ?? null;

// The section's own images (a figure under a highlight), served raw from the commit. They must be committed: a file
// that is only in the working tree would show here and be missing on the release page.
const raw = `https://raw.githubusercontent.com/${slug}/${sha}/`;
let ownImages = 0;
body = body.replace(/!\[([^\]]*)\]\((?!https?:)([^)\s]+)\)/g, (_, alt, rel) => {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}:${rel}`], { cwd: root, stdio: 'ignore' });
  } catch {
    throw new Error(`the notes show an image that is not in the commit: ${rel}`);
  }
  if (!alt.trim()) throw new Error(`the image ${rel} needs alt text saying what it shows`);
  ownImages++;
  return `![${alt}](${raw}${rel})`;
});

// Links to files in the repository, pinned to the commit
const blob = `https://github.com/${slug}/blob/${sha}/`;
body = body.replace(/\]\((?!https?:|#)([^)\s]+)\)/g, (_, rel) => `](${blob}${rel})`);
for (const [, url] of body.matchAll(/\]\((https:\/\/github\.com\/[^)]+)\)/g)) {
  if (!url.startsWith(blob)) continue;
  const rel = url.slice(blob.length).replace(/#.*$/, '');
  if (!fs.existsSync(path.join(root, rel))) throw new Error(`the notes link to a file that is not there: ${rel}`);
}

body = body.replace(/\n- Not notarized:[^\n]*/, '');

// A release with Highlights (a minor one) and no image of its own shows the screenshot under its summary line; a
// fixes-only one shows none
if (/^### Highlights$/m.test(body) && !ownImages) {
  const hero = 'docs/screenshots/hero.png';
  if (!fs.existsSync(path.join(root, hero))) throw new Error(`missing ${hero}`);
  const firstBreak = body.indexOf('\n\n');
  const image = `![${pkg.build?.productName ?? 'Silo Harness'}](${raw}${hero})`;
  body = firstBreak < 0 ? `${body}\n\n${image}` : `${body.slice(0, firstBreak)}\n\n${image}${body.slice(firstBreak)}`;
}

// Downloads
const files = [`Silo-Harness-${version}-arm64.dmg`, `Silo-Harness-${version}-arm64.zip`];
const rows = files.map((name) => {
  const file = path.join(root, 'release', name);
  if (!fs.existsSync(file)) throw new Error(`release/${name} is missing: run npm run dist first`);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  return `| \`${name}\` | ${(fs.statSync(file).size / 1e6).toFixed(0)} MB | \`${hash}\` |`;
});
const install = [
  '### Install',
  '',
  `For Apple silicon Macs. Download \`${files[0]}\` below, open it and drag Silo Harness into Applications; the \`.zip\` holds the same app.`,
  '',
  'The app is not notarized: on first launch, open it once, then allow it in System Settings → Privacy & Security → Open Anyway.',
  '',
  '| File | Size | SHA-256 |',
  '| --- | --- | --- |',
  ...rows,
].join('\n');

const full = prev ? `\n\n**Full changelog:** https://github.com/${slug}/compare/v${prev}...v${version}` : '';
const notes = `${body}\n\n${install}${full}\n`;
if (out) fs.writeFileSync(out, notes);
else process.stdout.write(notes);
