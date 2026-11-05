import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as oidc from 'openid-client';
import { TOTP, Secret } from 'otpauth';
import { isLocalAuthManagementRequest, isAuthorizedHttpRequest, parseCookieHeader } from './server-security.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');
const equal = (a, b) => {
  const left = Buffer.from(a || ''), right = Buffer.from(b || '');
  return left.length === right.length && timingSafeEqual(left, right);
};

export function authenticationConfig(env = process.env) {
  const issuer = env.CODEX_WEBUI_OIDC_ISSUER;
  const mode = env.CODEX_WEBUI_AUTH_MODE || (issuer ? 'oidc' : 'password');
  if (!['password', 'oidc', 'both'].includes(mode)) throw new Error('Invalid CODEX_WEBUI_AUTH_MODE');
  let provider = null;
  if (issuer) {
    const issuerUrl = new URL(issuer);
    const redirectUri = new URL(env.CODEX_WEBUI_OIDC_REDIRECT_URI || '');
    if (issuerUrl.protocol !== 'https:' || issuerUrl.username || issuerUrl.password || issuerUrl.search || issuerUrl.hash
      || !['http:', 'https:'].includes(redirectUri.protocol) || redirectUri.username || redirectUri.password || redirectUri.search || redirectUri.hash
      || redirectUri.pathname !== '/api/auth/oidc/callback') throw new Error('OIDC requires HTTPS issuer and /api/auth/oidc/callback redirect URI');
    if (!env.CODEX_WEBUI_OIDC_CLIENT_ID || !env.CODEX_WEBUI_OIDC_CLIENT_SECRET) {
      throw new Error('OIDC requires client ID and client secret');
    }
    provider = { issuer: issuerUrl.href, redirectUri: redirectUri.href, clientId: env.CODEX_WEBUI_OIDC_CLIENT_ID, clientSecret: env.CODEX_WEBUI_OIDC_CLIENT_SECRET };
  }
  if (mode !== 'password' && !provider) throw new Error('OIDC configuration is required for this authentication mode');
  let totp = null;
  if (env.CODEX_WEBUI_OTP_SECRET) {
    const value = env.CODEX_WEBUI_OTP_SECRET.replace(/\s/g, '').toUpperCase();
    if (!/^[A-Z2-7]{32,}$/.test(value)) throw new Error('OTP secret must contain at least 160 bits encoded as Base32');
    totp = new TOTP({ issuer: 'Codex WebUI', label: 'admin', algorithm: 'SHA1', digits: 6, period: 30, secret: Secret.fromBase32(value) });
  }
  return { mode, provider, totp, ttlMs: 8 * 60 * 60 * 1000 };
}

// Opaque server-side sessions cannot be forged using a password or a stored password hash.
export function createAuthentication(config, { now = Date.now, discover = oidc.discovery } = {}) {
  const sessions = new Map(), attempts = new Map(), flows = new Map();
  let lastOtpStep = -1;
  const discoveries = new Map();
  const prune = map => { for (const [key, value] of map) if (value.expiresAt <= now()) map.delete(key); };
  const cookie = (token, secure, maxAge = config.ttlMs / 1000) => `codex_webui_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  const sessionFor = req => {
    prune(sessions);
    const token = parseCookieHeader(req.headers.cookie).codex_webui_session;
    return token ? sessions.get(digest(token)) : null;
  };
  const client = async redirectUri => {
    const protocol = new URL(redirectUri).protocol;
    if (!discoveries.has(protocol)) {
      discoveries.set(protocol, discover(new URL(config.provider.issuer), config.provider.clientId, config.provider.clientSecret)
        .then(configuration => {
          oidc.enableNonRepudiationChecks(configuration);
          if (protocol === 'http:') oidc.allowInsecureRequests(configuration);
          return configuration;
        }).catch(error => { discoveries.delete(protocol); throw error; }));
    }
    return discoveries.get(protocol);
  };
  return {
    sessionFor,
    issue(secure, { verified = false } = {}) {
      prune(sessions);
      if (sessions.size >= 1000) throw new Error('Too many active sessions');
      const token = random(), session = { expiresAt: now() + config.ttlMs, revoked: false, verifiedAt: verified ? now() : 0 };
      sessions.set(digest(token), session);
      return cookie(token, secure);
    },
    logout(req, secure) {
      const token = parseCookieHeader(req.headers.cookie).codex_webui_session;
      const session = sessionFor(req);
      if (session) session.revoked = true;
      if (token) sessions.delete(digest(token));
      return cookie('', secure, 0);
    },
    revokeAll() { for (const session of sessions.values()) session.revoked = true; sessions.clear(); },
    // Use the TCP peer, never spoofable forwarding headers. Include a global ceiling for distributed attempts.
    allowAttempt(address) {
      prune(attempts);
      const keys = ['global', `peer:${address}`];
      if (keys.some(key => (attempts.get(key)?.count || 0) >= (key === 'global' ? 100 : 10))) return false;
      if (attempts.size >= 10000 && !attempts.has(keys[1])) return false;
      for (const key of keys) {
        const record = attempts.get(key) || { count: 0, expiresAt: now() + 5 * 60_000 };
        record.count++; attempts.set(key, record);
      }
      return true;
    },
    verifyOtp(token) {
      if (!config.totp) return true;
      if (typeof token !== 'string' || !/^\d{6}$/.test(token)) return false;
      const timestamp = now();
      const delta = config.totp.validate({ token, timestamp, window: 1 });
      if (delta === null) return false;
      const step = Math.floor(timestamp / 30000) + delta;
      if (step <= lastOtpStep) return false;
      lastOtpStep = step;
      return true;
    },
    async startOidc(redirectUri = config.provider.redirectUri) {
      prune(flows);
      if (flows.size >= 1000) throw new Error('Too many login attempts');
      const verifier = oidc.randomPKCECodeVerifier(), state = oidc.randomState(), nonce = oidc.randomNonce(), browser = random();
      const challenge = await oidc.calculatePKCECodeChallenge(verifier);
      const url = oidc.buildAuthorizationUrl(await client(redirectUri), { redirect_uri: redirectUri, scope: 'openid', response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state, nonce });
      flows.set(state, { redirectUri, verifier, nonce, browser: digest(browser), expiresAt: now() + 5 * 60_000 });
      return { url: url.href, cookie: `codex_webui_oidc=${browser}; Path=/api/auth/oidc; HttpOnly;${redirectUri.startsWith('https:') ? ' Secure;' : ''} SameSite=Lax; Max-Age=300` };
    },
    async finishOidc(url, req) {
      prune(flows);
      if (url.searchParams.getAll('state').length !== 1) throw new Error('Invalid OIDC state');
      const state = url.searchParams.get('state'), flow = flows.get(state);
      const browser = parseCookieHeader(req.headers.cookie).codex_webui_oidc;
      if (!flow || !browser || !equal(flow.browser, digest(browser))) throw new Error('Invalid OIDC login');
      if (`${url.origin}${url.pathname}` !== flow.redirectUri) throw new Error('OIDC callback address mismatch');
      flows.delete(state);
      const tokens = await oidc.authorizationCodeGrant(await client(flow.redirectUri), url, { pkceCodeVerifier: flow.verifier, expectedState: state, expectedNonce: flow.nonce, idTokenExpected: true });
      const claims = tokens.claims();
      if (!claims || typeof claims.sub !== 'string' || !claims.sub) throw new Error('Invalid OIDC identity');

    },
  };
}

export function authorizeAuthenticationRequest(req, authentication, config, accessToken) {
  if (authentication.sessionFor(req)) return true;
  return Boolean(accessToken && !config.totp && config.mode === 'password'
    && req.headers.authorization?.startsWith('Bearer ')
    && isAuthorizedHttpRequest(req, accessToken, false));
}

export function authenticationRequirements(req, config, localAuthRequired = 'true') {
  const local = isLocalAuthManagementRequest(req);
  return {
    local,
    loginRequired: !local || localAuthRequired !== 'false',
    passwordEnabled: local || config.mode !== 'oidc',
    oidcEnabled: !local && Boolean(config.provider) && config.mode !== 'password',
    otpRequired: !local && Boolean(config.totp) && config.mode !== 'oidc',
  };
}
