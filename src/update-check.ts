import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PACKAGE_NAME_FALLBACK = 'pistils-chat-cli';
const PACKAGE_VERSION_FALLBACK = '0.1.2';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 800;

export type PackageUpdateStatus = {
  ok: boolean;
  packageName: string;
  currentVersion: string;
  latestVersion?: string;
  updateAvailable: boolean;
  checkedAt?: string;
  source: 'registry' | 'cache' | 'disabled' | 'error';
  registryUrl?: string;
  error?: string;
};

type UpdateCheckCache = {
  version: 1;
  packageName: string;
  currentVersion: string;
  latestVersion?: string;
  updateAvailable: boolean;
  checkedAt: string;
  registryUrl: string;
};

export type PackageUpdateCheckOptions = {
  stateDir?: string;
  force?: boolean;
  ttlMs?: number;
  timeoutMs?: number;
  registryUrl?: string;
};

export type PackageUpdateNotifyOptions = PackageUpdateCheckOptions & {
  json?: boolean;
  quiet?: boolean;
  write?: (line: string) => void;
};

function envDisablesUpdateCheck() {
  const raw = process.env.AGENTTALK_UPDATE_CHECK;
  return raw !== undefined && ['0', 'false', 'off', 'no'].includes(raw.trim().toLowerCase());
}

function envSkipsPassiveUpdateCheck() {
  if (process.env.AGENTTALK_UPDATE_CHECK !== undefined) {
    return false;
  }
  return process.env.npm_lifecycle_event?.startsWith('smoke:') === true;
}

function parsePositiveIntEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function defaultStateDir() {
  return process.env.AGENTTALK_STATE_DIR
    ? path.resolve(process.env.AGENTTALK_STATE_DIR)
    : path.join(os.homedir(), '.agenttalk');
}

function updateCachePath(stateDir = defaultStateDir()) {
  return path.join(stateDir, 'update-check.json');
}

function readPackageMetadata() {
  const candidates = [
    path.join(__dirname, '..', 'package.json'),
    path.join(process.cwd(), 'package.json'),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    try {
      const parsed = JSON.parse(require('node:fs').readFileSync(candidate, 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (parsed.name === PACKAGE_NAME_FALLBACK && typeof parsed.version === 'string') {
        return { packageName: parsed.name, currentVersion: parsed.version };
      }
    } catch {
      // Fall through to the compiled-in metadata.
    }
  }
  return {
    packageName: PACKAGE_NAME_FALLBACK,
    currentVersion: PACKAGE_VERSION_FALLBACK,
  };
}

function defaultRegistryUrl(packageName: string) {
  return `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`;
}

function parseSemverParts(version: string) {
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])] as const;
}

export function isNewerVersion(latest: string, current: string) {
  const latestParts = parseSemverParts(latest);
  const currentParts = parseSemverParts(current);
  if (!latestParts || !currentParts) {
    return false;
  }
  for (let i = 0; i < latestParts.length; i += 1) {
    if (latestParts[i] > currentParts[i]) {
      return true;
    }
    if (latestParts[i] < currentParts[i]) {
      return false;
    }
  }
  return false;
}

async function readCache(cachePath: string): Promise<UpdateCheckCache | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(cachePath, 'utf8')) as UpdateCheckCache;
    if (parsed.version !== 1 || typeof parsed.checkedAt !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function writeCache(cachePath: string, cache: UpdateCheckCache) {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
}

async function fetchLatestVersion(registryUrl: string, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(registryUrl, {
      headers: {
        accept: 'application/json',
        'user-agent': 'pistils-chat-cli-update-check',
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`registry returned HTTP ${response.status}`);
    }
    const payload = (await response.json()) as { version?: unknown };
    if (typeof payload.version !== 'string' || !payload.version.trim()) {
      throw new Error('registry response did not include a version');
    }
    return payload.version.trim();
  } finally {
    clearTimeout(timer);
  }
}

export async function checkForPackageUpdate(
  options: PackageUpdateCheckOptions = {}
): Promise<PackageUpdateStatus> {
  const { packageName, currentVersion } = readPackageMetadata();
  const registryUrl =
    options.registryUrl ??
    process.env.AGENTTALK_UPDATE_CHECK_URL ??
    defaultRegistryUrl(packageName);
  const ttlMs =
    options.ttlMs ??
    parsePositiveIntEnv('AGENTTALK_UPDATE_CHECK_TTL_MS', DEFAULT_TTL_MS);
  const timeoutMs =
    options.timeoutMs ??
    parsePositiveIntEnv('AGENTTALK_UPDATE_CHECK_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);

  if (envDisablesUpdateCheck()) {
    return {
      ok: true,
      packageName,
      currentVersion,
      updateAvailable: false,
      source: 'disabled',
      registryUrl,
    };
  }

  const cachePath = updateCachePath(options.stateDir);
  const cached = await readCache(cachePath);
  const cachedAtMs = cached?.checkedAt ? Date.parse(cached.checkedAt) : Number.NaN;
  const fresh =
    !options.force &&
    cached &&
    cached.packageName === packageName &&
    cached.currentVersion === currentVersion &&
    cached.registryUrl === registryUrl &&
    Number.isFinite(cachedAtMs) &&
    Date.now() - cachedAtMs < ttlMs;
  if (fresh) {
    return {
      ok: true,
      packageName,
      currentVersion,
      latestVersion: cached.latestVersion,
      updateAvailable: cached.updateAvailable,
      checkedAt: cached.checkedAt,
      source: 'cache',
      registryUrl,
    };
  }

  try {
    const latestVersion = await fetchLatestVersion(registryUrl, timeoutMs);
    const checkedAt = new Date().toISOString();
    const updateAvailable = isNewerVersion(latestVersion, currentVersion);
    await writeCache(cachePath, {
      version: 1,
      packageName,
      currentVersion,
      latestVersion,
      updateAvailable,
      checkedAt,
      registryUrl,
    });
    return {
      ok: true,
      packageName,
      currentVersion,
      latestVersion,
      updateAvailable,
      checkedAt,
      source: 'registry',
      registryUrl,
    };
  } catch (error) {
    return {
      ok: false,
      packageName,
      currentVersion,
      latestVersion: cached?.latestVersion,
      updateAvailable: cached?.updateAvailable ?? false,
      checkedAt: cached?.checkedAt,
      source: 'error',
      registryUrl,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function formatPackageUpdateNotice(status: PackageUpdateStatus) {
  if (!status.updateAvailable || !status.latestVersion) {
    return null;
  }
  return `[update] ${status.packageName} ${status.latestVersion} is available; current ${status.currentVersion}. Run: npm install -g ${status.packageName}@latest`;
}

export async function maybeNotifyPackageUpdate(options: PackageUpdateNotifyOptions = {}) {
  if (options.json || options.quiet || envDisablesUpdateCheck() || envSkipsPassiveUpdateCheck()) {
    return;
  }
  const status = await checkForPackageUpdate(options);
  const notice = formatPackageUpdateNotice(status);
  if (notice) {
    (options.write ?? ((line: string) => process.stderr.write(`${line}\n`)))(notice);
  }
}
