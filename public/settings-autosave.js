// Serialize writes and save complete fields when the user finishes editing.
export function bindSettingsAutosave(root, { save, feedback, t = value => value, ready = () => true, delay = 0 }) {
  const fields = () => [...root.querySelectorAll('input,select,textarea')];
  const snapshot = () => JSON.stringify(fields().map(input => [input.type === 'checkbox' ? input.checked : input.value]));
  let saved = snapshot(), timer, saving = false, inFlight;
  function flush() {
    clearTimeout(timer);
    if (saving) return inFlight;
    if (snapshot() === saved) return;
    const inputs = fields();
    if (inputs.some(input => !input.disabled && !input.checkValidity()) || !ready()) return;
    saving = true;
    const states = inputs.map(input => ({ disabled: input.disabled, readOnly: input.readOnly }));
    inputs.forEach(input => {
      if (input.tagName === 'TEXTAREA' || (input.tagName === 'INPUT' && !['checkbox', 'file'].includes(input.type))) input.readOnly = true;
      else input.disabled = true;
    });
    feedback.textContent = t('Saving…');
    feedback.dataset.state = 'saving';
    inFlight = (async () => {
      try {
        await save();
        saved = snapshot();
        feedback.dataset.state = 'saved';
      } catch (error) {
        feedback.textContent = t(error.message);
        feedback.dataset.state = 'error';
      } finally {
        inputs.forEach((input, index) => { input.disabled = states[index].disabled; input.readOnly = states[index].readOnly; });
        saving = false;
      }
    })();
    return inFlight;
  }

  root.addEventListener('input', () => {
    clearTimeout(timer);
    feedback.textContent = '';
    if (delay) timer = setTimeout(flush, delay);
  });
  root.addEventListener('change', event => {
    if (event.target.type === 'checkbox' || event.target.tagName === 'SELECT') void flush();
  });
  root.addEventListener('focusout', event => {
    if (!root.contains(event.relatedTarget)) void flush();
  });
  root.addEventListener('submit', event => { event.preventDefault(); void flush(); });
  return { flush, reset: () => { saved = snapshot(); } };
}
