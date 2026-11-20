const { ValidationError } = require('./errors.js');
const { tagSlug } = require('./slug.js');

function name(value) {
  if (typeof value !== 'string' || !value.trim()) throw new ValidationError('a name is required');
  if (value.length > 40) throw new ValidationError('a name is at most 40 characters');
  return value.trim();
}

function title(value) {
  if (typeof value !== 'string' || !value.trim()) throw new ValidationError('a title is required');
  return value.trim();
}

function tags(list = []) {
  if (!Array.isArray(list)) throw new ValidationError('tags must be a list');
  const out = [];
  for (const t of list) {
    const s = tagSlug(t);
    if (!s) throw new ValidationError(`not a usable tag: ${t}`);
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

module.exports = { name, title, tags };
