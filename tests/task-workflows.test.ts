import { expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { createTaskThreadReader, prepareThreadMessage } from '../server/task-context.js';
import { createSubagentService, collectSubagents } from '../server/subagent-service.js';
import { createMessageQueue } from '../server/message-queue.js';
import { createFilePanel } from '../public/file-panel.js';
import { createSubagentPanel } from '../public/subagent-panel.js';

const input = [{ type: 'text', text: '请结合 @设计任务 分析', text_elements: [] }];
const parent = { id: 'parent', cwd: '/project', turns: [{ id: 'parent-turn', items: [{ type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['child'], prompt: '检查接口', agentsStates: { child: { status: 'running' } } }] }] };

test('paginated history loads every page with full items and keeps legacy reading compatible', async () => {
  const legacy = vi.fn(async id => ({ id, turns: [] }));
  let paginated = true;
  const request = vi.fn(async (method, params) => method === 'thread/read' ? { thread: { id: params.threadId, historyMode: paginated ? 'paginated' : 'legacy' } } : params.cursor ? { data: [{ id: 'second', items: [] }], nextCursor: null } : { data: [{ id: 'first', items: parent.turns[0].items }], nextCursor: 'next' });
  const read = createTaskThreadReader({ request, loadLegacy: legacy });
  const thread = await read('parent');
  expect(thread.turns.map(turn => turn.id)).toEqual(['first', 'second']);
  expect(collectSubagents(thread)[0].threadId).toBe('child');
  expect(request).toHaveBeenCalledWith('thread/turns/list', { threadId: 'parent', limit: 100, itemsView: 'full', sortDirection: 'asc', cursor: 'next' });
  expect(legacy).not.toHaveBeenCalled();
  paginated = false; await read('old-thread'); expect(legacy).toHaveBeenCalledWith('old-thread');
});

test('new subagent activity records preserve their final status', () => {
  const thread = { id: 'parent', turns: [{ items: [
    { type: 'subAgentActivity', kind: 'started', agentThreadId: 'child', agentPath: '/root/check' },
    { type: 'subAgentActivity', kind: 'completed', agentThreadId: 'child', agentPath: '/root/check' },
  ] }] };
  expect(collectSubagents(thread)).toMatchObject([{ threadId: 'child', status: 'completed', agentPath: '/root/check' }]);
});

test('referenced conversations are read on the server and reach turn/start through the durable queue', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'webui-reference-'));
  const sent = [];
  const queue = createMessageQueue({ storePath: join(directory, 'queue.json'), request: async (method, params) => {
    if (method === 'thread/read') return { thread: { status: { type: 'idle' } } };
    sent.push(params); return { turn: { id: 'turn' } };
  }, setTimer: () => ({ unref() {} }), clearTimer() {} });
  try {
    const params = await prepareThreadMessage({ messageId: 'message', threadId: 'parent', input, references: [{ source: 'task', threadId: 'reference' }] }, async id => ({ id, name: '设计任务', turns: [{ items: [{ type: 'userMessage', content: [{ type: 'text', text: '请使用 SQLite' }] }, { type: 'agentMessage', text: '数据库方案已确定' }, { type: 'commandExecution', aggregatedOutput: 'private tool output' }] }] }));
    queue.enqueue(params); await queue.flush('parent');
    expect(sent[0].input[1].text).toContain('任务 ID：reference');
    expect(sent[0].input[1].text).toContain('数据库方案已确定');
    expect(sent[0].input[1].text).not.toContain('private tool output');
    expect(sent[0]).not.toHaveProperty('references');
    expect(input).toHaveLength(1);
  } finally { queue.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('unreadable references fail rather than silently sending just the task title; context is bounded', async () => {
  const params = { input, references: [{ source: 'task', threadId: 'reference' }] };
  await expect(prepareThreadMessage(params, async () => { throw new Error('任务不存在'); })).rejects.toThrow('任务不存在');
  await expect(prepareThreadMessage({ input, references: Array(6).fill(params.references[0]) }, async () => ({}))).rejects.toThrow('最多引用');
  const prepared = await prepareThreadMessage(params, async id => ({ id, turns: [{ items: [{ type: 'agentMessage', text: 'a'.repeat(30000) + '最新结论' }] }] }));
  expect(prepared.input[1].text).toContain('最新结论');
  expect(prepared.input[1].text.length).toBeLessThan(13000);
});

test('subagents are recovered from parent history and their actual runtime state is read', async () => {
  expect(collectSubagents(parent)).toHaveLength(1);
  const dispatch = createSubagentService({ loadThread: async () => parent, enqueue: vi.fn(), request: async () => ({ thread: { id: 'child', name: '接口检查', status: { type: 'idle' } } }) });
  const result = await dispatch('host/subagents/list', { threadId: 'parent' });
  expect(result.tasks[0]).toMatchObject({ threadId: 'child', name: '接口检查', status: 'completed', active: false });
});

test('delegation uses the main thread queue and reports disabled capabilities', async () => {
  const enqueue = vi.fn(() => ({ accepted: true }));
  let disabled = false;
  const dispatch = createSubagentService({ loadThread: async () => parent, enqueue, request: async () => ({ config: { agents: { enabled: !disabled } } }) });
  const params = { threadId: 'parent', prompt: '检查安全问题', messageId: 'delegation' };
  await dispatch('host/subagents/delegate', params);
  expect(enqueue.mock.calls[0][0]).toMatchObject({ threadId: 'parent', messageId: 'delegation', cwd: '/project' });
  expect(enqueue.mock.calls[0][0].input[0].text).toContain('实际创建并分派子代理');
  disabled = true;
  await expect(dispatch('host/subagents/delegate', params)).rejects.toThrow('关闭子代理');
  expect(enqueue).toHaveBeenCalledTimes(1);
});

test('stopping a subagent checks the parent relationship and targets its active turn', async () => {
  const request = vi.fn(async () => ({}));
  const dispatch = createSubagentService({ request, enqueue: vi.fn(), loadThread: async id => id === 'parent' ? parent : { id, status: { type: 'active' }, turns: [{ id: 'active-child-turn', status: 'inProgress' }] } });
  await expect(dispatch('host/subagents/stop', { threadId: 'parent', childThreadId: 'unrelated' })).rejects.toThrow('不属于');
  expect(request).not.toHaveBeenCalled();
  await dispatch('host/subagents/stop', { threadId: 'parent', childThreadId: 'child' });
  expect(request).toHaveBeenCalledWith('turn/interrupt', { threadId: 'child', turnId: 'active-child-turn' });
});

test('file references open real text previews and highlight the requested source line', async () => {
  const dom = new JSDOM('<main></main>');
  vi.stubGlobal('document', dom.window.document); vi.stubGlobal('requestAnimationFrame', callback => callback());
  vi.stubGlobal('fetch', async url => ({ ok: true, json: async () => String(url).includes('/preview?') ? { path: '/project/app.md', filename: 'app.md', text: 'first\n<script>line two</script>\nthird', markdown: true } : { path: '/project', parent: null, items: [] } }));
  try {
    const root = dom.window.document.querySelector('main');
    const panel = createFilePanel(root, { getCwd: () => '/project' });
    await panel.openFile({ path: 'app.md', lineStart: 2, lineEnd: 2 });
    expect(root.querySelector('mark').textContent).toBe('<script>line two</script>');
    expect(root.querySelector('script')).toBeNull();
    expect(root.querySelector('.file-preview-name').textContent).toBe('app.md:2');
    expect(root.querySelector('[data-download]').href).toContain('app.md');
    expect(root.classList.contains('file-preview-open')).toBe(true);
  } finally { vi.unstubAllGlobals(); dom.window.close(); }
});

test('subagent controls dispatch requests, open the child and return to its parent', async () => {
  const dom = new JSDOM('<section><div id="sideTaskList"></div></section>');
  vi.stubGlobal('document', dom.window.document);
  let active = { id: 'parent', cwd: '/project' };
  const rpc = vi.fn(async method => method === 'host/subagents/list' ? { tasks: [{ threadId: 'child', parentThreadId: 'parent', name: '检查接口', status: 'running', active: true }] } : { stopped: true });
  const delegate = vi.fn(async () => ({ accepted: true }));
  const openThread = vi.fn(async id => { active = { id, cwd: '/project' }; });
  const root = dom.window.document.querySelector('section');
  const panel = createSubagentPanel(root, { rpc, getThread: () => active, delegate, openThread });
  try {
    await root.querySelector('.subagent-toolbar button:last-child').onclick();
    root.querySelector('textarea').value = '检查后端';
    await root.querySelector('form').onsubmit({ preventDefault() {} });
    expect(delegate).toHaveBeenCalledWith('检查后端', 'parent');
    await root.querySelector('.subagent-stop').onclick();
    expect(rpc).toHaveBeenCalledWith('host/subagents/stop', { threadId: 'parent', childThreadId: 'child' });
    await root.querySelector('.side-task-card').onclick();
    expect(active.id).toBe('child');
    const back = root.querySelector('.subagent-toolbar button'); expect(back.hidden).toBe(false);
    await back.onclick(); expect(active.id).toBe('parent');
  } finally { panel.hide(); vi.unstubAllGlobals(); dom.window.close(); }
});
