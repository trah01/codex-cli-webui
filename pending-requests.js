import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicJson } from './session-journal.js';

const requestKey = request => createHash('sha256').update(JSON.stringify([request.params?.threadId, request.params?.turnId, request.params?.itemId, request.method, request.id])).digest('hex');

// Persist request lifetimes, but never assume a saved RPC id is still live.
export class PendingRequests {
  requests = new Map();
  records = new Map();
  live = new Set();
  constructor({ path, onChange = () => {} } = {}) {
    this.path = path; this.onChange = onChange;
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(readFileSync(path, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.records)) throw Error('Invalid request store');
      for (const record of saved.records) {
        if (!record.key || !record.request?.params?.threadId) throw Error('Invalid saved request');
        if (record.status === 'awaiting' || record.status === 'submitting') record.status = 'recovering';
        this.records.set(record.key, record);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  save() { if (this.path) atomicJson(this.path, { version: 1, records: [...this.records.values()] }); }
  changed(threadId) { this.save(); this.onChange(threadId, this.listStates(threadId)); }
  add(request) {
    if (!request.params?.threadId) return;
    const key = requestKey(request), old = this.records.get(key);
    const record = { key, request: structuredClone(request), status: old?.status === 'accepted' || old?.status === 'ended' ? old.status : 'awaiting', updatedAt: Date.now() };
    this.records.set(key, record);
    if (record.status === 'awaiting') { this.requests.set(request.id, request); this.live.add(key); }
    this.changed(request.params.threadId);
    return record;
  }
  list(threadId) { return [...this.requests.values()].filter(request => request.params?.threadId === threadId); }
  listStates(threadId) { return [...this.records.values()].filter(record => record.request.params.threadId === threadId).map(record => structuredClone(record)); }
  find(id, threadId, key) { return [...this.records.values()].reverse().find(record => record.request.id === id && record.request.params.threadId === threadId && (!key || record.key === key)); }
  resolve(id, threadId) {
    const request = this.requests.get(id);
    const records = [...this.records.values()].filter(record => record.request.id === id && (!threadId || record.request.params.threadId === threadId) && record.status !== 'ended');
    for (const record of records) {
      record.status = 'ended'; record.updatedAt = Date.now(); this.live.delete(record.key);
      this.changed(record.request.params.threadId);
    }
    this.requests.delete(id);
    return Boolean(request || records.length);
  }
  reconcile(threadId, turns) {
    const statuses = new Map(turns.map(turn => [turn.id, turn.status]));
    for (const record of this.records.values()) {
      if (record.request.params.threadId !== threadId || record.status === 'ended') continue;
      const status = statuses.get(record.request.params.turnId);
      if (status && status !== 'inProgress') this.resolve(record.request.id, threadId);
    }
  }
  endTurn(threadId, turnId) {
    for (const record of this.records.values()) if (record.request.params.threadId === threadId && record.request.params.turnId === turnId) this.resolve(record.request.id, threadId);
  }
  disconnect() {
    const affected = new Set();
    for (const record of this.records.values()) if (record.status === 'awaiting' || record.status === 'submitting') { record.status = 'recovering'; affected.add(record.request.params.threadId); }
    this.requests.clear(); this.live.clear();
    for (const id of affected) this.changed(id);
  }
  clear() { this.requests.clear(); this.records.clear(); this.live.clear(); this.save(); }
  answer(id, threadId, send, key) {
    const record = this.find(id, threadId, key);
    if (!record || record.status !== 'awaiting' || !this.live.has(record.key)) throw Error('This request is no longer available');
    record.status = 'submitting'; this.changed(threadId);
    try { send(); }
    catch (error) { record.status = 'awaiting'; this.changed(threadId); throw error; }
    record.status = 'accepted'; this.requests.delete(id); this.live.delete(record.key); this.changed(threadId);
    return record;
  }
}
