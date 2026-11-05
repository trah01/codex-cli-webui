import { test, expect } from 'vitest';
import { mkdtempSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { oidcCallbackAddress, loadAuthenticationSettings, saveAuthenticationSettings, updateAuthenticationSettings, validateAuthenticationSettings, publicAuthenticationSettings } from '../server/authentication-store.js';
import { isLocalAuthManagementRequest } from '../server/server-security.js';

const settings = () => ({ localAuthRequired: 'true', mode: 'password', otpSecret: '', issuer: '', clientId: '', clientSecret: '', redirectUri: '', publicOrigin: '' });
test('saved settings persist across reload and secrets never appear in public settings', () => {
  const directory = mkdtempSync(join(tmpdir(), 'webui-security-'));
  try {
    const path = join(directory, 'security.json'), saved = { ...settings(), otpSecret: 'A'.repeat(32), clientSecret: 'private-client-secret' };
    saveAuthenticationSettings(path, saved);
    expect(loadAuthenticationSettings(path, {})).toEqual(saved);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const visible = publicAuthenticationSettings(saved);
    expect(visible.otpEnabled).toBe(true); expect(visible.clientSecretConfigured).toBe(true);
    expect(JSON.stringify(visible)).not.toContain(saved.otpSecret);
    expect(JSON.stringify(visible)).not.toContain(saved.clientSecret);
  } finally { rmSync(directory, { recursive: true }); }
});
test('blank secrets preserve credentials and OTP disable is explicit', () => {
  const previous = { ...settings(), otpSecret: 'A'.repeat(32), clientSecret: 'secret' };
  expect(updateAuthenticationSettings(previous, { ...settings(), otpEnabled: true })).toMatchObject({ otpSecret: previous.otpSecret, clientSecret: 'secret' });
  expect(updateAuthenticationSettings(previous, { ...settings(), otpEnabled: false }).otpSecret).toBe('');
  expect(() => updateAuthenticationSettings(settings(), { ...settings(), otpEnabled: true })).toThrow();
});
test('OTP requires a password and OIDC requires HTTPS and a bound callback domain', () => {
  expect(() => validateAuthenticationSettings({ ...settings(), otpSecret: 'A'.repeat(32) }, { domain: '', passwordConfigured: false })).toThrow();
  const oidc = { ...settings(), mode: 'both', issuer: 'https://identity.example.com', clientId: 'client', clientSecret: 'secret', redirectUri: 'https://codex.example.com/api/auth/oidc/callback' };
  expect(() => validateAuthenticationSettings(oidc, { domain: 'other.example.com', passwordConfigured: true })).toThrow();
  expect(validateAuthenticationSettings(oidc, { domain: 'codex.example.com', passwordConfigured: true }).origin).toBe('https://codex.example.com');
  expect(() => validateAuthenticationSettings({ ...oidc, issuer: 'http://identity.example.com' }, { domain: 'codex.example.com', passwordConfigured: true })).toThrow();
});
test('management rejects domains, LAN, IPv6, cross-origin and forwarded loopback requests', () => {
  const request = (address, host, extra = {}) => ({ socket: { remoteAddress: address }, headers: { host, ...extra } });
  expect(isLocalAuthManagementRequest(request('127.0.0.1', '127.0.0.1:8899'))).toBe(true);
  for (const req of [request('192.168.1.2', '127.0.0.1:8899'), request('::1', '[::1]:8899'), request('127.0.0.1', 'codex.example.com'), request('127.0.0.1', '127.0.0.1:8899', { 'x-forwarded-for': '127.0.0.1' }), request('127.0.0.1', '127.0.0.1:8899', { origin: 'https://evil.example.com' })]) expect(isLocalAuthManagementRequest(req)).toBe(false);
});

test('web form generates enrollment material and clears secrets after saving', async () => {
  const { JSDOM } = await import('jsdom');
  const { vi } = await import('vitest');
  const { renderAuthenticationSettings } = await import('../public/authentication-settings.js');
  const dom = new JSDOM('<main></main>'); const calls = [];
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('fetch', async (path, options = {}) => {
    calls.push({ path, options });
    return { ok: true, json: async () => path === '/api/auth/otp-secret' ? { secret: 'A'.repeat(32) } : options.method === 'POST' ? { ok: true } : { ...settings(), otpEnabled: false, clientSecretConfigured: true } };
  });
  try {
    const root = dom.window.document.querySelector('main'); await renderAuthenticationSettings(root);
    const form = root.querySelector('form');
    const generate = [...form.querySelectorAll('button')].find(button => button.textContent === '生成新密钥');
    await generate.onclick();
    expect(form.querySelector('[name="otpSecret"]').value).toBe('A'.repeat(32));
    form.querySelector('[name="otpCode"]').value = '123456';
    await form.onsubmit({ preventDefault() {} });
    const sent = JSON.parse(calls.at(-1).options.body);
    expect(sent.otpEnabled).toBe(true); expect(sent.otpCode).toBe('123456');
    expect(form.querySelector('[name="otpSecret"]').value).toBe('');
    expect(root.textContent).not.toContain('A'.repeat(32));
    expect(root.textContent).toContain('立即生效');
  } finally { vi.unstubAllGlobals(); dom.window.close(); }
});

test('saving one settings page preserves other authentication groups', () => {
  const previous = { ...settings(), otpSecret: 'A'.repeat(32), mode: 'both', issuer: 'https://identity.example.com', clientId: 'client', clientSecret: 'secret', redirectUri: 'https://codex.example.com/api/auth/oidc/callback', publicOrigin: 'https://codex.example.com' };
  const otp = updateAuthenticationSettings(previous, { scope: 'otp', otpEnabled: false, otpSecret: '', mode: 'password' });
  expect(otp).toEqual({ ...previous, otpSecret: '' });
  const origin = updateAuthenticationSettings(previous, { scope: 'origin', publicOrigin: '', otpEnabled: false });
  expect(origin).toEqual({ ...previous, publicOrigin: '' });
  const oidc = updateAuthenticationSettings(previous, { scope: 'oidc', mode: 'password', issuer: previous.issuer, clientId: previous.clientId, clientSecret: '', redirectUri: previous.redirectUri, subjects: 'new-admin' });
  expect(oidc).toEqual({ ...previous, mode: 'password' });
  expect(() => updateAuthenticationSettings(previous, { scope: 'unknown' })).toThrow();
});

test('each authentication page renders only its own fields and save action', async () => {
  const { JSDOM } = await import('jsdom'); const { vi } = await import('vitest');
  const { renderAuthenticationSettings } = await import('../public/authentication-settings.js');
  const { renderAccessSettings } = await import('../public/access-settings.js');
  const dom = new JSDOM('<main></main>'); vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('fetch', async path => ({ ok: true, json: async () => path === '/api/auth/credentials' ? { editable: true, username: 'admin' } : path === '/api/auth/domain' ? { domain: 'codex.example.com' } : { ...settings(), otpEnabled: false } }));
  try {
    const root = dom.window.document.querySelector('main');
    for (const [scope, names] of [['otp', ['otpEnabled', 'otpSecret', 'otpCode']], ['oidc', ['mode', 'issuer', 'clientId', 'clientSecret', 'redirectUri']]]) {
      root.replaceChildren(); await renderAuthenticationSettings(root, scope);
      expect([...root.querySelectorAll('[name]')].map(input => input.name)).toEqual(names);
      expect(root.querySelectorAll('button[type="submit"]')).toHaveLength(1);
      if (scope === 'oidc') {
        expect(root.querySelector('[name="redirectUri"]').readOnly).toBe(true);
        expect(root.querySelector('[name="subjects"]')).toBeNull();
      }
    }
    root.replaceChildren(); await renderAccessSettings(root, value => value);
    expect(root.querySelectorAll('form')).toHaveLength(2);
    expect(root.querySelector('[name="otpSecret"]')).toBeNull();
    root.replaceChildren(); await renderAccessSettings(root, value => value, 'domain-settings');
    expect(root.querySelector('[name="publicOrigin"]')).toBeNull();
    expect(root.querySelectorAll('input')).toHaveLength(1);
    expect(root.querySelector('input[type="password"]')).toBeNull();
  } finally { vi.unstubAllGlobals(); dom.window.close(); }
});

test('local login defaults to enabled and changes preserve remote authentication', () => {
  const previous = { ...settings(), otpSecret: 'A'.repeat(32), mode: 'oidc', issuer: 'https://identity.example.com' };
  const next = updateAuthenticationSettings(previous, { scope: 'local', localAuthRequired: 'false' });
  expect(next).toEqual({ ...previous, localAuthRequired: 'false' });
  expect(() => validateAuthenticationSettings({ ...settings(), localAuthRequired: 'invalid' }, { domain: '', passwordConfigured: true })).toThrow();
  expect(oidcCallbackAddress('codex.example.com', previous)).toBe('https://codex.example.com/api/auth/oidc/callback');
});
