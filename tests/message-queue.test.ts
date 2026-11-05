import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMessageQueue } from '../message-queue.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const input = [{ type: 'text', text: 'Please continue', text_elements: [] }];
const message = (id = 'message-1', threadId = 'thread-1', extra = {}) => ({ messageId: id, threadId, input, model: 'test-model', effort: 'high', ...extra });
function fixture(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'webui-queue-')); roots.push(root);
  return { storePath: join(root, 'queue.json'), request: async method => method==='thread/read'?{thread:{status:{type:'idle'}}}:{}, setTimer: () => ({ unref() {} }), clearTimer() {}, ...overrides };
}

test('ownership conflicts keep the message on disk and deliver after ownership is released', async () => {
  let busy = true;
  const calls: string[] = [], changes: any[] = [];
  const options = fixture({ request: async method => { calls.push(method); if(method==='thread/read')return {thread:{status:{type:'notLoaded'}}};if (busy && method === 'thread/resume') throw new Error('thread-store conflict: already has an active writer'); return {thread:{status:{type:'idle'}}}; }, notify: update => changes.push(update) });
  const queue = createMessageQueue(options);
  expect(queue.enqueue(message()).accepted).toBe(true);
  await queue.flush('thread-1');
  expect(queue.list('thread-1')[0].status).toBe('waiting');
  expect(JSON.parse(readFileSync(options.storePath, 'utf8')).messages[0].params.input).toEqual(input);
  expect(statSync(options.storePath).mode & 0o777).toBe(0o600);
  busy = false;
  await queue.flush('thread-1');
  expect(queue.list('thread-1')).toEqual([]);
  expect(calls).toEqual(['thread/read', 'thread/resume', 'thread/read', 'thread/resume', 'turn/start']);
  expect(changes.at(-1).messages).toEqual([]);
  queue.close();
});

test('messages wait for the current turn and retain FIFO order without concurrent sends', async () => {
  let active = true;
  const sent: any[] = [];
  const queue = createMessageQueue(fixture({ request: async (method, params) => { if(method==='thread/read')return {thread:{status:{type:active?'active':'idle'}}};if (method === 'turn/start') { sent.push(params); active = true; } return {}; } }));
  queue.enqueue(message('first')); queue.enqueue(message('second'));
  await queue.flush('thread-1');
  expect(sent).toHaveLength(0);
  active = false;
  await Promise.all([queue.flush('thread-1'), queue.flush('thread-1')]);
  expect(sent).toHaveLength(1);
  expect(queue.list('thread-1').map(entry => entry.id)).toEqual(['second']);
  await queue.flush('thread-1'); expect(sent).toHaveLength(1);
  active = false; await queue.flush('thread-1'); expect(sent).toHaveLength(2);
  expect(sent[0]).toMatchObject({ model: 'test-model', effort: 'high', input });
  queue.close();
});

test('a busy thread does not block another thread and pending messages survive a restart', async () => {
  const sent: string[] = [];
  const options = fixture({ request: async (method, params) => { if(method==='thread/read')return {thread:{status:{type:params.threadId==='thread-1'?'active':'idle'}}};if (method === 'turn/start') sent.push(params.threadId); return {}; } });
  const queue = createMessageQueue(options);
  queue.enqueue(message('first')); queue.enqueue(message('second', 'thread-2'));
  await queue.flush('thread-1'); await queue.flush('thread-2');
  expect(sent).toEqual(['thread-2']); queue.close();
  const restored = createMessageQueue({ ...options, request: async (method,params) => method==='thread/read'?{thread:{status:{type:'idle'}}}:options.request(method,params) });
  expect(restored.list('thread-1')[0].id).toBe('first');
  await restored.flush('thread-1'); expect(sent).toEqual(['thread-2', 'thread-1']);
  restored.close();
});

test('repeated acknowledgements cannot enqueue or send the same message twice, including after restart', async () => {
  let sent = 0;
  const options = fixture({ request: async method => { if (method === 'turn/start') sent++; return {}; } });
  const queue = createMessageQueue(options);
  queue.enqueue(message()); queue.enqueue(message());
  expect(queue.list('thread-1')).toHaveLength(1);
  await queue.flush('thread-1'); expect(queue.enqueue(message()).alreadySent).toBe(true);
  queue.close();
  const restored = createMessageQueue(options);
  expect(restored.enqueue(message()).alreadySent).toBe(true);
  await restored.flush('thread-1'); expect(sent).toBe(1);
  expect(() => restored.enqueue(message('message-1', 'thread-2'))).toThrow('another task');
  restored.close();
});

test('an owned active turn accepts immediate steering and a stale turn starts a new turn', async () => {
  const calls: any[] = [];
  let stale = false, reads = 0;
  const queue = createMessageQueue(fixture({ request: async (method, params) => { calls.push({ method, params }); if(method==='thread/read'){reads++;return {thread:{status:{type:stale&&reads>1?'idle':'active'}}}}if (stale && method === 'turn/steer') throw new Error('no active turn'); return {}; } }));
  queue.enqueue(message('steer', 'thread-1', { expectedTurnId: 'turn-1' }));
  await queue.flush('thread-1');
  expect(calls.map(call => call.method)).toEqual(['thread/read', 'turn/steer']);
  expect(calls[1].params.expectedTurnId).toBe('turn-1');
  stale = true; reads = 0; calls.length = 0;
  queue.enqueue(message('after', 'thread-1', { expectedTurnId: 'turn-1' }));
  await queue.flush('thread-1');
  expect(calls.map(call => call.method)).toEqual(['thread/read', 'turn/steer', 'thread/read', 'turn/start']);
  expect(calls[3].params.expectedTurnId).toBeUndefined();
  queue.close();
});

test('failed sends remain visible, block later messages and support retry or cancellation', async () => {
  let failing = true;
  const queue = createMessageQueue(fixture({ request: async method => { if (failing && method === 'turn/start') throw new Error('model unavailable'); return {}; } }));
  queue.enqueue(message('first')); queue.enqueue(message('second'));
  await queue.flush('thread-1');
  expect(queue.list('thread-1')[0]).toMatchObject({ status: 'failed', error: 'model unavailable' });
  await queue.flush('thread-1'); expect(queue.list('thread-1')).toHaveLength(2);
  failing = false; queue.retry({ threadId: 'thread-1', messageId: 'first' });
  await queue.flush('thread-1');
  expect(queue.list('thread-1')[0].id).toBe('second');
  queue.cancel({ threadId: 'thread-1', messageId: 'second' });
  expect(queue.list('thread-1')).toEqual([]);
  queue.close();
});

test('unknown delivery after a crash requires a deliberate retry instead of duplicating a send', async () => {
  const options = fixture();
  writeFileSync(options.storePath, JSON.stringify({ version: 1, messages: [{ id: 'unknown', params: message(), status: 'sending', createdAt: 1 }], receipts: [] }));
  const queue = createMessageQueue(options);
  expect(queue.list('thread-1')[0].status).toBe('failed');
  expect(queue.list('thread-1')[0].error).toContain('Delivery status is unknown');
  await queue.flush('thread-1'); expect(queue.list('thread-1')).toHaveLength(1);
  queue.close();
});

test('messages remain pending while the Codex connection is unavailable', async () => {
  let connected = false, calls = 0;
  const queue = createMessageQueue(fixture({ canSend: () => connected, request: async () => { calls++; return {}; } }));
  queue.enqueue(message()); await queue.flush('thread-1');
  expect(calls).toBe(0); expect(queue.list('thread-1')[0].status).toBe('waiting');
  connected = true; await queue.flush('thread-1'); expect(queue.list('thread-1')).toEqual([]);
  queue.close();
});

test('an idle runtime sends immediately despite old active rollout and historical turn states', async () => {
  const calls: string[] = [];
  const queue = createMessageQueue(fixture({
    request: async method => {
      calls.push(method);
      if (method === 'thread/read') return { thread: { status: { type: 'idle' }, turns: [{ id: 'old', status: 'inProgress' }] } };
      if (method !== 'turn/start') throw new Error('Idle threads must not be resumed or steered');
      return {};
    },
    readLiveThread: async () => { throw new Error('Rollout history must not block an idle runtime'); },
  }));
  queue.enqueue(message('after-completion', 'thread-1', { expectedTurnId: 'old' }));
  await queue.flush('thread-1');
  expect(calls).toEqual(['thread/read', 'turn/start']);
  expect(queue.list('thread-1')).toEqual([]);
  queue.close();
});

test('resumed idle threads ignore unfinished historical turns', async () => {
  const calls: string[] = [];
  const queue = createMessageQueue(fixture({ request: async method => {
    calls.push(method);
    if (method === 'thread/read') return { thread: { status: { type: 'notLoaded' } } };
    if (method === 'thread/resume') return { thread: { status: { type: 'idle' }, turns: [{ status: 'inProgress' }, { status: 'completed' }] } };
    return {};
  } }));
  queue.enqueue(message()); await queue.flush('thread-1');
  expect(calls).toEqual(['thread/read', 'thread/resume', 'turn/start']);
  expect(queue.list('thread-1')).toEqual([]);
  queue.close();
});

test('older servers without runtime status only consider the latest historical turn', async () => {
  let sends = 0;
  const queue = createMessageQueue(fixture({ request: async method => {
    if (method === 'thread/read') return { thread: { status: { type: 'notLoaded' } } };
    if (method === 'thread/resume') return { thread: { turns: [{ status: 'inProgress' }, { status: 'completed' }] } };
    if (method === 'turn/start') sends++;
    return {};
  } }));
  queue.enqueue(message()); await queue.flush('thread-1');
  expect(sends).toBe(1); expect(queue.list('thread-1')).toEqual([]);
  queue.close();
});
