import { bindSettingsAutosave } from './settings-autosave.js';

export async function renderAccessSettings(container, t, page = 'access-settings') {
  const autosaves = [];
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
  catch (error) { feedback.textContent = error.message; return autosaves; }
  if (page === 'domain-settings') {
  feedback.remove();
  const domainForm = document.createElement('form'); domainForm.className = 'settings-access-form';
  const domainLabel = document.createElement('label'), domainTitle = document.createElement('strong'), domainInput = document.createElement('input');
  domainTitle.textContent = t('Bound domain'); domainInput.type = 'text'; domainInput.placeholder = 'codex.example.com'; domainInput.autocomplete = 'off'; domainInput.maxLength = 253;
  domainInput.autocapitalize = 'none'; domainInput.spellcheck = false;
  const domainFeedback = document.createElement('p'); domainFeedback.className = 'settings-feedback'; domainFeedback.setAttribute('role', 'status');
  const domainActions = document.createElement('div'); domainActions.className = 'settings-actions'; domainActions.append(domainFeedback);
  domainLabel.append(domainTitle, domainInput); domainForm.append(domainLabel, domainActions); container.append(domainForm);
  async function domainRequest(options = {}) {
    const response = await fetch('/api/auth/domain', { cache: 'no-store', ...options });
    const result = await response.json();
    if (!response.ok) throw new Error(t(result.error || 'Unable to save domain binding'));
    return result;
  }
  try { domainInput.value = (await domainRequest()).domain; }
  catch (error) { domainFeedback.textContent = error.message; domainInput.disabled = true; }
  autosaves.push(bindSettingsAutosave(domainForm, { feedback: domainFeedback, t, save: async () => {
      const result = await domainRequest({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ domain: domainInput.value.trim() }) });
      domainInput.value = result.domain;
      domainFeedback.textContent = t(result.domain ? 'Domain binding saved' : 'Domain binding cleared. Only 127.0.0.1 can access this service.');
  } }));
  return autosaves;
  }
  const localForm = document.createElement('form'); localForm.className = 'settings-local-login-form';
  const localLabel = document.createElement('label'), localTitle = document.createElement('strong'), localToggle = document.createElement('input');
  localLabel.className = 'settings-row settings-toggle-row';
  localTitle.textContent = '本机访问需要登录'; localToggle.type = 'checkbox'; localToggle.name = 'localAuthRequired';
  localToggle.checked = settings.localAuthRequired !== 'false';
  const localSwitch = document.createElement('span'); localSwitch.className = 'settings-switch'; localSwitch.setAttribute('aria-hidden', 'true');
  localLabel.append(localTitle, localToggle, localSwitch);
  const localFeedback = document.createElement('p'); localFeedback.className = 'settings-feedback'; localFeedback.setAttribute('role', 'status');
  const localActions = document.createElement('div'); localActions.className = 'settings-actions'; localActions.append(localFeedback); localForm.append(localLabel, localActions); container.append(localForm);
  autosaves.push(bindSettingsAutosave(localForm, { feedback: localFeedback, t, save: async () => {
    try {
      const response = await fetch('/api/auth/security', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'local', localAuthRequired: String(localToggle.checked) }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || '无法保存本机登录设置。');
      settings.localAuthRequired = String(localToggle.checked); localFeedback.textContent = localToggle.checked ? '本机访问已开启账号密码登录。' : '本机访问已关闭登录验证。';
    } catch (error) { localToggle.checked = settings.localAuthRequired !== 'false'; throw error; }
  } }));
  if (!settings.editable) {
    feedback.textContent = t('Credentials are managed by startup environment variables'); return autosaves;
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
  const actions = document.createElement('div'); actions.className = 'settings-actions'; actions.append(feedback);
  form.append(actions); container.append(form);
  autosaves.push(bindSettingsAutosave(form, { feedback, t, ready: () => {
    if (password.value !== confirmation.value) { feedback.textContent = t('Passwords do not match'); return false; }
    return true;
  }, save: async () => {
    await request({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: username.value.trim(), password: password.value }) });
    password.value = ''; confirmation.value = ''; feedback.textContent = t('Account and password saved. Existing remote sessions have been signed out.');
  } }));
  return autosaves;
}
