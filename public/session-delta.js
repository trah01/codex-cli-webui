// A durable stream event carries only new text, rather than the growing turn.
export function sessionDelta(method, params) {
  let field, index;
  if (method === 'item/agentMessage/delta') field = 'text';
  else if (method.endsWith('/outputDelta')) field = 'aggregatedOutput';
  else if (/^item\/reasoning\//.test(method) && typeof params.delta === 'string') {
    field = method.includes('summary') ? 'summary' : 'content';
    index = params.summaryIndex ?? params.contentIndex ?? 0;
  }
  if (!field || !params.turnId || !params.itemId || typeof params.delta !== 'string') return null;
  return { turnId: params.turnId, itemId: params.itemId, type: method.split('/')[1], field, ...(index !== undefined && { index }), text: params.delta };
}

export function applySessionDelta(thread, delta) {
  const turns = [...(thread.turns || [])], position = turns.findIndex(turn => turn.id === delta.turnId);
  const turn = position < 0 ? { id: delta.turnId, status: 'inProgress', items: [] } : { ...turns[position] };
  turn.items = [...(turn.items || [])];
  const itemIndex = turn.items.findIndex(item => item.id === delta.itemId || Object.values(item.sourceIds || {}).includes(delta.itemId));
  const item = itemIndex < 0 ? { id: delta.itemId, type: delta.type, status: 'inProgress' } : { ...turn.items[itemIndex] };
  if (delta.index !== undefined) {
    const parts = [...(item[delta.field] || [])];
    while (parts.length <= delta.index) parts.push('');
    parts[delta.index] += delta.text; item[delta.field] = parts;
  } else item[delta.field] = (item[delta.field] || '') + delta.text;
  if (itemIndex < 0) turn.items.push(item); else turn.items[itemIndex] = item;
  if (position < 0) turns.push(turn); else turns[position] = turn;
  return { ...thread, turns };
}
