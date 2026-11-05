import { createGlobalInstructionsStore } from './global-instructions.js';
import { createProjectInstructionsStore } from './project-instructions.js';

const CONFIG_FIELDS = {
  webSearch: 'web_search',
  instructions: 'developer_instructions',
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
    if (!Object.hasOwn(CONFIG_FIELDS, field)) throw new Error('This setting cannot be changed from WebUI');
    if (field === 'webSearch' && !['disabled', 'cached', 'live'].includes(value)) throw new Error('Invalid web search mode');
    if (field === 'instructions' && (typeof value !== 'string' || value.length > 100000)) throw new Error('Invalid instructions');
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
