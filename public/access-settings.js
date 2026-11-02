export async function renderAccessSettings(container, t) {
  const feedback = document.createElement('p'); feedback.className = 'settings-feedback'; feedback.setAttribute('role', 'status');
  feedback.textContent = t('Loading…'); container.append(feedback);
  async function request(options = {}) {
    const response = await fetch('/api/auth/credentials', { cache: 'no-store', ...options });
    const result = await response.json();
    if (!response.ok) throw new Error(t(result.error || 'Cannot load settings'));
    return result;
  }
  let settings;
  try { settings = await request(); }
  catch (error) { feedback.textContent = error.message; return; }
  const domainForm = document.createElement('form'); domainForm.className = 'settings-access-form';
  const domainLabel = document.createElement('label'), domainTitle = document.createElement('strong'), domainInput = document.createElement('input');
  domainTitle.textContent = t('Bound domain'); domainInput.type = 'text'; domainInput.placeholder = 'codex.example.com'; domainInput.autocomplete = 'off'; domainInput.maxLength = 253;
  domainInput.autocapitalize = 'none'; domainInput.spellcheck = false;
  const domainButton = document.createElement('button'); domainButton.type = 'submit'; domainButton.className = 'integration-refresh'; domainButton.textContent = t('Save domain');
  const domainFeedback = document.createElement('p'); domainFeedback.className = 'settings-feedback'; domainFeedback.setAttribute('role', 'status');
  const domainActions = document.createElement('div'); domainActions.className = 'settings-actions'; domainActions.append(domainFeedback, domainButton);
  domainLabel.append(domainTitle, domainInput); domainForm.append(domainLabel, domainActions); container.append(domainForm);
  async function domainRequest(options = {}) {
    const response = await fetch('/api/auth/domain', { cache: 'no-store', ...options });
    const result = await response.json();
    if (!response.ok) throw new Error(t(result.error || 'Unable to save domain binding'));
    return result;
  }
  try { domainInput.value = (await domainRequest()).domain; }
  catch (error) { domainFeedback.textContent = error.message; domainButton.disabled = true; }
  domainForm.onsubmit = async event => {
    event.preventDefault(); domainButton.disabled = true;
    try {
      const result = await domainRequest({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ domain: domainInput.value.trim() }) });
      domainInput.value = result.domain;
      domainFeedback.textContent = t(result.domain ? 'Domain binding saved' : 'Domain binding cleared. Only 127.0.0.1 can access this service.');
    } catch (error) { domainFeedback.textContent = error.message; }
    finally { domainButton.disabled = false; }
  };
  if (!settings.editable) {
    feedback.textContent = t('Credentials are managed by startup environment variables'); return;
  }
  feedback.textContent = t('Only http://127.0.0.1 can change these settings. Saving signs out existing remote sessions.');
  const form = document.createElement('form'); form.className = 'settings-access-form';
  function field(title, type, autocomplete) {
    const label = document.createElement('label'), name = document.createElement('strong'), input = document.createElement('input');
    name.textContent = t(title); input.type = type; input.autocomplete = autocomplete; input.required = true;
    label.append(name, input); form.append(label); return input;
  }
  const username = field('Username', 'text', 'username'); username.value = settings.username;
  username.maxLength = 64; username.pattern = '[a-zA-Z0-9_.-]{1,64}';
  const password = field('New password', 'password', 'new-password'); password.minLength = 12; password.maxLength = 256;
  const confirmation = field('Confirm password', 'password', 'new-password'); confirmation.minLength = 12; confirmation.maxLength = 256;
  const button = document.createElement('button'); button.type = 'submit'; button.className = 'integration-refresh'; button.textContent = t('Save account and password');
  const actions = document.createElement('div'); actions.className = 'settings-actions'; actions.append(feedback, button);
  form.append(actions); container.append(form);
  form.onsubmit = async event => {
    event.preventDefault();
    if (password.value !== confirmation.value) { feedback.textContent = t('Passwords do not match'); confirmation.focus(); return; }
    button.disabled = true;
    try {
      await request({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: username.value.trim(), password: password.value }) });
      password.value = ''; confirmation.value = ''; feedback.textContent = t('Account and password saved. Existing remote sessions have been signed out.');
    } catch (error) { feedback.textContent = error.message; }
    finally { button.disabled = false; }
  };
}
