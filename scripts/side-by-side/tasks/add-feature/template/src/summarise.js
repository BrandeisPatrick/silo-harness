const { parseCsv } = require('./parse.js');

const isNumber = (s) => s !== '' && !Number.isNaN(Number(s));

/**
 * The summary of a CSV text:
 *   { rows, columns: [{ name, type: 'number', min, max, mean } | { name, type: 'text', distinct }] }
 * The mean is rounded to two decimals.
 */
function summarise(text) {
  const { header, rows } = parseCsv(text);
  const columns = header.map((name, i) => {
    const values = rows.map((r) => r[i]);
    if (values.length && values.every(isNumber)) {
      const nums = values.map(Number);
      const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
      return { name, type: 'number', min: Math.min(...nums), max: Math.max(...nums), mean: Math.round(mean * 100) / 100 };
    }
    return { name, type: 'text', distinct: new Set(values).size };
  });
  return { rows: rows.length, columns };
}

module.exports = { summarise };
