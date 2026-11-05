import { chmodSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { isStoredPassword } from "./server-security.js";

export type StoredPassword = {
  version: 1;
  algorithm: "scrypt";
  salt: string;
  hash: string;
  username?: string;
};

export function readEnvironmentCredentials(env: NodeJS.ProcessEnv = process.env) {
  const password = env.CODEX_WEBUI_PASSWORD || null;
  const username = env.CODEX_WEBUI_USERNAME?.trim() || null;
  if (username && (!password || !/^[a-zA-Z0-9_.-]{1,64}$/.test(username))) {
    throw new Error('CODEX_WEBUI_USERNAME 需与 CODEX_WEBUI_PASSWORD 一起配置，且为 1–64 位字母、数字、点、下划线或连字符。');
  }
  return { password, username };
}

export function passwordStorePath(env: NodeJS.ProcessEnv = process.env) {
  if (env.CODEX_WEBUI_AUTH_STORE) return resolve(env.CODEX_WEBUI_AUTH_STORE);
  const codexHome = env.CODEX_HOME || join(homedir(), ".codex");
  return join(codexHome, "codex-webui-auth.json");
}

export function loadStoredPassword(path: string): StoredPassword | null {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const credential = JSON.parse(raw);
  if (!isStoredPassword(credential)) throw new Error(`Invalid codex-cli-webui password store: ${path}`);
  return credential;
}

export function saveStoredPassword(path: string, credential: StoredPassword) {
  if (!isStoredPassword(credential)) throw new Error("Invalid stored password credential");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(credential, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  chmodSync(path, 0o600);
}

export function replaceStoredPassword(path: string, credential: StoredPassword) {
  if (!isStoredPassword(credential)) throw new Error("Invalid stored password credential");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(credential, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporaryPath, path);
  } finally {
    try { unlinkSync(temporaryPath); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
  }
}
