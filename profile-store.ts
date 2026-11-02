import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { profileInitials, type PublicAccountIdentity } from "./profile-service.js";

export function validateProfileName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 160 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Display name must contain 1–160 characters without control characters.");
  }
  return value.trim();
}

export function validateProfileAvatar(value: unknown) {
  if (typeof value !== "string" || value.length > 2_800_000) throw new Error("Use a PNG, JPEG, WebP or GIF image up to 2 MB.");
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw new Error("Use a PNG, JPEG, WebP or GIF image up to 2 MB.");
  const body = Buffer.from(match[2], "base64"), contentType = match[1];
  const valid = contentType === "image/png" ? body.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : contentType === "image/jpeg" ? body[0] === 255 && body[1] === 216 && body[2] === 255
    : contentType === "image/gif" ? ["GIF87a", "GIF89a"].includes(body.toString("ascii", 0, 6))
    : body.toString("ascii", 0, 4) === "RIFF" && body.toString("ascii", 8, 12) === "WEBP";
  if (!valid || body.length > 2 * 1024 * 1024 || body.toString("base64") !== match[2]) throw new Error("Use a PNG, JPEG, WebP or GIF image up to 2 MB.");
  return { body, contentType };
}

async function readProfile(path: string): Promise<{displayName: string; avatar?: string} | null> {
  try {
    const profile = JSON.parse(await readFile(path, "utf8"));
    const displayName = validateProfileName(profile.displayName);
    if (profile.avatar !== undefined) validateProfileAvatar(profile.avatar);
    return { displayName, avatar: profile.avatar };
  }
  catch (error: any) { if (error.code === "ENOENT") return null; throw error; }
}

export async function readProfileName(path: string) {
  return (await readProfile(path))?.displayName || null;
}

export async function readProfileAvatar(path: string) {
  const profile = await readProfile(path);
  return profile?.avatar ? validateProfileAvatar(profile.avatar) : null;
}

export async function saveProfileName(path: string, value: unknown, avatar?: string) {
  const displayName = validateProfileName(value);
  if (avatar !== undefined) validateProfileAvatar(avatar);
  const profile = await readProfile(path);
  const saved = { displayName, avatar: avatar ?? profile?.avatar };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(saved)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch((error: any) => { if (error.code !== "ENOENT") throw error; });
  }
}

export async function withProfileName(account: PublicAccountIdentity, path: string) {
  const profile = await readProfile(path);
  return profile ? { ...account, displayName: profile.displayName, initials: profileInitials(profile.displayName), avatarUrl: profile.avatar ? "/api/account/avatar" : account.avatarUrl } : account;
}
