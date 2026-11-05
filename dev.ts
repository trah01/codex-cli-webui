import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { context } from 'esbuild';

const root = fileURLToPath(new URL('.', import.meta.url));
const frontend = await context({
  absWorkingDir: root,
  entryPoints: ['public/app.js'],
  outfile: 'public/app.bundle.js',
  bundle: true,
  platform: 'browser',
  format: 'esm',
  logLevel: 'info',
});
await frontend.watch();
const server = spawn(process.execPath, ['--watch', '--import', 'tsx', 'server.ts'], {
  cwd: root,
  env: process.env,
  stdio: ['ignore', 'inherit', 'inherit'],
});
let stopping = false;
const exited = new Promise<number>(resolve => {
  server.once('error', error => {
    console.error('[codex-cli-webui] development server failed', error);
    resolve(1);
  });
  server.once('exit', code => resolve(code ?? 1));
});
async function stop(code: number) {
  if (stopping) return;
  stopping = true;
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM');
  await Promise.allSettled([exited, frontend.dispose()]);
  process.exit(code);
}
process.on('SIGINT', () => { void stop(0); });
process.on('SIGTERM', () => { void stop(0); });
const code = await exited;
if (!stopping) {
  console.error(`[codex-cli-webui] development server exited with code ${code}`);
  await stop(code || 1);
}
