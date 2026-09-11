'use strict';

// GitHub release lookup. Updates are downloaded in the user's normal browser,
// rather than attempting to replace a running .app from inside its own bundle.
// The release workflow names macOS assets Rejsudai-<version>-<arch>.dmg.

const REPOSITORY = 'anttonalberdi/rejsudai';
const API_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const DOWNLOAD_PATH = `/${REPOSITORY}/releases/download/`;

function parseVersion(value) {
  const match = String(value || '').trim().replace(/^v/i, '')
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

// Returns a positive number when `left` is newer than `right`.
function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return 0;
  for (let i = 0; i < a.core.length; i += 1) {
    if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length ? -1 : 1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    const partA = a.prerelease[i];
    const partB = b.prerelease[i];
    if (partA === undefined) return -1;
    if (partB === undefined) return 1;
    if (partA === partB) continue;
    const numericA = /^\d+$/.test(partA);
    const numericB = /^\d+$/.test(partB);
    if (numericA && numericB) return Number(partA) > Number(partB) ? 1 : -1;
    if (numericA !== numericB) return numericA ? -1 : 1;
    return partA > partB ? 1 : -1;
  }
  return 0;
}

function assetForPlatform(assets, platform, arch) {
  // A release can contain more than one operating system. Do not advertise an
  // update unless there is an artifact this running copy can actually use.
  const extension = { darwin: 'dmg', win32: 'exe', linux: 'AppImage' }[platform];
  if (!extension) return null;
  const suffix = `-${arch}.${extension}`.toLowerCase();
  return (Array.isArray(assets) ? assets : []).find(asset =>
    asset && typeof asset.name === 'string' && typeof asset.browser_download_url === 'string' &&
    asset.name.toLowerCase().endsWith(suffix)
  ) || null;
}

function isReleaseDownloadUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' && url.pathname.startsWith(DOWNLOAD_PATH);
  } catch {
    return false;
  }
}

async function check(currentVersion, { platform = process.platform, arch = process.arch, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetchImpl(API_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `Rejsudai/${currentVersion}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) return { available: false };
    const release = await response.json();
    if (!release || compareVersions(release.tag_name, currentVersion) <= 0) return { available: false };
    const asset = assetForPlatform(release.assets, platform, arch);
    if (!asset || !isReleaseDownloadUrl(asset.browser_download_url)) return { available: false };
    return {
      available: true,
      version: String(release.tag_name).replace(/^v/i, ''),
      url: asset.browser_download_url,
      assetName: asset.name,
    };
  } catch {
    // Being offline or rate-limited should never get in the way of filing a
    // settlement. The next app launch will try again.
    return { available: false };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { REPOSITORY, API_URL, parseVersion, compareVersions, assetForPlatform, isReleaseDownloadUrl, check };
