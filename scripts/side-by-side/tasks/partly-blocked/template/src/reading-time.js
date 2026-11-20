/** "3 min read" for a word count, at 220 words a minute; never less than one minute. */
function readingTime(words) {
  const minutes = Math.max(1, Math.round(words / 220));
  return `${minutes} min read`;
}

module.exports = { readingTime };
