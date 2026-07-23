#!/usr/bin/env node
/**
 * 对 providers/ 下各入口跑 skeg-provider-test conformance。
 * 用法：node scripts/check-providers.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const providersDir = join(root, 'providers');
const tester = join(root, 'scripts', 'provider-test.mjs');

/**
 * @returns {string[]}
 */
function listProviderEntries() {
  if (!existsSync(providersDir)) return [];
  return readdirSync(providersDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(providersDir, d.name, 'index.mjs'))
    .filter((p) => existsSync(p));
}

function main() {
  const entries = listProviderEntries();
  if (entries.length === 0) {
    console.error('No providers found under providers/*/index.mjs');
    process.exit(1);
  }

  let failed = false;
  for (const entry of entries) {
    console.log(`\n=== provider-test ${entry.replace(/\\/g, '/')} ===`);
    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', tester, entry],
      { stdio: 'inherit', cwd: root },
    );
    if (result.status !== 0) failed = true;
  }

  if (failed) {
    console.error('\nProvider conformance failed.');
    process.exit(1);
  }
  console.log('\nProvider conformance passed.');
}

main();
