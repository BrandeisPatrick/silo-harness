// Ids are a prefix and a number from one counter kept in the meta collection: u-1, n-2, u-3, ...
function nextId(store, prefix) {
  const meta = store.read('meta');
  let seq = meta.find((m) => m.key === 'seq');
  if (!seq) {
    seq = { key: 'seq', value: 0 };
    meta.push(seq);
  }
  seq.value += 1;
  store.write('meta', meta);
  return `${prefix}-${seq.value}`;
}

module.exports = { nextId };
