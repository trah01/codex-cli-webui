import { upsertSessionItem as upsert } from './session-items.js';
function turnOf(state, id) {
  if (!id) return null;
  const turns = state.thread.turns ||= [];
  let turn = turns.find(turn => turn.id === id);
  if (!turn) { turn = { id, status: 'inProgress', items: [] }; turns.push(turn); }
  return turn;
}

export function reduceSessionNotification(state, method, params) {
  if (method === 'error') return { error: { message: params.error?.message || params.message || 'Codex error', turnId: params.turnId, at: Date.now() } };
  if (method === 'thread/name/updated') { state.thread.name = params.name; return { thread: { name: params.name } }; }
  if (method === 'thread/status/changed') { state.thread.status = params.status; return { thread: { status: params.status } }; }
  if (method === 'thread/tokenUsage/updated') return { tokenUsage: params.tokenUsage };
  if (method === 'turn/diff/updated') return { diffs: { ...state.diffs, [params.turnId]: params.diff || '' } };
  if (method === 'turn/started' || method === 'turn/completed') {
    const turn = turnOf(state, params.turn?.id); if (!turn) return null;
    const previousItems = turn.items;
    Object.assign(turn, params.turn, { status: params.turn?.status || (method === 'turn/started' ? 'inProgress' : 'completed') });
    if (!params.turn?.items?.length) turn.items = previousItems;
    turn.items ||= [];
    if (method === 'turn/started') turn.startedAtMs ||= Date.now();
    else turn.completedAtMs ||= Date.now();
    return { turn: structuredClone(turn), thread: { status: { type: method === 'turn/started' ? 'active' : 'idle' } } };
  }
  if (!method.startsWith('item/')) return null;
  const turn = turnOf(state, params.turnId); if (!turn) return null;
  if (method === 'item/started' || method === 'item/completed') {
    upsert(turn, { ...params.item, status: params.item?.status || (method === 'item/started' ? 'inProgress' : 'completed') });
  } else {
    const id = params.itemId;
    let item = turn.items.find(item => item.id === id || Object.values(item.sourceIds || {}).includes(id));
    const type = method.split('/')[1];
    if (!item) { upsert(turn, { id, type, status: 'inProgress' }); item = turn.items.find(value => value.id === id); }
    if (method === 'item/agentMessage/delta') item.text = (item.text || '') + (params.delta || '');
    else if (/^item\/reasoning\//.test(method)) {
      const field = method.includes('summary') ? 'summary' : 'content', index = params.summaryIndex ?? params.contentIndex ?? 0;
      const parts = item[field] ||= []; while (parts.length <= index) parts.push('');
      if (params.delta) parts[index] += params.delta;
    } else if (method.endsWith('/outputDelta')) item.aggregatedOutput = (item.aggregatedOutput || '') + (params.delta || '');
    else if (method === 'item/fileChange/patchUpdated') item.changes = params.changes || [];
    else if (method === 'item/commandExecution/terminalInteraction') {
      let buffer = item.terminalInputBuffer || '';
      for (const character of String(params.stdin || '')) {
        if (character === '\r' || character === '\n') { if (buffer.trim()) (item.commandActions ||= []).push({ type: 'unknown', command: buffer.trim() }); buffer = ''; }
        else if (character === '\u0003') buffer = '';
        else if (character === '\b' || character === '\u007f') buffer = buffer.slice(0, -1);
        else buffer += character;
      }
      item.terminalInputBuffer = buffer;
    } else return null;
  }
  return { turn: structuredClone(turn) };
}
