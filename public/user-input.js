export function createUserInputDialog({ respond, t = text => text, document = globalThis.document }) {
  const pending = new Map();
  let active = false, sequence = 0;

  function showNext() {
    if (active || !pending.size) return;
    active = true;
    const [id, request] = pending.entries().next().value;
    const dialog = document.createElement('dialog');
    dialog.className = 'user-input-dialog';
    dialog.setAttribute('data-i18n-ignore', '');
    const form = document.createElement('form');
    const title = document.createElement('h2');
    title.id = `user-input-title-${++sequence}`;
    title.textContent = t('Choose an answer');
    dialog.setAttribute('aria-labelledby', title.id);
    form.append(title);
    const fields = [];

    for (const [index, question] of (request.params?.questions || []).entries()) {
      const fieldset = document.createElement('fieldset');
      const legend = document.createElement('legend');
      legend.textContent = question.question;
      fieldset.append(legend);
      const options = question.options || [];
      const choices = [];
      const name = `question-${sequence}-${index}`;
      function addChoice(label, description, value) {
        const row = document.createElement('label');
        row.className = 'user-input-choice';
        const radio = document.createElement('input');
        radio.type = 'radio'; radio.name = name; radio.value = value;
        const copy = document.createElement('span');
        const text = document.createElement('strong');
        text.textContent = label;
        copy.append(text);
        if (description) {
          const detail = document.createElement('span');
          detail.textContent = description;
          copy.append(detail);
        }
        row.append(radio, copy); fieldset.append(row); choices.push(radio);
        return radio;
      }
      options.forEach((option, optionIndex) => addChoice(option.label, option.description, String(optionIndex)));
      let custom, other;
      if (!options.length || question.isOther !== false) {
        if (options.length) other = addChoice(t('Other answer'), '', 'other');
        custom = document.createElement('input');
        custom.type = question.isSecret ? 'password' : 'text';
        custom.className = 'user-input-custom';
        custom.setAttribute('aria-label', question.question);
        custom.placeholder = t('Enter your answer');
        custom.autocomplete = 'off';
        custom.hidden = Boolean(other);
        fieldset.append(custom);
      }
      const answer = () => {
        const selected = choices.find(choice => choice.checked);
        if (!options.length || selected === other) return custom?.value.trim() || '';
        return selected ? options[Number(selected.value)].label : '';
      };
      fieldset.addEventListener('change', () => {
        if (custom && other) { custom.hidden = !other.checked; if (other.checked) custom.focus(); }
      });
      fields.push({ question, fieldset, answer });
      form.append(fieldset);
    }

    const error = document.createElement('p');
    error.className = 'user-input-error'; error.setAttribute('role', 'alert'); error.hidden = true;
    const actions = document.createElement('div');
    actions.className = 'user-input-actions';
    const submit = document.createElement('button');
    submit.type = 'submit'; submit.textContent = t('Submit answers'); submit.disabled = true;
    const update = () => { submit.disabled = !fields.length || fields.some(field => !field.answer()); };
    form.addEventListener('input', update);
    form.addEventListener('change', update);
    actions.append(submit); form.append(error, actions); dialog.append(form);
    dialog.addEventListener('cancel', event => event.preventDefault());
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (submit.disabled) return;
      const answers = Object.fromEntries(fields.map(({ question, answer }) => [question.id, { answers: [answer()] }]));
      submit.disabled = true;
      submit.textContent = t('Sending…');
      fields.forEach(({ fieldset }) => { fieldset.disabled = true; });
      error.hidden = true;
      try {
        await respond(id, { answers });
        pending.delete(id); dialog.close(); dialog.remove(); active = false; showNext();
      } catch {
        fields.forEach(({ fieldset }) => { fieldset.disabled = false; });
        submit.textContent = t('Submit answers');
        error.textContent = t('Unable to send answer. Try again.'); error.hidden = false; update();
      }
    });
    document.body.append(dialog); dialog.showModal();
  }

  return request => {
    if (!pending.has(request.id)) pending.set(request.id, request);
    showNext();
  };
}
