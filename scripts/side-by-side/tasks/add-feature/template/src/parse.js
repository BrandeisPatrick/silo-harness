/** Parses simple CSV text (no quoted fields): { header: string[], rows: string[][] }. Blank lines are skipped. */
function parseCsv(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) throw new Error('empty file');
  const header = lines[0].split(',').map((s) => s.trim());
  const rows = lines.slice(1).map((l) => l.split(',').map((s) => s.trim()));
  for (const [i, r] of rows.entries()) {
    if (r.length !== header.length) throw new Error(`row ${i + 2} has ${r.length} fields, the header has ${header.length}`);
  }
  return { header, rows };
}

module.exports = { parseCsv };
