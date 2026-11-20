/** Notes whose title or body has every word of the query (ignoring case), in id order. */
function search(store, query) {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return store
    .read('notes')
    .filter((n) => {
      const text = `${n.title} ${n.body}`.toLowerCase();
      return words.every((w) => text.includes(w));
    })
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

module.exports = { search };
