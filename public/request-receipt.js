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
  if (card.classList.contains('user-input-card')) {
    if (turn) {
      const itemId = request.params?.itemId;
      const item = itemId == null ? null : [...turn.querySelectorAll('[data-item-id]')].find(node => node.dataset.itemId === String(itemId));
      const anchor = item?.closest('.assistant-response, [data-agent-activity-group]') || item;
      if (anchor) {
        if (anchor.nextSibling !== card) anchor.after(card);
      } else if (!turn.contains(card)) (turn.querySelector('.turn-event-stream') || turn).append(card);
    } else if (requestFinished(card.dataset.requestState)) card.remove();
    else if (card.parentElement !== root) root.append(card);
    return;
  }
  // Resolved history belongs to its turn, never to the bottom of the conversation.
  if (requestFinished(card.dataset.requestState)) {
    const stream = turn?.querySelector('.turn-event-stream') || turn;
    if (stream) stream.append(card); else card.remove();
  } else root.append(card);
}
