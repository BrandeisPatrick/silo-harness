// Summary numbers for a list of numbers. Every function leaves its input as it was.

function assertNumbers(values) {
  if (!Array.isArray(values) || values.length === 0) throw new TypeError('expected a non-empty array of numbers');
  for (const v of values) if (typeof v !== 'number' || Number.isNaN(v)) throw new TypeError(`not a number: ${v}`);
}

function mean(values) {
  assertNumbers(values);
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** The middle value; for an even count, the mean of the two middle values. */
function median(values) {
  assertNumbers(values);
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid] + sorted[mid + 1]) / 2;
}

/** [smallest, largest] */
function range(values) {
  assertNumbers(values);
  return [Math.min(...values), Math.max(...values)];
}

module.exports = { mean, median, range };
