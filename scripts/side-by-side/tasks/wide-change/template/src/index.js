const { createStore } = require('./store/index.js');
const { users } = require('./users.js');
const { notes } = require('./notes.js');
const { tags } = require('./tags.js');
const { search } = require('./search.js');
const { stats } = require('./stats.js');
const { exportAll } = require('./export.js');
const { summary } = require('./format.js');
const errors = require('./errors.js');
const clock = require('./clock.js');

/** Opens (and creates) a data folder. */
function open(dir, opts = {}) {
  const store = createStore(dir, opts);
  return {
    store,
    users: users(store),
    notes: notes(store),
    tags: tags(store),
    stats: stats(store),
    search: (query) => search(store, query),
    exportAll: () => exportAll(store),
  };
}

module.exports = { open, summary, setClock: clock.setClock, ...errors };
