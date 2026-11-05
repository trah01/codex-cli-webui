import { expect, test } from 'vitest';
import { mkdtempSync, rmSync, appendFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionService } from '../server/session-service.js';
import { SessionJournal } from '../server/session-journal.js';
import { PendingRequests } from '../server/pending-requests.js';
import { createSessionRequestHandlers } from '../server/session-request-service.js';
import { mergeTurnSources, upsertSessionItem } from '../server/session-items.js';

const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const thread = id => ({ id, status: { type: 'idle' }, turns: [] });
const setup = (options = {}) => {
  const directory = mkdtempSync(join(tmpdir(), 'webui-sessions-'));
  const service = new SessionService({ directory, loadThread: async id => thread(id), pollMs: 60_000, ...options });
  return { directory, service, close() { service.close(); rmSync(directory, { recursive: true, force: true }); } };
};

test('subscriptions route only the owning session and stop delivering immediately after a switch', async () => {
  const f = setup(), a = [], b = [], clientA = {}, clientB = {};
  try {
    await f.service.subscribe(clientA, { threadId: 'a' }, event => a.push(event));
    await f.service.subscribe(clientB, { threadId: 'b' }, event => b.push(event));
    a.length = b.length = 0;
    f.service.notification('turn/started', { threadId: 'a', turn: { id: 'turn-a' } });
    f.service.notification('item/agentMessage/delta', { turnId: 'turn-a', itemId: 'msg', delta: 'hello' });
    expect(a).toHaveLength(2); expect(b).toHaveLength(0);
    expect(a[1].patch.delta.text).toBe('hello');
    await f.service.subscribe(clientA, { threadId: 'b' }, event => a.push(event));
    a.length = 0;
    f.service.notification('item/agentMessage/delta', { threadId: 'a', turnId: 'turn-a', itemId: 'msg', delta: ' world' });
    expect(a).toHaveLength(0);
    expect(f.service.entry('a').state.thread.turns[0].items[0].text).toBe('hello world');
    f.service.unsubscribe(clientA); f.service.unsubscribe(clientB);
    expect(f.service.subscriptions.size).toBe(0);
  } finally { f.close(); }
});

test('out-of-order SSE subscription requests cannot undo a newer selection and subscribers share one poll', async () => {
  const f = setup(), client = {}, other = {};
  try {
    await f.service.subscribe(client, { threadId: 'b', subscriptionId: 3 }, () => {});
    expect((await f.service.subscribe(client, { threadId: null, subscriptionId: 2 }, () => {})).mode).toBe('superseded');
    expect((await f.service.subscribe(client, { threadId: 'a', subscriptionId: 1 }, () => {})).mode).toBe('superseded');
    expect(f.service.subscriptions.get(client).threadId).toBe('b');
    await f.service.subscribe(other, { threadId: 'b', subscriptionId: 1 }, () => {});
    expect(f.service.polls.size).toBe(1);
    f.service.disconnect(client); expect(f.service.polls.size).toBe(1);
    f.service.disconnect(other); expect(f.service.polls.size).toBe(0);
    expect(f.service.subscriptionVersions.size).toBe(0);
  } finally { f.close(); }
});

test('request handlers acknowledge retries without resending and prohibit persisting secret question drafts', () => {
  const f = setup(), requests = new PendingRequests(), sent = [];
  const handlers = createSessionRequestHandlers({ requests, sessions: f.service, send: message => sent.push(message) });
  try {
    const record = requests.add({ id: 1, method: 'item/tool/requestUserInput', params: { threadId: 'a', turnId: 'turn', questions: [{ id: 'password', isSecret: true }] } });
    expect(() => handlers.saveDraft({ threadId: 'a', key: `question:${record.key}`, value: { secret: 'must not persist' } })).toThrow('Secret');
    expect(() => handlers.answer({ threadId: 'b', requestId: 1, requestKey: record.key, result: {} })).toThrow();
    const params = { threadId: 'a', requestId: 1, requestKey: record.key, result: { answers: {} } };
    expect(handlers.answer(params).status).toBe('accepted');
    expect(handlers.answer(params).status).toBe('accepted'); expect(sent).toHaveLength(1);
    requests.resolve(1, 'a'); expect(handlers.answer(params).status).toBe('ended'); expect(sent).toHaveLength(1);
    expect(f.service.entry('a').state.drafts).toEqual({});
  } finally { f.close(); }
});

test('streamed output accumulates from the first delta and an empty completion summary preserves items', () => {
  const f = setup();
  try {
    f.service.notification('turn/started', { threadId: 'a', turn: { id: 'turn' } });
    f.service.notification('item/commandExecution/outputDelta', { threadId: 'a', turnId: 'turn', itemId: 'cmd', delta: 'first\n' });
    f.service.notification('item/commandExecution/outputDelta', { threadId: 'a', turnId: 'turn', itemId: 'cmd', delta: 'second\n' });
    f.service.notification('turn/completed', { threadId: 'a', turn: { id: 'turn', items: [], status: 'completed' } });
    const turn = f.service.entry('a').state.thread.turns[0];
    expect(turn.items[0].aggregatedOutput).toBe('first\nsecond\n'); expect(turn.status).toBe('completed');
    expect(turn.items[0].status).toBe('completed');
  } finally { f.close(); }
});

test('stream events stay small and replay the complete output after reopening the journal', () => {
  const f = setup();
  try {
    f.service.notification('turn/started', { threadId: 'a', turn: { id: 'turn' } });
    const before = f.service.journal.read(f.service.entry('a'));
    const delta = '输出'.repeat(512);
    for (let i = 0; i < 80; i++) f.service.notification('item/commandExecution/outputDelta', { threadId: 'a', turnId: 'turn', itemId: 'cmd', delta });
    const entry = f.service.entry('a');
    expect(entry.events.at(-1).patch.turn).toBeUndefined();
    expect(JSON.stringify(entry.events.at(-1)).length).toBeLessThan(delta.length + 400);
    const restored = f.service.journal.open('a');
    expect(restored.seq).toBe(entry.seq);
    expect(restored.state.thread.turns[0].items[0].aggregatedOutput).toBe(delta.repeat(80));
    const replay = f.service.journal.read(restored, { epoch: before.epoch, seq: before.seq });
    expect(replay.mode).toBe('replay'); expect(replay.events).toHaveLength(80);
  } finally { f.close(); }
});

test('native notifications and rollout snapshots identify the same command without collapsing repeated commands', () => {
  const command = (id, sourceIds = undefined) => ({ id, type: 'commandExecution', command: 'pwd', sourceIds });
  const native = { id: 'turn', items: [command('native-one'), command('native-two')] };
  const live = { id: 'turn', items: [command('rollout-one'), command('rollout-two')] };
  const merged = mergeTurnSources(native, live);
  expect(merged.items).toHaveLength(2);
  expect(merged.items.map(item => item.sourceIds)).toEqual([{ native: 'native-one', rollout: 'rollout-one' }, { native: 'native-two', rollout: 'rollout-two' }]);
  const turn = { items: [command('rollout', { rollout: 'rollout' })] };
  upsertSessionItem(turn, { id: 'native', type: 'commandExecution', command: '' });
  upsertSessionItem(turn, command('native'));
  expect(turn.items).toHaveLength(1); expect(turn.items[0].sourceIds.native).toBe('native');
  upsertSessionItem(turn, command('another-native'));
  expect(turn.items).toHaveLength(2);
});

test('persisted sequences replay after restart, and old cursors fall back to a full snapshot', () => {
  const f = setup({ journalOptions: { maxEvents: 2 } });
  try {
    const first = f.service.publish('a', { queue: [{ id: 'one' }] });
    f.service.publish('a', { queue: [{ id: 'two' }] });
    // Reopen without checkpointing to exercise tail recovery after a process crash.
    const restored = new SessionService({ directory: f.directory, loadThread: async id => thread(id), journalOptions: { maxEvents: 2 } });
    const replay = restored.journal.read(restored.entry('a'), { epoch: first.epoch, seq: first.seq });
    expect(replay.mode).toBe('replay'); expect(replay.events.map(event => event.seq)).toEqual([2]);
    expect(restored.publish('a', { queue: [{ id: 'three' }] }).seq).toBe(3);
    expect(restored.journal.read(restored.entry('a'), { epoch: first.epoch, seq: 0 }).mode).toBe('snapshot');
    expect(restored.journal.read(restored.entry('a'), { epoch: 'other', seq: 3 }).mode).toBe('snapshot');
    expect(restored.journal.read(restored.entry('a'), { epoch: first.epoch, seq: 999 }).mode).toBe('snapshot');
    // Avoid writing the older in-memory instance back over the crash-recovered store.
    f.service.entries.clear(); restored.close();
  } finally { f.close(); }
});

test('only a partially appended final journal record is repaired', () => {
  const f = setup();
  try {
    const event = f.service.publish('a', { queue: [{ id: 'saved' }] }), paths = f.service.entry('a').paths;
    appendFileSync(paths.tail, '{"seq":');
    const journal = new SessionJournal(f.directory), entry = journal.open('a');
    expect(entry.seq).toBe(event.seq); expect(entry.state.queue[0].id).toBe('saved');
    expect(journal.append(entry, { queue: [] }).seq).toBe(event.seq + 1);
    expect(journal.open('a').seq).toBe(event.seq + 1);
    expect(statSync(paths.tail).mode & 0o777).toBe(0o600);
    f.service.entries.clear();
  } finally { f.close(); }
});

test('a late snapshot cannot overwrite newer live text or switch a client back to an old session', async () => {
  const read = deferred(), f = setup({ loadThread: async id => id === 'a' ? read.promise : thread(id) }), client = {}, events = [];
  try {
    const opening = f.service.subscribe(client, { threadId: 'a' }, event => events.push(event));
    f.service.notification('turn/started', { threadId: 'a', turn: { id: 'active' } });
    f.service.notification('item/agentMessage/delta', { threadId: 'a', turnId: 'active', itemId: 'message', delta: 'newer' });
    await f.service.subscribe(client, { threadId: 'b' }, event => events.push(event));
    read.resolve({ id: 'a', turns: [{ id: 'active', status: 'inProgress', items: [{ id: 'message', type: 'agentMessage', text: 'stale' }] }] });
    expect((await opening).mode).toBe('superseded');
    expect(f.service.entry('a').state.thread.turns[0].items[0].text).toBe('newer');
    expect(f.service.subscriptions.get(client).threadId).toBe('b');
  } finally { f.close(); }
});

test('an offline backend can still serve its durable snapshot and maintain the subscription', async () => {
  const f = setup({ loadThread: async () => { throw Error('offline'); } });
  try {
    f.service.publish('a', { queue: [{ id: 'saved' }] });
    const client = {}, result = await f.service.subscribe(client, { threadId: 'a' }, () => {});
    expect(result.mode).toBe('snapshot'); expect(result.snapshot.queue[0].id).toBe('saved');
    expect(f.service.subscriptions.has(client)).toBe(true);
  } finally { f.close(); }
});

test('composer and question drafts survive restart with compare-and-set conflict checks', () => {
  const f = setup();
  try {
    const value = { text: 'unsent', images: [], mentions: [] };
    const first = f.service.draft({ threadId: 'a', key: 'composer', expectedRevision: 0, value });
    expect(first.draft.revision).toBe(1);
    expect(f.service.draft({ threadId: 'a', key: 'composer', expectedRevision: 0, value }).draft.revision).toBe(1);
    const conflict = f.service.draft({ threadId: 'a', key: 'composer', expectedRevision: 0, value: { ...value, text: 'other window' } });
    expect(conflict.conflict).toBe(true); expect(conflict.draft.value.text).toBe('unsent');
    f.service.draft({ threadId: 'a', key: 'question:key', value: { values: [{ id: 'q', selected: '1' }] } });
    const restored = new SessionService({ directory: f.directory, loadThread: async id => thread(id) });
    expect(restored.entry('a').state.drafts.composer.value.text).toBe('unsent');
    expect(restored.entry('a').state.drafts['question:key'].value.values[0].selected).toBe('1');
    expect(restored.entry('b').state.drafts).toEqual({});
    f.service.entries.clear(); restored.close();
  } finally { f.close(); }
});

test('requests persist every lifecycle transition and never resend an unconfirmed old RPC after restart', () => {
  const f = setup(), path = join(f.directory, 'requests.json'), states = [];
  const request = { id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'a', turnId: 'turn', itemId: 'cmd', command: 'restart' } };
  try {
    const store = new PendingRequests({ path, onChange: (_id, records) => states.push(records.at(-1).status) });
    store.add(request); let sent = 0;
    store.answer(7, 'a', () => { sent++; });
    expect(states).toEqual(['awaiting', 'submitting', 'accepted']); expect(sent).toBe(1);
    const restored = new PendingRequests({ path });
    expect(restored.listStates('a')[0].status).toBe('accepted');
    expect(() => restored.answer(7, 'a', () => sent++)).toThrow(); expect(sent).toBe(1);
    store.add({ ...request, id: 8 });
    const crash = new PendingRequests({ path });
    expect(crash.find(8, 'a').status).toBe('recovering');
    expect(() => crash.answer(8, 'a', () => sent++)).toThrow();
    crash.add({ ...request, id: 8 });
    crash.answer(8, 'a', () => sent++); expect(sent).toBe(2);
    crash.reconcile('a', [{ id: 'turn', status: 'completed' }]);
    expect(crash.listStates('a').every(record => record.status === 'ended')).toBe(true);
  } finally { f.close(); }
});


test('polling a finished turn cannot revive stale running activities or emit endless idle updates', async () => {
  const f = setup({ loadThread: async () => ({ id: 'a', status: { type: 'idle' }, turns: [{ id: 'turn', status: 'completed', items: [{ id: 'tool', type: 'mcpToolCall', status: 'inProgress' }] }] }) });
  const events = [];
  try {
    await f.service.subscribe({}, { threadId: 'a' }, event => events.push(event));
    expect(f.service.entry('a').state.thread.turns[0].items[0].status).toBe('completed');
    events.length = 0;
    for (let poll = 0; poll < 20; poll++) await f.service.refresh('a');
    expect(events).toHaveLength(0);
  } finally { f.close(); }
});


test('idle snapshots with different object key order and derived async questions do not rebroadcast', async () => {
  let text = 'Which option?';
  const f = setup({
    loadRequests: () => [],
    loadThread: async () => ({ status: { type: 'idle' }, turns: [{ status: 'completed', id: 'turn', items: [{ text, questions: [{ title: 'Choose', options: ['A', 'B'] }], type: 'agentMessage', id: 'question' }] }], id: 'a' }),
  });
  const events = [];
  try {
    await f.service.subscribe({}, { threadId: 'a' }, event => events.push(event));
    expect(f.service.entry('a').state.requests).toHaveLength(1);
    events.length = 0;
    for (let poll = 0; poll < 100; poll++) await f.service.refresh('a');
    expect(events).toHaveLength(0);
    text = 'Changed'; await f.service.refresh('a');
    expect(events).toHaveLength(1);
    expect(events[0].patch.thread.turns[0].items[0].text).toBe('Changed');
    await f.service.refresh('a'); expect(events).toHaveLength(1);
  } finally { f.close(); }
});
