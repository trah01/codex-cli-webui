import { expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { PendingRequests } from '../server/pending-requests.js';
import { createUserInputDialog } from '../public/user-input.js';
import { parseRollout } from '../server/live-session-service.js';
import { createConversationScroll } from '../public/conversation-scroll.js';
import { createActivityMotion } from '../public/activity-motion.js';

test('scrolling upward cancels queued bottom-follow and only explicit navigation resumes it', () => {
  const dom = new JSDOM('<main></main><button hidden>回到最新</button>');
  const root = dom.window.document.querySelector('main')!, button = dom.window.document.querySelector('button')!, frames = [];
  Object.defineProperties(root, { scrollHeight: { value: 2000, configurable: true }, clientHeight: { value: 500 } });
  root.scrollTop = 1500;
  const scroll = createConversationScroll({ root, button, requestFrame: callback => frames.push(callback) });
  scroll.bottom();
  root.dispatchEvent(new dom.window.WheelEvent('wheel', { deltaY: -100 }));
  root.scrollTop = 1200; root.dispatchEvent(new dom.window.Event('scroll'));
  frames.shift()();
  expect(root.scrollTop).toBe(1200); expect(button.hidden).toBe(false);
  Object.defineProperty(root, 'scrollHeight', { value: 3000, configurable: true });
  scroll.bottom(); expect(frames).toHaveLength(0); expect(root.scrollTop).toBe(1200);
  button.click(); frames.shift()(); expect(root.scrollTop).toBe(3000); expect(button.hidden).toBe(true);
  root.scrollTop = 1000; root.dispatchEvent(new dom.window.Event('scroll')); scroll.bottom(true); frames.shift()();
  expect(root.scrollTop).toBe(3000);
});

const request = (id = 1, threadId = 'a') => ({ id, method: 'item/tool/requestUserInput', params: { threadId, turnId: 'turn', questions: [{ id: 'restart', question: '是否重启？', options: [{ label: '允许重启' }, { label: '暂不重启' }] }] } });

test('requests belong to one thread and can be answered only once; failed sends remain retryable', () => {
  const store = new PendingRequests();
  store.add(request()); store.add(request(2, 'b'));
  expect(store.list('a').map(r => r.id)).toEqual([1]);
  expect(() => store.answer(1, 'b', () => {})).toThrow();
  expect(() => store.answer(1, 'a', () => { throw Error('offline'); })).toThrow('offline');
  expect(store.list('a')).toHaveLength(1);
  store.answer(1, 'a', () => {});
  expect(() => store.answer(1, 'a', () => {})).toThrow();
  store.endTurn('a', 'turn'); expect(store.list('b')).toHaveLength(1);
  store.endTurn('b', 'turn'); expect(store.list('b')).toHaveLength(0);
});

test('question choices submit structured answers and preserve drafts across thread switches', async () => {
  const dom = new JSDOM('<main id="conversation"></main>');
  const document = dom.window.document, sent = [];
  const show = createUserInputDialog({ document, respond: async (...args) => { sent.push(args); } });
  show.setThread('a'); show(request()); show(request(2, 'b'));
  const choice = document.querySelector('input')!;
  choice.click();
  expect(document.querySelector('button')!.disabled).toBe(false);
  show.setThread('b'); expect(document.querySelectorAll('section')).toHaveLength(1);
  show.setThread(null); expect(document.querySelectorAll('section')).toHaveLength(0);
  show.setThread('a'); expect(document.querySelector('input')!.checked).toBe(true);
  document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  await Promise.resolve();
  expect(sent).toEqual([[1, { answers: { restart: { answers: ['允许重启'] } } }]]);
  expect(document.querySelector('section')).toBeNull();
  show.setThread('b'); show.resolve(2); expect(document.querySelector('section')).toBeNull();
});

test('question send failures retain the card for retry and completion removes it', async () => {
  const dom = new JSDOM('<main id="conversation"></main>'), document = dom.window.document;
  const show = createUserInputDialog({ document, respond: async () => { throw Error('offline'); } });
  show.setThread('a'); show(request()); document.querySelector('input')!.click();
  document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  await Promise.resolve();
  expect(document.querySelector('button')!.disabled).toBe(false);
  expect(document.querySelector('[role="alert"]')!.hidden).toBe(false);
  show.endTurn('a', 'turn'); expect(document.querySelector('section')).toBeNull();
});

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const functionSource = (name, next) => app.slice(app.indexOf(`function ${name}(`), app.indexOf(`function ${next}(`));

test('foreign and unowned command events never render into the active or new conversation', () => {
  const state = { active: { id: 'a' }, turns: new Map([['owned', {}]]) }, rendered = [];
  const notify = new Function('state', 'serverRequests', 'upsertItem', functionSource('onNotification', 'upsertReasoningDelta') + ';return onNotification;')(state, new Map(), (...args) => rendered.push(args));
  const item = { id: 'command', type: 'commandExecution' };
  notify('item/started', { threadId: 'b', turnId: 'foreign', item });
  notify('item/started', { turnId: 'unknown', item });
  state.active = null;
  notify('item/started', { threadId: 'a', turnId: 'owned', item });
  expect(rendered).toHaveLength(0);
  state.active = { id: 'a' };
  notify('item/started', { threadId: 'a', turnId: 'owned', item });
  expect(rendered).toHaveLength(1);
});

test('snapshot order keeps follow-up messages between earlier and later commands', () => {
  const dom = new JSDOM('<main><article id="initial">initial</article><article id="timeline"><div class="turn-event-stream"><div id="before">before</div><div id="after">after</div></div><div class="turn-final-slot"></div></article><article id="reply">reply</article></main>');
  const document = dom.window.document, root = document.querySelector('main'), timeline = document.querySelector('#timeline');
  const state = { turns: new Map([['turn', timeline]]), items: new Map(['initial', 'before', 'reply', 'after'].map(id => [id, document.getElementById(id)])) };
  const render = new Function('state', 'upsertItem', 'syncTurnTiming', functionSource('renderTurn', 'textFromInput') + ';return renderTurn;')(state, () => {}, () => {});
  const turn = { id: 'turn', items: ['initial', 'before', 'reply', 'after'].map(id => ({ id, type: ['initial', 'reply'].includes(id) ? 'userMessage' : 'agentMessage' })) };
  render(turn, root); render(turn, root);
  expect([...timeline.querySelector('.turn-event-stream').children].map(node => node.id)).toEqual(['before', 'reply', 'after']);
  expect(root.firstElementChild.id).toBe('initial');
});

test('rollout messages without upstream ids remain distinct and ordered', () => {
  const event = (type, payload) => JSON.stringify({ type, payload });
  const state = parseRollout([
    event('event_msg', { type: 'task_started', turn_id: 'turn' }),
    ...['first', 'second'].map(text => event('response_item', { type: 'message', role: 'assistant', content: text })),
  ].join('\n'));
  expect(state.turn.items.map(item => item.text)).toEqual(['first', 'second']);
  expect(new Set(state.turn.items.map(item => item.id)).size).toBe(2);
});


test('typing defers draft persistence, batches layout and skips autocomplete during IME composition', () => {
  vi.useFakeTimers();
  const saves = [], frames = [], lifecycle = {}, prompt = { value: 'first' };
  const declarations = app.slice(app.indexOf('let composerDraftReady='), app.indexOf('function restoreComposerDraft('));
  const inputHandler = app.match(/function handlePromptInput\(event\)\{[\s\S]*?\n\}/)[0];
  let layouts = 0, autocomplete = 0;
  const handlers = new Function('$', 'drafts', 'state', 'composerDraftOwner', 'addEventListener', 'requestAnimationFrame', 'resizePrompt', 'updateComposerAutocomplete',
    declarations + inputHandler + ';return {input:handlePromptInput,save:saveComposerDraft};')(
      () => prompt, { set: (...args) => saves.push(args) }, { composerMentions: [], composerImages: [] }, () => 'a',
      (name, handler) => { lifecycle[name] = handler; }, callback => { frames.push(callback); return frames.length; },
      () => { layouts++; }, () => { autocomplete++; });
  try {
    handlers.input({ isComposing: true }); prompt.value = '你好'; handlers.input({ isComposing: false });
    expect(saves).toHaveLength(0); expect(frames).toHaveLength(1); expect(autocomplete).toBe(1);
    frames[0](); expect(layouts).toBe(1);
    vi.advanceTimersByTime(300); expect(saves).toHaveLength(1); expect(saves[0][2].text).toBe('你好');
    prompt.value = 'next'; handlers.input({}); lifecycle.pagehide();
    expect(saves.at(-1)[2].text).toBe('next');
    vi.advanceTimersByTime(300); expect(saves).toHaveLength(2);
  } finally { vi.useRealTimers(); }
});

test('typing without changing submit mode preserves the send button DOM', () => {
  const dom = new JSDOM('<button id="sendButton"></button><textarea id="prompt"></textarea>');
  const document = dom.window.document;
  const sync = new Function('$', 'activeTurnId', 'state', 'interruptPending', 'imageReading', 'composerSubmitting', 'codexIcon', 't',
    functionSource('syncComposerSubmitState', 'setActiveTurnId') + ';return syncComposerSubmitState;')(
      selector => document.querySelector(selector), () => '', { composerImages: [] }, false, false, false,
      () => '<svg></svg>', value => value);
  sync(); const icon = document.querySelector('svg');
  document.querySelector('textarea').value = 'typing'; sync();
  expect(document.querySelector('svg')).toBe(icon);
});


function motionFixture() {
  const dom = new JSDOM('<article data-turn-id="turn" data-timing-status="inProgress"><div class="active"><span class="activity-motion"></span></div></article>');
  const row = dom.window.document.querySelector('.active'), holder = row.firstElementChild;
  const loads = [], players = new Set(); let hidden = false;
  const manager = createActivityMotion({
    loadData: (_name, signal) => new Promise(resolve => { loads.push({ signal, resolve }); }),
    createAnimation: () => {
      const player = { paused: false, pause() { this.paused = true; }, play() { this.paused = false; }, destroy() { players.delete(this); } };
      players.add(player); return player;
    }, hidden: () => hidden,
  });
  return { dom, manager, row, holder, loads, players, setHidden: value => { hidden = value; } };
}

test('completed turns cannot start animations even when a stale tool still says running', async () => {
  const f = motionFixture(); f.row.parentElement.dataset.timingStatus = 'completed';
  await f.manager.mount(f.row, f.holder, 'searching');
  expect(f.loads).toHaveLength(0); expect(f.players.size).toBe(0);
});

test('stopped and replaced animation loads cannot create orphan players', async () => {
  const f = motionFixture(), first = f.manager.mount(f.row, f.holder, 'searching');
  const second = f.manager.mount(f.row, f.holder, 'searching');
  expect(f.loads[0].signal.aborted).toBe(true);
  f.loads[1].resolve({}); await second; expect(f.players.size).toBe(1);
  f.loads[0].resolve({}); await first; expect(f.players.size).toBe(1);
  f.manager.clear(); expect(f.players.size).toBe(0);
  const last = f.manager.mount(f.row, f.holder, 'searching'); f.manager.stop(f.row);
  f.loads[2].resolve({}); await last; expect(f.players.size).toBe(0);
});

test('repeated teardown aborts all pending animation loads without accumulating players', async () => {
  const f = motionFixture(), tasks = [];
  for (let update = 0; update < 100; update++) { tasks.push(f.manager.mount(f.row, f.holder, 'searching')); f.manager.clear(); }
  expect(f.loads.every(load => load.signal.aborted)).toBe(true);
  for (const load of f.loads) load.resolve({});
  await Promise.all(tasks); expect(f.players.size).toBe(0);
});

test('hidden pages pause players and terminal activities release them', async () => {
  const f = motionFixture(), task = f.manager.mount(f.row, f.holder, 'searching');
  f.loads[0].resolve({}); await task;
  const player = [...f.players][0];
  f.setHidden(true); f.manager.updateVisibility(); expect(player.paused).toBe(true);
  f.setHidden(false); f.manager.updateVisibility(); expect(player.paused).toBe(false);
  f.row.parentElement.dataset.timingStatus = 'completed'; f.manager.updateVisibility();
  expect(f.players.size).toBe(0);
});
