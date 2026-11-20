#!/usr/bin/env node
// csvpeek <file.csv>: prints a short summary of the file.
const fs = require('node:fs');
const { summarise } = require('../src/summarise.js');
const { formatText } = require('../src/format.js');

function main(argv) {
  const file = argv[0];
  if (!file) {
    console.error('Usage: csvpeek <file.csv>');
    return 2;
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`csvpeek: cannot read ${file}: ${err.code || err.message}`);
    return 1;
  }
  try {
    console.log(formatText(summarise(text)));
  } catch (err) {
    console.error(`csvpeek: ${err.message}`);
    return 1;
  }
  return 0;
}

process.exitCode = main(process.argv.slice(2));
