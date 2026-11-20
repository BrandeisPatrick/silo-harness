#!/usr/bin/env node
// question: nothing in the project changed, and the answer names the key facts: the decision is in src/retry.js, the
// limit is 6 attempts (maxAttempts in src/config.js).
//   node verify.js <projectDir> <finalMessageFile>
const path = require('node:path');
const u = require('../../lib/verify-util.js');

const { projectDir, final } = u.args();
const template = path.join(__dirname, 'template');
const diff = u.diffTree(template, projectDir);
u.finish(
  {
    noFileChanged: diff.same,
    namesRetryFile: /retry\.js/.test(final),
    namesAttemptLimit: /\b6\b|\bsix\b/i.test(final) && /attempt/i.test(final),
  },
  {
    namesConfigFile: /config\.js/.test(final),
    namesMaxAttempts: /maxAttempts/.test(final),
    mentionsStatusRule: /\b4\d\d\b|\b429\b|status/i.test(final),
    mentionsEnvOverride: /RELAYBOX_MAX_ATTEMPTS/.test(final),
  },
);
