const { NotFoundError, ConflictError } = require('./errors.js');
const validate = require('./validate.js');
const { nextId } = require('./ids.js');
const clock = require('./clock.js');

function users(store) {
  const taken = (all, name, except) => all.some((u) => u.id !== except && u.name.toLowerCase() === name.toLowerCase());
  return {
    create(name) {
      const clean = validate.name(name);
      const all = store.read('users');
      if (taken(all, clean)) throw new ConflictError(`a user named ${clean} already exists`);
      const user = { id: nextId(store, 'u'), name: clean, createdAt: clock.now() };
      store.write('users', [...store.read('users'), user]);
      return user;
    },
    get(id) {
      const user = store.read('users').find((u) => u.id === id);
      if (!user) throw new NotFoundError('user', id);
      return user;
    },
    list() {
      return store.read('users').sort((a, b) => a.name.localeCompare(b.name));
    },
    rename(id, name) {
      const clean = validate.name(name);
      const all = store.read('users');
      const user = all.find((u) => u.id === id);
      if (!user) throw new NotFoundError('user', id);
      if (taken(all, clean, id)) throw new ConflictError(`a user named ${clean} already exists`);
      user.name = clean;
      store.write('users', all);
      return user;
    },
  };
}

module.exports = { users };
