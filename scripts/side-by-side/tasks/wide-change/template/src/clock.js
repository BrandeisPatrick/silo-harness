// The time new records get. Tests set it to a fixed value.
let now = () => Date.now();

module.exports = {
  now: () => now(),
  setClock(f) {
    now = f;
  },
};
