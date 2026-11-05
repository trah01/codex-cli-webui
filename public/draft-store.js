export function createDraftStore({ rpc, storage = globalThis.localStorage, onError = () => {}, delay = 300 }) {
  const drafts = new Map(), timers = new Map(), sending = new Set();
  const identity = (threadId, key) => `${threadId}\0${key}`;
  const storageKey = id => `codex-webui-draft:${encodeURIComponent(id)}`;
  function read(threadId, key) {
    const id = identity(threadId, key);
    if (!drafts.has(id)) {
      let saved; try { saved = JSON.parse(storage?.getItem(storageKey(id)) || 'null'); } catch {}
      drafts.set(id, saved || { revision: 0, value: null, pending: false, version: 0 });
    }
    return drafts.get(id);
  }
  function persist(id, draft) { try { storage?.setItem(storageKey(id), JSON.stringify(draft)); } catch { /* Large attachments are persisted by the host. */ } }
  function schedule(threadId, key) {
    const id = identity(threadId, key); clearTimeout(timers.get(id));
    timers.set(id, setTimeout(() => { timers.delete(id); void flush(threadId, key); }, delay));
  }
  async function flush(threadId, key) {
    const id = identity(threadId, key), draft = read(threadId, key);
    if (!draft.pending || sending.has(id)) return;
    sending.add(id); const version = draft.version;
    try {
      const result = await rpc('host/session/draft', { threadId, key, value: draft.value, expectedRevision: draft.revision });
      draft.revision = result.draft?.revision || 0;
      if (result.conflict) {
        draft.pending = false;
        onError(new Error('Draft changed in another window. Your current input has been kept.'));
      } else if (draft.version === version) draft.pending = false;
      persist(id, draft);
    } catch (error) { onError(error); }
    finally { sending.delete(id); if (draft.pending && draft.version !== version) schedule(threadId, key); }
  }
  return {
    get: (threadId, key) => { const draft=read(threadId,key);if(draft.pending)schedule(threadId,key);return structuredClone(draft.value); },
    set(threadId, key, value) {
      const id = identity(threadId, key), draft = read(threadId, key);
      if (JSON.stringify(draft.value) === JSON.stringify(value)) return;
      Object.assign(draft, { value: structuredClone(value), pending: true, version: draft.version + 1 });
      persist(id, draft); schedule(threadId, key);
    },
    hydrate(threadId, remote = {}) {
      for (const [key, saved] of Object.entries(remote)) {
        const id = identity(threadId, key), draft = read(threadId, key);
        if (!draft.pending && saved.revision >= draft.revision) { Object.assign(draft, { revision: saved.revision, value: structuredClone(saved.value) }); persist(id, draft); }
      }
    },
    async load(threadId) {
      const result = await rpc('host/session/drafts', { threadId }); this.hydrate(threadId, result.drafts); return this.get(threadId, 'composer');
    },
    flush,
    retry() { for (const id of drafts.keys()) { const [threadId, key] = id.split('\0'); void flush(threadId, key); } },
    close() { for (const timer of timers.values()) clearTimeout(timer); },
  };
}
