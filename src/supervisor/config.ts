import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type AgentConnectorKind = 'noop' | 'openclaw' | 'hermes' | 'codex' | 'shell';

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
  repoPath?: string;
  command?: string;
  connector?: {
    openclawAgentId?: string;
    sendReplyText?: boolean;
  };
  enabled: boolean;
  autoInit: boolean;
  maxConcurrentWakeJobs: number;
  connectorTimeoutMs: number;
  wake: {
    latencyMs: number;
    statusText: string;
    reasons: string[];
  };
};

export type SupervisorConfig = {
  version: 1;
  host: string;
  databaseName: string;
  logDir: string;
  runDir: string;
  defaultWakePolicy: SupervisorWakePolicy;
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
      wakeOnDirectMessage: true,
      wakeOnMention: true,
      wakeOnGroupMessage: false,
      acceptsNewConversations: true,
      coalesceWindowMs: 15_000,
      minWakeIntervalMs: 5_000,
      maxWakesPerMinute: 30,
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

export function redactConfig(config: SupervisorConfig) {
  return {
    ...config,
    logDir: '[redacted]',
    runDir: '[redacted]',
    agents: config.agents.map(agent => ({
      ...agent,
      stateDir: '[redacted]',
      repoPath: agent.repoPath ? '[redacted]' : undefined,
      command: agent.command ? '[configured]' : undefined,
    })),
  };
}
