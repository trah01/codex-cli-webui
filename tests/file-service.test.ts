import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveLocalFile, listLocalFiles, readLocalText, TEXT_PREVIEW_MAX_BYTES } from "../server/file-service.js";

describe("local agent file download boundary", () => {
  test("lists files and hidden entries, sorts folders first and preserves browsing boundaries", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-webui-list-"));
    try {
      mkdirSync(join(root, "folder"));
      writeFileSync(join(root, "a.txt"), "hello");
      writeFileSync(join(root, ".gitignore"), "node_modules");
      symlinkSync(join(root, "a.txt"), join(root, "link.txt"));
      const options = { allowedRoots: [root], home: root };
      const listing = await listLocalFiles(root, options);
      expect(listing.parent).toBeNull();
      expect(listing.items.map(item => item.name)).toEqual(["folder", ".gitignore", "a.txt"]);
      expect((await listLocalFiles(join(root, "folder"), options)).parent).toBe(root);
      await expect(listLocalFiles(join(root, ".."), options)).rejects.toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("previews Markdown and plain text while rejecting binary, oversized and escaped files", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-webui-preview-"));
    const outside = mkdtempSync(join(tmpdir(), "codex-webui-outside-"));
    try {
      writeFileSync(join(root, "note.md"), "# 中文标题\n\n**正文**");
      writeFileSync(join(root, "config.json"), '{"enabled":true}');
      writeFileSync(join(root, "utf16.txt"), Buffer.from('\ufeff中文', 'utf16le'));
      writeFileSync(join(root, "binary.bin"), Buffer.from([0, 1, 2]));
      writeFileSync(join(root, "big.txt"), Buffer.alloc(TEXT_PREVIEW_MAX_BYTES + 1));
      writeFileSync(join(outside, "secret.txt"), "outside");
      symlinkSync(outside, join(root, "escape"));
      const options = { cwd: root, allowedRoots: [root] };
      expect(await readLocalText("note.md", options)).toMatchObject({ text: "# 中文标题\n\n**正文**", markdown: true });
      expect(await readLocalText("config.json", options)).toMatchObject({ text: '{"enabled":true}', markdown: false });
      expect(await readLocalText("utf16.txt", options)).toMatchObject({ text: "中文" });
      for (const path of ["binary.bin", "big.txt", "escape/secret.txt", join(outside, "secret.txt")]) {
        await expect(readLocalText(path, options)).rejects.toThrow();
      }
      await expect(listLocalFiles(join(root, "escape"), options)).rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
  test("resolves absolute, relative, file URL and sandbox file references inside an allowed root", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-webui-file-"));
    const folder = join(root, "generated files");
    const file = join(folder, "report.txt");
    try {
      mkdirSync(folder);
      writeFileSync(file, "download me");
      const canonicalFile = realpathSync(file);
      expect(resolveLocalFile(file, { cwd: root, home: root, allowedRoots: [root] })).toMatchObject({ path: canonicalFile, filename: "report.txt", size: 11 });
      expect(resolveLocalFile("./generated%20files/report.txt", { cwd: root, home: root, allowedRoots: [root] }).path).toBe(canonicalFile);
      expect(resolveLocalFile(new URL(`file://${file}`).href, { cwd: root, home: root, allowedRoots: [root] }).path).toBe(canonicalFile);
      expect(resolveLocalFile(`sandbox:${file.replaceAll(" ", "%20")}`, { cwd: root, home: root, allowedRoots: [root] }).path).toBe(canonicalFile);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects paths outside the boundary, directories, symbolic links, invalid paths and oversized files", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-webui-file-root-"));
    const outside = mkdtempSync(join(tmpdir(), "codex-webui-file-outside-"));
    try {
      const outsideFile = join(outside, "outside.txt");
      const localFile = join(root, "large.bin");
      writeFileSync(outsideFile, "outside");
      writeFileSync(localFile, Buffer.alloc(8));
      symlinkSync(outsideFile, join(root, "linked.txt"));

      expect(() => resolveLocalFile(outsideFile, { cwd: root, home: root, allowedRoots: [root] })).toThrow();
      expect(() => resolveLocalFile(root, { cwd: root, home: root, allowedRoots: [root] })).toThrow();
      expect(() => resolveLocalFile(join(root, "linked.txt"), { cwd: root, home: root, allowedRoots: [root] })).toThrow();
      expect(() => resolveLocalFile(localFile, { cwd: root, home: root, allowedRoots: [root], maxBytes: 4 })).toThrow();
      expect(() => resolveLocalFile("bad\0path", { cwd: root, home: root, allowedRoots: [root] })).toThrow();
      expect(() => resolveLocalFile("a".repeat(8193), { cwd: root, home: root, allowedRoots: [root] })).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
