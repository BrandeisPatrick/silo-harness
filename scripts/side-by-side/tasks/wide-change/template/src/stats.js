function stats(store) {
  return {
    /** Each user with how many notes they have, by name. */
    perUser() {
      const notes = store.read('notes');
      return store
        .read('users')
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((u) => ({ userId: u.id, name: u.name, notes: notes.filter((n) => n.userId === u.id).length }));
    },
  };
}

module.exports = { stats };
