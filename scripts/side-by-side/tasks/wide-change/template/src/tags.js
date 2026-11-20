const { tagSlug } = require('./slug.js');
const { ValidationError } = require('./errors.js');

function tags(store) {
  return {
    /** Every tag in use and how many notes have it, most used first, then by name. */
    counts() {
      const counts = new Map();
      for (const n of store.read('notes')) for (const t of n.tags) counts.set(t, (counts.get(t) || 0) + 1);
      return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    },
    /** Renames a tag on every note that has it; returns how many notes changed. */
    rename(from, to) {
      const a = tagSlug(from);
      const b = tagSlug(to);
      if (!a || !b) throw new ValidationError('both tags are required');
      const all = store.read('notes');
      let changed = 0;
      for (const n of all) {
        if (!n.tags.includes(a)) continue;
        n.tags = [...new Set(n.tags.map((t) => (t === a ? b : t)))];
        changed++;
      }
      if (changed) store.write('notes', all);
      return changed;
    },
  };
}

module.exports = { tags };
