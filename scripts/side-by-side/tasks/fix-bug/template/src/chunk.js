/** Splits a list into lists of `size` items; the last may be shorter. */
function chunk(list, size) {
  if (!Number.isInteger(size) || size < 1) throw new RangeError('size must be a positive integer');
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

module.exports = { chunk };
