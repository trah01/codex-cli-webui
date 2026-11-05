import { build } from 'esbuild';
import { copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
await build({
  absWorkingDir: root,
  entryPoints: ['public/app.js'],
  outfile: 'public/app.bundle.js',
  bundle: true,
  platform: 'browser',
  format: 'esm',
});
await build({
  absWorkingDir: root,
  entryPoints: ['server/index.ts'],
  outfile: 'dist/server.js',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  packages: 'external',
});
await copyFile(new URL('../server/terminal-worker.js', import.meta.url), new URL('../dist/terminal-worker.js', import.meta.url));
