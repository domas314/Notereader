// Update check against the public update repository on GitHub (set at build
// time, see scripts/android-project.cjs). Each published build is a release
// tagged "v1.<build number>" with Notereader.apk attached. The installed app compares its own build number
// (version.json, written when the app is built) with the latest release.

/** @returns {Promise<{version: string, build: number, repo: string} | null>} */
export async function installedVersion() {
  try {
    const res = await fetch('version.json', { cache: 'no-store' });
    const info = res.ok ? await res.json() : null;
    return info && Number.isFinite(info.build) && info.repo ? info : null;
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<{installed: string, latest: string, available: boolean, apkUrl?: string, pageUrl?: string}>}
 * Throws with a readable message when the check itself is not possible.
 */
export async function checkForUpdate() {
  const info = await installedVersion();
  if (!info) throw new Error('This copy was not built as a release, so it has no version to compare.');
  let res;
  try {
    res = await fetch(`https://api.github.com/repos/${info.repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    throw new Error('Could not reach GitHub. Check your connection.');
  }
  if (res.status === 404) {
    throw new Error(`No published version found yet at github.com/${info.repo}.`);
  }
  if (!res.ok) throw new Error(`GitHub answered with an error (${res.status}). Try again later.`);
  const release = await res.json();
  const build = Number(/(\d+)\s*$/.exec(release.tag_name || '')?.[1]);
  const apk = (release.assets || []).find((a) => /\.apk$/i.test(a.name));
  return {
    installed: info.version,
    latest: (release.tag_name || '').replace(/^v/, ''),
    available: Number.isFinite(build) && build > info.build && Boolean(apk),
    apkUrl: apk?.browser_download_url,
    pageUrl: release.html_url,
  };
}
