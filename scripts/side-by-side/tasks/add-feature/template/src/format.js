/** The summary as lines of text for a terminal. */
function formatText(summary) {
  const lines = [`${summary.rows} rows, ${summary.columns.length} columns`];
  for (const c of summary.columns) {
    if (c.type === 'number') lines.push(`  ${c.name}: min ${c.min}, max ${c.max}, mean ${c.mean}`);
    else lines.push(`  ${c.name}: ${c.distinct} distinct values`);
  }
  return lines.join('\n');
}

module.exports = { formatText };
