#!/usr/bin/env node
// Copies this package's source files into the consuming project's
// functions/ and public/admin/ directories. Run automatically via the
// consumer's own "postinstall" script (see README.md) -- npm install /
// npm ci always re-syncs, so `npm update` genuinely pulls in fixes rather
// than requiring a manual copy-paste each time.
//
// Cloudflare Pages Functions have to exist as real files in the repo at
// build time (they aren't bundled out of node_modules), which is why this
// copies files into place rather than the consumer importing this package
// as a normal JS dependency.
//
// Destination paths are relative to wherever `npm install` is actually
// run (INIT_CWD, not this package's own directory) -- INIT_CWD is what
// npm sets to the directory a script was invoked from, which for a
// postinstall script in a dependency is the consumer project's root, not
// this package's own root inside node_modules.

import { mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(__dirname, '..');
const consumerRoot = process.env.INIT_CWD || process.cwd();

const files = [
  ['src/functions/github-webhook.js', 'functions/github-webhook.js'],
  ['src/functions/preview-url.js', 'functions/preview-url.js'],
  ['src/functions/admin/_middleware.js', 'functions/admin/_middleware.js'],
  ['src/admin/preview-status.js', 'public/admin/preview-status.js'],
  ['src/functions/admin/bulk-publish.js', 'functions/admin/bulk-publish.js'],
  ['src/admin/bulk-publish.html', 'public/admin/bulk-publish.html'],
];

async function main() {
  for (const [src, dest] of files) {
    const srcPath = path.join(packageRoot, src);
    const destPath = path.join(consumerRoot, dest);
    await mkdir(path.dirname(destPath), { recursive: true });
    await copyFile(srcPath, destPath);
    console.log(`decap-cloudflare-preview-status: synced ${dest}`);
  }
  console.log(
    '\nDone. Reminder: these are generated files (overwritten on every install) -- ' +
      "don't hand-edit them; fix bugs upstream in this package instead. " +
      'See this package\'s README for the env vars each one needs.'
  );
}

main().catch((err) => {
  console.error('decap-cloudflare-preview-status: sync failed:', err);
  process.exitCode = 1;
});
