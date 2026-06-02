import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type AgentConnectorKind = 'noop' | 'openclaw' | 'hermes' | 'codex' | 'shell';
export type WakeAccessMode = 'allow_list' | 'open';
export type AgentControlProfile = 'plugin_managed' | 'autonomous';
export type OpenWakeApprovalMode = 'none' | 'passphrase';

export const OPEN_WAKE_WARNING =
  'Careful: you are about to expose this agent to open wake requests from any AgentTalk sender who can deliver a message. This is generally inadvisable unless you have hardened the runtime and limited the blast radius of malicious actors attempting to influence or control your agents.';
export const OPEN_WAKE_APPROVAL_PASSPHRASE_REQUIRED =
  'Open wake approval passphrase is required before enabling open wake mode.';

const OPEN_WAKE_APPROVAL_DIGEST = 'sha256';
const OPEN_WAKE_APPROVAL_KEY_LENGTH = 32;
const OPEN_WAKE_APPROVAL_ITERATIONS = 210_000;

export type SupervisorOpenWakeApprovalConfig = {
  mode?: OpenWakeApprovalMode;
  salt?: string;
  hash?: string;
  iterations?: number;
  keyLength?: number;
  digest?: 'sha256';
};

export type SupervisorWakePolicy = {
  wakeOnDirectMessage: boolean;
  wakeOnMention: boolean;
  wakeOnGroupMessage: boolean;
  acceptsNewConversations: boolean;
  coalesceWindowMs: number;
  minWakeIntervalMs: number;
  maxWakesPerMinute: number;
};

export type SupervisorAgentConfig = {
  name: string;
  handle: string;
  stateDir: string;
  kind: AgentConnectorKind;
  controlProfile?: AgentControlProfile;
  repoPath?: string;
  command?: string;
  connector?: {
    openclawAgentId?: string;
    sendReplyText?: boolean;
    hermesSkills?: string[];
    reuseHermesSession?: boolean;
    liveChat?: boolean;
    liveChatIdleTimeoutMs?: number;
    liveChatMaxSessionMs?: number;
    startupTimeoutMs?: number;
    busyCommand?: string;
    busyCommandTimeoutMs?: number;
  };
  enabled: boolean;
  autoInit: boolean;
  maxConcurrentWakeJobs: number;
  connectorTimeoutMs: number;
  wake: {
    enabled: boolean;
    accessMode?: WakeAccessMode;
    latencyMs: number;
    statusText: string;
    reasons: string[];
    allowedWakeSenderAgentIds?: string[];
    blockedWakeSenderAgentIds?: string[];
  };
};

export type SupervisorConfig = {
  version: 1;
  host: string;
  databaseName: string;
  logDir: string;
  runDir: string;
  defaultWakePolicy: SupervisorWakePolicy;
  openWakeApproval?: SupervisorOpenWakeApprovalConfig;
  agents: SupervisorAgentConfig[];
};

export const DEFAULT_HOST = 'https://maincloud.spacetimedb.com';
export const DEFAULT_DB = 'crimsonconfidentialgibbon';

export function expandHome(input: string) {
  if (input === '~') {
    return os.homedir();
  }
  if (input.startsWith(`~${path.sep}`) || input.startsWith('~/')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export function supervisorRoot() {
  return process.env.AGENTTALK_SUPERVISOR_HOME
    ? path.resolve(expandHome(process.env.AGENTTALK_SUPERVISOR_HOME))
    : path.join(os.homedir(), '.agenttalk', 'supervisor');
}

export function supervisorConfigPath() {
  return process.env.AGENTTALK_SUPERVISOR_CONFIG
    ? path.resolve(expandHome(process.env.AGENTTALK_SUPERVISOR_CONFIG))
    : path.join(supervisorRoot(), 'config.json');
}

export function defaultAgentStateDir(name: string) {
  return path.join(os.homedir(), '.agenttalk', 'agents', name);
}

export function defaultSupervisorConfig(): SupervisorConfig {
  const root = supervisorRoot();
  return {
    version: 1,
    host: process.env.SPACETIMEDB_HOST ?? DEFAULT_HOST,
    databaseName: process.env.SPACETIMEDB_DB_NAME ?? DEFAULT_DB,
    logDir: path.join(root, 'logs'),
    runDir: path.join(root, 'runs'),
    defaultWakePolicy: {
      wakeOnDirectMessage: false,
      wakeOnMention: false,
      wakeOnGroupMessage: false,
      acceptsNewConversations: false,
      coalesceWindowMs: 15_000,
      minWakeIntervalMs: 5_000,
      maxWakesPerMinute: 30,
    },
    openWakeApproval: {
      mode: 'passphrase',
    },
    agents: [],
  };
}

export async function ensureSupervisorDirs(config: SupervisorConfig) {
  const dirs = [path.dirname(supervisorConfigPath()), config.logDir, config.runDir];
  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true });
    await fs.chmod(dir, 0o700).catch(() => undefined);
  }
}

export async function loadSupervisorConfig(): Promise<SupervisorConfig> {
  const raw = await fs.readFile(supervisorConfigPath(), 'utf8');
  const parsed = JSON.parse(raw) as SupervisorConfig;
  if (parsed.version !== 1 || !Array.isArray(parsed.agents)) {
    throw new Error(`Unsupported supervisor config at ${supervisorConfigPath()}`);
  }
  return parsed;
}

export async function loadSupervisorConfigOrDefault() {
  try {
    return await loadSupervisorConfig();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return defaultSupervisorConfig();
    }
    throw error;
  }
}

export async function saveSupervisorConfig(config: SupervisorConfig) {
  await ensureSupervisorDirs(config);
  await fs.writeFile(supervisorConfigPath(), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await fs.chmod(supervisorConfigPath(), 0o600).catch(() => undefined);
}

export function normalizeAgentName(name: string) {
  const normalized = name.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(normalized)) {
    throw new Error('agent name must be 2-63 lowercase letters, numbers, dashes, or underscores');
  }
  return normalized;
}

export function normalizeHandle(handle: string) {
  const normalized = handle.trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(normalized)) {
    throw new Error('handle must be 2-63 lowercase letters, numbers, dashes, or underscores');
  }
  return normalized;
}

export function normalizeKind(kind: string): AgentConnectorKind {
  if (
    kind === 'noop' ||
    kind === 'openclaw' ||
    kind === 'hermes' ||
    kind === 'codex' ||
    kind === 'shell'
  ) {
    return kind;
  }
  throw new Error('kind must be noop, openclaw, hermes, codex, or shell');
}

export function normalizeControlProfile(value: string | undefined | null): AgentControlProfile {
  const normalized = value?.trim().toLowerCase().replace(/-/g, '_');
  if (!normalized || normalized === 'plugin_managed' || normalized === 'plugin') {
    return 'plugin_managed';
  }
  if (normalized === 'autonomous' || normalized === 'admin' || normalized === 'full') {
    return 'autonomous';
  }
  throw new Error('control profile must be plugin-managed or autonomous');
}

export function normalizeWakeSenderAgentIds(
  value: string | string[] | undefined | null,
  field = 'wake sender agent IDs'
) {
  if (value === undefined || value === null) {
    return [] as string[];
  }

  let items: string[];
  if (Array.isArray(value)) {
    items = value;
  } else {
    const trimmed = value.trim();
    if (!trimmed) {
      return [] as string[];
    }
    if (trimmed.startsWith('[')) {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) {
        throw new Error(`${field} must be a comma/newline-separated list or JSON array of strings`);
      }
      items = parsed;
    } else {
      items = trimmed.split(/[\s,]+/);
    }
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const agentId = item.trim();
    if (!agentId) {
      continue;
    }
    if (agentId.length > 256 || /\s|,/.test(agentId)) {
      throw new Error(`${field} must contain AgentTalk agent IDs without whitespace or commas`);
    }
    if (!seen.has(agentId)) {
      normalized.push(agentId);
      seen.add(agentId);
    }
  }
  if (normalized.length > 100) {
    throw new Error(`${field} must contain 100 or fewer agent IDs`);
  }
  return normalized;
}

export function normalizeWakeAccessMode(value: string | undefined | null): WakeAccessMode {
  const normalized = value?.trim().toLowerCase().replace(/-/g, '_');
  if (!normalized || normalized === 'allow_list' || normalized === 'allowlist') {
    return 'allow_list';
  }
  if (normalized === 'open' || normalized === 'open_wake' || normalized === 'any_sender') {
    return 'open';
  }
  throw new Error('wake access mode must be allow-list or open');
}

export function wakeAccessMode(wake: { accessMode?: string } | undefined): WakeAccessMode {
  return normalizeWakeAccessMode(wake?.accessMode);
}

export function wakeSenderAgentIdsJson(value: string[] | undefined) {
  return JSON.stringify(normalizeWakeSenderAgentIds(value ?? []));
}

export function normalizeOpenWakeApprovalMode(
  value: string | undefined | null
): OpenWakeApprovalMode {
  const normalized = value?.trim().toLowerCase().replace(/-/g, '_');
  if (!normalized || normalized === 'none' || normalized === 'off') {
    return 'none';
  }
  if (normalized === 'passphrase' || normalized === 'password') {
    return 'passphrase';
  }
  throw new Error('open wake approval mode must be none or passphrase');
}

function normalizeOpenWakeApprovalConfig(config: SupervisorConfig) {
  const approval = config.openWakeApproval ?? { mode: 'passphrase' };
  const mode = normalizeOpenWakeApprovalMode(approval.mode);
  return {
    ...approval,
    mode,
    digest: approval.digest ?? OPEN_WAKE_APPROVAL_DIGEST,
    keyLength: approval.keyLength ?? OPEN_WAKE_APPROVAL_KEY_LENGTH,
    iterations: approval.iterations ?? OPEN_WAKE_APPROVAL_ITERATIONS,
  };
}

function hashOpenWakeApprovalPassphrase(input: {
  passphrase: string;
  salt: string;
  iterations: number;
  keyLength: number;
  digest: string;
}) {
  return pbkdf2Sync(
    input.passphrase,
    Buffer.from(input.salt, 'hex'),
    input.iterations,
    input.keyLength,
    input.digest
  ).toString('hex');
}

export function setOpenWakeApprovalPassphrase(config: SupervisorConfig, passphrase: string) {
  const normalized = passphrase.trim();
  if (normalized.length < 8) {
    throw new Error('open wake approval passphrase must be at least 8 characters');
  }
  const salt = randomBytes(16).toString('hex');
  const iterations = OPEN_WAKE_APPROVAL_ITERATIONS;
  const keyLength = OPEN_WAKE_APPROVAL_KEY_LENGTH;
  const digest = OPEN_WAKE_APPROVAL_DIGEST;
  config.openWakeApproval = {
    mode: 'passphrase',
    salt,
    hash: hashOpenWakeApprovalPassphrase({
      passphrase: normalized,
      salt,
      iterations,
      keyLength,
      digest,
    }),
    iterations,
    keyLength,
    digest,
  };
}

export function clearOpenWakeApprovalPassphrase(config: SupervisorConfig) {
  config.openWakeApproval = {
    mode: 'none',
  };
}

export function openWakeApprovalStatus(config: SupervisorConfig) {
  const approval = normalizeOpenWakeApprovalConfig(config);
  return {
    mode: approval.mode,
    configured:
      approval.mode === 'passphrase' &&
      typeof approval.salt === 'string' &&
      typeof approval.hash === 'string',
    iterations: approval.mode === 'passphrase' ? approval.iterations : undefined,
    digest: approval.mode === 'passphrase' ? approval.digest : undefined,
  };
}

export function requireOpenWakeLocalApproval(
  config: SupervisorConfig | undefined,
  passphrase: string | undefined
) {
  if (!config) {
    return;
  }
  const approval = normalizeOpenWakeApprovalConfig(config);
  if (approval.mode !== 'passphrase') {
    return;
  }
  if (!approval.salt || !approval.hash) {
    throw new Error(OPEN_WAKE_APPROVAL_PASSPHRASE_REQUIRED);
  }
  const normalized = passphrase?.trim();
  if (!normalized) {
    throw new Error(OPEN_WAKE_APPROVAL_PASSPHRASE_REQUIRED);
  }
  const candidate = Buffer.from(
    hashOpenWakeApprovalPassphrase({
      passphrase: normalized,
      salt: approval.salt,
      iterations: approval.iterations,
      keyLength: approval.keyLength,
      digest: approval.digest,
    }),
    'hex'
  );
  const expected = Buffer.from(approval.hash, 'hex');
  if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
    throw new Error('Open wake approval passphrase did not match.');
  }
}

export function allowedWakeSenderAgentIdsJson(wake: { accessMode?: string; allowedWakeSenderAgentIds?: string[] }) {
  return wakeAccessMode(wake) === 'open'
    ? ''
    : wakeSenderAgentIdsJson(wake.allowedWakeSenderAgentIds);
}

export function redactConfig(config: SupervisorConfig) {
  return {
    ...config,
    logDir: '[redacted]',
    runDir: '[redacted]',
    openWakeApproval: {
      mode: openWakeApprovalStatus(config).mode,
      configured: openWakeApprovalStatus(config).configured,
    },
    agents: config.agents.map(agent => ({
      ...agent,
      stateDir: '[redacted]',
      repoPath: agent.repoPath ? '[redacted]' : undefined,
      command: agent.command ? '[configured]' : undefined,
    })),
  };
}
