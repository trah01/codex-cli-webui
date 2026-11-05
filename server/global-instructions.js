import { readFile, lstat, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';

const MAX_BYTES = 1024 * 1024;

export function createGlobalInstructionsStore({ codexHome = () => process.env.CODEX_HOME || resolve(homedir(), '.codex') } = {}) {
  async function readFileState(path) {
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Global instructions must be a regular file');
      if (stat.size > MAX_BYTES) throw new Error('Global instructions exceed the 1 MB limit');
      return { path, content: await readFile(path, 'utf8'), mode: stat.mode & 0o777, exists: true };
    } catch (error) {
      if (error.code === 'ENOENT') return { path, content: '', mode: 0o600, exists: false };
      throw error;
    }
  }
  async function snapshot() {
    const home = resolve(codexHome());
    const override = await readFileState(resolve(home, 'AGENTS.override.md'));
    const base = await readFileState(resolve(home, 'AGENTS.md'));
    const file = override.content.trim() ? override : base;
    const version = createHash('sha256').update(JSON.stringify([home, override.exists, override.content, base.exists, base.content])).digest('hex');
    return { file, version };
  }
  const response = ({ file, version }) => ({ instructions: file.content, path: file.path, version });
  return {
    async read() { return response(await snapshot()); },
    async write({ value, version }) {
      if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_BYTES) throw new Error('Global instructions exceed the 1 MB limit');
      const current = await snapshot();
      if (typeof version !== 'string' || version !== current.version) throw new Error('Global instructions changed. Reopen this page before saving.');
      const { file } = current;
      await mkdir(dirname(file.path), { recursive: true, mode: 0o700 });
      const temporaryPath = `${file.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, value, { encoding: 'utf8', flag: 'wx', mode: file.mode });
        await rename(temporaryPath, file.path);
      } finally {
        await unlink(temporaryPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
      return { saved: true, ...response(await snapshot()) };
    },
  };
}
