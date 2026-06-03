import '../node-compat';
import { promises as fs } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import os from 'node:os';
import path from 'node:path';
import { Identity, setGlobalLogLevel } from 'spacetimedb';
import {
  AgentRealtimeClient,
  type AgentRole,
  type AgentSubscriptionProfile,
} from '../agent-client';
import type * as ModuleTypes from '../module_bindings/types';

export type AgentTalkMcpState = {
  host?: string;
  databaseName?: string;
  token?: string;
  ipcSecret?: string;
};

export type AgentTalkMcpConnectConfig = {
  host: string;
  databaseName: string;
  token?: string;
};

export type AgentTalkMcpClientContext = {
  client: AgentRealtimeClient;
  config: AgentTalkMcpConnectConfig;
  state: AgentTalkMcpState;
};

export type AgentTalkMcpRequestOverrides = Partial<AgentTalkMcpConnectConfig> & {
  stateDir?: string;
  persistState?: boolean;
};

export const DEFAULT_HOST = 'https://maincloud.spacetimedb.com';
export const DEFAULT_DB = 'crimsonconfidentialgibbon';

const DIRECTORY_SYNC_DELAY_MS = 250;
const requestOverrides = new AsyncLocalStorage<AgentTalkMcpRequestOverrides>();

function currentOverrides() {
  return requestOverrides.getStore() ?? {};
}

export function runWithMcpRequestOverrides<T>(
  overrides: AgentTalkMcpRequestOverrides,
  run: () => Promise<T>
) {
  return requestOverrides.run(overrides, run);
}

export function stateDir() {
  const override = currentOverrides().stateDir;
  return override
    ? path.resolve(override)
    : process.env.AGENTTALK_STATE_DIR
      ? path.resolve(process.env.AGENTTALK_STATE_DIR)
      : path.join(os.homedir(), '.agenttalk');
}

export function statePath() {
  return path.join(stateDir(), 'state.json');
}

export async function loadMcpState(): Promise<AgentTalkMcpState> {
  if (currentOverrides().persistState === false) {
    return {};
  }
  try {
    const raw = await fs.readFile(statePath(), 'utf8');
    return JSON.parse(raw) as AgentTalkMcpState;
  } catch {
    return {};
  }
}

export async function saveMcpState(state: AgentTalkMcpState) {
  if (currentOverrides().persistState === false) {
    return;
  }
  const dir = stateDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.chmod(dir, 0o700).catch(() => undefined);
  await fs.writeFile(statePath(), JSON.stringify(state, null, 2) + '\n', 'utf8');
  await fs.chmod(statePath(), 0o600).catch(() => undefined);
}

export function resolveMcpConnectConfig(state: AgentTalkMcpState): AgentTalkMcpConnectConfig {
  const overrides = currentOverrides();
  return {
    host: overrides.host ?? process.env.SPACETIMEDB_HOST ?? state.host ?? DEFAULT_HOST,
    databaseName:
      overrides.databaseName ?? process.env.SPACETIMEDB_DB_NAME ?? state.databaseName ?? DEFAULT_DB,
    token: overrides.token ?? process.env.AGENTTALK_TOKEN ?? state.token,
  };
}

export async function connectMcpClient(
  subscriptionProfile: AgentSubscriptionProfile = 'direct'
): Promise<AgentTalkMcpClientContext> {
  setGlobalLogLevel('error');
  const state = await loadMcpState();
  const config = resolveMcpConnectConfig(state);
  const client = await AgentRealtimeClient.connect({
    host: config.host,
    databaseName: config.databaseName,
    token: config.token,
    subscriptionProfile,
  });
  const nextState: AgentTalkMcpState = {
    ...state,
    host: config.host,
    databaseName: config.databaseName,
    token: client.token,
  };
  await saveMcpState(nextState);
  return { client, config, state: nextState };
}

export async function withMcpClient<T>(
  subscriptionProfile: AgentSubscriptionProfile,
  run: (context: AgentTalkMcpClientContext) => Promise<T>
) {
  const context = await connectMcpClient(subscriptionProfile);
  try {
    return await run(context);
  } finally {
    context.client.disconnect();
  }
}

export function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function clampTimeoutMs(value: number | undefined, defaultValue: number, maxValue: number) {
  if (value === undefined || !Number.isFinite(value)) {
    return defaultValue;
  }
  return Math.max(0, Math.min(Math.trunc(value), maxValue));
}

export function parseBigIntInput(value: unknown, name: string): bigint | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  throw new Error(`${name} must be an unsigned integer string or number`);
}

export function normalizeAccountRef(ref: string) {
  const trimmed = ref.trim();
  return trimmed.startsWith('@') ? trimmed.slice(1).toLowerCase() : trimmed.toLowerCase();
}

export async function resolveAccount(
  client: AgentRealtimeClient,
  accountRef: string
): Promise<ModuleTypes.Account | undefined> {
  const trimmed = accountRef.trim();
  if (!trimmed) {
    throw new Error('Account reference is required');
  }
  const maybeHex = trimmed.startsWith('0x') ? trimmed.slice(2) : trimmed;
  if (/^[0-9a-fA-F]{64}$/.test(maybeHex)) {
    const identity = Identity.fromString(maybeHex);
    await client.requestAccountDirectory({ limit: 20n });
    await sleep(DIRECTORY_SYNC_DELAY_MS);
    return client.listAccounts().find(row => row.identity.toHexString() === identity.toHexString());
  }
  const handle = normalizeAccountRef(trimmed);
  await client.requestAccountDirectory({ handle, limit: 1n });
  await sleep(DIRECTORY_SYNC_DELAY_MS);
  return client.searchAccounts({ handle })[0];
}

export async function resolveTargetIdentity(
  client: AgentRealtimeClient,
  accountRef: string
) {
  const maybeHex = accountRef.trim().startsWith('0x')
    ? accountRef.trim().slice(2)
    : accountRef.trim();
  if (/^[0-9a-fA-F]{64}$/.test(maybeHex)) {
    return Identity.fromString(maybeHex);
  }
  const account = await resolveAccount(client, accountRef);
  if (!account) {
    throw new Error(`Unknown account: ${accountRef}`);
  }
  return account.identity;
}

export function normalizeRole(role: string | undefined): AgentRole | undefined {
  if (!role) {
    return undefined;
  }
  const normalized = role.trim().toLowerCase();
  if (normalized === 'agent' || normalized === 'human') {
    return normalized;
  }
  throw new Error('role must be agent or human');
}

function redactKey(key: string) {
  const normalized = key.toLowerCase();
  return (
    normalized.includes('token') ||
    normalized.includes('secret') ||
    normalized.includes('authorization') ||
    normalized.includes('password') ||
    normalized === 'endpointref' ||
    normalized.endsWith('endpointref') ||
    normalized.includes('configpath') ||
    normalized.includes('authfile') ||
    normalized.includes('statepath')
  );
}

export function sanitizeForMcp(value: unknown, key = ''): unknown {
  if (redactKey(key)) {
    return '[redacted]';
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value !== 'object') {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if ('toHexString' in value && typeof value.toHexString === 'function') {
    return value.toHexString();
  }
  if ('toDate' in value && typeof value.toDate === 'function') {
    return value.toDate().toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(item => sanitizeForMcp(item));
  }
  const output: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (typeof childValue !== 'function') {
      output[childKey] = sanitizeForMcp(childValue, childKey);
    }
  }
  return output;
}

export function currentAccount(client: AgentRealtimeClient) {
  return client.listAccounts().find(row => row.identity.toHexString() === client.identityHex);
}
