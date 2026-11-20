# pantrylog

A command-line tool that keeps track of what is in the pantry. Node only (version 22 or later), no dependencies.

## Requirements

1. **Entry point.** It runs as `node bin/pantrylog.js <command> [arguments]`. `package.json` has `"test": "node --test"`.
2. **Data file.** Items are kept in `pantry.json` in the current working directory, as
   `{ "items": [ { "name": "rice", "qty": 2, "unit": "kg" } ] }`. A missing file means an empty pantry; the file is
   created on the first change. Commands that change nothing never write it.
3. **add.** `add <name> <qty> [unit]` adds `qty` of an item; the unit defaults to `pcs`. Names match without regard to
   case, and an item keeps the name and unit it was first added with. It prints
   `Added <qty> <unit> of <name> (now <total>)` and exits 0.
4. **use.** `use <name> <qty>` takes `qty` away and prints `Used <qty> <unit> of <name> (<left> left)`. An item that
   reaches 0 is removed from the file.
5. **Not enough.** `use` of more than there is prints `Error: only <n> <unit> of <name> left` to stderr, exits 4, and
   leaves the file as it was.
6. **Unknown item.** `use` or `remove` of an item that is not there prints `Error: no item named <name>` to stderr and
   exits 3.
7. **Quantities.** A quantity must be a positive whole number (`3`, not `0`, `-1`, `2.5` or `two`). Otherwise it prints
   `Error: quantity must be a positive whole number` to stderr and exits 2.
8. **remove.** `remove <name>` deletes the item and prints `Removed <name>`.
9. **list.** `list` prints one line per item, sorted by name: `<name>: <qty> <unit>`. An empty pantry prints
   `Pantry is empty`. `list --json` prints the items as a JSON array of `{ name, qty, unit }`, sorted by name.
10. **low.** `low [threshold]` prints, in the same format as `list`, the items with a quantity at or below the
    threshold (default 2). When there are none it prints `Nothing is running low`.
11. **Help and mistakes.** `--help` (or `help`) prints a usage text that names every command to stdout and exits 0.
    No command or an unknown command prints the usage text to stderr and exits 1. A known command with missing
    arguments prints a line starting `Error:` to stderr and exits 2.
12. **Broken data file.** A `pantry.json` that is not valid JSON makes every command print
    `Error: pantry.json is not valid JSON` to stderr and exit 5, without changing the file.

Write tests for it with `node:test`, and make them pass.
