import { expect, test, vi } from 'vitest';
import { compareVersions, createAboutService } from '../server/about-service.js';

const metadata = { version: '0.1.0', projectUrl: 'https://github.com/trah01/codex-cli-webui', githubRepository: 'trah01/codex-cli-webui' };
test('compares numeric versions and ignores non-release tags', () => {
  expect(compareVersions('v0.10.0', '0.9.0')).toBe(1);
  expect(compareVersions('v0.1.0', '0.1.0')).toBe(0);
  expect(compareVersions('v0.0.9', '0.1.0')).toBe(-1);
  expect(compareVersions('v1.0.0-beta', '0.1.0')).toBeNull();
});
test('checks tags in the project repository, selects the highest version and caches requests', async () => {
  const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => [{ name: 'v0.2.0' }, { name: 'v0.10.0' }, { name: 'v1.0.0-beta' }, { name: 'test' }] }));
  const read = createAboutService({ ...metadata, fetchImpl });
  expect(await read()).toEqual({ version: '0.1.0', projectUrl: metadata.projectUrl, updateStatus: 'available', latestVersion: 'v0.10.0', updateUrl: `${metadata.projectUrl}/tree/v0.10.0` });
  await read();
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(fetchImpl.mock.calls[0][0]).toBe('https://api.github.com/repos/trah01/codex-cli-webui/tags?per_page=100');
});
test('distinguishes current, missing tags and unavailable updates', async () => {
  for (const [tags, expected] of [[[{ name: 'v0.1.0' }], 'current'], [[], 'untagged']] as const) {
    const read = createAboutService({ ...metadata, fetchImpl: async () => ({ ok: true, json: async () => tags }) });
    expect((await read()).updateStatus).toBe(expected);
  }
  const read = createAboutService({ ...metadata, fetchImpl: async () => { throw Error('offline'); } });
  expect((await read()).updateStatus).toBe('unavailable');
});
test('retries failures after a short cache and coalesces simultaneous requests', async () => {
  let time = 0;
  const fetchImpl = vi.fn(async () => ({ ok: false }));
  const read = createAboutService({ ...metadata, fetchImpl, now: () => time });
  await Promise.all([read(), read()]);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  time = 61_000;
  await read();
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});
