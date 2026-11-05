import { interruptThread } from './turn-control.js';

export function collectSubagents(thread) {
  const tasks = new Map();
  for (const turn of thread.turns || []) for (const item of turn.items || []) {
    const ids = item.type === 'collabAgentToolCall' ? item.receiverThreadIds || [] : item.type === 'subAgentActivity' ? [item.agentThreadId] : [];
    for (const threadId of ids) {
      if (!threadId || threadId === thread.id) continue;
      const previous = tasks.get(threadId) || {};
      const agent = item.agentsStates?.[threadId];
      const activityStatus = item.type === 'subAgentActivity' ? { started: 'running', interacted: 'running', completed: 'completed', interrupted: 'interrupted' }[item.kind] : null;
      tasks.set(threadId, { ...previous, threadId, parentThreadId: thread.id, prompt: item.prompt || previous.prompt || '', model: item.model || previous.model || '', agentPath: item.agentPath || previous.agentPath || '', status: agent?.status || activityStatus || (item.tool === 'closeAgent' && item.status === 'completed' ? 'closed' : previous.status || 'unknown'), message: agent?.message || previous.message || '' });
    }
  }
  return [...tasks.values()];
}

export function createSubagentService({ request, loadThread, enqueue }) {
  async function parent(id) {
    if (typeof id !== 'string' || !id || id.length > 256) throw new Error('请先打开一个任务。');
    const thread = await loadThread(id);
    if (thread?.id !== id) throw new Error('无法读取主任务。');
    return thread;
  }
  return async function dispatch(method, params) {
    const thread = await parent(params.threadId);
    if (method === 'host/subagents/delegate') {
      if (typeof params.prompt !== 'string' || !params.prompt.trim() || params.prompt.length > 16000) throw new Error('请填写子代理需要完成的任务，最多 16000 字。');
      const configuration = (await request('config/read', { cwd: thread.cwd, includeLayers: false })).config || {};
      if (configuration.agents?.enabled === false || configuration.features?.multi_agent === false) throw new Error('Codex 配置已关闭子代理，请先在 Codex 中启用。');
      const text = `请使用子代理完成以下任务。请由当前主任务实际创建并分派子代理，协调其工作并在当前对话汇总结果；如果无法创建，请明确说明原因。\n\n${params.prompt.trim()}`;
      return enqueue({ messageId: params.messageId, threadId: thread.id, input: [{ type: 'text', text, text_elements: [] }], model: params.model, effort: params.effort, cwd: thread.cwd });
    }
    const tasks = collectSubagents(thread);
    if (method === 'host/subagents/list') {
      for (const task of tasks) {
        try {
          const child = (await request('thread/read', { threadId: task.threadId, includeTurns: false })).thread;
          task.name = child?.name || task.agentPath || task.model || '子代理';
          const status = child?.status?.type;
          task.active = status === 'active';
          if (status === 'active') task.status = 'running';
          else if (status === 'idle' && !['errored', 'interrupted', 'closed'].includes(task.status)) task.status = 'completed';
          task.runtimeStatus = status || 'unknown';
        } catch { task.error = '暂时无法读取状态'; task.active = false; }
      }
      return { parentThreadId: thread.id, tasks };
    }
    if (method === 'host/subagents/stop') {
      const task = tasks.find(task => task.threadId === params.childThreadId);
      if (!task) throw new Error('该子代理不属于当前主任务。');
      const child = await loadThread(task.threadId);
      const turn = child.turns?.findLast(turn => turn.status === 'inProgress');
      if (child.status?.type === 'idle') return { stopped: false };
      if (!turn) throw new Error('未找到正在运行的子代理任务，请刷新状态后重试。');
      await interruptThread(request, { threadId: task.threadId, turnId: turn.id });
      return { stopped: true };
    }
    throw new Error('未知的子代理操作。');
  };
}
