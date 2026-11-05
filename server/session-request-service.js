import { answerAsyncQuestion } from './async-user-input.js';

export function createSessionRequestHandlers({ requests, sessions, send, enqueue }) {
  function answer(params) {
    if (typeof params.requestId === 'string' && params.requestId.startsWith('async-')) return answerAsyncQuestion({ sessions, enqueue }, params);
    if (!Number.isSafeInteger(params.requestId)) throw Error('Invalid Codex request id');
    const previous = requests.find(params.requestId, params.threadId, params.requestKey);
    if (params.requestKey && previous?.key !== params.requestKey) throw Error('This request is no longer available');
    if (previous?.status === 'accepted' || previous?.status === 'ended') return { status: previous.status, requestKey: previous.key };
    const record = requests.answer(params.requestId, params.threadId, () => {
      send(params.error ? { id: params.requestId, error: params.error } : { id: params.requestId, result: params.result });
    }, params.requestKey);
    return { status: record.status, requestKey: record.key };
  }
  function saveDraft(params) {
    if (String(params.key).startsWith('question:')) {
      const key = String(params.key).slice(9);
      const record = requests.listStates(params.threadId).find(record => record.key === key);
      if (!record) throw Error('This request is no longer available');
      if (record.request.params?.questions?.some(question => question.isSecret)) throw Error('Secret answers cannot be saved');
    }
    return sessions.draft(params);
  }
  return { answer, saveDraft };
}
