const { FileStore } = require('./file-store.js');
const { CachedStore } = require('./cache.js');

/** The store for a data folder: a file store, with a cache in front unless cache is false. */
function createStore(dir, { cache = true } = {}) {
  const files = new FileStore(dir);
  return cache ? new CachedStore(files) : files;
}

module.exports = { createStore };
