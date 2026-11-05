import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';

const base64url = value => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
const unavailable = () => new Error('通行密钥验证失败，请重新尝试。');

export function createPasskeyService({ path, now = Date.now, webauthn = { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } }) {
  let store;
  try { store = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  store ||= { version: 1, userID: randomBytes(32).toString('base64url'), credentials: [] };
  if (store.version !== 1 || !base64url(store.userID) || !Array.isArray(store.credentials)
    || store.credentials.some(item => !base64url(item.id) || !base64url(item.publicKey) || typeof item.rpID !== 'string' || !Number.isSafeInteger(item.counter) || item.counter < 0)) throw new Error('通行密钥存储文件格式不正确。');
  const flows = new Map();
  function persist(credentials) {
    const next = { ...store, credentials };
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(next) + '\n', { flag: 'wx', mode: 0o600 });
      renameSync(temporary, path); store = next;
    } finally { try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
  const forRP = rpID => store.credentials.filter(item => item.rpID === rpID);
  function createFlow(type, context, options, session, name) {
    for (const [token, flow] of flows) if (flow.expiresAt <= now() || flow.session?.revoked) flows.delete(token);
    if (flows.size >= 1000) throw unavailable();
    const token = randomBytes(32).toString('base64url');
    flows.set(token, { type, rpID: context.rpID, origin: context.origin, challenge: options.challenge, session, name, expiresAt: now() + 5 * 60_000 });
    return { token, options };
  }
  function consume(type, token, context, session) {
    const flow = flows.get(token); flows.delete(token);
    if (!flow || flow.type !== type || flow.expiresAt <= now() || flow.rpID !== context.rpID || flow.origin !== context.origin
      || (type === 'register' && (flow.session !== session || session?.revoked))) throw unavailable();
    return flow;
  }
  return {
    has: rpID => forRP(rpID).length > 0,
    list: rpID => forRP(rpID).map(({ id, name, createdAt, lastUsedAt }) => ({ id, name, createdAt, lastUsedAt })),
    async beginRegistration(context, session, name = '') {
      if (forRP(context.rpID).length >= 20) throw new Error('最多添加 20 个通行密钥，请先移除不再使用的密钥。');
      if (typeof name !== 'string' || name.length > 80) throw new Error('名称不能超过 80 个字符。');
      const options = await webauthn.generateRegistrationOptions({
        rpName: 'Codex WebUI', rpID: context.rpID, userName: 'Codex WebUI', userID: Buffer.from(store.userID, 'base64url'),
        attestationType: 'none', authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        excludeCredentials: forRP(context.rpID).map(({ id, transports }) => ({ id, transports })),
      });
      return createFlow('register', context, options, session, name.trim() || '通行密钥');
    },
    async finishRegistration(context, session, token, response) {
      const flow = consume('register', token, context, session);
      const result = await webauthn.verifyRegistrationResponse({ response, expectedChallenge: flow.challenge, expectedOrigin: context.origin, expectedRPID: context.rpID, requireUserVerification: true });
      if (!result.verified || !result.registrationInfo?.userVerified || session?.revoked) throw unavailable();
      const { credential } = result.registrationInfo;
      if (store.credentials.some(item => item.id === credential.id) || forRP(context.rpID).length >= 20) throw unavailable();
      persist([...store.credentials, { id: credential.id, publicKey: Buffer.from(credential.publicKey).toString('base64url'), counter: credential.counter,
        transports: credential.transports, rpID: context.rpID, name: flow.name, createdAt: new Date(now()).toISOString(), lastUsedAt: null }]);
    },
    async beginAuthentication(context) {
      const options = await webauthn.generateAuthenticationOptions({ rpID: context.rpID, userVerification: 'required',
        allowCredentials: forRP(context.rpID).map(({ id, transports }) => ({ id, transports })) });
      return createFlow('login', context, options);
    },
    async finishAuthentication(context, token, response) {
      const flow = consume('login', token, context);
      const credential = forRP(context.rpID).find(item => item.id === response?.id);
      if (!credential || (response.response?.userHandle && response.response.userHandle !== store.userID)) throw unavailable();
      const result = await webauthn.verifyAuthenticationResponse({ response, expectedChallenge: flow.challenge, expectedOrigin: context.origin, expectedRPID: context.rpID,
        credential: { id: credential.id, publicKey: Buffer.from(credential.publicKey, 'base64url'), counter: credential.counter, transports: credential.transports }, requireUserVerification: true });
      if (!result.verified || !result.authenticationInfo.userVerified || !store.credentials.includes(credential)) throw unavailable();
      persist(store.credentials.map(item => item === credential ? { ...item, counter: result.authenticationInfo.newCounter, lastUsedAt: new Date(now()).toISOString() } : item));
    },
    remove(rpID, id) {
      if (!forRP(rpID).some(item => item.id === id)) throw new Error('找不到此通行密钥。');
      persist(store.credentials.filter(item => item.rpID !== rpID || item.id !== id));
      flows.clear();
    },
  };
}
