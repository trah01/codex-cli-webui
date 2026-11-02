import { expect, test } from 'bun:test';
import { interruptThread } from '../turn-control.js';

test('interrupts the exact requested turn without resuming an already loaded thread', async () => {
  const calls = [], params = { threadId: 'thread-1', turnId: 'turn-1' };
  const result = await interruptThread(async (method, params) => { calls.push({ method, params }); return { ok: true }; }, params);
  expect(result).toEqual({ ok: true });
  expect(calls).toEqual([{ method: 'turn/interrupt', params }]);
});

test('loads a history thread only when the app-server cannot find it', async () => {
  const calls = [];
  await interruptThread(async (method, params) => {
    calls.push({ method, params });
    if (calls.length === 1) throw new Error('thread not found');
    return {};
  }, { threadId: 'thread-1', turnId: 'turn-1' });
  expect(calls.map(call => call.method)).toEqual(['turn/interrupt', 'thread/resume', 'turn/interrupt']);
  expect(calls[2].params.turnId).toBe('turn-1');
});

test('surfaces ownership failures without attempting to stop a different thread', async () => {
  const calls = [];
  const stop = () => interruptThread(async method => { calls.push(method); throw new Error('thread-store conflict: already has an active writer'); }, { threadId: 'thread-1', turnId: 'turn-1' });
  await expect(stop()).rejects.toThrow('active writer');
  expect(calls).toEqual(['turn/interrupt']);
});
