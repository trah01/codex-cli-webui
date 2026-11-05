import { supportsPasskeys, passkeyRequest, usePasskey, passkeyError } from './passkey-client.js';

export async function renderPasskeySettings(container, t) {
  const feedback = document.createElement('p'); feedback.className = 'settings-feedback'; feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
  const setError = error => { feedback.textContent = t(passkeyError(error)); feedback.dataset.state = 'error'; };
  container.append(feedback);
  let status;
  try { status = await passkeyRequest('/api/auth/status', undefined, 'GET'); }
  catch (error) { setError(error); return; }
  if (!status.canManagePasskeys) { feedback.textContent = t('Passkeys can only be managed on the server. Remote access supports passkey sign-in only.'); return; }
  if (status.passkeyOrigin && status.passkeyOrigin !== location.origin) {
    const link = document.createElement('a'); link.className = 'integration-refresh'; link.textContent = t('Manage local passkeys');
    link.href = new URL('/settings/passkey-settings', status.passkeyOrigin).href; container.append(link);
    feedback.textContent = t('Local passkeys use localhost. Open this address to add or manage them.'); return;
  }
  if (!supportsPasskeys()) { feedback.textContent = t('Use HTTPS for remote passkeys, or localhost on this computer.'); return; }
  let settings;
  try { settings = await passkeyRequest('/api/auth/passkeys', undefined, 'GET'); }
  catch (error) { setError(error); return; }

  const verification = document.createElement('form'); verification.className = 'settings-access-form'; verification.hidden = settings.recentAuthentication;
  const verificationStatus = document.createElement('p'); verificationStatus.className = 'settings-feedback'; verificationStatus.textContent = t('Verify your identity before adding or removing passkeys.'); verification.append(verificationStatus);
  const fields = {};
  function field(parent, title, type = 'text', value = '') {
    const label = document.createElement('label'), name = document.createElement('strong'), input = document.createElement('input');
    name.textContent = t(title); input.type = type; input.value = value; label.append(name, input); parent.append(label); return input;
  }
  if (status.passwordEnabled) {
    if (status.usernameRequired) { fields.username = field(verification, 'Username'); fields.username.autocomplete = 'username'; fields.username.required = true; fields.username.maxLength = 64; }
    fields.password = field(verification, 'Password', 'password'); fields.password.autocomplete = 'current-password'; fields.password.required = true; fields.password.maxLength = 256;
    if (status.otpRequired) { fields.otp = field(verification, 'Verification code'); fields.otp.inputMode = 'numeric'; fields.otp.autocomplete = 'one-time-code'; fields.otp.pattern = '[0-9]{6}'; fields.otp.required = true; }
  }
  const verify = document.createElement('button'); verify.type = 'submit'; verify.className = 'integration-refresh'; verify.textContent = t(status.passwordEnabled ? 'Verify identity' : 'Single sign-on'); verification.append(verify);
  verification.onsubmit = async event => {
    event.preventDefault();
    if (!status.passwordEnabled) { location.href = '/api/auth/oidc/start'; return; }
    verify.disabled = true;
    try {
      await passkeyRequest('/api/auth/login', Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, input.value])));
      for (const input of Object.values(fields)) input.value = '';
      verification.hidden = true; settings.recentAuthentication = true; feedback.textContent = ''; add.disabled = false;
      for (const button of list.querySelectorAll('button')) button.disabled = false;
    } catch (error) { setError(error); } finally { verify.disabled = false; }
  };
  if (status.passkeyEnabled) {
    const verifyPasskey = document.createElement('button'); verifyPasskey.type = 'button'; verifyPasskey.className = 'integration-refresh'; verifyPasskey.textContent = t('Verify with a passkey');
    verifyPasskey.onclick = async () => {
      verifyPasskey.disabled = true;
      try {
        await usePasskey('login'); await refresh(); verification.hidden = true; add.disabled = false; feedback.textContent = '';
        for (const input of Object.values(fields)) input.value = '';
      } catch (error) { setError(error); } finally { verifyPasskey.disabled = false; }
    };
    verification.append(verifyPasskey);
  }
  container.append(verification);

  const editor = document.createElement('div'); editor.className = 'settings-access-form';
  const name = field(editor, 'Passkey name'); name.maxLength = 80; name.placeholder = t('Device name (optional)');
  const add = document.createElement('button'); add.type = 'button'; add.className = 'integration-refresh'; add.textContent = t('Add passkey'); add.disabled = !settings.recentAuthentication;
  editor.append(add); container.append(editor);
  const list = document.createElement('div'); list.className = 'settings-group'; container.append(list);
  const requestVerification = () => {
    settings.recentAuthentication = false; verification.hidden = false; add.disabled = true;
    for (const button of list.querySelectorAll('button')) button.disabled = true;
  };
  async function refresh() {
    settings = await passkeyRequest('/api/auth/passkeys', undefined, 'GET');
    list.replaceChildren();
    if (!settings.credentials.length) {
      const empty = document.createElement('p'); empty.className = 'settings-feedback'; empty.textContent = t('No passkeys added for this address.'); list.append(empty);
    }
    for (const credential of settings.credentials) {
      const row = document.createElement('div'), copy = document.createElement('span'), title = document.createElement('strong'), detail = document.createElement('small'), remove = document.createElement('button');
      row.className = 'settings-row'; title.textContent = credential.name;
      detail.textContent = `${t('Added')}: ${new Date(credential.createdAt).toLocaleDateString()}${credential.lastUsedAt ? ` · ${t('Last used')}: ${new Date(credential.lastUsedAt).toLocaleDateString()}` : ''}`;
      copy.append(title, detail); remove.type = 'button'; remove.className = 'integration-refresh'; remove.textContent = t('Remove'); remove.setAttribute('aria-label', `${t('Remove')}: ${credential.name}`); remove.disabled = !settings.recentAuthentication;
      remove.onclick = async () => {
        if (!confirm(t('Remove this passkey? You can still sign in with another method.'))) return;
        remove.disabled = true;
        try {
          await passkeyRequest('/api/auth/passkeys', { id: credential.id }, 'DELETE'); await refresh();
          feedback.textContent = t('Passkey removed. Other sessions have been signed out.'); feedback.dataset.state = 'saved';
        } catch (error) { setError(error); await refresh().catch(() => {}); }
      };
      row.append(copy, remove); list.append(row);
    }
    if (!settings.recentAuthentication) requestVerification();
  }
  add.onclick = async () => {
    add.disabled = true; feedback.textContent = t('Follow your device prompts to add a passkey.'); feedback.dataset.state = '';
    try {
      await usePasskey('register', name.value); name.value = ''; await refresh();
      feedback.textContent = t('Passkey added. You can use it the next time you sign in.'); feedback.dataset.state = 'saved';
    } catch (error) { setError(error); await refresh().catch(() => {}); }
    finally { add.disabled = !settings.recentAuthentication; }
  };
  await refresh();
}
