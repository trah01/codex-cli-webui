import { applySessionDelta } from './session-delta.js';

function applyPatch(snapshot, patch) {
  if (patch.delta) return { ...snapshot, thread: applySessionDelta(snapshot.thread, patch.delta) };
  const next = structuredClone(snapshot);
  if (patch.thread) next.thread = { ...next.thread, ...patch.thread };
  if (patch.turn) {
    const turns = next.thread.turns ||= [], index = turns.findIndex(turn => turn.id === patch.turn.id);
    if (index < 0) turns.push(structuredClone(patch.turn)); else turns[index] = structuredClone(patch.turn);
  }
  for (const key of ['requests', 'queue', 'drafts', 'tokenUsage', 'diffs', 'error']) if (key in patch) next[key] = structuredClone(patch[key]);
  return next;
}

// The browser applies ordered server projections, never native/log deltas.
export function createSessionClient({ rpc, onState, onError = () => {}, retryMs = 1000 }) {
  let threadId = null, generation = 0, cursor = null, snapshot = null, loading = false, buffered = [], retry = null;
  const current = () => ({ threadId, cursor: cursor && { ...cursor }, snapshot });
  function schedule() { clearTimeout(retry); retry = setTimeout(() => activate(threadId), retryMs); }
  function apply(event) {
    if (event.threadId !== threadId) return;
    if (loading) { buffered.push(event); return; }
    if (event.epoch === cursor?.epoch && event.seq <= cursor.seq) return;
    if (!snapshot || event.epoch !== cursor?.epoch || event.seq !== cursor.seq + 1) {
      buffered.push(event); void activate(threadId, true); return;
    }
    snapshot = applyPatch(snapshot, event.patch); cursor = { epoch: event.epoch, seq: event.seq };
    onState(structuredClone(snapshot), event.patch, false);
  }
  async function activate(id, forceSnapshot = false) {
    clearTimeout(retry);
    const changed = id !== threadId, revision = ++generation;
    threadId = id; loading = true; buffered = [];
    if (changed || forceSnapshot) { cursor = null; if (changed) snapshot = null; }
    if (!id) {
      loading = false; snapshot = null; cursor = null;
      try { await rpc('host/session/subscribe', { threadId: null, subscriptionId: revision }); } catch {}
      return;
    }
    try {
      const result = await rpc('host/session/subscribe', { threadId: id, subscriptionId: revision, ...(cursor && snapshot ? { cursor } : {}) });
      if (generation !== revision || id !== threadId) return;
      if (result.mode === 'superseded') return;
      const queued = buffered; buffered = []; loading = false;
      if (result.mode === 'snapshot') {
        snapshot = result.snapshot; cursor = { epoch: result.epoch, seq: result.seq };
        onState(structuredClone(snapshot), null, true);
      } else if (result.mode === 'replay') {
        if (!snapshot || cursor?.epoch !== result.epoch) { void activate(id, true); return; }
        for (const event of result.events) { if (generation !== revision) return; apply(event); }
        if (generation !== revision) return;
        if (cursor.seq !== result.seq) { void activate(id, true); return; }
      } else throw Error('Invalid session subscription');
      for (const event of queued.sort((left, right) => left.seq - right.seq)) { if (generation !== revision) return; apply(event); }
    } catch (error) {
      if (generation !== revision) return;
      loading = false; onError(error); schedule();
    }
  }
  return {
    activate, receive: apply, current,
    reconnect: () => threadId ? activate(threadId) : Promise.resolve(),
    disconnect() { ++generation; loading = true; buffered = []; clearTimeout(retry); },
    close() { ++generation; clearTimeout(retry); },
  };
}
