import { bindSettingsAutosave } from './settings-autosave.js';

export async function renderAuthenticationSettings(container, scope = 'otp') {
  const form = document.createElement('form'); form.className = 'settings-access-form';
  const feedback = document.createElement('p'); feedback.className = 'settings-feedback'; feedback.setAttribute('role', 'status');
  const controls = {};
  const request = async (path, options = {}) => {
    const response = await fetch(path, { cache: 'no-store', ...options });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '无法加载认证设置。');
    return result;
  };
  let settings;
  try { settings = await request('/api/auth/security'); }
  catch (error) { feedback.textContent = error.message; container.append(feedback); return []; }
  function field(key, title, type = 'text', choices) {
    const label = document.createElement('label'), name = document.createElement('strong'); name.textContent = title;
    const input = document.createElement(choices ? 'select' : 'input');
    if (choices) {
      input.className = 'settings-select';
      for (const [value, text] of choices) { const option = document.createElement('option'); option.value = value; option.textContent = text; input.append(option); }
    } else { input.type = type; input.autocomplete = type === 'password' ? 'new-password' : 'off'; input.spellcheck = false; input.maxLength = 8192; }
    input.value = settings[key] || ''; input.name = key; controls[key] = input;
    label.append(name, input); form.append(label); return input;
  }
  if (scope === 'oidc') {
  const mode = field('mode', '登录方式', 'text', [['password', '密码登录'], ['oidc', '统一身份登录（OIDC）'], ['both', '密码或统一身份登录']]);
  if (!settings.issuer) mode.value = 'oidc';
  }
  let otp, secret, generate, enrollment, code;
  const enrollmentHint = '在验证器中手动添加密钥，选择 SHA1、6 位数字、30 秒，然后填写验证码，离开输入区域后自动生效。';
  if (scope === 'otp') {
  otp = field('otpEnabled', '密码登录二次验证', 'text', [['false', '关闭'], ['true', '开启动态验证码']]); otp.value = String(settings.otpEnabled);
  secret = field('otpSecret', '验证器密钥', 'password'); secret.placeholder = settings.otpEnabled ? '已配置，留空保持不变' : '生成新密钥或填写已有密钥';
  generate = document.createElement('button'); generate.type = 'button'; generate.className = 'integration-refresh'; generate.textContent = '生成新密钥';
  enrollment = document.createElement('p'); enrollment.className = 'settings-feedback settings-enrollment'; enrollment.textContent = enrollmentHint;
  form.append(generate, enrollment);
  code = field('otpCode', '验证器当前验证码'); code.inputMode = 'numeric'; code.maxLength = 6; code.pattern = '[0-9]{6}'; code.autocomplete = 'one-time-code';
  generate.onclick = async () => {
    generate.disabled = true;
    try {
      const result = await request('/api/auth/otp-secret', { method: 'POST' });
      secret.value = result.secret; otp.value = 'true';
      enrollment.textContent = `在验证器中手动添加密钥：${result.secret}。选择 SHA1、6 位数字、30 秒，然后填写验证码，离开输入区域后自动生效。`;
      code.focus();
    } catch (error) { feedback.textContent = error.message; }
    finally { generate.disabled = false; }
  };
  }
  if (scope === 'oidc') {
  field('issuer', '身份提供方地址（Issuer）', 'url').placeholder = 'https://identity.example.com/realms/example';
  field('clientId', '客户端编号（Client ID）');
  field('clientSecret', '客户端密钥', 'password').placeholder = settings.clientSecretConfigured ? '已配置，留空保持不变' : '填写身份提供方分配的密钥';
  const callback = field('redirectUri', '登录回调地址', 'url'); callback.readOnly = true;
  callback.placeholder = '请先绑定访问域名';
  const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'integration-refresh'; copy.textContent = '复制回调地址'; copy.disabled = !callback.value;
  copy.onclick = async () => { try { await navigator.clipboard.writeText(callback.value); feedback.textContent = '回调地址已复制。'; } catch { callback.select(); feedback.textContent = '请复制已选中的回调地址。'; } };
  form.append(copy);
  }
  const note = document.createElement('p'); note.className = 'settings-feedback'; note.textContent = '仅服务器本机通过 localhost 或 127.0.0.1 可配置。OIDC 的二次验证请在身份提供方开启；本机仍可使用已配置的密码维护设置。';
  const actions = document.createElement('div'); actions.className = 'settings-actions'; actions.append(feedback); form.append(note, actions); container.append(form);
  return [bindSettingsAutosave(form, { feedback, t: value => value === 'Saving…' ? '正在保存…' : value, ready: () => {
    if (otp?.value === 'true' && (!settings.otpEnabled || secret.value) && !/^[0-9]{6}$/.test(code.value)) {
      feedback.textContent = '填写验证器当前的 6 位验证码后自动生效。'; return false;
    }
    if (controls.mode?.value !== 'password' && scope === 'oidc' && (!controls.issuer.value || !controls.clientId.value)) {
      feedback.textContent = '填写身份提供方地址和客户端编号后自动生效。'; return false;
    }
    return true;
  }, save: async () => {
    if (generate) generate.disabled = true;
    try {
      const payload = Object.fromEntries(Object.entries(controls).map(([key, input]) => [key, input.value])); payload.scope = scope; if (otp) payload.otpEnabled = otp.value === 'true';
      await request('/api/auth/security', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      if (otp) {
        settings.otpEnabled = payload.otpEnabled; secret.value = ''; code.value = ''; enrollment.textContent = enrollmentHint;
        secret.placeholder = settings.otpEnabled ? '已配置，留空保持不变' : '生成新密钥或填写已有密钥';
      }
      if (controls.clientSecret) { controls.clientSecret.value = ''; controls.clientSecret.placeholder = '已配置，留空保持不变'; }
      feedback.textContent = '认证设置已保存并立即生效，其他登录会话已退出。';
    } finally { if (generate) generate.disabled = false; }
  } })];
}
