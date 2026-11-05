import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { open, readdir } from "node:fs/promises";
import { extname } from "node:path";
import { resolveBrowsePath } from "./folder-service.js";

export const LOCAL_FILE_MAX_BYTES = 512 * 1024 * 1024;
export const TEXT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

export async function listLocalFiles(input, { allowedRoots, home } = {}) {
  const path = resolveBrowsePath(input, allowedRoots, home);
  const entries = await readdir(path, { withFileTypes: true });
  const items = entries.filter(entry => !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile()))
    .map(entry => ({ name: entry.name, path: resolve(path, entry.name), kind: entry.isDirectory() ? "folder" : "file" }))
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "folder" ? -1 : 1) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  let parent = null;
  if (resolve(path, "..") !== path) {
    try { parent = resolveBrowsePath(resolve(path, ".."), allowedRoots, home); } catch { /* Root boundary. */ }
  }
  return { path, parent, items };
}

export async function readLocalText(input, options = {}) {
  const file = resolveLocalFile(input, { ...options, maxBytes: TEXT_PREVIEW_MAX_BYTES });
  const handle = await open(file.path, "r");
  try {
    // Bound the actual read as well as the metadata check if a file grows meanwhile.
    const buffer = Buffer.alloc(TEXT_PREVIEW_MAX_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!chunk.bytesRead) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > TEXT_PREVIEW_MAX_BYTES) throw new Error("文件超过 2 MB，请下载后查看");
    const bytes = buffer.subarray(0, bytesRead);
    let text;
    if (bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder("utf-16le", { fatal: true }).decode(bytes);
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder("utf-16be", { fatal: true }).decode(bytes);
    else text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (/[\u0000-\u0008\u000e-\u001f]/.test(text)) throw new Error("该文件不支持文本预览，请下载后查看");
    return { path: file.path, filename: file.filename, size: bytesRead, text, markdown: [".md", ".markdown", ".mdown"].includes(extname(file.filename).toLowerCase()) };
  } finally { await handle.close(); }
}

const inside = (candidate, root) => candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

function canonicalRoots(roots) {
  const result = [];
  for (const root of roots || []) {
    try {
      const canonical = realpathSync(resolve(root));
      if (!result.includes(canonical)) result.push(canonical);
    } catch { /* Ignore unavailable roots. */ }
  }
  return result;
}

function decodePath(value) {
  try { return decodeURIComponent(value); }
  catch { return value; }
}

function expandFilePath(value, home) {
  const input = String(value || "").trim();
  if (!input || input.length > 8192 || input.includes("\0")) throw new Error("Invalid file path");
  if (/^file:/i.test(input)) return fileURLToPath(input);
  if (/^sandbox:/i.test(input)) return decodePath(input.replace(/^sandbox:/i, ""));
  if (input === "~") return home;
  if (input.startsWith("~/") || input.startsWith("~\\")) return resolve(home, decodePath(input.slice(2)));
  return decodePath(input);
}

export function resolveLocalFile(input, {
  cwd = process.cwd(),
  home = process.env.HOME || process.cwd(),
  allowedRoots = [home],
  maxBytes = LOCAL_FILE_MAX_BYTES,
} = {}) {
  const expanded = expandFilePath(input, home);
  const candidate = resolve(isAbsolute(expanded) ? expanded : resolve(cwd, expanded));
  const roots = canonicalRoots(allowedRoots);
  if (!roots.length) throw new Error("No file roots are available");

  const metadata = lstatSync(candidate);
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("File not found");
  const path = realpathSync(candidate);
  if (!roots.some(root => inside(path, root))) throw new Error("File is outside allowed roots");

  const size = statSync(path).size;
  if (size > maxBytes) throw new Error("File is too large");
  return { path, size, filename: basename(path) };
}
