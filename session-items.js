const text = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(part => typeof part === 'string' ? part : part?.text || '').join('\n') : '';
const familyOf = item => item.sourceIds?.rollout ? 'rollout' : String(item.id).startsWith('host-sent-') ? 'sent' : 'native';

function signature(item) {
  if (item.type === 'userMessage') return JSON.stringify((item.content || []).map(part => part.type === 'text' ? { type: 'text', text: part.text?.trim() } : { type: part.type, source: part.url || part.path }));
  if (item.type === 'agentMessage') return `${item.phase === 'commentary' ? 'commentary' : 'final'}\0${(item.text || text(item.content)).trim()}`;
  if (item.type === 'reasoning') return text(item.summary).trim() || null;
  if (item.type === 'commandExecution') return item.command?.trim() || null;
  if (item.type === 'fileChange') return (item.changes || []).map(change => change.path || change.filePath).sort().join('\0') || null;
  return null;
}

function equivalent(left, right) {
  const value = signature(left);
  return left.type === right.type && value !== null && value !== '' && value === signature(right);
}

export function upsertSessionItem(turn, item) {
  if (!turn || !item?.id) return;
  const family = familyOf(item);
  let index = turn.items.findIndex(existing => existing.id === item.id || Object.values(existing.sourceIds || {}).includes(item.id));
  const value = index < 0 ? item : { ...turn.items[index], ...item };
  const counterpart = turn.items.findIndex((existing, position) => position !== index && !(existing.sourceIds || { [familyOf(existing)]: existing.id })[family] && equivalent(existing, value));
  if (counterpart >= 0) {
    const previous = turn.items[counterpart];
    turn.items[counterpart] = { ...previous, ...value, id: previous.id, sourceIds: { ...previous.sourceIds, ...value.sourceIds, [family]: item.id } };
    if (index >= 0) turn.items.splice(index, 1);
  } else if (index < 0) turn.items.push({ ...item, sourceIds: { ...item.sourceIds, [family]: item.id } });
  else {
    const previous = turn.items[index];
    turn.items[index] = { ...previous, ...item, id: previous.id, sourceIds: { ...previous.sourceIds, ...item.sourceIds, [family]: item.id } };
  }
}

export function mergeTurnSources(nativeTurn, rolloutTurn) {
  const native = (nativeTurn?.items || []).map(item => ({ ...item, sourceIds: { native: item.id } }));
  const matched = new Set(), anchors = new Map();
  const items = (rolloutTurn.items || []).map(item => {
    const index = native.findIndex((value, position) => !matched.has(position) && (value.id === item.id || equivalent(value, item)));
    if (index < 0) return { ...item, sourceIds: { rollout: item.id } };
    matched.add(index);
    const merged = { ...native[index], ...item, id: native[index].id, sourceIds: { native: native[index].id, rollout: item.id } };
    anchors.set(index, merged); return merged;
  });
  let previous = null;
  for (let index = 0; index < native.length; index++) {
    if (matched.has(index)) { previous = anchors.get(index); continue; }
    const next = [...anchors].find(([position]) => position > index)?.[1];
    const position = next ? items.indexOf(next) : previous ? items.indexOf(previous) + 1 : items.length;
    items.splice(position, 0, native[index]); previous = native[index];
  }
  return { ...nativeTurn, ...rolloutTurn, items };
}

// Polling snapshots can lag behind text already received through notifications.
export function mergeStreamingTurn(previous, snapshot) {
  if (previous?.status !== 'inProgress') return snapshot;
  const turn = { ...snapshot, items: structuredClone(previous.items || []) };
  for (const item of snapshot.items || []) {
    const ids = new Set([item.id, ...Object.values(item.sourceIds || {})]);
    const current = turn.items.find(value => [value.id, ...Object.values(value.sourceIds || {})].some(id => ids.has(id)));
    const incoming = { ...item };
    if (current?.type === 'agentMessage' && item.type === 'agentMessage') {
      const before = current.text ?? text(current.content), after = item.text ?? text(item.content);
      if (before.startsWith(after)) incoming.text = before;
    }
    upsertSessionItem(turn, incoming);
  }
  return turn;
}
