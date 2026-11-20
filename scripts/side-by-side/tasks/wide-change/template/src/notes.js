const { NotFoundError } = require('./errors.js');
const validate = require('./validate.js');
const { nextId } = require('./ids.js');
const clock = require('./clock.js');
const { users } = require('./users.js');

function notes(store) {
  const people = users(store);
  return {
    create(userId, { title, body = '', tags = [] } = {}) {
      people.get(userId);
      const at = clock.now();
      const note = { id: nextId(store, 'n'), userId, title: validate.title(title), body: String(body), tags: validate.tags(tags), createdAt: at, updatedAt: at };
      store.write('notes', [...store.read('notes'), note]);
      return note;
    },
    get(id) {
      const note = store.read('notes').find((n) => n.id === id);
      if (!note) throw new NotFoundError('note', id);
      return note;
    },
    listByUser(userId) {
      people.get(userId);
      return store
        .read('notes')
        .filter((n) => n.userId === userId)
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id, undefined, { numeric: true }));
    },
    update(id, patch = {}) {
      const all = store.read('notes');
      const note = all.find((n) => n.id === id);
      if (!note) throw new NotFoundError('note', id);
      if (patch.title !== undefined) note.title = validate.title(patch.title);
      if (patch.body !== undefined) note.body = String(patch.body);
      if (patch.tags !== undefined) note.tags = validate.tags(patch.tags);
      note.updatedAt = clock.now();
      store.write('notes', all);
      return note;
    },
    remove(id) {
      const all = store.read('notes');
      if (!all.some((n) => n.id === id)) throw new NotFoundError('note', id);
      store.write('notes', all.filter((n) => n.id !== id));
      return true;
    },
  };
}

module.exports = { notes };
