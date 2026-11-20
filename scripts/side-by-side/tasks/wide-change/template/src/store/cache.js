// Keeps each collection in memory after its first read; writes go through to the store underneath.
class CachedStore {
  constructor(inner) {
    this.inner = inner;
    this.cache = new Map();
  }

  read(collection) {
    if (!this.cache.has(collection)) this.cache.set(collection, this.inner.read(collection));
    // A copy, so a caller that changes the list does not change the cache
    return this.cache.get(collection).map((r) => ({ ...r }));
  }

  write(collection, records) {
    this.inner.write(collection, records);
    this.cache.set(collection, records.map((r) => ({ ...r })));
  }

  collections() {
    return this.inner.collections();
  }
}

module.exports = { CachedStore };
