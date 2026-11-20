// What a shell command did, read from its text: whether it runs tests, writes files, only reads files, or starts with
// `cd <path> &&`. A rough reading, good enough to count how often a model reaches for the shell where a file tool
// exists; it never runs anything.

/** A command that runs tests. */
const TEST_RUN = /\bnode\s+(?:[^|;&\n]*\s)?--test\b|\bnode\s+[^|;&\n]*\.test\.[cm]?js\b|\bnpm\s+(?:run\s+)?t(?:est)?\b|\bnpx\s+(?:jest|vitest|mocha)\b|\b(?:jest|vitest|mocha|pytest)\b/;
const looksLikeTestRun = (cmd) => TEST_RUN.test(String(cmd || ''));

/** Commands that only read files (sed only without -i; find only without -delete or -exec). */
const READERS = new Set(['cat', 'head', 'tail', 'sed', 'ls', 'find', 'grep', 'egrep', 'rg', 'wc', 'nl', 'tree', 'stat', 'file', 'less', 'more']);
/** Words that neither read nor write: loop syntax, separators people print, moving about. */
const NEUTRAL = new Set(['cd', 'echo', 'printf', 'for', 'while', 'done', 'do', 'then', 'fi', 'if', 'true', ':', 'pwd', 'sort', 'uniq', 'cut', 'xargs', 'tr', 'test', '[']);

/** The command without heredoc bodies (the line that opens one stays), and how many there were. */
function stripHeredocs(cmd) {
  const lines = String(cmd || '').split('\n');
  const out = [];
  let heredocs = 0;
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const tags = [...lines[i].matchAll(/<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/g)].map((m) => m[2]);
    for (const tag of tags) {
      heredocs++;
      while (i + 1 < lines.length && lines[i + 1].trim() !== tag) i++;
      i++; // the closing tag
    }
  }
  return { text: out.join('\n'), heredocs };
}

/** Quoted strings become a placeholder, so a `>` or `;` inside them (node -e "…=>…") is not read as shell. */
const unquote = (s) => s.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, 'Q');

/** The simple commands of a line of shell, in order (split on && || ; | and newlines), leading keywords dropped. */
function segments(text) {
  return unquote(text)
    .split(/&&|\|\||;|\||\n/)
    .map((s) => s.trim().replace(/^[({]\s*/, '').replace(/^(?:do|then|else)\s+/, '').replace(/^(?:\w+=\S*\s+)+/, ''))
    .filter(Boolean);
}

/** Whether one simple command writes a file. */
function segmentWrites(seg) {
  // Redirection to a file: > or >> not part of 2>&1, >&2, and not to /dev/null
  // (a quoted file name shows as Q, and counts)
  for (const m of seg.matchAll(/(?:^|[^<>&=\d-])\d?(>>?)\s*(?!&)([^\s;&|)]+)/g)) if (m[2] !== '/dev/null') return true;
  const word = seg.split(/\s+/)[0];
  if (word === 'tee' && !/^tee\s+(?:-a\s+)?\/dev\/null\b/.test(seg)) return /^tee\s+\S/.test(seg);
  if (word === 'sed' && /\s-[a-zA-Z]*i/.test(seg)) return true;
  if (word === 'perl' && /\s-[a-zA-Z]*i/.test(seg)) return true;
  if (word === 'cp' || word === 'mv') return true;
  return false;
}

function segmentReads(seg) {
  const word = seg.split(/\s+/)[0];
  if (!READERS.has(word)) return false;
  if (word === 'sed' && /\s-[a-zA-Z]*i/.test(seg)) return false;
  if (word === 'find' && /\s-(?:delete|exec|execdir|ok)\b/.test(seg)) return false;
  return true;
}

/**
 * { testRun, writes, testAfterWrite, readOnly, cdPrefixed } for one shell command. testAfterWrite: a test run comes
 * after the last write in the same command (cat > a.js <<EOF … EOF && npm test).
 */
function analyse(cmd) {
  const raw = String(cmd || '');
  const { text } = stripHeredocs(raw);
  const segs = segments(text);
  let lastWrite = -1;
  let lastTest = -1;
  let reads = 0;
  let other = 0;
  segs.forEach((s, i) => {
    const w = segmentWrites(s);
    const t = looksLikeTestRun(s);
    if (w) lastWrite = i;
    if (t) lastTest = i;
    if (segmentReads(s) && !w) reads++;
    else if (!w && !t && !NEUTRAL.has(s.split(/\s+/)[0])) other++;
  });
  // A heredoc that feeds a file: cat > f <<EOF, cat <<EOF > f, tee f <<EOF (already a redirection or tee above)
  return {
    testRun: lastTest >= 0,
    writes: lastWrite >= 0,
    testAfterWrite: lastWrite >= 0 && lastTest > lastWrite,
    readOnly: lastWrite < 0 && lastTest < 0 && reads > 0 && other === 0,
    cdPrefixed: /^\s*cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)/.test(raw),
  };
}

module.exports = { analyse, looksLikeTestRun, stripHeredocs, segments };
