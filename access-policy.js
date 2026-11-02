import { readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isLocalAuthManagementRequest } from './server-security.js';

export function normalizeBoundDomain(value) {
  if (typeof value !== 'string') throw new Error('Enter a domain without a protocol, port or path');
  const domain = value.trim().toLowerCase();
  if (!domain) return '';
  if (domain.length > 253 || !domain.includes('.') || !domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || /^\d+(?:\.\d+){3}$/.test(domain)) {
    throw new Error('Enter a domain without a protocol, port or path');
  }
  return domain;
}

export function loadBoundDomain(path) {
  try { return normalizeBoundDomain(JSON.parse(readFileSync(path, 'utf8')).domain); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

export function saveBoundDomain(path, domain) {
  const normalized = normalizeBoundDomain(domain);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ domain: normalized })}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function matchesDomain(host, domain) {
  return typeof host === 'string' && new RegExp(`^${domain.replaceAll('.', '\\.')}(:[0-9]+)?$`, 'i').test(host);
}

// Forwarded hosts can only select the explicitly configured domain, never local access.
export function boundDomainRequest(req, domain) {
  if (isLocalAuthManagementRequest(req)) return req;
  if (!domain) return null;
  if (matchesDomain(req.headers.host, domain)) return req;
  const forwardedHost = req.headers['x-forwarded-host'];
  if (!matchesDomain(forwardedHost, domain)) return null;
  return { socket: req.socket, headers: { ...req.headers, host: forwardedHost } };
}
