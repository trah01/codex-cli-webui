import { expect, test } from 'vitest';
import { JSDOM } from 'jsdom';
import { createSessionClient } from '../public/session-client.js';
import { createDraftStore } from '../public/draft-store.js';
import { createUserInputDialog } from '../public/user-input.js';

const baseline = (threadId = 'a', seq = 1, epoch = 'epoch') => ({ mode: 'snapshot', threadId, epoch, seq, snapshot: { thread: { id: threadId, turns: [] }, requests: [], queue: [], drafts: {} } });
const event = (seq, text, threadId = 'a') => ({ type: 'session/event', threadId, epoch: 'epoch', seq, patch: { turn: { id: 'turn', items: [{ id: 'message', type: 'agentMessage', text }] } } });
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };

test('events received before the subscription reply are buffered and duplicates are ignored', async () => {
  const opening = deferred(), states = [];
  const client = createSessionClient({ rpc: async () => opening.promise, onState: state => states.push(state) });
  try {
    const subscribed = client.activate('a');
    client.receive(event(2, 'two')); client.receive(event(1, 'duplicate'));
    opening.resolve(baseline()); await subscribed;
    expect(client.current().cursor.seq).toBe(2);
    expect(states.at(-1).thread.turns[0].items[0].text).toBe('two');
    client.receive(event(2, 'duplicate')); client.receive(event(3, 'foreign', 'b'));
    expect(states).toHaveLength(2);
  } finally { client.close(); }
});

test('text, command and indexed reasoning deltas replay without modifying earlier snapshots', async () => {
  const states = [], client = createSessionClient({ rpc: async () => baseline(), onState: state => states.push(state) });
  try {
    await client.activate('a');
    const emit = (seq, delta) => client.receive({ type: 'session/event', threadId: 'a', epoch: 'epoch', seq, patch: { delta: { turnId: 'turn', ...delta } } });
    emit(2, { itemId: 'msg', type: 'agentMessage', field: 'text', text: '你' });
    emit(3, { itemId: 'msg', type: 'agentMessage', field: 'text', text: '好' });
    emit(4, { itemId: 'cmd', type: 'commandExecution', field: 'aggregatedOutput', text: 'ok\n' });
    emit(5, { itemId: 'reason', type: 'reasoning', field: 'summary', index: 1, text: '分析' });
    const items = client.current().snapshot.thread.turns[0].items;
    expect(items[0].text).toBe('你好'); expect(items[1].aggregatedOutput).toBe('ok\n'); expect(items[2].summary).toEqual(['', '分析']);
    expect(states[1].thread.turns[0].items[0].text).toBe('你');
    client.receive({ type: 'session/event', threadId: 'a', epoch: 'epoch', seq: 3, patch: { delta: { turnId: 'turn', itemId: 'msg', field: 'text', text: 'duplicate' } } });
    expect(client.current().snapshot.thread.turns[0].items[0].text).toBe('你好');
  } finally { client.close(); }
});

test('reconnect replays only missing projections and refresh starts with an authoritative snapshot', async () => {
  const calls = [], states = [];
  const rpc = async (_method, params) => {
    calls.push(params);
    return params.cursor ? { mode: 'replay', threadId: 'a', epoch: 'epoch', seq: 3, events: [event(3, 'after reconnect')] } : baseline();
  };
  const client = createSessionClient({ rpc, onState: state => states.push(state) });
  try {
    await client.activate('a'); client.receive(event(2, 'before disconnect')); client.disconnect(); await client.reconnect();
    expect(calls[1].cursor.seq).toBe(2);
    expect(client.current().snapshot.thread.turns[0].items[0].text).toBe('after reconnect');
    const refreshed = createSessionClient({ rpc, onState: () => {} });
    await refreshed.activate('a'); expect(calls.at(-1).cursor).toBeUndefined(); refreshed.close();
  } finally { client.close(); }
});

test('a sequence gap requests a replacement snapshot and an old opening cannot replace another session', async () => {
  const waiting = deferred(), calls = [];
  const client = createSessionClient({ rpc: async (_method, params) => {
    calls.push(params);
    if (calls.length === 1) return baseline();
    if (params.threadId === 'a') return waiting.promise;
    return baseline('b', 4);
  }, onState: () => {} });
  try {
    await client.activate('a'); client.receive(event(7, 'gap'));
    expect(calls[1].cursor).toBeUndefined();
    await client.activate('b'); waiting.resolve(baseline('a', 7)); await Promise.resolve(); await Promise.resolve();
    expect(client.current().threadId).toBe('b'); expect(client.current().snapshot.thread.id).toBe('b');
  } finally { client.close(); }
});

test('offline local drafts survive a page reload and flush once using the saved revision', async () => {
  const storage = new JSDOM('', { url: 'https://example.test' }).window.localStorage, calls = [];
  const first = createDraftStore({ storage, rpc: async () => { throw Error('offline'); }, delay: 60_000 });
  const value = { text: 'keep my draft', images: [], mentions: [] };
  first.set('a', 'composer', value); first.close();
  const restored = createDraftStore({ storage, rpc: async (_method, params) => { calls.push(params); return { draft: { revision: 1, value: params.value } }; }, delay: 60_000 });
  try {
    expect(restored.get('a', 'composer')).toEqual(value); expect(restored.get('b', 'composer')).toBeNull();
    await restored.flush('a', 'composer'); await restored.flush('a', 'composer');
    expect(calls).toHaveLength(1); expect(calls[0].expectedRevision).toBe(0);
  } finally { restored.close(); }
});

test('another window cannot silently overwrite a saved draft', async () => {
  const errors = [], storage = new JSDOM('', { url: 'https://example.test' }).window.localStorage;
  const drafts = createDraftStore({ storage, delay: 60_000, onError: error => errors.push(error.message), rpc: async () => ({ conflict: true, draft: { revision: 4, value: { text: 'remote', images: [], mentions: [] } } }) });
  try {
    drafts.set('a', 'composer', { text: 'local', images: [], mentions: [] }); await drafts.flush('a', 'composer');
    expect(drafts.get('a', 'composer').text).toBe('local'); expect(errors).toHaveLength(1);
  } finally { drafts.close(); }
});

test('question choices restore after refresh and show submitting, accepted and ended distinctly', async () => {
  const storage = new JSDOM('', { url: 'https://example.test' }).window.localStorage;
  const drafts = createDraftStore({ storage, delay: 60_000, rpc: async (_method, params) => ({ draft: { revision: 1, value: params.value } }) });
  const request = { id: 1, method: 'item/tool/requestUserInput', params: { threadId: 'a', turnId: 'turn', itemId: 'question-item', questions: [{ id: 'q', question: '重启？', options: [{ label: '允许' }, { label: '暂不' }] }] } };
  const record = { key: 'key', status: 'awaiting', request }, response = deferred();
  const create = document => createUserInputDialog({ document, respond: async () => response.promise, getDraft: (id, key) => drafts.get(id, `question:${key}`), saveDraft: (id, key, value) => drafts.set(id, `question:${key}`, value) });
  try {
    const old = new JSDOM('<main id="conversation"></main>'), show = create(old.window.document);
    show.setThread('a'); show.sync([record]); old.window.document.querySelectorAll('input')[1].click();
    await drafts.flush('a', 'question:key');
    const refreshed = new JSDOM('<main id="conversation"><article data-turn-id="turn"><div class="turn-event-stream"><div class="assistant-response" data-item-id="question-item"></div><div class="later-message"></div></div></article></main>'), restored = create(refreshed.window.document);
    restored.setThread('a'); restored.sync([record]);
    expect(refreshed.window.document.querySelectorAll('input')[1].checked).toBe(true);
    refreshed.window.document.querySelector('form').dispatchEvent(new refreshed.window.Event('submit', { cancelable: true }));
    expect(refreshed.window.document.querySelector('section').dataset.requestState).toBe('submitting');
    response.resolve({ status: 'accepted' }); await new Promise(resolve => setTimeout(resolve, 0));
    expect(refreshed.window.document.querySelector('section').dataset.requestState).toBe('accepted');
    const card = refreshed.window.document.querySelector('section');
    expect(card.parentElement.className).toBe('turn-event-stream');
    expect(card.querySelector('form').hidden).toBe(true);
    expect(card.querySelector('details').open).toBe(false);
    expect(card.querySelector('summary strong').textContent).toBe('暂不');
    expect(card.querySelector('pre').textContent).toBe('重启？\n暂不');
    expect(card.previousElementSibling.dataset.itemId).toBe('question-item');
    expect(card.nextElementSibling.className).toBe('later-message');
    restored.sync([{ ...record, status: 'ended' }]);
    expect(refreshed.window.document.querySelector('section').dataset.requestState).toBe('ended');
    expect(refreshed.window.document.querySelector('button').disabled).toBe(true);
    restored.sync([{ ...record, status: 'ended' }]);
    expect(refreshed.window.document.querySelectorAll('.request-receipt')).toHaveLength(1);
    expect(card.nextElementSibling.className).toBe('later-message');
    expect(card.querySelector('summary strong').textContent).toBe('暂不');
    refreshed.window.document.querySelector('article').remove();
    restored.setThread('a');
    expect(refreshed.window.document.querySelector('section')).toBeNull();
  } finally { drafts.close(); }
});
