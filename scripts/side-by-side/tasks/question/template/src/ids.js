let next = 1;

/** Event ids: evt-1, evt-2, ... in this process. */
function nextId() {
  return `evt-${next++}`;
}

module.exports = { nextId };
