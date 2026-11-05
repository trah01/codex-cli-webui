import { createHash } from 'node:crypto';

// Async questions are conversation items, not outstanding JSON-RPC requests.
export function withAsyncQuestions(thread, requests = [], previous = []) {
  const saved = new Map([...previous, ...requests].map(record => [record.key, record]));
  const result = requests.filter(record => !record.request.params?.asyncQuestion);
  for (const turn of thread.turns || []) {
    for (const [index, item] of (turn.items || []).entries()) {
      if (item.type !== 'agentMessage' || !item.questions?.length) continue;
      const key = createHash('sha256').update(JSON.stringify(['async-question', thread.id, turn.id, item.id])).digest('hex');
      const questions = item.questions.map((question, index) => ({
        id: `question-${index}`, question: question.title, isOther: true,
        options: (question.options || []).map(label => ({ label })),
      }));
      if (questions.some(question => typeof question.question !== 'string' || question.options.some(option => typeof option.label !== 'string'))) continue;
      const answered = (turn.items || []).slice(index + 1).some(item => item.type === 'userMessage')
        || (thread.turns || []).slice((thread.turns || []).indexOf(turn) + 1).some(turn => turn.items?.some(item => item.type === 'userMessage'));
      result.push({ key, status: answered ? 'ended' : saved.get(key)?.status === 'accepted' ? 'accepted' : 'awaiting', request: {
        id: `async-${key}`, method: 'item/tool/requestUserInput',
        params: { threadId: thread.id, turnId: turn.id, itemId: item.id, questions, asyncQuestion: true },
      } });
    }
  }
  return result;
}

export function answerAsyncQuestion({ sessions, enqueue }, params) {
  const entry = sessions.entry(params.threadId);
  const record = entry.state.requests.find(record => record.request.id === params.requestId && record.key === params.requestKey && record.request.params?.asyncQuestion);
  if (!record) throw Error('This request is no longer available');
  if (record.status === 'accepted' || record.status === 'ended') return { status: record.status, requestKey: record.key };
  const questions = record.request.params.questions;
  const text = questions.map(question => {
    const answers = params.result?.answers?.[question.id]?.answers;
    if (!Array.isArray(answers) || answers.length !== 1 || typeof answers[0] !== 'string' || !answers[0].trim() || answers[0].length > 10_000) throw Error('Invalid question answer');
    return `${question.question}\n${answers[0].trim()}`;
  }).join('\n\n');
  const turn = entry.state.thread.turns?.find(turn => turn.id === record.request.params.turnId);
  enqueue({ messageId: `async-answer-${record.key}`, threadId: params.threadId,
    ...(turn?.status === 'inProgress' && { expectedTurnId: turn.id }), input: [{ type: 'text', text }] });
  sessions.publish(params.threadId, { requests: entry.state.requests.map(value => value.key === record.key ? { ...value, status: 'accepted' } : value) });
  return { status: 'accepted', requestKey: record.key };
}
