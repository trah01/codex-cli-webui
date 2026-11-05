const labels = { running: '运行中', pendingInit: '启动中', completed: '已完成', errored: '失败', interrupted: '已停止', closed: '已关闭', shutdown: '已关闭', notFound: '任务不可用', unknown: '状态待刷新' };

export function createSubagentPanel(root, { rpc, getThread, delegate, openThread, onCount = () => {} }) {
  const list = root.querySelector('#sideTaskList');
  const toolbar = document.createElement('div'); toolbar.className = 'subagent-toolbar';
  const back = document.createElement('button'); back.type = 'button'; back.textContent = '返回主任务';
  const refresh = document.createElement('button'); refresh.type = 'button'; refresh.textContent = '刷新状态';
  toolbar.append(back, refresh);
  const form = document.createElement('form'); form.className = 'subagent-form';
  const input = document.createElement('textarea'); input.rows = 3; input.maxLength = 16000; input.required = true; input.placeholder = '填写要分派给子代理的任务'; input.setAttribute('aria-label', '子代理任务');
  const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = '分派给子代理';
  const feedback = document.createElement('p'); feedback.className = 'settings-feedback'; feedback.setAttribute('role', 'status');
  form.append(input, submit, feedback); root.prepend(toolbar, form);
  const parents = new Map(), snapshots = new Map();
  let generation = 0, timer, loading = false;
  const parentId = () => parents.get(getThread()?.id) || getThread()?.parentThreadId || getThread()?.id;
  function render(tasks = snapshots.get(parentId()) || []) {
    back.hidden = parentId() === getThread()?.id;
    list.replaceChildren(); onCount(tasks.length);
    for (const task of tasks) {
      const row = document.createElement('div'); row.className = 'subagent-row';
      const open = document.createElement('button'); open.type = 'button'; open.className = 'side-task-card'; open.dataset.threadId = task.threadId;
      const copy = document.createElement('span'); copy.className = 'side-task-copy';
      const name = document.createElement('strong'); name.textContent = task.name || task.agentPath || task.model || '子代理';
      const detail = document.createElement('small'); detail.textContent = task.error || task.message || task.prompt || task.threadId;
      const status = document.createElement('span'); status.className = `side-task-status ${['running', 'completed', 'errored', 'interrupted'].includes(task.status) ? task.status : ''}`; status.textContent = labels[task.status] || task.status || labels.unknown;
      copy.append(name, detail); open.append(copy, status);
      open.onclick = async () => {
        open.disabled = true; open.setAttribute('aria-busy', 'true');
        try { await openThread(task.threadId, { id: task.threadId, name: name.textContent, cwd: getThread()?.cwd, source: 'local' }); render(); }
        catch (error) { feedback.textContent = error.message; }
        finally { open.disabled = false; open.removeAttribute('aria-busy'); }
      };
      row.append(open);
      if (task.active || ['running', 'pendingInit'].includes(task.status)) {
        const stop = document.createElement('button'); stop.type = 'button'; stop.className = 'subagent-stop'; stop.textContent = '停止'; stop.setAttribute('aria-label', `停止子代理：${name.textContent}`);
        stop.onclick = async () => {
          stop.disabled = true;
          try { await rpc('host/subagents/stop', { threadId: task.parentThreadId || parentId(), childThreadId: task.threadId }); feedback.textContent = '停止请求已发送。'; await reload(); }
          catch (error) { feedback.textContent = error.message; }
          finally { stop.disabled = false; }
        };
        row.append(stop);
      }
      list.append(row);
    }
    if (!tasks.length) { const empty = document.createElement('p'); empty.className = 'side-task-empty'; empty.textContent = '尚未创建子代理'; list.append(empty); }
  }
  async function reload() {
    const id = parentId(); clearTimeout(timer);
    if (!id) { render([]); return; }
    if (loading) { timer = setTimeout(reload, 3000); return; }
    const revision = ++generation; loading = true; refresh.disabled = true;
    try {
      const result = await rpc('host/subagents/list', { threadId: id });
      if (revision !== generation || id !== parentId()) return;
      snapshots.set(id, result.tasks);
      for (const task of result.tasks) parents.set(task.threadId, id);
      render(result.tasks);
    } catch (error) { if (id === parentId()) feedback.textContent = error.message; }
    finally { loading = false; refresh.disabled = false; if (!root.hidden) timer = setTimeout(reload, 3000); }
  }
  form.onsubmit = async event => {
    event.preventDefault(); if (!input.value.trim()) return; submit.disabled = true;
    try {
      await delegate(input.value.trim(), parentId()); input.value = '';
      feedback.textContent = '分派请求已发送，等待 Codex 创建子代理。'; await reload();
    } catch (error) { feedback.textContent = error.message; }
    finally { submit.disabled = false; }
  };
  refresh.onclick = reload;
  back.onclick = async () => { const id = parentId(); if (id) { try { await openThread(id); await reload(); } catch (error) { feedback.textContent = error.message; } } };
  render();
  return {
    show() { render(); void reload(); },
    hide() { clearTimeout(timer); ++generation; },
    observe(tasks, id) {
      if (tasks.length && id && !parents.has(id)) {
        snapshots.set(id, tasks); for (const task of tasks) parents.set(task.threadId, id);
      }
      onCount((snapshots.get(parentId()) || []).length);
      if (!root.hidden) { render(); if (!loading) { clearTimeout(timer); timer = setTimeout(reload, 300); } }
    },
  };
}
