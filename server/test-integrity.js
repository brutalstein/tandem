'use strict';
// Policy for deciding whether an automated verification is trustworthy. The
// fingerprint scanner owns filesystem discovery; this module owns the consistent
// pre-execution and final integrity decision. It deliberately does not run code.
const verify = require('./verify');

function inspect(workdir, fpBefore, testsBefore, foreign = [], overlaps = () => false, checkDir = '') {
  const changedDefs = verify.definitionChanges(fpBefore, verify.fingerprint(workdir, checkDir));
  const afterTests = verify.testFingerprint(workdir);
  const changedTests = verify.testChanges(testsBefore, afterTests)
    .filter(f => !foreign.some(p => overlaps(p, f)));
  const scanFailed = Object.hasOwn(testsBefore, '__scan_error__') ||
    Object.hasOwn(afterTests, '__scan_error__');
  // The check starts in checkDir: if the job turned it into a link out of the workspace, nothing above holds.
  const checkDirEscaped = !!checkDir && !verify.contained(workdir, checkDir);
  return { changedDefs, changedTests, scanFailed, checkDirEscaped };
}

function blocked(scan) {
  return scan.scanFailed || scan.checkDirEscaped || scan.changedDefs.length > 0 || scan.changedTests.length > 0;
}

function reason(scan) {
  return [
    scan.changedDefs.length && 'changed definitions: ' + scan.changedDefs.join(', '),
    scan.changedTests.length && 'changed tests: ' + scan.changedTests.join(', '),
    scan.scanFailed && 'test-file fingerprint scan failed',
    scan.checkDirEscaped && 'the check directory is no longer a directory inside the workspace',
  ].filter(Boolean).join('; ');
}

module.exports = { inspect, blocked, reason };
