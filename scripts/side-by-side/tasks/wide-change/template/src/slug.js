/** A tag as stored: lower case, spaces and underscores as hyphens, nothing else but letters, digits and hyphens. */
function tagSlug(tag) {
  return String(tag)
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

module.exports = { tagSlug };
