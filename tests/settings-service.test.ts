import { expect, test } from 'vitest';
import { createSettingsService } from '../server/settings-service.js';

test('settings responses exclude credentials and unknown fields cannot be written', async () => {
  const writes = [];
  const service = createSettingsService(async (method, params) => {
    if (method === 'config/read') return { config: { web_search: 'live', developer_instructions: 'test', api_key: 'hidden', mcp_servers: { example: { enabled: false, env: { SECRET: 'hidden' } } } } };
    writes.push([method, params]); return {};
  });
  expect(await service('host/settings/read')).toEqual({ webSearch: 'live', instructions: 'test', mcpServers: [{ name: 'example', enabled: false }] });
  await expect(service('host/settings/write', { field: '__proto__', value: true })).rejects.toThrow();
  await expect(service('host/settings/write', { field: 'instructions', value: {} })).rejects.toThrow();
  await expect(service('host/settings/write', { field: 'webSearch', value: 'invalid' })).rejects.toThrow();
  await expect(service('host/mcp/set-enabled', { name: 'example.enabled', enabled: true })).rejects.toThrow();
  await expect(service('host/mcp/set-enabled', { name: 'missing', enabled: true })).rejects.toThrow();
  expect(writes).toHaveLength(0);
  await service('host/settings/write', { field: 'webSearch', value: 'disabled', filePath: '/tmp/ignored' });
  expect(writes).toEqual([['config/value/write', { keyPath: 'web_search', value: 'disabled', mergeStrategy: 'replace' }]]);
});

test('skill changes are restricted to discovered skill paths', async () => {
  const writes = [];
  const service = createSettingsService(async (method, params) => {
    if (method === 'skills/list') return { data: [{ skills: [{ path: '/skills/example/SKILL.md' }] }] };
    writes.push([method, params]); return { effectiveEnabled: false };
  });
  await expect(service('host/skills/set-enabled', { path: '/tmp/arbitrary', enabled: false })).rejects.toThrow();
  expect(writes).toHaveLength(0);
  expect(await service('host/skills/set-enabled', { path: '/skills/example/SKILL.md', enabled: false })).toEqual({ effectiveEnabled: false });
  expect(writes[0][0]).toBe('skills/config/write');
});

test('chat defaults use global configuration unless a project overrides individual values', async () => {
  const global = { model: 'default-model', model_reasoning_effort: 'high', sandbox_mode: 'workspace-write', approvals_reviewer: 'user' };
  const service = createSettingsService(async (method, params) => {
    expect(method).toBe('config/read');
    return { config: { ...global, ...(params.cwd === '/project' ? { model_reasoning_effort: 'low', sandbox_mode: 'danger-full-access' } : {}) } };
  });
  expect(await service('host/settings/read', { scope: 'chat-defaults' })).toEqual({ model: 'default-model', reasoningEffort: 'high', permissionMode: 'default' });
  expect(await service('host/settings/read', { scope: 'chat-defaults', cwd: '/project' })).toEqual({ model: 'default-model', reasoningEffort: 'low', permissionMode: 'full-access' });
});

test('default selections write user configuration and validate permission values', async () => {
  const writes: any[] = [];
  const service = createSettingsService(async (method, params) => { writes.push([method, params]); return {}; });
  await service('host/settings/write', { field: 'model', value: 'default-model' });
  await service('host/settings/write', { field: 'reasoningEffort', value: 'high' });
  await service('host/settings/write', { field: 'permissionMode', value: 'guardian-approvals' });
  expect(writes).toEqual([
    ['config/value/write', { keyPath: 'model', value: 'default-model', mergeStrategy: 'replace' }],
    ['config/value/write', { keyPath: 'model_reasoning_effort', value: 'high', mergeStrategy: 'replace' }],
    ['config/batchWrite', { edits: [
      { keyPath: 'approval_policy', value: 'on-request', mergeStrategy: 'replace' },
      { keyPath: 'approvals_reviewer', value: 'auto_review', mergeStrategy: 'replace' },
      { keyPath: 'sandbox_mode', value: 'workspace-write', mergeStrategy: 'replace' },
    ] }],
  ]);
  await expect(service('host/settings/write', { field: 'permissionMode', value: '__proto__' })).rejects.toThrow();
  await expect(service('host/settings/write', { field: 'reasoningEffort', value: 'invalid' })).rejects.toThrow();
  await expect(service('host/settings/write', { field: 'model', value: '' })).rejects.toThrow();
  expect(writes).toHaveLength(3);
});
