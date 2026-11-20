# notebox

Notes for a handful of people, kept as JSON files in one folder (one file per collection: `users.json`,
`notes.json`, `meta.json`). Every call reads and writes the files directly, so it is simple and synchronous.

```js
const notebox = require('notebox');

const nb = notebox.open('./data');
const ada = nb.users.create('Ada');
const note = nb.notes.create(ada.id, { title: 'Groceries', body: 'eggs, flour', tags: ['Home'] });
nb.notes.listByUser(ada.id);   // [note]
nb.tags.counts();              // [{ tag: 'home', count: 1 }]
nb.search('flour');            // [note]
nb.stats.perUser();            // [{ userId, name: 'Ada', notes: 1 }]
nb.exportAll();                // { users, notes, tags }
```

## API

- `open(dir, { cache = true })` opens (and creates) the data folder.
- `users.create(name)`, `users.get(id)`, `users.list()`, `users.rename(id, name)`. Names are unique, ignoring case.
- `notes.create(userId, { title, body, tags })`, `notes.get(id)`, `notes.listByUser(userId)`,
  `notes.update(id, { title, body, tags })`, `notes.remove(id)`.
- `tags.counts()`, `tags.rename(from, to)`: tags are lower case, with hyphens for spaces.
- `search(query)`: notes whose title or body has every word of the query.
- `stats.perUser()`, `exportAll()`.

A missing user or note throws `NotFoundError`; a second user with the same name throws `ConflictError`; a bad
name, title or tag throws `ValidationError`.

Run the tests with `npm test`.
