import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { applySessionDelta } from '../public/session-delta.js';

export function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}

export function applySessionPatch(state, patch) {
  if (patch.delta) state.thread = applySessionDelta(state.thread, patch.delta);
  if (patch.thread) state.thread = { ...state.thread, ...patch.thread };
  if (patch.turn) {
    const turns = state.thread.turns ||= [];
    const index = turns.findIndex(turn => turn.id === patch.turn.id);
    if (index < 0) turns.push(patch.turn); else turns[index] = patch.turn;
  }
  for (const key of ['requests', 'queue', 'drafts', 'tokenUsage', 'diffs', 'error']) if (key in patch) state[key] = patch[key];
  return state;
}

// Checkpoints and a bounded tail share the same sequence space across restarts.
export class SessionJournal {
  constructor(directory, { maxEvents = 128, maxBytes = 4 * 1024 * 1024 } = {}) {
    this.directory = directory; this.maxEvents = maxEvents; this.maxBytes = maxBytes;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  paths(threadId) {
    const name = createHash('sha256').update(threadId).digest('hex');
    return { checkpoint: join(this.directory, `${name}.json`), tail: join(this.directory, `${name}.jsonl`) };
  }
  open(threadId) {
    const paths = this.paths(threadId);
    let entry = { threadId, epoch: randomUUID(), seq: 0, state: { thread: { id: threadId, turns: [] }, requests: [], queue: [], drafts: {}, diffs: {} }, events: [] };
    try {
      const saved = JSON.parse(readFileSync(paths.checkpoint, 'utf8'));
      if (saved.version !== 1 || saved.threadId !== threadId || !Number.isSafeInteger(saved.seq) || !saved.state?.thread || !Array.isArray(saved.events)) throw Error('Invalid session checkpoint');
      entry = saved;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let tail = '';
    try { tail = readFileSync(paths.tail, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const lines = tail.split('\n');
    let valid = '';
    for (const line of lines.slice(0, -1)) {
      if (!line) continue;
      const event = JSON.parse(line);
      if (event.epoch !== entry.epoch || event.threadId !== threadId) throw Error('Invalid session journal identity');
      if (event.seq > entry.seq) {
        if (event.seq !== entry.seq + 1) throw Error('Session journal sequence gap');
        applySessionPatch(entry.state, event.patch); entry.seq = event.seq; entry.events.push(event);
      }
      valid += `${line}\n`;
    }
    // Only an interrupted final append is repaired; internal corruption is reported.
    if (lines.at(-1)) writeFileSync(paths.tail, valid, { mode: 0o600 });
    entry.paths = paths; entry.sinceCheckpoint = 0;
    entry.eventSizes = entry.events.map(event => Buffer.byteLength(JSON.stringify(event)));
    entry.eventBytes = entry.eventSizes.reduce((sum, size) => sum + size, 0);
    this.trim(entry);
    if (entry.seq === 0) this.checkpoint(entry);
    return entry;
  }
  trim(entry) {
    while (entry.events.length > this.maxEvents || entry.events.length > 1 && entry.eventBytes > this.maxBytes) {
      entry.events.shift(); entry.eventBytes -= entry.eventSizes.shift();
    }
  }
  append(entry, patch) {
    const event = { type: 'session/event', threadId: entry.threadId, epoch: entry.epoch, seq: entry.seq + 1, patch: structuredClone(patch) };
    const serialized = JSON.stringify(event);
    appendFileSync(entry.paths.tail, `${serialized}\n`, { mode: 0o600 });
    applySessionPatch(entry.state, event.patch); entry.seq = event.seq; entry.events.push(event);
    const size = Buffer.byteLength(serialized); entry.eventSizes.push(size); entry.eventBytes += size;
    this.trim(entry);
    if (++entry.sinceCheckpoint >= 32) this.checkpoint(entry);
    return event;
  }
  checkpoint(entry) {
    atomicJson(entry.paths.checkpoint, { version: 1, threadId: entry.threadId, epoch: entry.epoch, seq: entry.seq, state: entry.state, events: entry.events });
    writeFileSync(entry.paths.tail, '', { mode: 0o600 });
    entry.sinceCheckpoint = 0;
  }
  read(entry, cursor) {
    if (cursor?.epoch === entry.epoch && Number.isSafeInteger(cursor.seq) && cursor.seq >= 0 && cursor.seq <= entry.seq && cursor.seq >= (entry.events[0]?.seq ?? entry.seq + 1) - 1) {
      return { mode: 'replay', threadId: entry.threadId, epoch: entry.epoch, seq: entry.seq, events: structuredClone(entry.events.filter(event => event.seq > cursor.seq)) };
    }
    return { mode: 'snapshot', threadId: entry.threadId, epoch: entry.epoch, seq: entry.seq, snapshot: structuredClone(entry.state) };
  }
}
