import { createPasskeyService } from './passkey-service.js';
import { createPasskeyRoutes, passkeyRequestContext } from './passkey-routes.js';
import { createTaskThreadReader, prepareThreadMessage } from './task-context.js';
import { createSubagentService } from './subagent-service.js';
import { oidcCallbackAddress, loadAuthenticationSettings, validateAuthenticationSettings, updateAuthenticationSettings, publicAuthenticationSettings, saveAuthenticationSettings } from './authentication-store.js';
import { Secret, TOTP } from 'otpauth';
import { authenticationRequirements, createAuthentication, authorizeAuthenticationRequest } from './authentication.js';
import { mergeTurnSources } from './session-items.js';
import { createSessionRequestHandlers } from './session-request-service.js';
import { SessionService } from './session-service.js';
import { PendingRequests } from './pending-requests.js';
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { join, relative, resolve, extname } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { WebSocketServer, WebSocket } from "ws";
import { defaultBrowseRoots, isDirectory, listFolders, resolveBrowsePath } from "./folder-service.js";
import { applyReviewPatch } from "./review-service.js";
import { ReviewDiffStore, parseReviewPatchRequest } from "./review-state.js";
import { unifiedDiffFromFileChanges } from "../public/codex-surfaces.js";
import { rpcErrorPayload } from "../public/bridge-errors.js";
import { createTerminalSession, normalizeTerminalResize, resolveTerminalCwd } from "./terminal-service.js";
import { readWorkspaceContext } from "./workspace-context.js";
import { searchWorkspaceFiles } from "./file-search.js";
import { resolveLocalFile, listLocalFiles, readLocalText } from "./file-service.js";
import { resolveLocalImage } from "./image-service.js";
import { LiveSessionStore } from "./live-session-service.js";
import { createSettingsService } from "./settings-service.js";
import {
  createStoredPassword,
  isAllowedBrowserRpcMethod,
  isDirectLocalRequest, isLocalAuthManagementRequest,
  isRequestAuthorized,
  isSameOrigin,
  resolvePublicAsset,
  resolveSafeRegularFile,
  storedPasswordSessionSecret,
  unauthorizedResponse,
  verifyStoredPassword,
} from "./server-security.js";
import { loadStoredPassword, passwordStorePath, saveStoredPassword, replaceStoredPassword, type StoredPassword } from "./password-store.js";
import { boundDomainRequest, loadBoundDomain, normalizeBoundDomain, saveBoundDomain } from "./access-policy.js";
import { validateImageInputs, TURN_REQUEST_MAX_BYTES } from "../public/composer-input.js";
import { interruptThread } from "./turn-control.js";
import { createMessageQueue } from "./message-queue.js";
import { createCodexConnection } from "./codex-connection.js";
import {
  createAccountIdentityLoader,
  fetchProfileAvatar,
  resolveAccountIdentity,
  toPublicAccountIdentity,
} from "./profile-service.js";

import { saveProfileName, validateProfileName, validateProfileAvatar, readProfileAvatar, withProfileName } from "./profile-store.js";

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8899);
const accessToken = process.env.CODEX_WEBUI_ACCESS_TOKEN || null;
const environmentPassword = process.env.CODEX_WEBUI_PASSWORD || null;
const managedPasswordPath = passwordStorePath();
const passkeys = createPasskeyService({ path: `${managedPasswordPath}.passkeys.json` });
const profileStorePath = `${managedPasswordPath}.profile.json`;
const domainStorePath = `${managedPasswordPath}.access.json`;
let boundDomain = loadBoundDomain(domainStorePath);
let managedPassword: StoredPassword | null = environmentPassword || accessToken ? null : loadStoredPassword(managedPasswordPath);
let authSecret = environmentPassword || accessToken || storedPasswordSessionSecret(managedPassword);
const securityStorePath = `${managedPasswordPath}.security.json`;
let securitySettings = loadAuthenticationSettings(securityStorePath);
let { config: authenticationOptions, origin: publicOrigin } = validateAuthenticationSettings(securitySettings, { domain: boundDomain, passwordConfigured: Boolean(authSecret) });
let authentication = createAuthentication(authenticationOptions);
if (authenticationOptions.totp && !authSecret && authenticationOptions.mode !== 'oidc') throw new Error('Configure a password before enabling OTP');
if (authenticationOptions.mode === 'both' && !authSecret) throw new Error('Configure a password before enabling both authentication methods');
if (authenticationOptions.mode !== 'password' && new URL(authenticationOptions.provider.redirectUri).hostname !== boundDomain) throw new Error('Bind the OIDC callback domain locally before enabling OIDC');
let passwordSetupInProgress = false;
const localhostOnly = host === "127.0.0.1" || host === "::1" || host === "localhost";
const moduleDir = fileURLToPath(new URL(".", import.meta.url));
const appRoot = existsSync(resolve(moduleDir, "public")) ? moduleDir : resolve(moduleDir, "..");
const publicDir = resolve(appRoot, "public");
const homeDir = process.env.HOME || process.cwd();
const projectless = process.env.CODEX_WEBUI_PROJECTLESS === "true";
const configuredReviewRoot = process.env.CODEX_WEBUI_REVIEW_ROOT || null;
const ntfyTopic = process.env.CODEX_WEBUI_NTFY_TOPIC || null;
const ntfyUrl = (process.env.CODEX_WEBUI_NTFY_URL || "https://ntfy.sh").replace(/\/+$/, "");
if (projectless && !configuredReviewRoot) {
  throw new Error("CODEX_WEBUI_REVIEW_ROOT is required when CODEX_WEBUI_PROJECTLESS=true");
}
const defaultCwd = resolve(process.env.CODEX_WEBUI_CWD || (projectless ? homeDir : appRoot));
const browseRoots = defaultBrowseRoots(homeDir);
const imageRoots = [...new Set([...browseRoots, resolve(tmpdir()), resolve("/tmp")])];
const fileRoots = [...new Set([...browseRoots, defaultCwd, resolve(tmpdir()), resolve("/tmp")])];
const reviewRoots = [resolve(configuredReviewRoot || defaultCwd)];
const clients = new Set<WebSocket>();
const sseClients = new Set<ServerResponse>();
const terminalSessions = new Map<WebSocket, ReturnType<typeof createTerminalSession>>();
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
const reviewDiffs = new ReviewDiffStore();
const liveSessions = new LiveSessionStore();
const sessionService = new SessionService({
  directory: `${managedPasswordPath}.sessions`, loadThread: loadSessionThread,
  loadQueue: id => messageQueue.list(id), loadRequests: id => pendingRequests.listStates(id),
});
const pendingRequests = new PendingRequests({ path: `${managedPasswordPath}.requests.json`, onChange: (id, requests) => sessionService.publish(id, { requests }) });
const { answer: answerBrowserRequest, saveDraft: saveSessionDraft } = createSessionRequestHandlers({ requests: pendingRequests, sessions: sessionService, send: sendRaw, enqueue: params => messageQueue.enqueue(params) });
const eventChannels = new Map<string, { send: (message: any) => void }>();
const settingsService = createSettingsService(request, { codexHome: () => resolve(codexSessionsRoot, ".."), projectRoots: [...new Set([...browseRoots, defaultCwd])] });
const threadPaths = new Map<string, string>();
let codexSessionsRoot = resolve(process.env.CODEX_HOME || resolve(homeDir, ".codex"), "sessions");
let seq = 1;
let connected = false;
let shuttingDown = false;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
const messageQueue = createMessageQueue({
  storePath: `${managedPasswordPath}.queue.json`, request,
  canSend: () => connected && !shuttingDown, notify: broadcast,
});
const loadNativeThread = createTaskThreadReader({ request, loadLegacy: async id => (await request("thread/read", { threadId: id, includeTurns: true })).thread });
const subagentService = createSubagentService({ request, loadThread: loadSessionThread, enqueue: params => messageQueue.enqueue(params) });
let httpClosed = false;
const accountLoader = createAccountIdentityLoader(async (refresh) => {
  const account = await request("account/read", { refreshToken: refresh });
  return resolveAccountIdentity(account);
});

const codexConnection = createCodexConnection({
  cwd: defaultCwd, env: process.env, onMessage: handleCodex,
  onError: (error: Error) => console.error("[codex app-server]", error.message),
  onConnect: () => {
    connected = false;
    initialize().catch(error => {
      console.error("[codex-cli-webui] initialize failed", error.message);
      terminateCodex();
    });
  },
  onDisconnect: ({ code, signal }: { code?: number | null; signal?: string | null }) => {
    connected = false;
    pendingRequests.disconnect();
    accountLoader.invalidate(); reviewDiffs.clear();
    broadcast({ type: "bridge/status", status: "disconnected", code, signal });
    for (const item of pending.values()) item.reject(new Error("Codex connection closed"));
    pending.clear();
    if (shuttingDown) maybeFinishShutdown();
    else restartTimer = setTimeout(startCodex, 1000);
  },
});

function startCodex() {
  if (!shuttingDown) codexConnection.start();
}

function terminateCodex(signal: NodeJS.Signals = "SIGTERM") {
  codexConnection.stop(signal);
}

function maybeFinishShutdown() {
  if (shuttingDown && httpClosed && !codexConnection.running) process.exit(0);
}

function sendRaw(message: any) {
  if (shuttingDown) throw new Error("codex-cli-webui is shutting down");
  startCodex();
  codexConnection.send(message);
}

function request(method: string, params: any = {}) {
  const id = seq++;
  sendRaw({ id, method, params });
  return new Promise<any>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Codex request timed out: ${method}`));
    }, 30000);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolvePromise(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
  });
}

async function initialize() {
  const result = await request("initialize", {
    clientInfo: { name: "codex-cli-webui", title: "codex-cli-webui", version: "0.2.0" },
    capabilities: { experimentalApi: true },
  });
  sendRaw({ method: "initialized", params: {} });
  if (typeof result?.codexHome === "string") codexSessionsRoot = resolve(result.codexHome, "sessions");
  connected = true;
  messageQueue.wake();
  broadcast({ type: "bridge/status", status: "connected", info: result });
}

function handleCodex(message: any) {
  if (message.id !== undefined && ("result" in message || "error" in message)) {
    const item = pending.get(Number(message.id));
    if (item) {
      pending.delete(Number(message.id));
      if (message.error) item.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else item.resolve(message.result);
      return;
    }
  }
  if (message.id !== undefined && message.method) {
    pendingRequests.add(message);
    broadcast({ type: "codex/request", payload: message });
    return;
  }
  if (message.method) {
    if (message.method === "serverRequest/resolved") pendingRequests.resolve(message.params?.requestId, message.params?.threadId);
    if (message.method === "account/updated") accountLoader.invalidate();
    if (message.method === "turn/diff/updated") reviewDiffs.record(message.params || {});
    if (message.method === "item/fileChange/patchUpdated") recordFileChangeDiff(message.params || {});
    if (message.method === "item/completed" && message.params?.item?.type === "fileChange") {
      recordFileChangeDiff({ ...message.params, changes: message.params.item.changes });
    }
    if (message.method === "turn/completed") {
      pendingRequests.endTurn(message.params?.threadId, message.params?.turn?.id);
      notifyNtfyTurnCompleted(message.params || {});
      messageQueue.wake();
    }
    broadcast({ type: "codex/notification", payload: message });
  }
}

async function notifyNtfyTurnCompleted(params: any) {
  if (!ntfyTopic) return;
  const turnId = typeof params?.turn?.id === "string" ? params.turn.id : "";
  const threadId = typeof params?.threadId === "string" ? params.threadId : "";
  const body = `Codex task completed${threadId ? ` (thread ${threadId.slice(0, 8)})` : ""}`;
  try {
    await fetch(`${ntfyUrl}/${encodeURIComponent(ntfyTopic)}`, {
      method: "POST",
      headers: { Title: "Codex task completed", Tags: "white_check_mark", ...(turnId ? { "X-Turn-Id": turnId } : {}) },
      body,
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    console.error("ntfy notification failed:", error instanceof Error ? error.message : error);
  }
}

function recordFileChangeDiff({ threadId, turnId, changes }: any) {
  const diff = unifiedDiffFromFileChanges(Array.isArray(changes) ? changes : []);
  if (diff) reviewDiffs.record({ threadId, turnId, diff });
}

function recordReviewDiffsFromRpc(method: string, params: any, result: any) {
  if (!["thread/read", "thread/resume", "thread/turns/list"].includes(method)) return;
  const threadId = result?.thread?.id || params?.threadId;
  const turns = result?.thread?.turns || result?.data || [];
  if (typeof threadId !== "string" || !Array.isArray(turns)) return;
  for (const turn of turns) {
    const changes = (turn?.items || []).flatMap((item: any) => item?.type === "fileChange" && Array.isArray(item.changes) ? item.changes : []);
    const diff = unifiedDiffFromFileChanges(changes);
    if (typeof turn?.id === "string" && diff) reviewDiffs.record({ threadId, turnId: turn.id, diff });
  }
}

function recordThreadPathsFromRpc(result: any) {
  const threads = [result?.thread, ...(Array.isArray(result?.data) ? result.data : [])].filter(Boolean);
  for (const thread of threads) {
    if (typeof thread?.id === "string" && typeof thread?.path === "string") threadPaths.set(thread.id, thread.path);
  }
}

async function readLiveThread(threadId: unknown) {
  if (typeof threadId !== "string" || !threadId) throw new Error("Invalid thread id");
  let path = threadPaths.get(threadId);
  if (!path) {
    const result = await request("thread/read", { threadId, includeTurns: false });
    recordThreadPathsFromRpc(result);
    path = threadPaths.get(threadId);
  }
  if (!path) return { active: false, turn: null, lastEventAt: null };
  const child = relative(codexSessionsRoot, resolve(path));
  const safePath = child && !child.startsWith("..") ? resolveSafeRegularFile(codexSessionsRoot, child) : null;
  if (!safePath) throw new Error("Thread rollout is outside the Codex sessions directory");
  return liveSessions.read(safePath);
}

async function loadSessionThread(threadId: string) {
  const result = { thread: await loadNativeThread(threadId) };
  recordThreadPathsFromRpc(result);
  recordReviewDiffsFromRpc("thread/read", { threadId }, result);
  const thread = result.thread;
  try {
    const live = await readLiveThread(threadId);
    // The runtime status wins over unfinished historical rollout records.
    if (live.active && live.turn && thread.status?.type === "active") {
      const index = (thread.turns || []).findIndex((turn: any) => turn.id === live.turn.id);
      if (index < 0) (thread.turns ||= []).push(mergeTurnSources(null, live.turn));
      else thread.turns[index] = mergeTurnSources(thread.turns[index], live.turn);
    }
  } catch { /* Native thread snapshots remain usable without a local rollout. */ }
  pendingRequests.reconcile(threadId, thread.turns || []);
  return thread;
}

function broadcast(data: any) {
  if (data.type === "bridge/queue") { sessionService.publish(data.threadId, { queue: data.messages }); return; }
  if (data.type === "bridge/message") {
    sessionService.notification("item/completed", { threadId: data.threadId, turnId: data.turnId, item: data.item }); return;
  }
  if (data.type === "codex/request") return; // Requests are published as durable per-session state.
  if (data.type === "codex/notification") {
    const { method, params = {} } = data.payload;
    const scoped = sessionService.notification(method, params);
    if (scoped || method.startsWith("item/") || method.startsWith("turn/") || method === "serverRequest/resolved") return;
  }
  const text = JSON.stringify(data);
  for (const client of clients) if (client.readyState === WebSocket.OPEN) client.send(text);
  for (const client of sseClients) if (!client.writableEnded) client.write(`data: ${text}\n\n`);
}

async function dispatchBrowserMessage(message: any, channel: { send: (message: any) => void } | null = null) {
  const id = message?.id;
  if (message?.type === "rpc") {
    try {
      if (!isAllowedBrowserRpcMethod(message.method)) throw new Error("RPC method is not available to browser clients");
      const params = message.params || {};
      if (["turn/start", "turn/steer"].includes(message.method)) validateImageInputs(params.input || []);
      const result = ["host/settings/read", "host/settings/write", "host/skills/set-enabled", "host/mcp/set-enabled"].includes(message.method)
        ? await settingsService(message.method, params)
        : message.method === "host/session/subscribe"
        ? await sessionService.subscribe(channel, params, event => channel?.send(event))
        : message.method === "host/session/drafts"
        ? { drafts: sessionService.entry(params.threadId).state.drafts }
        : message.method === "host/session/draft"
        ? saveSessionDraft(params)
        : message.method === "host/thread/requests"
        ? { requests: pendingRequests.list(params.threadId) }
        : message.method === "host/request/respond"
        ? answerBrowserRequest(params)
        : message.method.startsWith("host/subagents/")
        ? await subagentService(message.method, params)
        : message.method === "host/thread/send"
        ? messageQueue.enqueue(await prepareThreadMessage(params, loadSessionThread))
        : message.method === "host/thread/queue/list"
        ? { messages: messageQueue.list(params.threadId) }
        : message.method === "host/thread/queue/cancel"
        ? messageQueue.cancel(params)
        : message.method === "host/thread/queue/retry"
        ? messageQueue.retry(params)
        : message.method === "host/thread/live"
        ? await readLiveThread(params.threadId)
        : message.method === "turn/interrupt"
        ? await interruptThread(request, params)
        : await request(message.method, params);
      recordThreadPathsFromRpc(result);
      recordReviewDiffsFromRpc(message.method, params, result);
      return { type: "rpc/result", id, result };
    } catch (error) {
      return rpcErrorPayload(id, error);
    }
  }
  if (message?.type === "codex/response") {
    if (!Number.isSafeInteger(message.requestId)) throw new Error("Invalid Codex request id");
    answerBrowserRequest({ ...message, threadId: message.threadId || pendingRequests.requests.get(message.requestId)?.params?.threadId });
    return { type: "ack" };
  }
  if (message?.type === "codex/error") {
    if (!Number.isSafeInteger(message.requestId)) throw new Error("Invalid Codex request id");
    answerBrowserRequest({ ...message, threadId: message.threadId || pendingRequests.requests.get(message.requestId)?.params?.threadId });
    return { type: "ack" };
  }
  if (message?.type === "ping") return { type: "pong" };
  throw new Error("Unsupported browser bridge message");
}

async function handleClient(client: WebSocket, message: any, channel: { send: (message: any) => void }) {
  try { client.send(JSON.stringify(await dispatchBrowserMessage(message, channel))); }
  catch (error) { client.send(JSON.stringify(rpcErrorPayload(message?.id, error))); }
}

function readJsonBody(req: IncomingMessage, maxBytes = 256_000) {
  return new Promise<any>((resolvePromise, reject) => {
    let body = "", tooLarge = false, bodyBytes = 0;
    req.setEncoding("utf8");
    req.on("data", chunk => {
      if (tooLarge) return;
      bodyBytes += Buffer.byteLength(chunk);
      if (bodyBytes > maxBytes) { tooLarge = true; return; }
      body += chunk;
    });
    req.on("error", reject);
    req.on("end", () => {
      if (tooLarge) return reject(new Error("Bridge payload too large"));
      try { resolvePromise(JSON.parse(body || "{}")); }
      catch { reject(new Error("Invalid JSON payload")); }
    });
  });
}

function passwordSetupRequired() {
  return !authSecret && authenticationOptions.mode !== 'oidc';
}

function browserPasswordConfigured() {
  return Boolean(environmentPassword || managedPassword || accessToken);
}

function requestMatchesSecret(req: IncomingMessage, submittedPassword: string, expectedSecret: string | null) {
  if (!submittedPassword || !expectedSecret) return false;
  req = boundDomainRequest(req, boundDomain);
  if (!req) return false;
  return isRequestAuthorized({
    remoteAddress: req.socket.remoteAddress,
    hostHeader: req.headers.host,
    authorization: `Bearer ${submittedPassword}`,
    accessToken: expectedSecret,
    origin: req.headers.origin,
    fetchSite: req.headers["sec-fetch-site"],
    forwardedFor: req.headers["x-forwarded-for"],
    forwarded: req.headers.forwarded,
    realIp: req.headers["x-real-ip"],
    allowLoopback: false,
  });
}

function validBrowserPassword(req: IncomingMessage, submittedPassword: string, username?: string) {
  if (environmentPassword) return requestMatchesSecret(req, submittedPassword, environmentPassword);
  if (managedPassword) {
    if (managedPassword.username && username !== managedPassword.username) return false;
    if (!requestMatchesSecret(req, submittedPassword, submittedPassword)) return false;
    return verifyStoredPassword(submittedPassword, managedPassword);
  }
  return requestMatchesSecret(req, submittedPassword, accessToken);
}

function authConfigured() { return Boolean(authSecret || (authenticationOptions.provider && authenticationOptions.mode !== 'password')); }
function secureCookie(req: IncomingMessage) {
  return Boolean((req.socket as any).encrypted || (publicOrigin?.startsWith('https:') && !isLocalAuthManagementRequest(req)));
}
function sameOriginRequest(req: IncomingMessage) {
  const accessRequest = boundDomainRequest(req, boundDomain);
  if (!accessRequest || req.headers['sec-fetch-site'] === 'cross-site') return false;
  if (authenticationOptions.mode === 'password' && req.headers.origin && publicOrigin && req.headers.origin !== publicOrigin && !isLocalAuthManagementRequest(req)) return false;
  return isSameOrigin(req.headers.origin, accessRequest.headers.host);
}
function authorizedRequest(req: IncomingMessage) {
  if (!sameOriginRequest(req)) return false;
  if (!authenticationRequirements(req, authenticationOptions, securitySettings.localAuthRequired).loginRequired) return true;
  if (!authConfigured()) return false;
  return authorizeAuthenticationRequest(boundDomainRequest(req, boundDomain), authentication, authenticationOptions, accessToken);
}
function canManageAuthentication(req: IncomingMessage) {
  return isLocalAuthManagementRequest(req) && (!browserPasswordConfigured() || !authConfigured() || authorizedRequest(req));
}

function sendAuthError(res: ServerResponse, status: number, error: string, extraHeaders: Record<string, string> = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  res.end(JSON.stringify({ error }));
}

function issueBrowserSession(req: IncomingMessage, res: ServerResponse, verified = false, extraCookie?: string, forceSecure = false) {
  let cookie: string;
  try { cookie = authentication.issue(forceSecure || secureCookie(req), { verified }); }
  catch { sendAuthError(res, 503, '登录会话已满，请稍后重试。'); return; }
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "set-cookie": extraCookie ? [cookie, extraCookie] : cookie,
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify({ ok: true }));
}

function encodeContentDispositionFilename(filename: string) {
  return encodeURIComponent(filename).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
};

const handlePasskeys = createPasskeyRoutes({
  passkeys, getState: () => ({ authentication, domain: boundDomain, publicOrigin, configured: authConfigured() }),
  authorizedRequest, sameOriginRequest, readJsonBody, sendAuthError, issueBrowserSession,
  revokeConnections: () => {
    for (const client of clients) client.close(1008, 'Passkey removed');
    for (const client of terminalSessions.keys()) client.close(1008, 'Passkey removed');
    for (const stream of sseClients) stream.end();
  },
});

const server = createServer(async (req, res) => {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('content-security-policy', "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'");
  res.setHeader('cache-control', 'no-store');
  if (!boundDomainRequest(req, boundDomain)) {
    sendAuthError(res, 403, "Access is only allowed through direct 127.0.0.1, localhost or the bound domain");
    return;
  }
  let url: URL;
  try { url = new URL(req.url || "/", "http://localhost"); }
  catch {
    res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify({ error: "Invalid request URL" }));
    return;
  }
  const appRoute = req.method === "GET" && (url.pathname === "/" || /^\/settings(?:\/[^/]+)?\/?$/.test(url.pathname));
  const loginAssets = new Set(["/", "/index.html", "/style.css", "/favicon.svg", "/auth-bootstrap.js", "/passkey-client.js", "/i18n.js", "/codex-brand.js"]);
  if (url.pathname === "/api/auth/status") {
    const authenticated = authorizedRequest(req);
    const passkeyContext = passkeyRequestContext(req, { domain: boundDomain, publicOrigin });
    const requirements = authenticationRequirements(req, authenticationOptions, securitySettings.localAuthRequired);
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify({
      setupRequired: (requirements.local ? !browserPasswordConfigured() : passwordSetupRequired()) && !authenticated,
      passwordRequired: requirements.passwordEnabled && browserPasswordConfigured(),
      loginRequired: requirements.loginRequired,
      otpRequired: requirements.otpRequired,
      oidcEnabled: requirements.oidcEnabled,
      passwordEnabled: requirements.passwordEnabled,
      authenticated,
      passkeyEnabled: Boolean(authConfigured() && passkeyContext && passkeys.has(passkeyContext.rpID)),
      passkeyOrigin: passkeyContext?.origin || null,
      canManagePasskeys: isLocalAuthManagementRequest(req),
      canManageCredentials: canManageAuthentication(req),
      usernameRequired: Boolean(managedPassword?.username),
    }));
    return;
  }
  if (await handlePasskeys(req, res, url)) return;
  if (url.pathname === '/api/auth/security' || url.pathname === '/api/auth/otp-secret') {
    if (!canManageAuthentication(req)) { sendAuthError(res, 403, '仅允许在服务器本机通过 127.0.0.1 或 localhost 配置认证。'); return; }
    if (url.pathname === '/api/auth/otp-secret') {
      if (req.method !== 'POST') { sendAuthError(res, 405, 'Method not allowed'); return; }
      const secret = new Secret({ size: 20 });
      const totp = new TOTP({ issuer: 'Codex WebUI', label: managedPassword?.username || 'admin', algorithm: 'SHA1', digits: 6, period: 30, secret });
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ secret: secret.base32, uri: totp.toString() })); return;
    }
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(publicAuthenticationSettings({ ...securitySettings, redirectUri: oidcCallbackAddress(boundDomain, securitySettings) }))); return;
    }
    if (req.method !== 'POST') { sendAuthError(res, 405, 'Method not allowed'); return; }
    try {
      const payload = await readJsonBody(req, 32768);
      const next = updateAuthenticationSettings(securitySettings, { ...payload, redirectUri: oidcCallbackAddress(boundDomain, securitySettings) });
      const validated = validateAuthenticationSettings(next, { domain: boundDomain, passwordConfigured: Boolean(authSecret) });
      const nextAuthentication = createAuthentication(validated.config);
      if (next.otpSecret && next.otpSecret !== securitySettings.otpSecret && !nextAuthentication.verifyOtp(payload.otpCode)) {
        sendAuthError(res, 400, '请填写验证器当前的六位验证码，确认绑定成功。'); return;
      }
      saveAuthenticationSettings(securityStorePath, next);
      authentication.revokeAll(); securitySettings = next; authenticationOptions = validated.config; publicOrigin = validated.origin;
      authentication = nextAuthentication;
      for (const client of clients) client.close(1008, 'Authentication settings changed');
      for (const client of terminalSessions.keys()) client.close(1008, 'Authentication settings changed');
      for (const stream of sseClients) stream.end();
      issueBrowserSession(req, res);
    } catch { sendAuthError(res, 400, '无法保存认证配置，请检查密码、域名、OIDC 必填项和密钥格式。'); }
    return;
  }
  if (url.pathname === "/api/auth/domain") {
    if (!canManageAuthentication(req)) {
      sendAuthError(res, 403, "Account settings are only available through direct 127.0.0.1 or localhost access");
      return;
    }
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ domain: boundDomain }));
      return;
    }
    if (req.method !== "POST") { sendAuthError(res, 405, "Method not allowed", { allow: "GET, POST" }); return; }
    let domain: string;
    try { domain = normalizeBoundDomain((await readJsonBody(req, 4096)).domain); }
    catch { sendAuthError(res, 400, "Enter a domain without a protocol, port or path"); return; }
    if (!domain && authenticationOptions.mode !== 'password') { sendAuthError(res, 400, '请先关闭统一身份登录，再清除域名。'); return; }
    const next = { ...securitySettings, publicOrigin: '', redirectUri: oidcCallbackAddress(domain, securitySettings) };
    try {
      const validated = validateAuthenticationSettings(next, { domain, passwordConfigured: Boolean(authSecret) });
      saveBoundDomain(domainStorePath, domain);
      try { saveAuthenticationSettings(securityStorePath, next); }
      catch (error) { saveBoundDomain(domainStorePath, boundDomain); throw error; }
      boundDomain = domain; securitySettings = next;
      authentication.revokeAll(); authenticationOptions = validated.config; publicOrigin = validated.origin;
      authentication = createAuthentication(authenticationOptions);
      res.setHeader('set-cookie', authentication.issue(false));
    } catch { sendAuthError(res, 500, '无法保存域名绑定。'); return; }
    for (const client of clients) client.close(1008, "Domain binding changed");
    for (const client of terminalSessions.keys()) client.close(1008, "Domain binding changed");
    for (const stream of sseClients) stream.end();
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ domain: boundDomain }));
    return;
  }
  if (url.pathname === "/api/auth/setup" || url.pathname === "/api/auth/credentials") {
    if (!canManageAuthentication(req)) {
      sendAuthError(res, 403, "Account settings are only available through direct 127.0.0.1 or localhost access");
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/auth/credentials") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ configured: browserPasswordConfigured(), username: managedPassword?.username || "codex", localAuthRequired: securitySettings.localAuthRequired, editable: !environmentPassword && !accessToken }));
      return;
    }
    if (req.method !== "POST") {
      sendAuthError(res, 405, "Method not allowed", { allow: "GET, POST" });
      return;
    }
    if (environmentPassword || accessToken) {
      sendAuthError(res, 409, "Credentials are managed by startup environment variables");
      return;
    }
    if (passwordSetupInProgress || (url.pathname === "/api/auth/setup" && browserPasswordConfigured())) {
      sendAuthError(res, 409, "Account settings have changed. Refresh and try again.");
      return;
    }
    let payload: any;
    try { payload = await readJsonBody(req, 4096); }
    catch { sendAuthError(res, 400, "Invalid account settings"); return; }
    const username = typeof payload?.username === "string" ? payload.username.trim() : "";
    const submittedPassword = typeof payload?.password === "string" ? payload.password : "";
    if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(username)) {
      sendAuthError(res, 400, "Username must be 1–64 letters, numbers, dots, underscores or hyphens");
      return;
    }
    if (submittedPassword.length < 12 || submittedPassword.length > 256) {
      sendAuthError(res, 400, "Password must be between 12 and 256 characters");
      return;
    }
    passwordSetupInProgress = true;
    try {
      const credential: StoredPassword = { ...createStoredPassword(submittedPassword), username };
      if (managedPassword) replaceStoredPassword(managedPasswordPath, credential);
      else saveStoredPassword(managedPasswordPath, credential);
      managedPassword = credential;
      authSecret = storedPasswordSessionSecret(credential);
      authentication.revokeAll();
      issueBrowserSession(req, res, true);
      // Existing remote connections must authenticate again after credential rotation.
      for (const client of clients) client.close(1008, "Account settings changed");
      for (const client of terminalSessions.keys()) client.close(1008, "Account settings changed");
      for (const stream of sseClients) stream.end();
    } catch (error: any) {
      console.error("[codex-cli-webui] account settings save failed", error?.code || "write error");
      sendAuthError(res, error?.code === "EEXIST" ? 409 : 500, "Unable to save account settings");
    } finally { passwordSetupInProgress = false; }
    return;
  }
  if (url.pathname === '/api/auth/oidc/start' || url.pathname === '/api/auth/oidc/callback') {
    if (req.method !== 'GET' || isDirectLocalRequest(req) || !authenticationOptions.provider || authenticationOptions.mode === 'password') {
      sendAuthError(res, 404, 'Not found'); return;
    }
    if (!authentication.allowAttempt(req.socket.remoteAddress)) { sendAuthError(res, 429, 'Too many login attempts. Try again in five minutes.', { 'retry-after': '300' }); return; }
    const loginAuthentication = authentication;
    try {
      if (url.pathname.endsWith('/start')) {
        if (!sameOriginRequest(req)) { sendAuthError(res, 403, 'Invalid request origin'); return; }
        const flow = await loginAuthentication.startOidc(oidcCallbackAddress(boundDomain, securitySettings));
        if (authentication !== loginAuthentication) throw new Error("Authentication settings changed");
        res.writeHead(302, { location: flow.url, 'set-cookie': flow.cookie }); res.end();
      } else {
        const callback = oidcCallbackAddress(boundDomain, securitySettings);
        if (!callback) throw new Error('Callback host mismatch');
        const expected = new URL(callback);
        if (boundDomainRequest(req, boundDomain)?.headers.host !== expected.host) throw new Error('Callback host mismatch');
        expected.search = url.search;
        await loginAuthentication.finishOidc(expected, req);
        if (authentication !== loginAuthentication) throw new Error("Authentication settings changed");
        res.writeHead(303, { location: '/', 'referrer-policy': 'no-referrer', 'set-cookie': [authentication.issue(expected.protocol === 'https:', { verified: true }), `codex_webui_oidc=; Path=/api/auth/oidc; HttpOnly;${expected.protocol === 'https:' ? ' Secure;' : ''} SameSite=Lax; Max-Age=0`] }); res.end();
      }
    } catch { sendAuthError(res, 401, '身份认证失败，请重新登录或联系管理员检查配置。'); }
    return;
  }
  if (url.pathname === '/api/auth/logout') {
    if (req.method !== 'POST') { sendAuthError(res, 405, 'Method not allowed', { allow: 'POST' }); return; }
    if (!sameOriginRequest(req)) { sendAuthError(res, 403, 'Invalid request origin'); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': authentication.logout(req, secureCookie(req)) });
    res.end(JSON.stringify({ ok: true })); return;
  }
  if (url.pathname === "/api/auth/login") {
    if (req.method !== "POST") {
      sendAuthError(res, 405, "Method not allowed", { allow: "POST" });
      return;
    }
    if (authenticationOptions.mode === 'oidc' && !isLocalAuthManagementRequest(req)) { sendAuthError(res, 403, '请使用统一身份登录。'); return; }
    if (!sameOriginRequest(req)) { sendAuthError(res, 403, 'Invalid request origin'); return; }
    if (!authentication.allowAttempt(req.socket.remoteAddress)) { sendAuthError(res, 429, '登录尝试过多，请五分钟后重试。', { 'retry-after': '300' }); return; }
    let payload: any;
    try { payload = await readJsonBody(req, 4096); }
    catch {
      sendAuthError(res, 401, "账号、密码或验证码不正确。");
      return;
    }
    const submittedPassword = typeof payload?.password === "string" ? payload.password : "";
    if (submittedPassword.length > 256 || !validBrowserPassword(req, submittedPassword, typeof payload?.username === "string" ? payload.username : undefined) || (authenticationRequirements(req, authenticationOptions, securitySettings.localAuthRequired).otpRequired && !authentication.verifyOtp(payload?.otp))) {
      sendAuthError(res, 401, "账号、密码或验证码不正确。");
      return;
    }
    issueBrowserSession(req, res, true);
    return;
  }
  if (!authorizedRequest(req)) {
    if (appRoute || loginAssets.has(url.pathname)) {
      const file = resolvePublicAsset(appRoute ? "/" : url.pathname, publicDir);
      if (file) {
        res.writeHead(200, { "content-type": mime[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
        res.end(readFileSync(file));
        return;
      }
    }
    unauthorizedResponse(res);
    return;
  }
  if (url.pathname === "/api/events") {
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "GET" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    });
    res.flushHeaders?.();
    res.write("retry: 1000\n\n");
    sseClients.add(res);
    const session = authentication.sessionFor(req);
    if (session) {
      const expiry = setInterval(() => { if (session.revoked || session.expiresAt <= Date.now()) res.end(); }, 1000);
      expiry.unref();
      res.once('close', () => clearInterval(expiry));
    }
    const clientId = url.searchParams.get("clientId") || "";
    const channel = { send: (message: any) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(message)}\n\n`); } };
    if (/^[a-zA-Z0-9_-]{16,128}$/.test(clientId)) {
      const previous = eventChannels.get(clientId); if (previous) sessionService.disconnect(previous);
      eventChannels.set(clientId, channel);
    }
    res.write(`data: ${JSON.stringify({ type: "bridge/status", status: connected ? "connected" : "connecting" })}\n\n`);
    req.on("close", () => { sseClients.delete(res); sessionService.disconnect(channel); if (eventChannels.get(clientId) === channel) eventChannels.delete(clientId); });
    return;
  }
  if (url.pathname === "/api/rpc" || url.pathname === "/api/codex/respond") {
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "POST" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const payload = await readJsonBody(req, url.pathname === "/api/rpc" ? TURN_REQUEST_MAX_BYTES : 256_000);
      const message = url.pathname === "/api/rpc"
        ? { type: "rpc", id: payload.id, method: payload.method, params: payload.params || {} }
        : { type: payload.error ? "codex/error" : "codex/response", requestId: payload.requestId, result: payload.result, error: payload.error };
      const reply = await dispatchBrowserMessage(message, eventChannels.get(payload.clientId) || null);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(JSON.stringify(reply));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }
  if (url.pathname === "/api/health") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: true, codex: connected, codexBackend: codexConnection.kind, version: "0.2.0" }));
    return;
  }
  if (url.pathname === "/api/config") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ home: homeDir, defaultCwd, reviewRoot: reviewRoots[0], projectless }));
    return;
  }
  if (url.pathname === "/api/workspace/context") {
    try {
      const context = readWorkspaceContext(url.searchParams.get("cwd") || defaultCwd, browseRoots);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(context));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }
  if (url.pathname === "/api/files/list" || url.pathname === "/api/files/preview") {
    if (req.method !== "GET") {
      res.writeHead(405, { allow: "GET", "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const options = { cwd: url.searchParams.get("cwd") || defaultCwd, home: homeDir, allowedRoots: fileRoots };
      const result = url.pathname.endsWith("/list")
        ? await listLocalFiles(url.searchParams.get("path") || options.cwd, options)
        : await readLocalText(url.searchParams.get("path"), options);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(JSON.stringify(result));
    } catch {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: url.pathname.endsWith("/list") ? "无法读取目录，请检查路径和访问权限" : "无法预览此文件：仅支持 2 MB 以内的 UTF-8 / UTF-16 文本，请下载后查看" }));
    }
    return;
  }
  if (url.pathname === "/api/files/search") {
    try {
      const cwd = url.searchParams.get("cwd") || defaultCwd;
      const query = url.searchParams.get("query") || "";
      const items = await searchWorkspaceFiles(cwd, query, { allowedRoots: browseRoots, limit: 30 });
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ cwd, query, items }));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }
  if (url.pathname === "/api/files/download") {
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "GET", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const file = resolveLocalFile(url.searchParams.get("path"), {
        cwd: url.searchParams.get("cwd") || defaultCwd,
        home: homeDir,
        allowedRoots: fileRoots,
      });
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(file.size),
        "content-disposition": `attachment; filename="download"; filename*=UTF-8''${encodeContentDispositionFilename(file.filename)}`,
        "cache-control": "no-store",
        "cross-origin-resource-policy": "same-origin",
        "x-content-type-options": "nosniff",
      });
      const stream = createReadStream(file.path);
      stream.on("error", () => res.destroy());
      req.on("aborted", () => stream.destroy());
      stream.pipe(res);
    } catch {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(JSON.stringify({ error: "File unavailable" }));
    }
    return;
  }
  if (url.pathname === "/api/images/local") {
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "GET", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const image = resolveLocalImage(url.searchParams.get("path"), {
        cwd: url.searchParams.get("cwd") || defaultCwd,
        home: homeDir,
        allowedRoots: imageRoots,
      });
      res.writeHead(200, {
        "content-type": image.contentType,
        "content-length": String(image.size),
        "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(image.filename)}`,
        "cache-control": "private, max-age=60",
        "cross-origin-resource-policy": "same-origin",
        "x-content-type-options": "nosniff",
      });
      res.end(readFileSync(image.path));
    } catch {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(JSON.stringify({ error: "Image unavailable" }));
    }
    return;
  }
  if (url.pathname === "/api/account" || url.pathname === "/api/account/avatar") {
    if (req.method !== "GET" && !canManageAuthentication(req)) {
      res.writeHead(403, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "Account identity is available only on localhost" }));
      return;
    }
    const editing = url.pathname === "/api/account" && req.method === "POST";
    if (req.method !== "GET" && !editing) {
      sendAuthError(res, 405, "Method not allowed", { allow: url.pathname === "/api/account" ? "GET, POST" : "GET" });
      return;
    }
    let displayName: string | undefined, uploadedAvatar: string | undefined;
    if (editing) {
      if (!isSameOrigin(req.headers.origin, req.headers.host)) {
        sendAuthError(res, 403, "Request origin does not match the access domain");
        return;
      }
      try {
        const payload = await readJsonBody(req, 2_810_000);
        displayName = validateProfileName(payload.displayName);
        if (payload.avatar !== undefined) { validateProfileAvatar(payload.avatar); uploadedAvatar = payload.avatar; }
      }
      catch (error) { sendAuthError(res, 400, error instanceof Error ? error.message : "Invalid profile"); return; }
    }
    try {
      if (url.pathname === "/api/account/avatar") {
        const uploaded = await readProfileAvatar(profileStorePath);
        if (uploaded) {
          res.writeHead(200, { "content-type": uploaded.contentType, "content-length": String(uploaded.body.length), "cache-control": "no-store", "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin" });
          res.end(uploaded.body);
          return;
        }
      }
      const account = await accountLoader.get(url.searchParams.get("refresh") === "1");
      if (editing) await saveProfileName(profileStorePath, displayName, uploadedAvatar);
      if (url.pathname === "/api/account") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
        res.end(JSON.stringify(await withProfileName(toPublicAccountIdentity({ ...account, ...(account.type === "apiKey" ? { displayName: managedPassword?.username || "个人资料" } : {}) }), profileStorePath)));
        return;
      }
      if (!account.imageUrl) {
        res.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "No profile avatar" }));
        return;
      }
      const avatar = await fetchProfileAvatar(account.imageUrl);
      res.writeHead(200, {
        "content-type": avatar.contentType,
        "content-length": String(avatar.body.byteLength),
        "cache-control": "private, max-age=300",
        "x-content-type-options": "nosniff",
      });
      res.end(avatar.body);
    } catch (error) {
      console.warn("[codex-cli-webui] account request failed:", error instanceof Error ? error.message : String(error));
      if (editing) {
        sendAuthError(res, 500, "Could not save profile. Try again.");
        return;
      }
      if (url.pathname === "/api/account/avatar") {
        res.writeHead(502, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "Profile avatar unavailable" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(toPublicAccountIdentity(await resolveAccountIdentity({ account: null, requiresOpenaiAuth: true }))));
    }
    return;
  }
  if (url.pathname === "/api/folders") {
    try {
      const path = resolveBrowsePath(url.searchParams.get("path") || "~", browseRoots, homeDir);
      if (!isDirectory(path)) throw new Error("Directory not found");
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(listFolders(path, browseRoots)));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }
  if (url.pathname === "/api/review/patch") {
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "POST" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 2_000_000) req.destroy(new Error("Review patch payload too large"));
    });
    req.on("end", async () => {
      let requestPayload: ReturnType<typeof parseReviewPatchRequest> | null = null;
      let operationStarted = false;
      let success = false;
      try {
        const payload = JSON.parse(body || "{}");
        requestPayload = parseReviewPatchRequest(payload);
        const stored = reviewDiffs.begin(requestPayload.threadId, requestPayload.turnId, requestPayload.action);
        operationStarted = true;
        const threadResult = await request("thread/read", { threadId: requestPayload.threadId, includeTurns: false });
        const cwd = threadResult?.thread?.cwd;
        if (typeof cwd !== "string" || !cwd) throw new Error("Thread working directory is unavailable");
        const result = await applyReviewPatch({ cwd, diff: stored.diff, action: requestPayload.action }, reviewRoots);
        success = true;
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      } finally {
        if (operationStarted && requestPayload) reviewDiffs.finish(requestPayload.threadId, requestPayload.turnId, requestPayload.action, success);
      }
    });
    return;
  }
  if (url.pathname.startsWith("/vendor/katex/")) {
    let relative;
    try { relative = decodeURIComponent(url.pathname.slice("/vendor/katex/".length)); }
    catch { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("Not found"); return; }
    const katexDir = resolve(appRoot, "node_modules/katex/dist");
    const file = resolveSafeRegularFile(katexDir, relative);
    if (!file) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("Not found"); return;
    }
    res.writeHead(200, { "content-type": mime[extname(file)] || "application/octet-stream", "cache-control": "public, max-age=86400" });
    res.end(readFileSync(file));
    return;
  }
  if (url.pathname === "/vendor/xterm/xterm.css") {
    const xtermDir = resolve(appRoot, "node_modules/@xterm/xterm/css");
    const file = resolveSafeRegularFile(xtermDir, "xterm.css");
    if (!file) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("Not found"); return;
    }
    res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=86400" });
    res.end(readFileSync(file));
    return;
  }
  const file = resolvePublicAsset(appRoute ? "/" : url.pathname, publicDir);
  if (!file) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("Not found"); return;
  }
  res.writeHead(200, { "content-type": mime[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
  res.end(readFileSync(file));
});

const sseKeepalive = setInterval(() => {
  for (const client of sseClients) if (!client.writableEnded) client.write(": keepalive\n\n");
}, 25_000);
sseKeepalive.unref();

const wss = new WebSocketServer({ noServer: true, maxPayload: TURN_REQUEST_MAX_BYTES });
const terminalWss = new WebSocketServer({ noServer: true, maxPayload: 1_000_000 });
server.headersTimeout = 15_000;
server.requestTimeout = 30_000;
server.on("upgrade", (req, socket, head) => {
  let pathname = "";
  try { pathname = new URL(req.url || "/", "http://localhost").pathname; }
  catch { socket.destroy(); return; }
  if ((pathname !== "/ws" && pathname !== "/terminal") || !authorizedRequest(req)) {
    const body = JSON.stringify({ error: "Authentication required" });
    socket.end([
      "HTTP/1.1 401 Unauthorized",
      "Connection: close",
      'WWW-Authenticate: Bearer realm="codex-cli-webui"',
      "Content-Type: application/json; charset=utf-8",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "X-Content-Type-Options: nosniff",
      "",
      body,
    ].join("\r\n"));
    return;
  }
  const session = authentication.sessionFor(req);
  const target = pathname === "/terminal" ? terminalWss : wss;
  target.handleUpgrade(req, socket, head, client => {
    if (session) {
      const valid = () => !session.revoked && session.expiresAt > Date.now();
      const timer = setInterval(() => { if (!valid()) client.close(1008, 'Session expired'); }, 1000);
      timer.unref();
      client.prependListener('message', () => { if (!valid()) client.close(1008, 'Session expired'); });
      (client as any).authenticatedSession = session;
      client.once('close', () => clearInterval(timer));
    }
    target.emit("connection", client, req);
  });
});
wss.on("connection", (client) => {
  clients.add(client);
  const channel = { send: (message: any) => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message)); } };
  client.send(JSON.stringify({ type: "bridge/status", status: connected ? "connected" : "connecting" }));
  client.on("message", (raw) => {
    const session = (client as any).authenticatedSession;
    if (session && (session.revoked || session.expiresAt <= Date.now())) return;
    try { handleClient(client, JSON.parse(String(raw)), channel); }
    catch (error) { client.send(JSON.stringify({ type: "rpc/error", error: String(error) })); }
  });
  client.on("close", () => { clients.delete(client); sessionService.disconnect(channel); });
});
terminalWss.on("connection", (client, req) => {
  let terminal: ReturnType<typeof createTerminalSession> | null = null;
  try {
    const url = new URL(req.url || "/terminal", "http://localhost");
    const cwd = resolveTerminalCwd(url.searchParams.get("cwd"), browseRoots, defaultCwd);
    terminal = createTerminalSession({
      cwd,
      cols: 100,
      rows: 24,
      onData: data => { if (client.readyState === WebSocket.OPEN) client.send(data); },
      onExit: event => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(`\r\n[Process exited ${event.exitCode}]\r\n`);
          client.close(1000, "Terminal exited");
        }
      },
    });
    terminalSessions.set(client, terminal);
  } catch (error) {
    console.error("[codex-cli-webui] terminal failed", error);
    client.close(1011, "Terminal unavailable");
    return;
  }
  client.on("message", (raw, isBinary) => {
    const session = (client as any).authenticatedSession;
    if (session && (session.revoked || session.expiresAt <= Date.now())) return;
    if (!terminal || raw.byteLength > 1_000_000) return;
    if (isBinary) {
      terminal.write(Buffer.from(raw as Buffer).toString("utf8"));
      return;
    }
    try {
      const resize = normalizeTerminalResize(JSON.parse(String(raw)));
      if (resize) terminal.resize(resize.cols, resize.rows);
    } catch { /* Terminal input is sent as binary; ignore malformed control frames. */ }
  });
  client.on("close", () => {
    terminalSessions.delete(client);
    terminal?.kill();
    terminal = null;
  });
  client.on("error", () => client.close());
});

await build({
  entryPoints: [resolve(publicDir, "app.js")],
  outfile: resolve(publicDir, "app.bundle.js"),
  bundle: true,
  platform: "browser",
  format: "esm",
  minify: false,
});

startCodex();
server.listen(port, host, () => {
  console.log(`codex-cli-webui listening on http://${host}:${port}`);
  console.log(`[codex-cli-webui] Codex connection: ${codexConnection.kind}`);
  if (passwordSetupRequired()) console.warn(`[codex-cli-webui] Configure public access credentials at http://127.0.0.1:${port}/settings/access-settings`);
  if (!localhostOnly) {
    const addresses = Object.values(networkInterfaces()).flat().filter((entry): entry is NonNullable<typeof entry> => !!entry && entry.family === "IPv4" && !entry.internal);
    for (const entry of addresses) console.log(`LAN: http://${entry.address}:${port} (authentication required)`);
  }
});

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  messageQueue.close();
  sessionService.close();
  connected = false;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = null;
  clearInterval(sseKeepalive);
  for (const item of pending.values()) item.reject(new Error("codex-cli-webui is shutting down"));
  pending.clear();
  for (const client of clients) client.terminate();
  clients.clear();
  for (const client of sseClients) client.end();
  sseClients.clear();
  wss.close();
  for (const [client, terminal] of terminalSessions) { terminal.kill(); client.terminate(); }
  terminalSessions.clear();
  terminalWss.close();
  terminateCodex();
  server.close(() => { httpClosed = true; maybeFinishShutdown(); });
  server.closeAllConnections?.();
  const forceExit = setTimeout(() => {
    terminateCodex("SIGKILL");
    process.exit(0);
  }, 5000);
  forceExit.unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
