import { afterEach, describe, expect, test, vi } from 'vitest';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { createPasskeyService } from '../server/passkey-service.js';
import { createPasskeyRoutes, passkeyRequestContext } from '../server/passkey-routes.js';
import { authenticationConfig, createAuthentication } from '../server/authentication.js';
import { usePasskey } from '../public/passkey-client.js';
import { isLocalAuthManagementRequest } from '../server/server-security.js';

const local = { rpID: 'localhost', origin: 'http://localhost:8899' };
const remote = { rpID: 'codex.example.com', origin: 'https://codex.example.com' };
const directories: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'webui-passkeys-')); directories.push(directory);
  const path = join(directory, 'auth.json.passkeys.json');
  let time = Date.now();
  const service = createPasskeyService({ path, now: () => time });
  const session = { revoked: false, verifiedAt: time };
  return { path, service, session, advance: (ms: number) => { time += ms; } };
}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest();
function authenticator() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const key = publicKey.export({ format: 'jwk' });
  const id = randomBytes(32), credentialId = id.toString('base64url');
  const cose = isoCBOR.encode(new Map<number, any>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(key.x!, 'base64url')], [-3, Buffer.from(key.y!, 'base64url')]]));
  let userHandle: string;
  const data = (rpID: string, flags: number, counter: number) => {
    const count = Buffer.alloc(4); count.writeUInt32BE(counter);
    return Buffer.concat([hash(rpID), Buffer.from([flags]), count]);
  };
  return {
    id: credentialId,
    registration(options: any, context = local, verified = true) {
      userHandle = options.user.id;
      const length = Buffer.alloc(2); length.writeUInt16BE(id.length);
      const authData = Buffer.concat([data(context.rpID, verified ? 0x45 : 0x41, 0), Buffer.alloc(16), length, id, cose]);
      const client = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: context.origin, crossOrigin: false }));
      const attestation = isoCBOR.encode(new Map<string, any>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
      return { id: credentialId, rawId: credentialId, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: client.toString('base64url'), attestationObject: Buffer.from(attestation).toString('base64url'), transports: ['internal'] } };
    },
    assertion(options: any, { context = local, counter = 1, verified = true, badSignature = false, challenge = options.challenge, handle = userHandle } = {}) {
      const authData = data(context.rpID, verified ? 0x05 : 0x01, counter);
      const client = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: context.origin, crossOrigin: false }));
      const signature = sign('sha256', Buffer.concat([authData, hash(client)]), privateKey);
      if (badSignature) signature[signature.length - 1] ^= 1;
      return { id: credentialId, rawId: credentialId, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: client.toString('base64url'), authenticatorData: authData.toString('base64url'), signature: signature.toString('base64url'), userHandle: handle } };
    },
  };
}
async function enrolled(context = local) {
  const f = fixture(), device = authenticator();
  const flow = await f.service.beginRegistration(context, f.session, 'My device');
  await f.service.finishRegistration(context, f.session, flow.token, device.registration(flow.options, context));
  return { ...f, device };
}

describe('real WebAuthn registration and signatures', () => {
  test.each([local, remote])('registers and signs in on $origin, persisting only public credentials', async context => {
    const f = await enrolled(context);
    const login = await f.service.beginAuthentication(context);
    expect(login.options.userVerification).toBe('required');
    await f.service.finishAuthentication(context, login.token, f.device.assertion(login.options, { context }));
    const stored = JSON.parse(readFileSync(f.path, 'utf8'));
    expect(stored.credentials[0].counter).toBe(1);
    expect(statSync(f.path).mode & 0o777).toBe(0o600);
    expect(f.service.list(context.rpID)[0]).toMatchObject({ name: 'My device' });
    expect(JSON.stringify(f.service.list(context.rpID))).not.toContain(stored.credentials[0].publicKey);
    expect(createPasskeyService({ path: f.path }).has(context.rpID)).toBe(true);
    await expect(f.service.finishAuthentication(context, login.token, f.device.assertion(login.options, { context }))).rejects.toThrow();
  });

  test('rejects registration without device verification, wrong sessions and reused challenges', async () => {
    const f = fixture(), device = authenticator();
    const first = await f.service.beginRegistration(local, f.session);
    await expect(f.service.finishRegistration(local, f.session, first.token, device.registration(first.options, local, false))).rejects.toThrow();
    const second = await f.service.beginRegistration(local, f.session);
    await expect(f.service.finishRegistration(local, {}, second.token, device.registration(second.options))).rejects.toThrow();
    await expect(f.service.finishRegistration(local, f.session, second.token, device.registration(second.options))).rejects.toThrow();
    expect(f.service.has(local.rpID)).toBe(false);
  });

  test.each(['signature', 'challenge', 'origin', 'rpID', 'verification', 'userHandle'])('rejects an invalid %s', async invalid => {
    const f = await enrolled();
    const flow = await f.service.beginAuthentication(local);
    const options: any = { badSignature: invalid === 'signature', verified: invalid !== 'verification' };
    if (invalid === 'challenge') options.challenge = randomBytes(32).toString('base64url');
    if (invalid === 'origin') options.context = { ...local, origin: 'https://evil.example' };
    if (invalid === 'rpID') options.context = { ...local, rpID: 'evil.example' };
    if (invalid === 'userHandle') options.handle = randomBytes(32).toString('base64url');
    await expect(f.service.finishAuthentication(local, flow.token, f.device.assertion(flow.options, options))).rejects.toThrow();
    expect(JSON.parse(readFileSync(f.path, 'utf8')).credentials[0].counter).toBe(0);
  });

  test('expires challenges, isolates RP IDs and invalidates removed credentials', async () => {
    const f = await enrolled();
    const expired = await f.service.beginAuthentication(local); f.advance(300001);
    await expect(f.service.finishAuthentication(local, expired.token, f.device.assertion(expired.options))).rejects.toThrow();
    const isolated = await f.service.beginAuthentication(remote);
    expect(isolated.options.allowCredentials).toEqual([]);
    await expect(f.service.finishAuthentication(remote, isolated.token, f.device.assertion(isolated.options, { context: remote }))).rejects.toThrow();
    const pending = await f.service.beginAuthentication(local);
    f.service.remove(local.rpID, f.device.id);
    await expect(f.service.finishAuthentication(local, pending.token, f.device.assertion(pending.options))).rejects.toThrow();
    expect(createPasskeyService({ path: f.path }).has(local.rpID)).toBe(false);
  });

  test('rejects non-increasing signature counters and concurrent stale updates', async () => {
    const f = await enrolled();
    const first = await f.service.beginAuthentication(local);
    await f.service.finishAuthentication(local, first.token, f.device.assertion(first.options));
    const repeated = await f.service.beginAuthentication(local);
    await expect(f.service.finishAuthentication(local, repeated.token, f.device.assertion(repeated.options))).rejects.toThrow();
    const a = await f.service.beginAuthentication(local), b = await f.service.beginAuthentication(local);
    const result = await Promise.allSettled([
      f.service.finishAuthentication(local, a.token, f.device.assertion(a.options, { counter: 2 })),
      f.service.finishAuthentication(local, b.token, f.device.assertion(b.options, { counter: 2 })),
    ]);
    expect(result.filter(item => item.status === 'fulfilled')).toHaveLength(1);
  });

  test('does not accept a registration after its authorizing session is revoked', async () => {
    const f = fixture(), device = authenticator();
    const flow = await f.service.beginRegistration(local, f.session); f.session.revoked = true;
    await expect(f.service.finishRegistration(local, f.session, flow.token, device.registration(flow.options))).rejects.toThrow();
  });
});

function request(host = 'localhost:8899', extra = {}) {
  return { method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: { host, origin: `http://${host}`, ...extra } };
}
function harness(f: ReturnType<typeof fixture>, context = local) {
  const authentication = createAuthentication(authenticationConfig({}));
  const state = { authentication, domain: remote.rpID, publicOrigin: null, configured: true };
  const sessionCookie = authentication.issue(context.origin.startsWith('https:'), { verified: true }).split(';')[0];
  const issueBrowserSession = vi.fn((req, res, verified, extra, secure) => { res.status = 200; res.body = { ok: true, verified, secure }; res.cookie = extra; });
  const handler = createPasskeyRoutes({ passkeys: f.service, getState: () => state,
    authorizedRequest: req => Boolean(authentication.sessionFor(req)), sameOriginRequest: () => true,
    readJsonBody: async req => req.body || {},
    sendAuthError: (res, status, error) => { res.status = status; res.body = { error }; }, issueBrowserSession, revokeConnections: vi.fn() });
  async function call(path: string, { cookie = '', body = {}, method = 'POST', origin = context.origin } = {}) {
    const req = { ...request(new URL(context.origin).host), method, body, headers: { host: new URL(context.origin).host, origin, cookie } };
    const res: any = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(data) { this.body = JSON.parse(data); } };
    await handler(req, res, new URL(path, context.origin)); return res;
  }
  return { call, sessionCookie, authentication, state, issueBrowserSession };
}

describe('Passkey HTTP security boundary', () => {
  test('supports direct localhost but rejects forwarded, cross-origin, IP-shaped and non-local requests', () => {
    expect(isLocalAuthManagementRequest(request())).toBe(true);
    expect(passkeyRequestContext(request('127.0.0.1:8899'), { domain: '', publicOrigin: null })).toMatchObject({ rpID: 'localhost', useLocalhost: true });
    expect(isLocalAuthManagementRequest(request('localhost:8899', { 'x-forwarded-for': '127.0.0.1' }))).toBe(false);
    expect(isLocalAuthManagementRequest(request('localhost:8899', { origin: 'https://evil.example' }))).toBe(false);
    expect(passkeyRequestContext({ ...request(), socket: { remoteAddress: '192.168.1.2' } }, { domain: '', publicOrigin: null })).toBeNull();
    expect(passkeyRequestContext(request('localhost.attacker.example:8899'), { domain: '', publicOrigin: null })).toBeNull();
    expect(passkeyRequestContext(request('localhost:999999999'), { domain: '', publicOrigin: null })).toBeNull();
    expect(passkeyRequestContext(request(remote.rpID), { domain: remote.rpID, publicOrigin: null })).toMatchObject({ rpID: remote.rpID, origin: remote.origin });
  });

  test('requires a verified recent cookie session for enrollment, not a bypassed or unverified session', async () => {
    const f = fixture(), h = harness(f);
    expect((await h.call('/api/auth/passkeys/register/options')).status).toBe(401);
    const cookie = h.authentication.issue(false).split(';')[0];
    expect((await h.call('/api/auth/passkeys/register/options', { cookie })).status).toBe(403);
    const session = h.authentication.sessionFor({ headers: { cookie: h.sessionCookie } }); session.verifiedAt -= 300001;
    expect((await h.call('/api/auth/passkeys/register/options', { cookie: h.sessionCookie })).status).toBe(403);
  });

  test('rejects cross-origin operations and HTTP remote origins, and enforces rate limits', async () => {
    const f = fixture(), h = harness(f);
    expect((await h.call('/api/auth/passkeys/register/options', { cookie: h.sessionCookie, origin: 'https://evil.example' })).status).toBe(403);
    const https = harness(f, remote);
    expect((await https.call('/api/auth/passkeys/login/options', { origin: 'http://codex.example.com' })).status).toBe(403);
    for (let i = 0; i < 10; i++) h.authentication.allowAttempt('127.0.0.1');
    expect((await h.call('/api/auth/passkeys/register/options', { cookie: h.sessionCookie })).status).toBe(429);
  });

  test('rejects remote enrollment and management even with a recently verified session', async () => {
    const f = fixture(), h = harness(f, remote);
    for (const [path, method] of [
      ['/api/auth/passkeys/register/options', 'POST'],
      ['/api/auth/passkeys/register/verify', 'POST'],
      ['/api/auth/passkeys', 'GET'],
      ['/api/auth/passkeys', 'DELETE'],
    ]) {
      expect((await h.call(path, { method, cookie: h.sessionCookie })).status).toBe(403);
    }
  });

  test('binds verification to an HttpOnly browser cookie and issues a verified secure remote session', async () => {
    const f = await enrolled(remote), h = harness(f, remote);
    const flow = await h.call('/api/auth/passkeys/login/options');
    expect(flow.headers['set-cookie']).toContain('HttpOnly; SameSite=Strict');
    expect(flow.headers['set-cookie']).toContain('; Secure');
    const assertion = f.device.assertion(flow.body, { context: remote });
    expect((await h.call('/api/auth/passkeys/login/verify', { body: assertion })).status).toBe(400);
    const result = await h.call('/api/auth/passkeys/login/verify', { body: assertion, cookie: flow.headers['set-cookie'].split(';')[0] });
    expect(result.body).toMatchObject({ ok: true, verified: true, secure: true });
    expect(result.cookie).toContain('Max-Age=0');
  });
});


test('browser adapter exchanges real signed assertions with the server route', async () => {
  const f = await enrolled(), h = harness(f);
  let flowCookie = '';
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('PublicKeyCredential', class {});
  vi.stubGlobal('fetch', async (path, init) => {
    const result = await h.call(path, { method: init.method, body: JSON.parse(init.body || '{}'), cookie: flowCookie });
    if (result.headers?.['set-cookie']) flowCookie = result.headers['set-cookie'].split(';')[0];
    return { ok: result.status === 200, json: async () => result.body };
  });
  vi.stubGlobal('navigator', { credentials: {
    create: vi.fn(),
    get: async ({ publicKey }) => {
      expect(publicKey.challenge).toBeInstanceOf(Uint8Array);
      expect(publicKey.allowCredentials[0].id).toBeInstanceOf(Uint8Array);
      const result = f.device.assertion({ challenge: Buffer.from(publicKey.challenge).toString('base64url') });
      return { ...result, rawId: Buffer.from(result.rawId, 'base64url'), getClientExtensionResults: () => ({}),
        response: Object.fromEntries(Object.entries(result.response).map(([key, value]) => [key, value ? Buffer.from(value as string, 'base64url') : null])) };
    },
  } });
  await expect(usePasskey('login')).resolves.toMatchObject({ ok: true, verified: true });
  expect(JSON.parse(readFileSync(f.path, 'utf8')).credentials[0].counter).toBe(1);
});
