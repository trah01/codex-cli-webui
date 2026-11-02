import { renderAccessSettings } from './access-settings.js';

export function createSettingsEditor(context) {
  const { t, rpc } = context;
  let generation = 0;
  function text(container, message) {
    const node = document.createElement('p');
    node.className = 'settings-feedback'; node.textContent = t(message); container.append(node);
    return node;
  }
  function row(container, label, control) {
    const node = document.createElement('label'), name = document.createElement('strong');
    node.className = 'settings-row settings-select-row'; name.textContent = t(label);
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
    const models = context.models();
    select(container, 'Model', models.map(model => [model.model, model.displayName || model.model]), context.model(), async value => {
      context.chooseModel(value); await render('agent', container);
    });
    select(container, 'Reasoning effort', context.efforts(), context.effort(), value => context.chooseEffort(value));
    select(container, 'Selected mode', context.permissions(), context.permission(), value => context.choosePermission(value));
    const remote = document.createElement('div'); container.append(remote);
    const loading = text(remote, 'Loading…');
    const settings = await rpc('host/settings/read', { cwd: context.cwd() || undefined });
    if (current !== generation) return;
    loading.remove();
    const saved = text(remote, 'Changes to Codex configuration apply to new chats.');
    select(remote, 'Web search', [['disabled', 'Disabled'], ['cached', 'Cached search'], ['live', 'Live search']], settings.webSearch, async value => {
      await rpc('host/settings/write', { field: 'webSearch', value }); saved.textContent = t('Saved. Start a new chat to use this setting.');
    });
    const label = document.createElement('label'), title = document.createElement('strong'), input = document.createElement('textarea');
    label.className = 'settings-instructions'; title.textContent = t('Custom instructions'); input.value = settings.instructions; input.rows = 6; input.maxLength = 100000;
    label.append(title, input); remote.append(label);
    button(remote, 'Save instructions', async () => {
      await rpc('host/settings/write', { field: 'instructions', value: input.value }); saved.textContent = t('Saved. Start a new chat to use this setting.');
    });
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
    const label = document.createElement('label'), title = document.createElement('span'), input = document.createElement('textarea');
    label.className = 'settings-instructions settings-global-instructions';
    title.className = 'sr-only'; title.textContent = t('Global instructions');
    input.value = settings.instructions; input.rows = 16; input.spellcheck = false;
    label.append(title, input); container.append(label);
    const status = text(container, ''); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    let saving = false;
    const save = document.createElement('button');
    save.type = 'button'; save.className = 'integration-refresh'; save.textContent = t('Save'); container.append(save);
    save.onclick = async () => {
      saving = true; save.disabled = true; input.disabled = true; status.textContent = t('Saving…');
      try {
        const result = await rpc('host/settings/write', { field: 'globalInstructions', value: input.value, version: settings.version });
        if (current !== generation) return;
        const fallback = result.path !== settings.path;
        settings = result; input.value = result.instructions; source.textContent = result.path;
        status.textContent = t(fallback ? 'Saved. The fallback global instructions are now active for new chats.' : 'Saved. Start a new chat to use this setting.');
      } catch (error) {
        if (current === generation) status.textContent = t(error.message);
      } finally {
        saving = false; input.disabled = false;
        save.disabled = input.value === settings.instructions;
      }
    };
    save.disabled = true;
    input.oninput = () => { save.disabled = saving || input.value === settings.instructions; status.textContent = ''; };
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
  async function archived(container, current) {
    let cursor = null;
    const list = document.createElement('div'); container.append(list);
    const more = button(container, 'Load more', load);
    async function load() {
      const result = await rpc('thread/list', { archived: true, limit: 30, ...(cursor ? { cursor } : {}) });
      if (current !== generation) return;
      for (const thread of result.data || []) {
        const actions = document.createElement('span');
        const item = row(list, thread.name || thread.preview || 'Untitled task', actions);
        button(actions, 'Restore', async () => {
          await rpc('thread/unarchive', { threadId: thread.id }); item.remove(); context.refreshThreads();
          if (!list.childElementCount && !cursor) text(list, 'No archived chats');
        });
      }
      cursor = result.nextCursor; more.hidden = !cursor;
      if (!list.childElementCount) text(list, 'No archived chats');
    }
    more.disabled = true;
    try { await load(); } finally { more.disabled = false; }
  }
  async function render(page, container) {
    const current = ++generation; container.replaceChildren();
    try {
      if (page === 'access-settings') await renderAccessSettings(container, t);
      else if (page === 'agent') await configuration(container, current);
      else if (page === 'global-instructions') await globalInstructions(container, current);
      else if (page === 'code-review') review(container);
      else if (page === 'plugins-settings') await plugins(container, current);
      else if (page === 'data-controls') await archived(container, current);
      else if (page === 'browser-use') {
        button(container, 'Open browser panel', () => { context.closeSettings(); context.openBrowser(); });
      }
    } catch (error) {
      if (current === generation) text(container, `${t('Cannot load settings')}: ${error.message}`);
    }
  }
  return { render, cancel: () => { generation++; } };
}
