// The record store: one JSON file per job in records/.
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'records');

function saveRecord(rec) {
  if (rec.final === 'failed') rec.cause = rec.attempts[rec.attempts.length - 1].outcome;
  fs.writeFileSync(path.join(DIR, `${rec.job}.json`), JSON.stringify(rec, null, 2) + '\n');
}

function loadRecord(job) {
  return JSON.parse(fs.readFileSync(path.join(DIR, `${job}.json`), 'utf8'));
}

module.exports = { saveRecord, loadRecord };
