import { describe, expect, test } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import * as oidc from 'openid-client';
import { authenticationConfig, createAuthentication, authorizeAuthenticationRequest } from '../authentication.js';
import { createPasswordSession } from '../server-security.js';

const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const request = (headers = {}) => ({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:8899', ...headers } });
const cookieOf = value => value.split(';')[0];
const oidcEnv = {
  CODEX_WEBUI_OIDC_ISSUER: 'https://identity.example.com',
  CODEX_WEBUI_OIDC_CLIENT_ID: 'codex', CODEX_WEBUI_OIDC_CLIENT_SECRET: 'test-client-secret',
  CODEX_WEBUI_OIDC_REDIRECT_URI: 'https://codex.example.com/api/auth/oidc/callback',
  CODEX_WEBUI_OIDC_ALLOWED_SUBJECTS: 'admin-subject',
};

describe('authentication boundary', () => {
  test('fails closed on incomplete, insecure or unrestricted configuration', () => {
    expect(authenticationConfig({}).mode).toBe('password');
    expect(authenticationConfig(oidcEnv).mode).toBe('oidc');
    for (const env of [
      { CODEX_WEBUI_AUTH_MODE: 'oidc' }, { CODEX_WEBUI_AUTH_MODE: 'typo' },
      { ...oidcEnv, CODEX_WEBUI_OIDC_ISSUER: 'http://identity.example.com' },
      { ...oidcEnv, CODEX_WEBUI_OIDC_ALLOWED_SUBJECTS: '' },
      { ...oidcEnv, CODEX_WEBUI_OIDC_REDIRECT_URI: 'https://codex.example.com/wrong' },
      { CODEX_WEBUI_OTP_SECRET: 'short' },
    ]) expect(() => authenticationConfig(env)).toThrow();
  });

  test('local requests, password authorization and legacy signed cookies cannot bypass login or MFA', () => {
    const config = authenticationConfig({ CODEX_WEBUI_OTP_SECRET: secret });
    const auth = createAuthentication(config);
    const legacy = createPasswordSession('machine-secret');
    for (const req of [request(), request({ authorization: 'Bearer machine-secret' }), request({ authorization: `Basic ${Buffer.from('codex:machine-secret').toString('base64')}` }), request({ cookie: `codex_webui_session=${legacy.token}` })]) {
      expect(authorizeAuthenticationRequest(req, auth, config, 'machine-secret')).toBe(false);
    }
    const cookie = cookieOf(auth.issue(true));
    expect(authorizeAuthenticationRequest(request({ cookie }), auth, config, 'machine-secret')).toBe(true);
    const plain = authenticationConfig({});
    expect(authorizeAuthenticationRequest(request({ authorization: 'Bearer machine-secret' }), auth, plain, 'machine-secret')).toBe(true);
    expect(authorizeAuthenticationRequest(request({ authorization: 'Bearer machine-secret' }), auth, authenticationConfig(oidcEnv), 'machine-secret')).toBe(false);
  });

  test('sessions expire, logout revokes captured connections and rotation revokes all sessions', () => {
    let time = 1000000;
    const config = authenticationConfig({});
    const auth = createAuthentication(config, { now: () => time });
    const cookie = cookieOf(auth.issue(true)), req = request({ cookie });
    const connectionSession = auth.sessionFor(req);
    expect(auth.issue(true)).toContain('HttpOnly; SameSite=Strict');
    expect(auth.issue(true)).toContain('; Secure');
    expect(auth.sessionFor(request({ cookie: cookie + 'tampered' }))).toBeFalsy();
    auth.logout(req, true);
    expect(connectionSession.revoked).toBe(true);
    expect(auth.sessionFor(req)).toBeFalsy();
    const second = request({ cookie: cookieOf(auth.issue(false)) });
    time += config.ttlMs;
    expect(auth.sessionFor(second)).toBeFalsy();
    const third = request({ cookie: cookieOf(auth.issue(false)) });
    const thirdConnection = auth.sessionFor(third);
    auth.revokeAll();
    expect(thirdConnection.revoked).toBe(true);
    expect(auth.sessionFor(third)).toBeFalsy();
  });

  test('TOTP matches RFC 6238, rejects incorrect codes and prevents reuse', () => {
    const config = authenticationConfig({ CODEX_WEBUI_OTP_SECRET: secret });
    const auth = createAuthentication(config, { now: () => 59000 });
    expect(auth.verifyOtp('123')).toBe(false);
    expect(auth.verifyOtp('000000')).toBe(false);
    expect(auth.verifyOtp('287082')).toBe(true);
    expect(auth.verifyOtp('287082')).toBe(false);
    expect(auth.verifyOtp(config.totp.generate({ timestamp: 59000 - 30000 }))).toBe(false);
  });

  test('rate limits peers and distributed attempts, with finite recovery', () => {
    let time = 1;
    const auth = createAuthentication(authenticationConfig({}), { now: () => time });
    for (let i = 0; i < 10; i++) expect(auth.allowAttempt('peer')).toBe(true);
    expect(auth.allowAttempt('peer')).toBe(false);
    for (let i = 0; i < 90; i++) expect(auth.allowAttempt(`peer-${i}`)).toBe(true);
    expect(auth.allowAttempt('new-peer')).toBe(false);
    time += 300000;
    expect(auth.allowAttempt('peer')).toBe(true);
  });
});

// Exercise the real OIDC library with signed ID tokens; no external identity provider is contacted.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
function providerHarness(subject = 'admin-subject', overrides = {}, badSignature = false) {
  const config = authenticationConfig(oidcEnv);
  let nonce, tokenRequests = 0;
  const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  const mockFetch = async (input, options) => {
    const url = String(input);
    if (url.includes('.well-known')) return json({
      issuer: 'https://identity.example.com/', authorization_endpoint: 'https://identity.example.com/authorize',
      token_endpoint: 'https://identity.example.com/token', jwks_uri: 'https://identity.example.com/jwks',
      response_types_supported: ['code'], id_token_signing_alg_values_supported: ['RS256'],
      token_endpoint_auth_methods_supported: ['client_secret_post'],
    });
    if (url.endsWith('/jwks')) return json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'key', alg: 'RS256', use: 'sig' }] });
    if (url.endsWith('/token')) {
      tokenRequests++;
      expect(String(options.body)).toContain('code_verifier=');
      const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'key' })).toString('base64url');
      const body = Buffer.from(JSON.stringify({ iss: 'https://identity.example.com/', aud: 'codex', sub: subject, nonce, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, ...overrides })).toString('base64url');
      const data = `${head}.${body}`;
      return json({ access_token: 'test-access', token_type: 'Bearer', id_token: `${data}.${sign('RSA-SHA256', Buffer.from(badSignature ? data + 'tampered' : data), privateKey).toString('base64url')}` });
    }
    throw new Error('Unexpected provider URL');
  };
  const auth = createAuthentication(config, { discover: (issuer, id, clientSecret) => oidc.discovery(issuer, id, clientSecret, undefined, { [oidc.customFetch]: mockFetch }) });
  return { auth, tokenRequests: () => tokenRequests, async flow() {
    const flow = await auth.startOidc(), url = new URL(flow.url);
    nonce = url.searchParams.get('nonce');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const callback = new URL(config.provider.redirectUri);
    callback.searchParams.set('state', url.searchParams.get('state'));
    callback.searchParams.set('code', 'test-code');
    return { callback, req: request({ cookie: cookieOf(flow.cookie) }) };
  } };
}

describe('OIDC authorization code flow', () => {
  test('accepts a signed allowed identity once, using PKCE and browser-bound state', async () => {
    const provider = providerHarness();
    const { callback, req } = await provider.flow();
    await expect(provider.auth.finishOidc(callback, request())).rejects.toThrow();
    expect(provider.tokenRequests()).toBe(0);
    await provider.auth.finishOidc(callback, req);
    expect(provider.tokenRequests()).toBe(1);
    await expect(provider.auth.finishOidc(callback, req)).rejects.toThrow();
  });
  test('rejects unlisted subjects and incorrect nonce, audience, issuer or expiry', async () => {
    for (const [sub, claims] of [
      ['other-user', {}], ['admin-subject', { nonce: 'wrong' }], ['admin-subject', { aud: 'wrong' }],
      ['admin-subject', { iss: 'https://attacker.example.com' }], ['admin-subject', { exp: 1 }],
    ]) {
      const provider = providerHarness(sub, claims);
      const { callback, req } = await provider.flow();
      await expect(provider.auth.finishOidc(callback, req)).rejects.toThrow();
    }
  });
  test('rejects an ID token with a forged signature', async () => {
    const provider = providerHarness('admin-subject', {}, true);
    const { callback, req } = await provider.flow();
    await expect(provider.auth.finishOidc(callback, req)).rejects.toThrow();
  });
  test('rejects unknown state before contacting token endpoint', async () => {
    const provider = providerHarness();
    const { callback, req } = await provider.flow(); callback.searchParams.set('state', 'attacker');
    await expect(provider.auth.finishOidc(callback, req)).rejects.toThrow();
    expect(provider.tokenRequests()).toBe(0);
  });
});
