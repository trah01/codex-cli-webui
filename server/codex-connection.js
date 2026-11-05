import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

function isSocket(path) {
  try { return statSync(path).isSocket(); } catch { return false; }
}

export function resolveCodexConnection(env = process.env, { platform = process.platform, socketExists = isSocket } = {}) {
  const mode = env.CODEX_WEBUI_APP_SERVER_MODE || 'auto';
  if (!['auto', 'shared', 'standalone'].includes(mode)) throw new Error('CODEX_WEBUI_APP_SERVER_MODE must be auto, shared or standalone');
  const socketPath = resolve(env.CODEX_WEBUI_APP_SERVER_SOCKET || join(env.CODEX_HOME || join(env.HOME || homedir(), '.codex'), 'app-server-control', 'app-server-control.sock'));
  if (mode === 'standalone') return { kind: 'standalone' };
  if (platform !== 'win32' && (mode === 'shared' || env.CODEX_WEBUI_APP_SERVER_SOCKET || socketExists(socketPath))) return { kind: 'shared', socketPath };
  if (mode === 'shared') throw new Error('Shared Codex Unix sockets are not supported on this platform');
  return { kind: 'standalone' };
}

export function openSharedCodex(socketPath) {
  // Use the existing WebSocket client over the Unix socket, including paths with spaces.
  return new WebSocket('ws://localhost/', { createConnection: () => connect({ path: socketPath }) });
}

export function createCodexConnection({ cwd, env = process.env, onConnect, onMessage, onDisconnect, onError, spawnProcess = spawn, openShared = openSharedCodex, connection = resolveCodexConnection(env) }) {
  let child = null, socket = null;
  function receive(raw) {
    try { onMessage(JSON.parse(raw)); }
    catch (error) { onError(error); }
  }
  function start() {
    if (child || socket) return;
    if (connection.kind === 'shared') {
      let client;
      try { client = openShared(connection.socketPath); }
      catch (error) { onError(error); onDisconnect({}); return; }
      socket = client;
      client.on('open', () => { if (socket === client) onConnect(); });
      client.on('message', raw => { if (socket === client) receive(raw.toString()); });
      client.on('error', onError);
      client.on('close', () => {
        if (socket !== client) return;
        socket = null; onDisconnect({});
      });
      return;
    }
    const proc = spawnProcess('codex', ['app-server', '--stdio'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    child = proc;
    let buffer = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', chunk => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf('\n'); if (end < 0) break;
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
        if (line) receive(line);
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', data => onError(new Error(String(data).trimEnd())));
    const disconnected = (code, signal) => {
      if (child !== proc) return;
      child = null; onDisconnect({ code, signal });
    };
    proc.on('error', error => { onError(error); disconnected(null, null); });
    proc.on('exit', disconnected);
    onConnect();
  }
  return {
    kind: connection.kind,
    get running() { return Boolean(child || socket); },
    start,
    send(message) {
      if (socket) {
        if (socket.readyState !== WebSocket.OPEN) throw new Error('Connecting to shared Codex app server');
        socket.send(JSON.stringify(message)); return;
      }
      if (!child || child.exitCode !== null) throw new Error('Codex app server is not connected');
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    stop(signal = 'SIGTERM') {
      if (socket) {
        // The daemon belongs to Codex. Only detach this WebUI client.
        if (signal === 'SIGKILL' || socket.readyState !== WebSocket.OPEN) socket.terminate();
        else socket.close();
        return;
      }
      if (!child || child.exitCode !== null) return;
      if (process.platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, signal); return; } catch { /* Terminate only our wrapper if its group is unavailable. */ }
      }
      child.kill(signal);
    },
  };
}
