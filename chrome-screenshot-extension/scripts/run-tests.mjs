/**
 * run-tests.mjs
 * Runs every suite in sequence and reports a combined result.
 * Run: node scripts/run-tests.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const SUITES = [
  ['unit', 'test-units.mjs'],
  ['imports', 'test-imports.mjs'],
  ['pipeline', 'test-pipeline.mjs']
];

let failed = 0;

for (const [name, file] of SUITES) {
  console.log(`\n${'='.repeat(60)}\n  ${name}\n${'='.repeat(60)}`);
  const result = spawnSync(process.execPath, [join(HERE, file)], { stdio: 'inherit' });
  if (result.status !== 0) {
    failed += 1;
    console.error(`  !! ${name} suite failed (exit ${result.status})`);
  }
}

console.log(`\n${'='.repeat(60)}`);
if (failed) {
  console.error(`  ${failed} of ${SUITES.length} suites FAILED\n`);
  process.exit(1);
}
console.log(`  All ${SUITES.length} suites passed\n`);
