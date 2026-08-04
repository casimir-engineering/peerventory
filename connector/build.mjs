/**
 * Builds the extension bundles (popup, scan page, background worker) into
 * chrome-extension/, so `chrome-extension/` stays the folder you load
 * unpacked. The content scripts and manifest are plain files and need no
 * build.
 *
 * Also emits test/.tmp/core.mjs, a Node-consumable ESM bundle of the pure
 * logic (backup decode, decryption, materialization, listing payload) used
 * by test/unit-tests.mjs.
 */
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [
    join(HERE, 'src', 'popup.ts'),
    join(HERE, 'src', 'scan.ts'),
    join(HERE, 'src', 'background.ts'),
  ],
  outdir: join(HERE, 'chrome-extension'),
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  minify: true,
  logLevel: 'info',
});

mkdirSync(join(HERE, 'test', '.tmp'), { recursive: true });
await build({
  entryPoints: [join(HERE, 'src', 'core.ts')],
  outfile: join(HERE, 'test', '.tmp', 'core.mjs'),
  bundle: true,
  format: 'esm',
  // Tests build Yjs fixtures themselves; sharing one yjs instance avoids
  // the "Yjs was already imported" constructor-check hazard.
  external: ['yjs', '@hocuspocus/provider'],
  platform: 'node',
  target: 'node20',
  logLevel: 'info',
});
