// The storage layer: each collection is a JSON array in <dir>/<collection>.json. Writes go to a temporary file
// first and are renamed into place, so a crash never leaves half a file.
const fs = require('node:fs');
const path = require('node:path');

class FileStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  file(collection) {
    return path.join(this.dir, `${collection}.json`);
  }

  /** The collection's records (an empty list when it has none yet). */
  read(collection) {
    const file = this.file(collection);
    if (!fs.existsSync(file)) return [];
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  /** Replaces the collection's records. */
  write(collection, records) {
    const file = this.file(collection);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(records, null, 2));
    fs.renameSync(tmp, file);
  }

  /** The names of the collections on disk. */
  collections() {
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5))
      .sort();
  }
}

module.exports = { FileStore };
