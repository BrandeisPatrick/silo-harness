/** One line for a note: its title and tags. */
function summary(note) {
  return note.tags.length ? `${note.title} [${note.tags.join(', ')}]` : note.title;
}

module.exports = { summary };
