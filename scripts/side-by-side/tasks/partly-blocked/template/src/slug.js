/**
 * A URL slug: lower case, accents dropped, every run of other characters turned into one hyphen, no hyphen at
 * either end. "Héllo,  World!" becomes "hello-world".
 */
function slugify(title) {
  return String(title)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/^-+|-+$/g, '');
}

module.exports = { slugify };
