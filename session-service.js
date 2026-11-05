import { isDeepStrictEqual } from 'node:util';
import { SessionJournal } from './session-journal.js';
import { reduceSessionNotification } from './session-reducer.js';
import { validateImageInputs } from './public/composer-input.js';
import { sessionDelta } from './public/session-delta.js';
import { mergeStreamingTurn } from './session-items.js';
import { withAsyncQuestions } from './async-user-input.js';

const validThread = id => typeof id === 'string' && id.length > 0 && id.length <= 256;

export class SessionService {
  entries = new Map();
  subscriptions = new Map();
  subscriptionVersions = new Map();
  polls = new Map();
  turnOwners = new Map();
  refreshing = new Map();
  constructor({ directory, loadThread, loadQueue = () => undefined, loadRequests = () => undefined, pollMs = 1200, journalOptions }) {
    this.journal = new SessionJournal(directory, journalOptions);
    Object.assign(this, { loadThread, loadQueue, loadRequests, pollMs });
  }
  entry(id) {
    if (!validThread(id)) throw Error('Invalid thread id');
    let entry = this.entries.get(id);
    if (!entry) {
      entry = this.journal.open(id); this.entries.set(id, entry);
      for (const turn of entry.state.thread.turns || []) this.turnOwners.set(turn.id, id);
    }
    return entry;
  }
  publish(id, patch) {
    const entry = this.entry(id);
    if (patch.thread || patch.turn || patch.requests) {
      const thread = { ...entry.state.thread, ...patch.thread };
      if (patch.turn) {
        const turns = thread.turns || [], index = turns.findIndex(turn => turn.id === patch.turn.id);
        thread.turns = index < 0 ? [...turns, patch.turn] : turns.map((turn, position) => position === index ? patch.turn : turn);
      }
      patch = { ...patch, requests: withAsyncQuestions(thread, patch.requests ?? this.loadRequests(id) ?? entry.state.requests, entry.state.requests) };
    }
    const event = this.journal.append(entry, patch);
    if (patch.turn) this.turnOwners.set(patch.turn.id, id);
    for (const subscription of this.subscriptions.values()) if (subscription.threadId === id) {
      try { subscription.send(event); } catch { /* The transport closes and removes its subscription. */ }
    }
    return event;
  }
  notification(method, params) {
    const id = params.threadId || this.turnOwners.get(params.turnId || params.turn?.id);
    if (!id) return false;
    const entry = this.entry(id);
    const delta = sessionDelta(method, params);
    if (delta) {
      entry.contentRevision = (entry.contentRevision || 0) + 1;
      this.turnOwners.set(delta.turnId, id);
      this.publish(id, { delta });
      return true;
    }
    // Compute on a copy: disk persistence must succeed before authoritative state changes.
    const target = params.turnId || params.turn?.id;
    const working = { ...entry.state, thread: { ...entry.state.thread, turns: (entry.state.thread.turns || []).map(turn => turn.id === target ? structuredClone(turn) : turn) } };
    const patch = reduceSessionNotification(working, method, params);
    if (patch) { entry.contentRevision = (entry.contentRevision || 0) + 1; this.publish(id, patch); }
    return true;
  }
  async refresh(id) {
    if (this.refreshing.has(id)) return this.refreshing.get(id);
    const operation = this.refreshNow(id).finally(() => this.refreshing.delete(id));
    this.refreshing.set(id, operation); return operation;
  }
  async refreshNow(id) {
    const entry = this.entry(id), revision = entry.contentRevision || 0;
    const thread = await this.loadThread(id);
    if (!thread || thread.id !== id) throw Error('Invalid thread snapshot');
    // A late read cannot overwrite live notifications received while it was loading.
    if ((entry.contentRevision || 0) !== revision) {
      const current = new Map((entry.state.thread.turns || []).map(turn => [turn.id, turn]));
      thread.turns = (thread.turns || []).map(turn => current.get(turn.id) || turn);
      for (const turn of current.values()) if (!thread.turns.some(value => value.id === turn.id)) thread.turns.push(turn);
      Object.assign(thread, { status: entry.state.thread.status || thread.status });
    }
    const previousTurns = new Map((entry.state.thread.turns || []).map(turn => [turn.id, turn]));
    thread.turns = (thread.turns || []).map(turn => mergeStreamingTurn(previousTurns.get(turn.id), turn));
    for (const previous of previousTurns.values()) {
      if (previous.status === 'inProgress' && thread.status?.type === 'active' && !thread.turns.some(turn => turn.id === previous.id)) thread.turns.push(structuredClone(previous));
    }
    for (const turn of thread.turns || []) {
      const previous = previousTurns.get(turn.id);
      for (const key of ['startedAtMs', 'completedAtMs']) if (previous?.[key] !== undefined && turn[key] === undefined) turn[key] = previous[key];
    }
    const patch = { thread, requests: withAsyncQuestions(thread, this.loadRequests(id) ?? entry.state.requests, entry.state.requests), queue: this.loadQueue(id) ?? entry.state.queue };
    // Object key order is not a content change; compare the same derived projection that publish stores.
    if (!isDeepStrictEqual({ thread: entry.state.thread, requests: entry.state.requests, queue: entry.state.queue }, patch)) this.publish(id, patch);
    entry.loaded = true;
    for (const turn of thread.turns || []) this.turnOwners.set(turn.id, id);
    return entry;
  }
  async subscribe(client, { threadId, cursor, subscriptionId }, send) {
    if (!client) throw Error('Session subscription requires an event connection');
    if (subscriptionId !== undefined) {
      if (!Number.isSafeInteger(subscriptionId) || subscriptionId < 1) throw Error('Invalid subscription version');
      if (subscriptionId <= (this.subscriptionVersions.get(client) || 0)) return { mode: 'superseded' };
      this.subscriptionVersions.set(client, subscriptionId);
    }
    this.unsubscribe(client);
    if (!threadId) return { mode: 'unsubscribed' };
    const generation = { threadId, send };
    this.subscriptions.set(client, generation);
    try {
      await this.refresh(threadId);
      if (this.subscriptions.get(client) !== generation) return { mode: 'superseded' };
      this.poll(threadId);
      return this.journal.read(this.entry(threadId), cursor);
    } catch (error) {
      const entry = this.entry(threadId);
      if (this.subscriptions.get(client) !== generation) return { mode: 'superseded' };
      if (entry.seq) { this.publish(threadId, { requests: this.loadRequests(threadId) ?? entry.state.requests, queue: this.loadQueue(threadId) ?? entry.state.queue }); this.poll(threadId); return this.journal.read(entry, cursor); }
      this.unsubscribe(client); throw error;
    }
  }

  poll(threadId) {
    if (this.polls.has(threadId) || ![...this.subscriptions.values()].some(value => value.threadId === threadId)) return;
    const timer = setTimeout(async () => {
      try { await this.refresh(threadId); } catch {}
      if (this.polls.get(threadId) !== timer) return;
      this.polls.delete(threadId); this.poll(threadId);
    }, this.pollMs);
    timer.unref?.(); this.polls.set(threadId, timer);
  }
  unsubscribe(client) {
    const subscription = this.subscriptions.get(client);
    this.subscriptions.delete(client);
    if (subscription && ![...this.subscriptions.values()].some(value => value.threadId === subscription.threadId)) {
      clearTimeout(this.polls.get(subscription.threadId)); this.polls.delete(subscription.threadId);
    }
  }
  disconnect(client) { this.unsubscribe(client); this.subscriptionVersions.delete(client); }
  draft({ threadId, key, value, expectedRevision }) {
    if (key !== 'composer' && !/^question:[a-zA-Z0-9_-]{1,160}$/.test(key || '')) throw Error('Invalid draft key');
    if (value !== null && (!value || typeof value !== 'object' || Array.isArray(value))) throw Error('Invalid draft');
    if (JSON.stringify(value).length > 30 * 1024 * 1024) throw Error('Draft is too large');
    if (key === 'composer' && value) {
      if (typeof value.text !== 'string' || value.text.length > 1_000_000 || !Array.isArray(value.images) || !Array.isArray(value.mentions)) throw Error('Invalid composer draft');
      validateImageInputs(value.images.map(image => ({ type: 'image', url: image.url })));
    }
    const entry = this.entry(threadId), current = entry.state.drafts[key];
    if (current && JSON.stringify(current.value) === JSON.stringify(value)) return { draft: current };
    if (expectedRevision !== undefined && expectedRevision !== (current?.revision || 0)) return { conflict: true, draft: current };
    const draft = { revision: (current?.revision || 0) + 1, value, updatedAt: Date.now() };
    this.publish(threadId, { drafts: { ...entry.state.drafts, [key]: draft } });
    return { draft };
  }
  close() {
    for (const client of [...this.subscriptions.keys()]) this.unsubscribe(client);
    this.subscriptionVersions.clear();
    for (const entry of this.entries.values()) this.journal.checkpoint(entry);
  }
}
