import { expect, test } from 'bun:test';
import { createSettingsService } from '../settings-service.js';

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
