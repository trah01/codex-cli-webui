import { readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { authenticationConfig } from './authentication.js';

const fields = {
  localAuthRequired: 'CODEX_WEBUI_LOCAL_AUTH_REQUIRED', mode: 'CODEX_WEBUI_AUTH_MODE', otpSecret: 'CODEX_WEBUI_OTP_SECRET',
  issuer: 'CODEX_WEBUI_OIDC_ISSUER', clientId: 'CODEX_WEBUI_OIDC_CLIENT_ID',
  clientSecret: 'CODEX_WEBUI_OIDC_CLIENT_SECRET', redirectUri: 'CODEX_WEBUI_OIDC_REDIRECT_URI',
  publicOrigin: 'CODEX_WEBUI_PUBLIC_ORIGIN',
};
export function loadAuthenticationSettings(path, env = process.env) {
  let saved = {};
  try { saved = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return Object.fromEntries(Object.entries(fields).map(([key, name]) => [key, saved[key] ?? env[name] ?? (key === 'localAuthRequired' ? 'true' : '')]));
}
export function validateAuthenticationSettings(settings, { domain, passwordConfigured }) {
  if (settings.localAuthRequired !== undefined && !['true', 'false'].includes(settings.localAuthRequired)) throw new Error('本机登录设置格式不正确。');
  const env = Object.fromEntries(Object.entries(fields).map(([key, name]) => [name, settings[key]]));
  const config = authenticationConfig(env);
  if ((config.totp || config.mode === 'both') && !passwordConfigured) throw new Error('请先设置登录账号和密码。');
  if (config.mode !== 'password' && new URL(config.provider.redirectUri).hostname !== domain) throw new Error('请先绑定与 OIDC 回调地址一致的域名。');
  const origin = config.mode !== 'password' ? new URL(config.provider.redirectUri).origin : settings.publicOrigin || null;
  if (origin && (!['http:', 'https:'].includes(new URL(origin).protocol) || new URL(origin).origin !== origin || new URL(origin).hostname !== domain)) throw new Error('公网地址必须为已绑定域名的 HTTPS 地址，不带路径或结尾斜线。');
  return { config, origin };
}
export function updateAuthenticationSettings(previous, payload) {
  if (payload.scope !== undefined) {
    const groups = { local: ['localAuthRequired'], otp: ['otpSecret'], oidc: ['mode', 'issuer', 'clientId', 'clientSecret', 'redirectUri'], origin: ['publicOrigin'] };
    const keys = groups[payload.scope];
    if (!keys) throw new Error('未知的认证设置页面。');
    const changes = Object.fromEntries(keys.map(key => [key, payload[key]]));
    payload = { ...previous, ...changes, otpEnabled: payload.scope === 'otp' ? payload.otpEnabled : Boolean(previous.otpSecret) };
  }
  payload = { localAuthRequired: previous.localAuthRequired ?? 'true', ...payload };
  const next = {};
  for (const key of Object.keys(fields)) {
    if (typeof payload[key] !== 'string' || payload[key].length > 8192) throw new Error('认证配置格式不正确。');
    next[key] = payload[key].trim();
  }
  // Empty secret fields preserve existing values; disabling OTP is explicit.
  next.clientSecret ||= previous.clientSecret;
  next.otpSecret = payload.otpEnabled === false ? '' : next.otpSecret || previous.otpSecret;
  if (payload.otpEnabled && !next.otpSecret) throw new Error('请生成或填写验证器密钥。');
  return next;
}
export function publicAuthenticationSettings(settings) {
  const { otpSecret, clientSecret, subjects, publicOrigin, ...visible } = settings;
  return { ...visible, mode: settings.mode || (settings.issuer ? 'oidc' : 'password'), otpEnabled: Boolean(otpSecret), clientSecretConfigured: Boolean(clientSecret) };
}
export function saveAuthenticationSettings(path, settings) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(settings) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export function oidcCallbackAddress(domain, settings = {}) {
  if (!domain) return '';
  let protocol = 'https:';
  try { protocol = new URL(settings.redirectUri || settings.publicOrigin).protocol; } catch {}
  return `${protocol === 'http:' ? 'http:' : 'https:'}//${domain}/api/auth/oidc/callback`;
}
