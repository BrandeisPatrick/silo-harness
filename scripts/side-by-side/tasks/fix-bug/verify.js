#!/usr/bin/env node
// fix-bug: the tests pass and the test files are as the template had them.
//   node verify.js <projectDir> [finalMessageFile]
const path = require('node:path');
const u = require('../../lib/verify-util.js');

const { projectDir } = u.args();
const template = path.join(__dirname, 'template');
const tests = u.runTests(projectDir);
const testDiff = u.diffTree(template, projectDir, 'test');
u.finish(
  { testsPass: tests.ok, testFilesUnchanged: testDiff.same },
  { onlySrcChanged: u.diffTree(template, projectDir).changed.every((f) => f.startsWith('src' + path.sep)) },
);
