export function createUserInputDialog({ respond, t = text => text, document = globalThis.document, getDraft = () => null, saveDraft = () => {} }) {
  const pending = new Map(), cards = new Map();
  let threadId = null, sequence = 0;
  const labels = { awaiting: 'Choose an answer', submitting: 'Sending…', accepted: 'Answer received', ended: 'Request ended', recovering: 'Waiting for the original request' };
  const owner = request => request.params?.threadId;
  const keyOf = request => request.requestKey || String(request.id);
  function mount() {
    for (const [id, card] of cards) {
      if (owner(pending.get(id)) === threadId) mountRequestCard(document, card, pending.get(id));
      else card.remove();
    }
  }
  function build(request) {
    const id = request.id, key = keyOf(request), status = request.requestStatus || 'awaiting';
    const statusLabel = status => status === 'accepted' && request.params?.asyncQuestion ? 'Answer queued' : labels[status] || labels.awaiting;
    const dialog = document.createElement('section');
    dialog.className = 'user-input-dialog user-input-card'; dialog.dataset.requestId = String(id); dialog.dataset.requestState = status;
    dialog.setAttribute('data-i18n-ignore', '');
    const form = document.createElement('form'), title = document.createElement('h2');
    title.id = `user-input-title-${++sequence}`; title.textContent = t(statusLabel(status));
    dialog.setAttribute('aria-labelledby', title.id); form.append(title);
    const context = document.createElement('p'); context.className = 'request-context'; context.textContent = (request.params?.questions || []).map(question => question.question).join(' '); context.hidden = true; form.append(context);
    const fields = [], draft = getDraft(owner(request), key);
    for (const [index, question] of (request.params?.questions || []).entries()) {
      const fieldset = document.createElement('fieldset'), legend = document.createElement('legend');
      legend.textContent = question.question; fieldset.append(legend);
      const options = question.options || [], choices = [], name = `question-${sequence}-${index}`;
      function addChoice(label, description, value) {
        const row = document.createElement('label'); row.className = 'user-input-choice';
        const radio = document.createElement('input'); radio.type = 'radio'; radio.name = name; radio.value = value;
        const copy = document.createElement('span'), text = document.createElement('strong'); text.textContent = label; copy.append(text);
        if (description) { const detail = document.createElement('span'); detail.textContent = description; copy.append(detail); }
        row.append(radio, copy); row.insertAdjacentHTML('beforeend', codexIcon('check', 'user-input-choice-check')); fieldset.append(row); choices.push(radio); return radio;
      }
      options.forEach((option, optionIndex) => addChoice(option.label, option.description, String(optionIndex)));
      let custom, other;
      if (!options.length || question.isOther !== false) {
        if (options.length) other = addChoice(t('Other answer'), '', 'other');
        custom = document.createElement('input'); custom.type = question.isSecret ? 'password' : 'text'; custom.className = 'user-input-custom';
        custom.setAttribute('aria-label', question.question); custom.placeholder = t('Enter your answer'); custom.autocomplete = 'off'; fieldset.append(custom);
      }
      const saved = !question.isSecret && draft?.values?.find(value => value.id === question.id);
      if (saved) { const selected = choices.find(choice => choice.value === saved.selected); if (selected) selected.checked = true; if (custom) custom.value = saved.custom || ''; }
      if (custom && other) custom.hidden = !other.checked;
      fieldset.addEventListener('change', () => { if (custom && other) { custom.hidden = !other.checked; if (other.checked) custom.focus(); } });
      const answer = () => { const selected = choices.find(choice => choice.checked); return !options.length || selected === other ? custom?.value.trim() || '' : selected ? options[Number(selected.value)].label : ''; };
      const value = () => ({ id: question.id, selected: choices.find(choice => choice.checked)?.value || '', custom: custom?.value || '' });
      fields.push({ question, fieldset, answer, value }); form.append(fieldset);
    }
    const error = document.createElement('p'); error.className = 'user-input-error'; error.setAttribute('role', 'alert'); error.hidden = true;
    const actions = document.createElement('div'); actions.className = 'user-input-actions';
    const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = t('Submit answers');
    const writable = () => dialog.dataset.requestState === 'awaiting';
    const update = () => { submit.disabled = !writable() || !fields.length || fields.some(field => !field.answer()); };
    const persist = () => { if (!request.params?.questions?.some(question => question.isSecret)) saveDraft(owner(request), key, { values: fields.map(field => field.value()) }); update(); };
    form.addEventListener('input', persist); form.addEventListener('change', persist);
    actions.append(submit); form.append(error, actions); dialog.append(form);
    const receipt = createRequestReceipt(document, '', context.textContent); receipt.hidden = true; dialog.append(receipt);
    function setStatus(next) {
      dialog.dataset.requestState = next; title.textContent = t(statusLabel(next));
      const finished = requestFinished(next);
      form.hidden = finished; receipt.hidden = !finished;
      const summary = receipt.querySelector('summary'), answers = fields.filter(field => !field.question.isSecret && field.answer());
      summary.textContent = answers.length ? t('Selected: ') : `${t(statusLabel(next))} · `;
      if (answers.length) {
        const selected = document.createElement('strong'); selected.textContent = answers.map(field => field.answer()).join('；');
        summary.append(selected);
      } else summary.append(document.createTextNode(t('Submit answers')));
      receipt.querySelector('pre').textContent = fields.map(field => [field.question.question, !field.question.isSecret && field.answer()].filter(Boolean).join('\n')).join('\n\n');
      fields.forEach(({ fieldset }) => { fieldset.disabled = next !== 'awaiting'; fieldset.hidden = next === 'accepted' || next === 'ended'; });
      context.hidden = next !== 'accepted' && next !== 'ended';
      actions.hidden = next !== 'awaiting' && next !== 'submitting'; update();
      if (cards.has(id)) mount();
    }
    dialog.setStatus = setStatus; setStatus(status);
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (submit.disabled) return;
      const answers = Object.fromEntries(fields.map(({ question, answer }) => [question.id, { answers: [answer()] }]));
      setStatus('submitting'); submit.textContent = t('Sending…'); error.hidden = true;
      try {
        const result = await respond(id, { answers });
        if (result?.status) { if (dialog.dataset.requestState !== 'ended') { request.requestStatus = result.status; setStatus(result.status); } }
        else show.resolve(id);
      } catch {
        if (dialog.dataset.requestState !== 'submitting') return;
        setStatus('awaiting'); submit.textContent = t('Submit answers'); error.textContent = t('Unable to send answer. Try again.'); error.hidden = false;
      }
    });
    cards.set(id, dialog); return dialog;
  }
  const show = request => {
    const old = pending.get(request.id);
    pending.set(request.id, request);
    if (!old || keyOf(old) !== keyOf(request)) { cards.get(request.id)?.remove(); build(request); }
    else cards.get(request.id)?.setStatus(request.requestStatus || 'awaiting');
    mount();
  };
  show.resolve = id => { pending.delete(id); cards.get(id)?.remove(); cards.delete(id); };
  show.setThread = id => { threadId = id; mount(); };
  show.clear = () => { for (const card of cards.values()) card.remove(); cards.clear(); pending.clear(); };
  show.endTurn = (id, turnId) => { for (const [key, request] of pending) if (owner(request) === id && request.params?.turnId === turnId) show.resolve(key); };
  show.sync = (records, drafts) => {
    const keep = new Set();
    for (const record of records) {
      if (record.request.method !== 'item/tool/requestUserInput') continue;
      const request = { ...record.request, requestKey: record.key, requestStatus: record.status }; keep.add(request.id); show(request);
    }
    for (const [id, request] of pending) if (owner(request) === threadId && !keep.has(id)) show.resolve(id);
    mount();
  };
  return show;
}
import { createRequestReceipt, mountRequestCard, requestFinished } from './request-receipt.js';
import { codexIcon } from './codex-icons.js';
