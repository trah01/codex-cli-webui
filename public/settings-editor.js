import { renderPasskeySettings } from './passkey-settings.js';
import { bindSettingsAutosave } from './settings-autosave.js';
import { renderAuthenticationSettings } from './authentication-settings.js';
import { renderAccessSettings } from './access-settings.js';

export function createSettingsEditor(context) {
  const { t, rpc } = context;
  let generation = 0;
  let autosaves = [], pendingWrites = Promise.resolve();
  function flushEdits() {
    const editors = autosaves; autosaves = [];
    pendingWrites = Promise.all([pendingWrites, ...editors.map(editor => editor.flush())]);
    return pendingWrites;
  }
  function groupRows(container) {
    let group;
    for (const child of [...container.children]) {
      if (child.matches('.settings-row')) {
        if (!group) { group = document.createElement('div'); group.className = 'settings-group'; container.insertBefore(group, child); }
        group.append(child);
      } else { group = null; if (child.tagName === 'DIV' && !child.className) groupRows(child); }
    }
  }
  function text(container, message) {
    const node = document.createElement('p');
    node.className = 'settings-feedback'; node.textContent = t(message); container.append(node);
    return node;
  }
  function row(container, label, control) {
    const node = document.createElement('label'), name = document.createElement('strong');
    node.className = 'settings-row settings-select-row'; name.textContent = t(label);
    if (control.nodeType === 3) {
      const value = document.createElement('span'); value.className = 'settings-row-value'; value.append(control); control = value;
    }
    node.append(name, control); container.append(node); return node;
  }
  function select(container, label, values, value, change) {
    const input = document.createElement('select'); input.className = 'settings-select';
    for (const item of values) {
      const [key, title] = Array.isArray(item) ? item : [item, item];
      const option = document.createElement('option'); option.value = key; option.textContent = t(title); input.append(option);
    }
    input.value = value; input.disabled = !input.options.length;
    input.onchange = async () => {
      const previous = value; input.disabled = true;
      try { await change(input.value); value = input.value; }
      catch (error) { input.value = previous; context.toast(error.message); }
      finally { input.disabled = !input.options.length; }
    };
    row(container, label, input); return input;
  }
  function button(container, label, action) {
    const node = document.createElement('button'); node.type = 'button'; node.className = 'integration-refresh'; node.textContent = t(label);
    node.onclick = async () => { node.disabled = true; try { await action(); } catch (error) { context.toast(error.message); } finally { node.disabled = false; } };
    container.append(node); return node;
  }
  async function configuration(container, current) {
    const loading = text(container, 'Loading…');
    const [settings, defaults] = await Promise.all([
      rpc('host/settings/read', {}), rpc('host/settings/read', { scope: 'chat-defaults' }),
    ]);
    if (current !== generation) return;
    loading.remove();
    const models = context.models(), model = models.find(item => item.model === defaults.model) || models.find(item => item.isDefault) || models[0];
    const saveDefault = async (field, value) => {
      await rpc('host/settings/write', { field, value });
      await context.defaultsChanged();
    };
    select(container, 'Model', models.map(item => [item.model, item.displayName || item.model]), model?.model, async value => {
      await saveDefault('model', value); await render('agent', container);
    });
    const efforts = model?.supportedReasoningEfforts || [{ reasoningEffort: 'medium' }];
    const effort = efforts.some(item => item.reasoningEffort === defaults.reasoningEffort) ? defaults.reasoningEffort : model?.defaultReasoningEffort || efforts[0]?.reasoningEffort;
    select(container, 'Reasoning effort', efforts.map(item => [item.reasoningEffort, context.reasoningLabel(item.reasoningEffort)]), effort, value => saveDefault('reasoningEffort', value));
    select(container, 'Selected mode', context.permissions().filter(([mode]) => !mode.startsWith('profile:')), defaults.permissionMode, value => saveDefault('permissionMode', value));
    const remote = document.createElement('div'); container.append(remote);
    const actions = document.createElement('div'); actions.className = 'settings-actions';
    const saved = text(actions, 'Changes to Codex configuration apply to new chats.'); saved.setAttribute('role', 'status');
    select(remote, 'Web search', [['disabled', 'Disabled'], ['cached', 'Cached search'], ['live', 'Live search']], settings.webSearch, async value => {
      await rpc('host/settings/write', { field: 'webSearch', value }); saved.textContent = t('Saved. Start a new chat to use this setting.');
    });
    const label = document.createElement('label'), title = document.createElement('strong'), input = document.createElement('textarea');
    label.className = 'settings-instructions'; title.textContent = t('Custom instructions'); input.value = settings.instructions; input.rows = 6; input.maxLength = 100000;
    label.append(title, input); remote.append(label);
    autosaves.push(bindSettingsAutosave(label, { feedback: saved, t, delay: 800, save: async () => {
      await rpc('host/settings/write', { field: 'instructions', value: input.value });
      saved.textContent = t('Saved. Start a new chat to use this setting.');
    } }));
    remote.append(actions);
  }
  function review(container) {
    const preferences = context.review();
    select(container, 'Diff view', [['unified', 'Unified'], ['split', 'Side by side']], preferences.mode, value => context.setReview('mode', value));
    select(container, 'Wrap lines', [['on', 'Enabled'], ['off', 'Disabled']], preferences.wrap ? 'on' : 'off', value => context.setReview('wrap', value === 'on'));
    select(container, 'Expand changes', [['on', 'Enabled'], ['off', 'Disabled']], preferences.expanded ? 'on' : 'off', value => context.setReview('expanded', value === 'on'));
  }
  async function globalInstructions(container, current) {
    const loading = text(container, 'Loading…');
    let settings = await rpc('host/settings/read', { scope: 'global-instructions' });
    if (current !== generation) return;
    loading.remove();
    const source = text(container, settings.path);
    source.classList.add('settings-file-path');
    const label = document.createElement('label'), title = document.createElement('span'), input = document.createElement('textarea');
    label.className = 'settings-instructions settings-global-instructions';
    title.className = 'sr-only'; title.textContent = t('Global instructions');
    input.value = settings.instructions; input.rows = 16; input.spellcheck = false;
    label.append(title, input); container.append(label);
    const actions = document.createElement('div'); actions.className = 'settings-actions'; container.append(actions);
    const status = text(actions, ''); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    autosaves.push(bindSettingsAutosave(label, { feedback: status, t, delay: 800, save: async () => {
      const result = await rpc('host/settings/write', { field: 'globalInstructions', value: input.value, version: settings.version });
      const fallback = result.path !== settings.path;
      settings = result; input.value = result.instructions; source.textContent = result.path;
      status.textContent = t(fallback ? 'Saved. The fallback global instructions are now active for new chats.' : 'Saved. Start a new chat to use this setting.');
    } }));
  }
  async function plugins(container, current) {
    const loading = text(container, 'Loading…');
    const result = await rpc('plugin/installed', { cwds: context.cwd() ? [context.cwd()] : [] });
    if (current !== generation) return;
    loading.remove(); let count = 0;
    for (const marketplace of result.marketplaces || []) for (const plugin of marketplace.plugins || []) {
      if (!plugin.installed) continue;
      row(container, plugin.interface?.displayName || plugin.name, document.createTextNode(t(plugin.enabled ? 'Enabled' : 'Disabled'))); count++;
    }
    for (const error of result.marketplaceLoadErrors || []) text(container, error.message);
    if (!count) text(container, 'No installed plugins found');
  }
  async function securitySettings(page, container, current) {
    const content = document.createElement('div');
    const editors = page === 'access-settings' || page === 'domain-settings'
      ? await renderAccessSettings(content, t, page)
      : await renderAuthenticationSettings(content, page === 'otp-settings' ? 'otp' : 'oidc');
    if (current !== generation) return;
    container.append(...content.childNodes); autosaves.push(...editors);
  }
  async function about(container, current) {
    const loading = text(container, 'Loading…');
    const response = await fetch('/api/about', { cache: 'no-store' });
    if (!response.ok) throw new Error('无法读取项目信息。');
    const info = await response.json();
    if (current !== generation) return;
    loading.remove();
    row(container, '当前版本', document.createTextNode(info.version));
    if (info.projectUrl) {
      const link = document.createElement('a'); link.href = info.projectUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = info.projectUrl;
      row(container, '项目地址', link);
    }
    const messages = { available: `有新版本：${info.latestVersion}`, current: '已是最新版本', untagged: 'GitHub 暂无版本标签。', unavailable: '暂时无法检查更新，请稍后再试。', unconfigured: '尚未配置 GitHub 更新地址。' };
    const status = text(container, messages[info.updateStatus] || messages.unavailable); status.setAttribute('role', 'status');
    if (info.updateStatus === 'available' && info.updateUrl) {
      const link = document.createElement('a'); link.className = 'integration-refresh'; link.href = info.updateUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = '查看新版本'; container.append(link);
    }
  }
  async function render(page, container) {
    const pending = flushEdits();
    const current = ++generation;
    await pending;
    if (current !== generation) return;
    container.replaceChildren();
    try {
      if (['access-settings', 'domain-settings', 'otp-settings', 'oidc-settings'].includes(page)) await securitySettings(page, container, current);
      else if (page === 'passkey-settings') {
        const content = document.createElement('div'); await renderPasskeySettings(content, t);
        if (current === generation) container.append(...content.childNodes);
      }
      else if (page === 'about') await about(container, current);
      else if (page === 'agent') await configuration(container, current);
      else if (page === 'global-instructions') await globalInstructions(container, current);
      else if (page === 'code-review') review(container);
      else if (page === 'plugins-settings') await plugins(container, current);
      else if (page === 'browser-use') {
        button(container, 'Open browser panel', () => { context.closeSettings(); context.openBrowser(); });
      }
      if (current === generation) groupRows(container);
    } catch (error) {
      if (current === generation) text(container, `${t('Cannot load settings')}: ${error.message}`);
    }
  }
  return { render, cancel: () => { flushEdits(); generation++; } };
}
