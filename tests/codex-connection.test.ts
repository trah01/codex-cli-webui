import { expect, test } from 'vitest';
import { EventEmitter } from 'node:events';
import { createCodexConnection, resolveCodexConnection } from '../server/codex-connection.js';

test('auto shares an existing daemon and otherwise starts an isolated backend', () => {
  const env = { HOME: '/home/example' };
  expect(resolveCodexConnection(env, { platform: 'darwin', socketExists: () => true })).toEqual({ kind: 'shared', socketPath: '/home/example/.codex/app-server-control/app-server-control.sock' });
  expect(resolveCodexConnection(env, { platform: 'darwin', socketExists: () => false })).toEqual({ kind: 'standalone' });
  expect(resolveCodexConnection({ ...env, CODEX_WEBUI_APP_SERVER_MODE: 'standalone' }, { platform: 'darwin', socketExists: () => true })).toEqual({ kind: 'standalone' });
});

test('explicit shared mode keeps its target even when temporarily unavailable', () => {
  expect(resolveCodexConnection({ CODEX_WEBUI_APP_SERVER_MODE: 'shared', CODEX_WEBUI_APP_SERVER_SOCKET: '/tmp/custom.sock' }, { platform: 'darwin', socketExists: () => false })).toEqual({ kind: 'shared', socketPath: '/tmp/custom.sock' });
  expect(() => resolveCodexConnection({ CODEX_WEBUI_APP_SERVER_MODE: 'invalid' })).toThrow('must be');
});

test('shared transport exchanges messages, reconnects and closes only its own socket', () => {
  const sockets = [], received = [], disconnected = [];
  let opened = 0, closed = 0;
  const transport = createCodexConnection({
    connection: { kind: 'shared', socketPath: '/tmp/shared.sock' },
    onConnect: () => opened++, onMessage: value => received.push(value),
    onDisconnect: value => disconnected.push(value), onError: error => { throw error; },
    spawnProcess: () => { throw new Error('Must not spawn a second backend'); },
    openShared: () => {
      const socket = Object.assign(new EventEmitter(), { readyState: 0, sent: [], send(value) { this.sent.push(value); }, close() { closed++; this.emit('close'); } });
      sockets.push(socket); return socket;
    },
  });
  transport.start(); transport.start();
  expect(sockets.length).toBe(1);
  expect(() => transport.send({ id: 1 })).toThrow('Connecting');
  sockets[0].readyState = 1; sockets[0].emit('open');
  transport.send({ id: 1, method: 'thread/read' });
  sockets[0].emit('message', Buffer.from('{"id":1,"result":{}}'));
  expect(opened).toBe(1);
  expect(sockets[0].sent).toEqual(['{"id":1,"method":"thread/read"}']);
  expect(received).toEqual([{ id: 1, result: {} }]);
  transport.stop();
  expect(closed).toBe(1);
  expect(transport.running).toBe(false);
  expect(disconnected.length).toBe(1);
  transport.start();
  sockets[0].emit('close');
  expect(transport.running).toBe(true);
  expect(sockets.length).toBe(2);
});

test('standalone transport preserves newline framing and stops its own child', () => {
  const output = [], received = [], signals = [];
  const stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  const stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
  const child = Object.assign(new EventEmitter(), { stdout, stderr, exitCode: null, stdin: { write: value => output.push(value) }, kill: signal => signals.push(signal) });
  const transport = createCodexConnection({ connection: { kind: 'standalone' }, spawnProcess: () => child,
    onConnect() {}, onMessage: value => received.push(value), onDisconnect() {}, onError: error => { throw error; } });
  transport.start(); transport.send({ id: 1 });
  stdout.emit('data', '{"id":'); stdout.emit('data', '1}\n{"id":2}\n');
  expect(output).toEqual(['{"id":1}\n']);
  expect(received).toEqual([{ id: 1 }, { id: 2 }]);
  transport.stop();
  expect(signals).toEqual(['SIGTERM']);
  child.emit('exit', 0, null);
  expect(transport.running).toBe(false);
});
