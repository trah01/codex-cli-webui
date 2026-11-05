const parseVersion = value => {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value || '');
  return match ? match.slice(1).map(Number) : null;
};
export function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  return 0;
}

export function createAboutService({ version, projectUrl, githubRepository, fetchImpl = fetch, now = Date.now }) {
  let cache, expires = 0, pending;
  const metadata = { version, projectUrl };
  return async function readAbout() {
    if (!githubRepository || !/^[\w.-]+\/[\w.-]+$/.test(githubRepository)) return { ...metadata, updateStatus: 'unconfigured' };
    if (cache && now() < expires) return cache;
    if (pending) return pending;
    pending = (async () => {
      try {
        const response = await fetchImpl(`https://api.github.com/repos/${githubRepository}/tags?per_page=100`, {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'codex-cli-webui' },
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error('Cannot read version tags');
        const tags = await response.json();
        if (!Array.isArray(tags)) throw new Error('Invalid version tags');
        const latest = tags.filter(tag => parseVersion(tag?.name)).sort((a, b) => compareVersions(b.name, a.name))[0];
        const hasUpdate = latest && compareVersions(latest.name, version) === 1;
        cache = { ...metadata, updateStatus: !latest ? 'untagged' : hasUpdate ? 'available' : 'current', latestVersion: latest?.name || null,
          ...(hasUpdate ? { updateUrl: `https://github.com/${githubRepository}/tree/${encodeURIComponent(latest.name)}` } : {}) };
        expires = now() + 15 * 60_000;
      } catch {
        cache = { ...metadata, updateStatus: 'unavailable' };
        expires = now() + 60_000;
      }
      return cache;
    })().finally(() => { pending = null; });
    return pending;
  };
}
