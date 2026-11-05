import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { bridgeErrorCode, THREAD_ACTIVE_WRITER, THREAD_NOT_FOUND } from '../public/bridge-errors.js';
import { validateImageInputs } from '../public/composer-input.js';

const errorText = error => error?.message || String(error);
const isBusy = error => bridgeErrorCode(error) === THREAD_ACTIVE_WRITER || /(?:already|another|existing).*active turn|turn.*(?:already running|in progress)/i.test(errorText(error));
const staleTurn = error => bridgeErrorCode(error) === THREAD_NOT_FOUND || /no active turn|turn.*(?:not found|not active|mismatch|completed)|expected.*turn/i.test(errorText(error));

export function createMessageQueue({ storePath, request, notify = () => {}, canSend = () => true, retryMs = 2000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let messages = [], receipts = [], closed = false;
  const timers = new Map(), running = new Set();

  function save() {
    mkdirSync(dirname(storePath), { recursive: true, mode: 0o700 });
    const temporary = `${storePath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify({ version: 1, messages, receipts })}\n`, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, storePath);
    } finally {
      try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }

  try {
    const saved = JSON.parse(readFileSync(storePath, 'utf8'));
    if (saved.version !== 1 || !Array.isArray(saved.messages) || !Array.isArray(saved.receipts)) throw new Error('Invalid message queue');
    messages = saved.messages; receipts = saved.receipts;
    for (const message of messages) {
      if (!message.id || !message.params?.threadId || !Array.isArray(message.params.input)) throw new Error('Invalid queued message');
      validateImageInputs(message.params.input);
      if (message.status === 'sending') {
        message.status = 'failed';
        message.error = 'Delivery status is unknown. Check the conversation before retrying.';
      }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }

  function summary(message) {
    return {
      id: message.id, threadId: message.params.threadId, status: message.status, error: message.error || '', createdAt: message.createdAt,
      text: message.params.input.filter(part => part.type === 'text').map(part => part.text).join('\n').slice(0, 300),
      imageCount: message.params.input.filter(part => part.type === 'image' || part.type === 'localImage').length,
    };
  }
  function list(threadId) { return messages.filter(message => message.params.threadId === threadId).map(summary); }
  function submitted(messageId, params) {
    return { messageId, threadId: params.threadId, item: {
      id: `host-sent-${messageId}`, type: 'userMessage', content: structuredClone(params.input),
    } };
  }
  function changed(threadId) { notify({ type: 'bridge/queue', threadId, messages: list(threadId) }); }
  function schedule(threadId, delay = 0) {
    if (closed || timers.has(threadId)) return;
    const timer = setTimer(() => {
      timers.delete(threadId);
      void flush(threadId).catch(error => console.error('[codex-webui] message queue failed:', error.code || 'queue write error'));
    }, delay);
    timer?.unref?.(); timers.set(threadId, timer);
  }

  async function deliver(message) {
    const { expectedTurnId, ...params } = message.params;
    let thread;
    try { thread = (await request('thread/read', { threadId: params.threadId, includeTurns: false }))?.thread; }
    catch (error) { if (bridgeErrorCode(error) !== THREAD_NOT_FOUND) throw error; }
    // Runtime state takes precedence over old rollout events and historical turns.
    if (!thread?.status || thread.status.type === 'notLoaded') {
      if (closed || !canSend()) return null;
      thread = (await request('thread/resume', { threadId: params.threadId }))?.thread;
    }
    const active = thread?.status ? thread.status.type === 'active' : thread?.turns?.at(-1)?.status === 'inProgress';
    if (active) {
      if (!expectedTurnId || closed || !canSend()) return null;
      try { return await request('turn/steer', { threadId: params.threadId, expectedTurnId, input: params.input }); }
      catch (error) {
        if (!staleTurn(error)) throw error;
        // A completion can race with reading the active status. Refresh before deciding to wait.
        const current = (await request('thread/read', { threadId: params.threadId, includeTurns: false }))?.thread;
        if (current?.status?.type !== 'idle') return null;
      }
    }
    if (closed || !canSend()) return null;
    return await request('turn/start', params);
  }

  async function flush(threadId) {
    if (closed || running.has(threadId)) return;
    const message = messages.find(entry => entry.params.threadId === threadId);
    if (!message || message.status === 'failed') return;
    if (!canSend()) { schedule(threadId, retryMs); return; }
    running.add(threadId);
    let delay = retryMs;
    try {
      message.status = 'sending'; message.error = ''; save(); changed(threadId);
      let result;
      try { result = await deliver(message); }
      catch (error) {
        message.status = isBusy(error) ? 'waiting' : 'failed';
        message.error = message.status === 'failed' ? errorText(error) : '';
        save(); changed(threadId); return;
      }
      if (result === null) { message.status = 'waiting'; save(); changed(threadId); return; }
      // Persist receipts so retrying an acknowledged request cannot send it twice.
      const turnId = result?.turn?.id || result?.turnId || message.params.expectedTurnId;
      const delivered = turnId ? {
        type: 'bridge/message', threadId, turnId,
        item: { id: `host-sent-${message.id}`, type: 'userMessage', content: message.params.input, status: 'completed' },
      } : null;
      messages = messages.filter(entry => entry.id !== message.id);
      receipts.push({ id: message.id, threadId, delivered }); receipts = receipts.slice(-1000);
      save(); if (delivered) notify(delivered); changed(threadId); delay = 0;
    } finally {
      running.delete(threadId);
      if (messages.some(entry => entry.params.threadId === threadId && entry.status === 'waiting')) schedule(threadId, delay);
    }
  }

  function enqueue({ messageId, ...params }) {
    if (closed) throw new Error('Message queue is shutting down');
    if (typeof messageId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(messageId) || typeof params.threadId !== 'string' || !params.threadId || !Array.isArray(params.input) || !params.input.length) throw new Error('Invalid queued message');
    validateImageInputs(params.input);
    const existing = messages.find(message => message.id === messageId);
    const receipt = receipts.find(entry => entry.id === messageId);
    if ((existing && existing.params.threadId !== params.threadId) || (receipt && receipt.threadId !== params.threadId)) throw new Error('Message id belongs to another task');
    if (existing || receipt) return { accepted: true, alreadySent: Boolean(receipt), submitted: submitted(messageId, existing?.params || params), ...(receipt?.delivered ? { delivered: receipt.delivered } : {}), messages: list(params.threadId) };
    const message = { id: messageId, params: structuredClone(params), status: 'waiting', createdAt: Date.now() };
    messages.push(message);
    try { save(); } catch (error) { messages = messages.filter(entry => entry !== message); throw error; }
    changed(params.threadId); schedule(params.threadId);
    return { accepted: true, submitted: submitted(messageId, message.params), messages: list(params.threadId) };
  }
  function changeMessage({ threadId, messageId }, retry) {
    const message = messages.find(entry => entry.id === messageId && entry.params.threadId === threadId);
    if (!message) return { messages: list(threadId) };
    if (message.status === 'sending') throw new Error('This message is already being sent');
    if (retry) { message.status = 'waiting'; message.error = ''; }
    else messages = messages.filter(entry => entry !== message);
    save(); changed(threadId); schedule(threadId);
    return { messages: list(threadId) };
  }
  return {
    enqueue, list, flush,
    cancel: params => changeMessage(params, false), retry: params => changeMessage(params, true),
    wake() {
      for (const timer of timers.values()) clearTimer(timer);
      timers.clear();
      for (const threadId of new Set(messages.map(message => message.params.threadId))) schedule(threadId);
    },
    close() { closed = true; for (const timer of timers.values()) clearTimer(timer); timers.clear(); },
  };
}
