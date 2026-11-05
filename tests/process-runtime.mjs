import { spawn } from 'node:child_process';

export function startProcess(args, { stdout = 'pipe', stderr = 'pipe', ...options } = {}) {
  const child = spawn(args[0], args.slice(1), {
    ...options,
    stdio: ['ignore', stdout, stderr],
  });
  child.exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  return child;
}
