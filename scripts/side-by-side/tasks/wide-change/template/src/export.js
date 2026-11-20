const { tags } = require('./tags.js');

/** Everything in the store, for a backup: users and notes in id order, and the tag counts. */
function exportAll(store) {
  const byId = (a, b) => a.id.localeCompare(b.id, undefined, { numeric: true });
  return { users: store.read('users').sort(byId), notes: store.read('notes').sort(byId), tags: tags(store).counts() };
}

module.exports = { exportAll };
