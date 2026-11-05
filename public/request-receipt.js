export const requestFinished = status => status === 'accepted' || status === 'ended';

export function createRequestReceipt(document, label, text) {
  const details = document.createElement('details'), summary = document.createElement('summary'), content = document.createElement('pre');
  details.className = 'request-receipt'; summary.textContent = label; content.textContent = text;
  details.append(summary, content);
  return details;
}

export function mountRequestCard(document, card, request) {
  const root = document.querySelector('#conversation') || document.body;
  const turn = [...root.querySelectorAll('[data-turn-id]')].find(node => node.dataset.turnId === request.params?.turnId);
  // Resolved history belongs to its turn, never to the bottom of the conversation.
  if (requestFinished(card.dataset.requestState)) {
    const stream = turn?.querySelector('.turn-event-stream') || turn;
    if (stream) stream.append(card); else card.remove();
  } else root.append(card);
}
