import { lstat, readFile, realpath, writeFile, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { resolveBrowsePath } from './folder-service.js';

const MAX_BYTES = 1024 * 1024;

export function createProjectInstructionsStore({ projectRoots = [homedir()] } = {}) {
  async function snapshot(cwd) {
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw Error('Invalid working folder');
    const directory = await realpath(resolveBrowsePath(cwd, projectRoots));
    if (!(await lstat(directory)).isDirectory()) throw Error('Invalid working folder');
    const path = join(directory, 'AGENTS.md');
    let instructions = '', exists = false, mode = 0o644;
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw Error('AGENTS.md must be a regular file');
      if (stat.size > MAX_BYTES) throw Error('AGENTS.md exceeds the 1 MB limit');
      instructions = await readFile(path, 'utf8'); exists = true; mode = stat.mode & 0o777;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const version = createHash('sha256').update(JSON.stringify([path, exists, instructions])).digest('hex');
    return { path, instructions, exists, version, mode };
  }
  const response = ({ mode, ...file }) => file;
  return {
    async read(cwd) { return response(await snapshot(cwd)); },
    async write({ cwd, value, version }) {
      if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_BYTES) throw Error('AGENTS.md exceeds the 1 MB limit');
      const current = await snapshot(cwd);
      if (typeof version !== 'string' || version !== current.version) throw Error('AGENTS.md changed. Reopen the editor before saving.');
      const temporaryPath = `${current.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, value, { encoding: 'utf8', flag: 'wx', mode: current.mode });
        await rename(temporaryPath, current.path);
      } finally {
        await unlink(temporaryPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
      return { saved: true, ...response(await snapshot(cwd)) };
    },
  };
}
