import { expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boundDomainRequest, loadBoundDomain, normalizeBoundDomain, saveBoundDomain } from '../server/access-policy.js';
import { createStoredPassword, isAuthorizedHttpRequest, isLocalAuthManagementRequest, isSameOrigin, storedPasswordSessionSecret } from '../server/server-security.js';

const request = (host: string, headers = {}, address = '192.168.1.2') => ({ socket: { remoteAddress: address }, headers: { host, ...headers } });
const domain = 'codex.example.com';

test('only direct 127.0.0.1 and the bound domain can access HTTP or upgrade authentication', () => {
  expect(boundDomainRequest(request('127.0.0.1:8899', {}, '127.0.0.1'), '')).not.toBeNull();
  for (const host of ['[::1]:8899', '192.168.1.2:8899', 'other.example.com', '127.1:8899']) {
    expect(boundDomainRequest(request(host, {}, '127.0.0.1'), domain)).toBeNull();
  }
  expect(boundDomainRequest(request(domain), '')).toBeNull();
  expect(boundDomainRequest(request(domain), domain)).not.toBeNull();
  expect(boundDomainRequest(request(`${domain}:8899`), domain)).not.toBeNull();
  expect(boundDomainRequest(request(`${domain}.evil.example`), domain)).toBeNull();
  expect(boundDomainRequest(request('127.0.0.1:8899'), domain)).toBeNull();
  expect(boundDomainRequest(request('127.0.0.1:8899', { 'x-forwarded-for': '192.168.1.2' }, '127.0.0.1'), domain)).toBeNull();
});

test('bound forwarded domain supports authentication without granting local management or accepting foreign origins', () => {
  const credential = { ...createStoredPassword('long example password'), username: 'codex' };
  const secret = storedPasswordSessionSecret(credential);
  const raw = request('127.0.0.1:8899', {
    'x-forwarded-host': domain,
    origin: `https://${domain}`,
    authorization: `Basic ${Buffer.from('codex:long example password').toString('base64')}`,
  }, '127.0.0.1');
  const forwarded = boundDomainRequest(raw, domain)!;
  expect(isAuthorizedHttpRequest(forwarded, secret, false, credential)).toBe(true);
  expect(isLocalAuthManagementRequest(raw)).toBe(false);
  expect(isLocalAuthManagementRequest(forwarded)).toBe(false);
  expect(isSameOrigin(raw.headers.origin, forwarded.headers.host)).toBe(true);
  expect(isAuthorizedHttpRequest({ ...forwarded, headers: { ...forwarded.headers, origin: 'https://evil.example' } }, secret, false, credential)).toBe(false);
  expect(isAuthorizedHttpRequest({ ...forwarded, headers: { ...forwarded.headers, authorization: undefined } }, secret, false, credential)).toBe(false);
  for (const host of ['other.example.com', '127.0.0.1', `${domain}, other.example.com`]) {
    expect(boundDomainRequest(request('internal:8899', { 'x-forwarded-host': host }), domain)).toBeNull();
  }
});

test('validates and persists domain changes independently of credentials', () => {
  const root = mkdtempSync(join(tmpdir(), 'webui-domain-'));
  const path = join(root, 'access.json');
  try {
    expect(loadBoundDomain(path)).toBe('');
    expect(normalizeBoundDomain(' CODEX.EXAMPLE.COM ')).toBe(domain);
    for (const invalid of ['https://codex.example.com', 'codex.example.com/path', 'codex.example.com:443', '127.0.0.1', '*.example.com', 'localhost', 'bad_.example', null]) {
      expect(() => normalizeBoundDomain(invalid)).toThrow();
    }
    saveBoundDomain(path, domain);
    expect(loadBoundDomain(path)).toBe(domain);
    saveBoundDomain(path, 'other.example.com');
    expect(loadBoundDomain(path)).toBe('other.example.com');
    saveBoundDomain(path, '');
    expect(loadBoundDomain(path)).toBe('');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('cross-site OIDC returns can reach loopback pages without gaining settings access', () => {
  for (const path of ['/api/auth/oidc/callback', '/settings/oidc-settings']) {
    const local = { ...request('127.0.0.1:8899', { 'sec-fetch-site': 'cross-site' }, '127.0.0.1'), url: path };
    expect(boundDomainRequest(local, domain)).toBe(local);
    expect(isLocalAuthManagementRequest(local)).toBe(false);
  }
  const foreignOrigin = request('127.0.0.1:8899', { origin: 'https://identity.example.com' }, '127.0.0.1');
  expect(boundDomainRequest(foreignOrigin, domain)).toBe(foreignOrigin);
  expect(isLocalAuthManagementRequest(foreignOrigin)).toBe(false);
  expect(boundDomainRequest(request('127.0.0.1:8899', { 'x-forwarded-for': '192.168.1.2', 'sec-fetch-site': 'cross-site' }, '127.0.0.1'), domain)).toBeNull();
});

test('environment domain enables initial remote access while saved choices retain precedence', () => {
  const root = mkdtempSync(join(tmpdir(), 'webui-environment-domain-'));
  const path = join(root, 'access.json');
  const env = { CODEX_WEBUI_DOMAIN: 'initial.example.com' };
  try {
    expect(loadBoundDomain(path, env)).toBe('initial.example.com');
    expect(boundDomainRequest(request('initial.example.com'), loadBoundDomain(path, env))).not.toBeNull();
    expect(() => loadBoundDomain(path, { CODEX_WEBUI_DOMAIN: 'https://bad.example.com' })).toThrow();
    saveBoundDomain(path, 'saved.example.com');
    expect(loadBoundDomain(path, env)).toBe('saved.example.com');
    saveBoundDomain(path, '');
    expect(loadBoundDomain(path, env)).toBe('');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
