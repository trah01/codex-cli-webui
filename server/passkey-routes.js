import { boundDomainRequest } from './access-policy.js';
import { isDirectLocalRequest, isLocalAuthManagementRequest, parseCookieHeader } from './server-security.js';

export function passkeyRequestContext(req, { domain, publicOrigin }) {
  try {
    const request = boundDomainRequest(req, domain);
    if (!request) return null;
    if (isDirectLocalRequest(req)) {
      const url = new URL(`${req.socket.encrypted ? 'https:' : 'http:'}//${req.headers.host}`);
      const useLocalhost = url.hostname !== 'localhost';
      url.hostname = 'localhost';
      return { rpID: 'localhost', origin: url.origin, useLocalhost };
    }
    const origin = new URL(publicOrigin || `https://${request.headers.host}`);
    if (origin.protocol !== 'https:' || origin.host !== request.headers.host) return null;
    return { rpID: origin.hostname, origin: origin.origin, useLocalhost: false };
  } catch { return null; }
}

export function createPasskeyRoutes({ passkeys, getState, authorizedRequest, sameOriginRequest, readJsonBody, sendAuthError, issueBrowserSession, revokeConnections }) {
  const json = (res, data, headers = {}) => { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(data)); };
  const recent = (authentication, req) => {
    const session = authentication.sessionFor(req);
    return Boolean(session?.verifiedAt && !session.revoked && Date.now() - session.verifiedAt <= 5 * 60_000);
  };
  return async (req, res, url) => {
    if (url.pathname !== '/api/auth/passkeys' && !url.pathname.startsWith('/api/auth/passkeys/')) return false;
    const { authentication, domain, publicOrigin, configured } = getState();
    const context = passkeyRequestContext(req, { domain, publicOrigin });
    if (!context || !configured || !sameOriginRequest(req)) { sendAuthError(res, 403, '请先配置登录方式，并从正确的地址访问。'); return true; }
    if (context.useLocalhost) { sendAuthError(res, 400, '本机通行密钥请通过 localhost 地址使用。'); return true; }
    const method = req.method;
    const listing = url.pathname === '/api/auth/passkeys' && method === 'GET';
    const removing = url.pathname === '/api/auth/passkeys' && method === 'DELETE';
    const registering = ['/api/auth/passkeys/register/options', '/api/auth/passkeys/register/verify'].includes(url.pathname) && method === 'POST';
    const loggingIn = ['/api/auth/passkeys/login/options', '/api/auth/passkeys/login/verify'].includes(url.pathname) && method === 'POST';
    if (!listing && !removing && !registering && !loggingIn) { sendAuthError(res, 405, 'Method not allowed'); return true; }
    if (!loggingIn && !isLocalAuthManagementRequest(req)) { sendAuthError(res, 403, '只能在服务器本机管理通行密钥，远程访问仅支持通行密钥登录。'); return true; }
    if (!listing && req.headers.origin !== context.origin) { sendAuthError(res, 403, 'Invalid request origin'); return true; }
    if (!loggingIn && (!authorizedRequest(req) || (!authentication.sessionFor(req) && !isDirectLocalRequest(req)))) {
      sendAuthError(res, 401, '请先登录。'); return true;
    }
    if (listing) { json(res, { credentials: passkeys.list(context.rpID), recentAuthentication: recent(authentication, req) }); return true; }
    if ((removing || registering) && !recent(authentication, req)) { sendAuthError(res, 403, '请先验证身份，再管理通行密钥。'); return true; }
    if (!authentication.allowAttempt(req.socket.remoteAddress)) { sendAuthError(res, 429, '登录尝试过多，请五分钟后重试。', { 'retry-after': '300' }); return true; }
    const cookie = token => `codex_webui_passkey=${token}; Path=/api/auth/passkeys; HttpOnly; SameSite=Strict; Max-Age=${token ? 300 : 0}${context.origin.startsWith('https:') ? '; Secure' : ''}`;
    try {
      const payload = await readJsonBody(req, 65536);
      const session = authentication.sessionFor(req);
      if (removing) {
        passkeys.remove(context.rpID, payload.id); authentication.revokeAll(); revokeConnections();
        issueBrowserSession(req, res, true, cookie(''), context.origin.startsWith('https:')); return true;
      }
      if (url.pathname.endsWith('/options')) {
        if (loggingIn && !passkeys.has(context.rpID)) throw new Error('当前地址尚未添加通行密钥，请先使用其他方式登录。');
        const flow = registering ? await passkeys.beginRegistration(context, session, payload.name) : await passkeys.beginAuthentication(context);
        if (getState().authentication !== authentication || session?.revoked) throw new Error('认证设置已变更，请重新登录。');
        json(res, flow.options, { 'set-cookie': cookie(flow.token) }); return true;
      }
      const token = parseCookieHeader(req.headers.cookie).codex_webui_passkey;
      if (registering) await passkeys.finishRegistration(context, session, token, payload);
      else await passkeys.finishAuthentication(context, token, payload);
      if (getState().authentication !== authentication || session?.revoked) throw new Error('认证设置已变更，请重新登录。');
      // Session issuance replaces the response headers, so clear the flow cookie separately.
      if (loggingIn) issueBrowserSession(req, res, true, cookie(''), context.origin.startsWith('https:'));
      else json(res, { ok: true }, { 'set-cookie': cookie('') });
    } catch { sendAuthError(res, 400, '通行密钥验证失败，请重新尝试。', { 'set-cookie': cookie('') }); }
    return true;
  };
}
