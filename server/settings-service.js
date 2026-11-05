import { createGlobalInstructionsStore } from './global-instructions.js';
import { createProjectInstructionsStore } from './project-instructions.js';

const CONFIG_FIELDS = {
  webSearch: 'web_search',
  instructions: 'developer_instructions',
  model: 'model',
  reasoningEffort: 'model_reasoning_effort',
};

export function createSettingsService(request, options = {}) {
  const globalInstructions = createGlobalInstructionsStore(options);
  const projectInstructions = createProjectInstructionsStore(options);
  async function read(cwd) {
    const result = await request('config/read', { includeLayers: false, ...(cwd ? { cwd } : {}) });
    const config = result.config || {};
    return {
      webSearch: config.web_search || 'cached',
      instructions: config.developer_instructions || '',
      mcpServers: Object.entries(config.mcp_servers || {}).map(([name, value]) => ({ name, enabled: value?.enabled !== false })),
    };
  }

  async function write(params) {
    const { field, value } = params;
    if (field === 'globalInstructions') return globalInstructions.write(params);
    if (field === 'projectInstructions') return projectInstructions.write(params);
    if (field === 'permissionMode') {
      const modes = {
        default: ['on-request', 'user', 'workspace-write'],
        'guardian-approvals': ['on-request', 'auto_review', 'workspace-write'],
        'full-access': ['never', 'user', 'danger-full-access'],
      };
      if (!Object.hasOwn(modes, value)) throw new Error('Invalid permission mode');
      const keys = ['approval_policy', 'approvals_reviewer', 'sandbox_mode'];
      await request('config/batchWrite', { edits: keys.map((keyPath, index) => ({ keyPath, value: modes[value][index], mergeStrategy: 'replace' })) });
      return { saved: true };
    }
    if (!Object.hasOwn(CONFIG_FIELDS, field)) throw new Error('This setting cannot be changed from WebUI');
    if (field === 'webSearch' && !['disabled', 'cached', 'live'].includes(value)) throw new Error('Invalid web search mode');
    if (field === 'instructions' && (typeof value !== 'string' || value.length > 100000)) throw new Error('Invalid instructions');
    if (field === 'model' && (typeof value !== 'string' || !value.trim() || value.length > 256)) throw new Error('Invalid model');
    if (field === 'reasoningEffort' && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(value)) throw new Error('Invalid reasoning effort');
    await request('config/value/write', { keyPath: CONFIG_FIELDS[field], value, mergeStrategy: 'replace' });
    return { saved: true };
  }

  async function setSkill({ cwd, path, enabled }) {
    if (typeof path !== 'string' || typeof enabled !== 'boolean') throw new Error('Invalid skill setting');
    const result = await request('skills/list', { cwds: cwd ? [cwd] : [], forceReload: true });
    if (!(result.data || []).some(entry => (entry.skills || []).some(skill => skill.path === path))) {
      throw new Error('Skill is not available in the selected project');
    }
    return request('skills/config/write', { path, enabled });
  }

  async function setMcp({ name, enabled }) {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(name) || typeof enabled !== 'boolean') throw new Error('Invalid MCP server setting');
    const current = await read();
    if (!current.mcpServers.some(server => server.name === name)) throw new Error('MCP server is not configured');
    await request('config/value/write', { keyPath: `mcp_servers.${name}.enabled`, value: enabled, mergeStrategy: 'replace' });
    return { saved: true, requiresNewChat: true };
  }

  return async function dispatch(method, params = {}) {
    if (params.cwd != null && typeof params.cwd !== 'string') throw new Error('Invalid working folder');
    if (method === 'host/settings/read') {
      if (params.scope === 'chat-defaults') {
        const { config = {} } = await request('config/read', { includeLayers: false, ...(params.cwd ? { cwd: params.cwd } : {}) });
        return {
          model: config.model || '', reasoningEffort: config.model_reasoning_effort || '',
          permissionMode: config.sandbox_mode === 'danger-full-access' ? 'full-access' : config.approvals_reviewer === 'auto_review' ? 'guardian-approvals' : 'default',
        };
      }
      if (params.scope === 'global-instructions') return globalInstructions.read();
      if (params.scope === 'project-instructions') return projectInstructions.read(params.cwd);
      return read(params.cwd);
    }
    if (method === 'host/settings/write') return write(params);
    if (method === 'host/skills/set-enabled') return setSkill(params);
    if (method === 'host/mcp/set-enabled') return setMcp(params);
    throw new Error('Unknown settings method');
  };
}
