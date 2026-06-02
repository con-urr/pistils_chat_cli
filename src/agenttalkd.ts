#!/usr/bin/env node
import { existsSync, readFileSync, promises as fs } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { Identity, setGlobalLogLevel } from 'spacetimedb';
import { AgentRealtimeClient, type AgentSubscriptionProfile } from './agent-client';
import type * as ModuleTypes from './module_bindings/types';

type AgenttalkState = {
  host?: string;
  databaseName?: string;
  token?: string;
  ipcSecret?: string;
};

type AgenttalkdResponse =
  | { id: string; ok: true; data: unknown }
  | { id: string; ok: false; error: string; reason?: string; retryAfterMs?: number };

const DEFAULT_HOST = 'https://maincloud.spacetimedb.com';
const DEFAULT_DB = 'crimsonconfidentialgibbon';
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8000;
const RECONNECT_MAX_ATTEMPTS = 6;
const HEARTBEAT_INTERVAL_MS = 30000;
const STATE_DIR = process.env.AGENTTALK_STATE_DIR
  ? path.resolve(process.env.AGENTTALK_STATE_DIR)
  : path.join(os.homedir(), '.agenttalk');
const STATE_PATH = path.join(STATE_DIR, 'state.json');
const PID_PATH = path.join(STATE_DIR, 'agenttalkd.pid');

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function jsonReplacer(_key: string, value: unknown) {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Identity) {
    return value.toHexString();
  }
  if (value && typeof value === 'object' && 'toDate' in value) {
    return (value as { toDate(): Date }).toDate().toISOString();
  }
  return value;
}

function writeJsonLine(stream: NodeJS.WritableStream, payload: unknown) {
  stream.write(JSON.stringify(payload, jsonReplacer) + '\n');
}

function loadStateSync(): AgenttalkState {
  try {
    if (!existsSync(STATE_PATH)) {
      return {};
    }
    return JSON.parse(readFileSync(STATE_PATH, 'utf8')) as AgenttalkState;
  } catch {
    return {};
  }
}

function daemonPipeKey() {
  const state = loadStateSync();
  const host = process.env.SPACETIMEDB_HOST ?? state.host ?? DEFAULT_HOST;
  const databaseName = process.env.SPACETIMEDB_DB_NAME ?? state.databaseName ?? DEFAULT_DB;
  return createHash('sha256')
    .update(JSON.stringify({ stateDir: STATE_DIR, host, databaseName }))
    .digest('hex')
    .slice(0, 16);
}

function daemonPipePath() {
  if (process.env.AGENTTALK_DAEMON_PIPE) {
    return process.env.AGENTTALK_DAEMON_PIPE;
  }
  const key = daemonPipeKey();
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\agenttalkd-${key}`;
  }
  return path.join(os.tmpdir(), `agenttalkd-${key}.sock`);
}

async function loadState(): Promise<AgenttalkState> {
  try {
    return JSON.parse(await fs.readFile(STATE_PATH, 'utf8')) as AgenttalkState;
  } catch {
    return {};
  }
}

async function saveState(state: AgenttalkState) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.chmod(STATE_DIR, 0o700).catch(() => undefined);
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
  await fs.chmod(STATE_PATH, 0o600).catch(() => undefined);
}

function ensureIpcSecret(state: AgenttalkState) {
  return state.ipcSecret && state.ipcSecret.length >= 32
    ? state.ipcSecret
    : randomBytes(32).toString('hex');
}

function parseIdentity(value: string) {
  return Identity.fromString(value);
}

function coerceErrorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isNeedsInitError(error: unknown) {
  const text = coerceErrorText(error).toLowerCase();
  return (
    text.includes('guest-only') ||
    text.includes('create an active account') ||
    text.includes('accept a workspace invite')
  );
}

function requestIdFromPayload(
  payload: Record<string, unknown>,
  action: string,
  envelopeId: string
) {
  const existing =
    typeof payload.clientRequestId === 'string'
      ? payload.clientRequestId
      : typeof payload.client_request_id === 'string'
        ? payload.client_request_id
        : undefined;
  if (existing) {
    return existing;
  }
  const generated = envelopeId
    ? `agenttalkd:${action}:${envelopeId}`
    : `agenttalkd:${action}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  payload.clientRequestId = generated;
  return generated;
}

function conversationMessageDto(row: ModuleTypes.ConversationMessage) {
  return {
    id: row.id.toString(),
    conversationId: row.conversationId.toString(),
    sequence: row.sequence.toString(),
    authorIdentity: row.authorIdentity.toHexString(),
    authorLabel: row.authorLabel,
    authorKind: row.authorKind,
    kind: row.kind,
    text: row.text,
    sent: row.sent.toDate().toISOString(),
    clientRequestId: row.clientRequestId ?? null,
    correlationId: row.correlationId ?? null,
  };
}

function deliveryDto(row: ModuleTypes.ConversationDelivery) {
  return {
    key: row.key,
    recipientAgentId: row.recipientAgentId,
    recipientIdentity: row.recipientIdentity?.toHexString() ?? null,
    conversationId: row.conversationId.toString(),
    messageId: row.messageId.toString(),
    sequence: row.sequence.toString(),
    senderAgentId: row.senderAgentId,
    senderIdentity: row.senderIdentity.toHexString(),
    state: row.state,
    sent: row.sent.toDate().toISOString(),
    updatedAt: row.updatedAt.toDate().toISOString(),
  };
}

function receiptDto(row: ModuleTypes.ClientRequestReceipt) {
  return {
    key: row.key,
    action: row.action,
    clientRequestId: row.clientRequestId,
    status: row.status,
    conversationId: row.conversationId?.toString() ?? null,
    messageId: row.messageId?.toString() ?? null,
    sequence: row.sequence?.toString() ?? null,
    error: row.error ?? null,
    createdAt: row.createdAt.toDate().toISOString(),
  };
}

function identityHex(identity?: Identity | null) {
  return identity ? identity.toHexString() : null;
}

function accountDto(account: ModuleTypes.Account) {
  return {
    handle: account.handle,
    identity: account.identity.toHexString(),
    agentId: account.agentId ?? null,
    displayName: account.displayName,
    role: account.role,
    bio: account.bio ?? null,
    online: account.online,
    createdAt: account.createdAt.toDate().toISOString(),
    updatedAt: account.updatedAt.toDate().toISOString(),
    lastSeen: account.lastSeen.toDate().toISOString(),
  };
}

function accountEntitlementDto(entitlement: ModuleTypes.AccountEntitlement) {
  return {
    handle: entitlement.handle,
    identity: entitlement.identity.toHexString(),
    accountType: entitlement.accountType,
    groupChatAllowed: entitlement.groupChatAllowed,
    agentId: entitlement.agentId ?? null,
    maxGroupConversationMembers:
      entitlement.maxGroupConversationMembers?.toString() ?? null,
    maxMessageBytes: entitlement.maxMessageBytes?.toString() ?? null,
    sendRatePerMinute: entitlement.sendRatePerMinute?.toString() ?? null,
    openConversationRatePerMinute:
      entitlement.openConversationRatePerMinute?.toString() ?? null,
    historyRequestRatePerMinute:
      entitlement.historyRequestRatePerMinute?.toString() ?? null,
    inboxRequestRatePerMinute:
      entitlement.inboxRequestRatePerMinute?.toString() ?? null,
    directorySearchRatePerMinute:
      entitlement.directorySearchRatePerMinute?.toString() ?? null,
    maxInboxPageSize: entitlement.maxInboxPageSize?.toString() ?? null,
    maxHistoryPageSize: entitlement.maxHistoryPageSize?.toString() ?? null,
    maxPendingUnreadDeliveries:
      entitlement.maxPendingUnreadDeliveries?.toString() ?? null,
    createdAt: entitlement.createdAt.toDate().toISOString(),
    updatedAt: entitlement.updatedAt.toDate().toISOString(),
    updatedBy: identityHex(entitlement.updatedBy),
  };
}

function deploymentPolicyDto(policy: ModuleTypes.DeploymentPolicyView) {
  return {
    key: policy.key,
    openBetaMode: policy.openBetaMode,
    disableNewAccounts: policy.disableNewAccounts,
    disableMessageSend: policy.disableMessageSend,
    maintenanceModeMessage: policy.maintenanceModeMessage ?? null,
    maxMessageBytesDefault: policy.maxMessageBytesDefault.toString(),
    defaultSendRatePerMinute: policy.defaultSendRatePerMinute.toString(),
    defaultOpenConversationRatePerMinute:
      policy.defaultOpenConversationRatePerMinute.toString(),
    defaultHistoryRequestsPerMinute:
      policy.defaultHistoryRequestsPerMinute.toString(),
    defaultInboxRequestsPerMinute:
      policy.defaultInboxRequestsPerMinute.toString(),
    defaultDirectorySearchRatePerMinute:
      policy.defaultDirectorySearchRatePerMinute.toString(),
    maxInboxPageSize: policy.maxInboxPageSize.toString(),
    maxHistoryPageSize: policy.maxHistoryPageSize.toString(),
    maxPendingUnreadDeliveries: policy.maxPendingUnreadDeliveries.toString(),
    updatedAt: policy.updatedAt.toDate().toISOString(),
  };
}

function deploymentWakePolicyDto(policy: ModuleTypes.DeploymentWakePolicyView) {
  return {
    key: policy.key,
    disableWakeDispatch: policy.disableWakeDispatch,
    defaultWakeCoalesceWindowMs: policy.defaultWakeCoalesceWindowMs.toString(),
    defaultMinWakeIntervalMs: policy.defaultMinWakeIntervalMs.toString(),
    defaultMaxWakesPerMinute: policy.defaultMaxWakesPerMinute.toString(),
    defaultWakeRequestTtlSeconds: policy.defaultWakeRequestTtlSeconds.toString(),
    maxWakeAttempts: policy.maxWakeAttempts.toString(),
    maxWakePayloadBytes: policy.maxWakePayloadBytes.toString(),
    maxPendingWakeRequestsPerAgent: policy.maxPendingWakeRequestsPerAgent.toString(),
    maintenanceModeMessage: policy.maintenanceModeMessage ?? null,
    updatedAt: policy.updatedAt.toDate().toISOString(),
  };
}

function wakeProfileDto(profile: ModuleTypes.AgentWakeProfileView) {
  return {
    agentId: profile.agentId,
    handle: profile.handle,
    displayName: profile.displayName,
    role: profile.role,
    online: profile.online,
    wakeable: profile.wakeable,
    availability: profile.availability,
    acceptsNewConversations: profile.acceptsNewConversations,
    expectedWakeLatencyMs: profile.expectedWakeLatencyMs?.toString() ?? null,
    wakeLatencyClass: profile.wakeLatencyClass ?? null,
    supportedWakeReasonsJson: profile.supportedWakeReasonsJson,
    statusText: profile.statusText ?? null,
    updatedAt: profile.updatedAt.toDate().toISOString(),
  };
}

function wakeRegistrationDto(
  registration: ModuleTypes.WakeRegistrationView,
  showPrivate = false
) {
  return {
    registrationId: registration.registrationId,
    agentId: registration.agentId,
    ownerIdentity: registration.ownerIdentity.toHexString(),
    kind: registration.kind,
    endpointRef: showPrivate ? registration.endpointRef ?? null : null,
    endpointRefRedacted: Boolean(registration.endpointRef && !showPrivate),
    secretConfigured: registration.secretConfigured,
    enabled: registration.enabled,
    createdAt: registration.createdAt.toDate().toISOString(),
    updatedAt: registration.updatedAt.toDate().toISOString(),
    lastSuccessAt: registration.lastSuccessAt?.toDate().toISOString() ?? null,
    lastFailureAt: registration.lastFailureAt?.toDate().toISOString() ?? null,
    failureCount: registration.failureCount.toString(),
    metadataJson: registration.metadataJson ?? null,
  };
}

function wakePolicyDto(policy: ModuleTypes.AgentWakePolicy) {
  return {
    agentId: policy.agentId,
    wakeOnDirectMessage: policy.wakeOnDirectMessage,
    wakeOnMention: policy.wakeOnMention,
    wakeOnGroupMessage: policy.wakeOnGroupMessage,
    wakeOnHandoff: policy.wakeOnHandoff,
    wakeOnBusinessInquiry: policy.wakeOnBusinessInquiry,
    acceptsNewConversations: policy.acceptsNewConversations,
    minWakeIntervalMs: policy.minWakeIntervalMs.toString(),
    coalesceWindowMs: policy.coalesceWindowMs.toString(),
    maxWakesPerMinute: policy.maxWakesPerMinute.toString(),
    maxConcurrentWakeJobs: policy.maxConcurrentWakeJobs.toString(),
    expectedWakeLatencyMs: policy.expectedWakeLatencyMs?.toString() ?? null,
    availabilityOverride: policy.availabilityOverride ?? null,
    statusText: policy.statusText ?? null,
    allowedWakeSenderAgentIdsJson: policy.allowedWakeSenderAgentIdsJson ?? null,
    blockedWakeSenderAgentIdsJson: policy.blockedWakeSenderAgentIdsJson ?? null,
    updatedAt: policy.updatedAt.toDate().toISOString(),
    updatedBy: policy.updatedBy.toHexString(),
  };
}

function wakeRequestDto(wake: ModuleTypes.WakeRequestView) {
  return {
    wakeId: wake.wakeId,
    wakeKey: wake.wakeKey,
    recipientAgentId: wake.recipientAgentId,
    recipientIdentity: wake.recipientIdentity?.toHexString() ?? null,
    senderAgentId: wake.senderAgentId,
    conversationId: wake.conversationId.toString(),
    minSequence: wake.minSequence.toString(),
    maxSequence: wake.maxSequence.toString(),
    reason: wake.reason,
    status: wake.status,
    priority: wake.priority,
    attemptCount: wake.attemptCount.toString(),
    nextAttemptAt: wake.nextAttemptAt.toDate().toISOString(),
    leaseUntil: wake.leaseUntil?.toDate().toISOString() ?? null,
    createdAt: wake.createdAt.toDate().toISOString(),
    updatedAt: wake.updatedAt.toDate().toISOString(),
    expiresAt: wake.expiresAt.toDate().toISOString(),
    suppressedReason: wake.suppressedReason ?? null,
    metadataJson: wake.metadataJson ?? null,
    payload: {
      type: 'agenttalk.wake',
      version: '1',
      wakeId: wake.wakeId,
      recipientAgentId: wake.recipientAgentId,
      conversationId: wake.conversationId.toString(),
      minSequence: wake.minSequence.toString(),
      maxSequence: wake.maxSequence.toString(),
      reason: wake.reason,
      createdAt: wake.createdAt.toDate().toISOString(),
      expiresAt: wake.expiresAt.toDate().toISOString(),
    },
  };
}

function wakeAttemptDto(attempt: ModuleTypes.WakeAttemptView) {
  return {
    attemptId: attempt.attemptId,
    wakeId: attempt.wakeId,
    registrationId: attempt.registrationId ?? null,
    recipientAgentId: attempt.recipientAgentId,
    attemptNumber: attempt.attemptNumber.toString(),
    status: attempt.status,
    claimedBy: attempt.claimedBy.toHexString(),
    claimedAt: attempt.claimedAt.toDate().toISOString(),
    dispatchedAt: attempt.dispatchedAt?.toDate().toISOString() ?? null,
    completedAt: attempt.completedAt?.toDate().toISOString() ?? null,
    leaseUntil: attempt.leaseUntil.toDate().toISOString(),
    error: attempt.error ?? null,
    metadataJson: attempt.metadataJson ?? null,
  };
}

function payloadString(
  payload: Record<string, unknown>,
  keys: string[],
  defaultValue?: string
) {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  return defaultValue;
}

function payloadBoolean(
  payload: Record<string, unknown>,
  keys: string[],
  defaultValue?: boolean
) {
  for (const key of keys) {
    const value = payload[key];
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(normalized)) {
        return true;
      }
      if (['false', '0', 'no', 'off'].includes(normalized)) {
        return false;
      }
    }
    throw new Error(`${keys[0]} must be a boolean`);
  }
  return defaultValue;
}

function payloadBigInt(payload: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = payload[key];
    if (value === undefined || value === null || value === '') {
      continue;
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
    throw new Error(`${keys[0]} must be an unsigned integer string`);
  }
  return undefined;
}

function payloadNumber(
  payload: Record<string, unknown>,
  keys: string[],
  defaultValue: number,
  maxValue = Number.MAX_SAFE_INTEGER
) {
  for (const key of keys) {
    const value = payload[key];
    if (value === undefined || value === null || value === '') {
      continue;
    }
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
      throw new Error(`${keys[0]} must be a non-negative integer`);
    }
    return Math.min(parsed, maxValue);
  }
  return defaultValue;
}

function sortWakeRequestsDesc(left: ModuleTypes.WakeRequestView, right: ModuleTypes.WakeRequestView) {
  const updated = right.updatedAt.toDate().getTime() - left.updatedAt.toDate().getTime();
  if (updated !== 0) {
    return updated;
  }
  return right.createdAt.toDate().getTime() - left.createdAt.toDate().getTime();
}

function conversationDto(conversation: ModuleTypes.Conversation) {
  return {
    id: conversation.id.toString(),
    kind: conversation.kind,
    title: conversation.title,
    createdBy: conversation.createdBy.toHexString(),
    createdAt: conversation.createdAt.toDate().toISOString(),
    lastActivity: conversation.lastActivity.toDate().toISOString(),
  };
}

function conversationMemberDto(member: ModuleTypes.ConversationMember) {
  return {
    id: member.id.toString(),
    conversationId: member.conversationId.toString(),
    memberIdentity: member.memberIdentity.toHexString(),
    role: member.role,
    joinedAt: member.joinedAt.toDate().toISOString(),
  };
}

function normalizeAccountRef(ref: string): string {
  return ref.startsWith('@') ? ref.slice(1).trim().toLowerCase() : ref.trim().toLowerCase();
}

function maybeAccountHandle(ref: string) {
  const normalized = normalizeAccountRef(ref);
  return /^[a-z0-9][a-z0-9_-]{2,39}$/.test(normalized) ? normalized : undefined;
}

class AgenttalkDaemon {
  private handleCache = new Map<
    string,
    { identity: Identity; account: ModuleTypes.Account | null }
  >();
  private directCache = new Map<string, bigint>();
  private receiptCache = new Map<string, ReturnType<typeof receiptDto>>();
  private conversationSequenceCache = new Map<string, bigint>();
  private startedAt = Date.now();
  private commandCount = 0;
  private shuttingDown = false;
  private reconnectCount = 0;
  private lastReconnectAt: number | undefined;
  private lastReconnectReason: string | undefined;
  private lastConnectionError: string | undefined;
  private needsInit = false;
  private reconnectPromise: Promise<void> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private client: AgentRealtimeClient,
    private state: AgenttalkState,
    private readonly profile: AgentSubscriptionProfile
  ) {}

  acceptsIpcSecret(value: unknown) {
    return typeof value === 'string' && value === this.state.ipcSecret;
  }

  static async connect(profile: AgentSubscriptionProfile = 'daemon-direct') {
    setGlobalLogLevel('error');
    const state = await loadState();
    const host = process.env.SPACETIMEDB_HOST ?? state.host ?? DEFAULT_HOST;
    const databaseName = process.env.SPACETIMEDB_DB_NAME ?? state.databaseName ?? DEFAULT_DB;
    const token = process.env.AGENTTALK_TOKEN ?? process.env.SPACETIMEDB_TOKEN ?? state.token;
    const client = await AgentRealtimeClient.connect({
      host,
      databaseName,
      token,
      subscriptionProfile: profile,
    });
    const ipcSecret = ensureIpcSecret(state);
    const nextState = { ...state, host, databaseName, token: client.token, ipcSecret };
    await saveState(nextState);
    let needsInit = false;
    try {
      await client.heartbeat('agenttalkd online', 'agenttalkd');
    } catch (error) {
      if (!isNeedsInitError(error)) {
        throw error;
      }
      needsInit = true;
    }
    const daemon = new AgenttalkDaemon(client, nextState, profile);
    daemon.needsInit = needsInit;
    daemon.lastConnectionError = needsInit ? 'needs_init' : undefined;
    return daemon;
  }

  isShuttingDown() {
    return this.shuttingDown;
  }

  async close() {
    this.shuttingDown = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    try {
      await fs.rm(PID_PATH, { force: true });
    } catch {
      // ignore best-effort pid cleanup
    }
    this.client.disconnect();
  }

  startHeartbeat() {
    if (this.heartbeatTimer) {
      return;
    }
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeatOnce();
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  private async heartbeatOnce() {
    if (this.shuttingDown) {
      return;
    }
    try {
      await this.ensureConnected('heartbeat');
      await this.client.heartbeat('agenttalkd online', 'agenttalkd');
      this.needsInit = false;
      this.lastConnectionError = undefined;
    } catch (error) {
      this.lastConnectionError = coerceErrorText(error);
      if (isNeedsInitError(error)) {
        this.needsInit = true;
        return;
      }
      if (!this.shuttingDown) {
        try {
          await this.reconnect(`heartbeat failed: ${this.lastConnectionError}`);
        } catch (reconnectError) {
          this.lastConnectionError = coerceErrorText(reconnectError);
        }
      }
    }
  }

  private async ensureConnected(reason: string) {
    if (this.client.connected) {
      return;
    }
    await this.reconnect(reason);
  }

  private isReconnectableError(error: unknown) {
    const text = coerceErrorText(error);
    return /disconnect|closed|websocket|socket|network|connection|econn|timed out waiting for receipt/i.test(text);
  }

  private async reconnect(reason: string) {
    if (this.reconnectPromise) {
      return this.reconnectPromise;
    }

    this.reconnectPromise = (async () => {
      this.lastReconnectReason = reason;
      let delayMs = RECONNECT_BASE_MS;
      let lastError = reason;

      for (let attempt = 1; attempt <= RECONNECT_MAX_ATTEMPTS && !this.shuttingDown; attempt += 1) {
        if (attempt > 1) {
          await sleep(delayMs);
          delayMs = Math.min(delayMs * 2, RECONNECT_MAX_MS);
        }

        try {
          try {
            this.client.disconnect();
          } catch {
            // best effort cleanup before replacing the connection
          }

          const client = await AgentRealtimeClient.connect({
            host: this.state.host,
            databaseName: this.state.databaseName,
            token: this.state.token,
            subscriptionProfile: this.profile,
            onDisconnect: error => {
              this.lastConnectionError = error ? error.message : 'connection disconnected';
            },
          });
          try {
            await client.heartbeat('agenttalkd reconnected', 'agenttalkd');
            this.needsInit = false;
          } catch (error) {
            if (!isNeedsInitError(error)) {
              throw error;
            }
            this.needsInit = true;
          }
          this.client = client;
          this.state = {
            ...this.state,
            token: client.token,
            ipcSecret: ensureIpcSecret(this.state),
          };
          await saveState(this.state);
          this.reconnectCount += 1;
          this.lastReconnectAt = Date.now();
          this.lastConnectionError = undefined;
          return;
        } catch (error) {
          lastError = coerceErrorText(error);
          this.lastConnectionError = lastError;
        }
      }

      throw new Error(`agenttalkd reconnect failed: ${lastError}`);
    })().finally(() => {
      this.reconnectPromise = undefined;
    });

    return this.reconnectPromise;
  }

  private accountCacheKey(ref: string) {
    return ref.trim().replace(/^@/, '').toLowerCase();
  }

  private rememberResolvedAccount(
    ref: string,
    resolved: { identity: Identity; account: ModuleTypes.Account | null }
  ) {
    const keys = new Set<string>([
      this.accountCacheKey(ref),
      resolved.identity.toHexString(),
    ]);
    if (resolved.account) {
      keys.add(resolved.account.handle);
      keys.add(`@${resolved.account.handle}`);
    }
    for (const key of keys) {
      this.handleCache.set(key, resolved);
    }
  }

  private rememberReceipt(row: ModuleTypes.ClientRequestReceipt) {
    const dto = receiptDto(row);
    this.receiptCache.set(`${row.action}:${row.clientRequestId}`, dto);
    this.receiptCache.set(row.clientRequestId, dto);
    if (row.conversationId && row.sequence) {
      this.rememberConversationSequence(row.conversationId, row.sequence);
    }
    return dto;
  }

  private rememberConversationSequence(conversationId: bigint, sequence: bigint) {
    const key = conversationId.toString();
    const existing = this.conversationSequenceCache.get(key) ?? 0n;
    if (sequence > existing) {
      this.conversationSequenceCache.set(key, sequence);
    }
  }

  private async resolveAccount(ref: string) {
    const trimmed = ref.trim().replace(/^@/, '');
    if (/^[0-9a-f]{64}$/i.test(trimmed)) {
      const resolved = { identity: parseIdentity(trimmed), account: null };
      this.rememberResolvedAccount(ref, resolved);
      return resolved;
    }

    const cached = this.handleCache.get(this.accountCacheKey(ref));
    if (cached) {
      return cached;
    }

    await this.client.requestAccountDirectory({ handle: trimmed, limit: 1n });
    await sleep(150);
    const account = this.client.searchAccounts({ handle: trimmed })[0];
    if (!account) {
      throw new Error(`Unknown account handle: ${ref}`);
    }
    const resolved = { identity: account.identity, account };
    this.rememberResolvedAccount(ref, resolved);
    return resolved;
  }

  private currentAccount(client = this.client) {
    return client.listAccounts().find(row => row.identity.toHexString() === client.identityHex);
  }

  private async currentAccountWithRefresh(client = this.client) {
    let account = this.currentAccount(client);
    if (account) {
      return account;
    }

    const profile = client.currentAgentProfile();
    if (profile?.handle) {
      await client.requestAccountDirectory({ handle: profile.handle, limit: 1n });
      await sleep(250);
      account = this.currentAccount(client);
    }
    return account;
  }

  private async withProfile<T>(
    profile: AgentSubscriptionProfile,
    fn: (client: AgentRealtimeClient) => Promise<T>
  ) {
    if (profile === this.profile) {
      return fn(this.client);
    }

    const client = await AgentRealtimeClient.connect({
      host: this.state.host,
      databaseName: this.state.databaseName,
      token: this.state.token,
      subscriptionProfile: profile,
    });
    try {
      return await fn(client);
    } finally {
      client.disconnect();
    }
  }

  private async openDirect(target: string, clientRequestId?: string) {
    const targetKey = this.accountCacheKey(target);
    const resolved = await this.resolveAccount(target);
    const requestId = await this.client.openDirectConversation({
      targetIdentity: resolved.identity,
      clientRequestId,
    });
    const receipt = await this.client.waitForReceipt(
      requestId,
      5000,
      'open_direct_conversation'
    );
    if (!receipt.conversationId) {
      throw new Error('open_direct_conversation receipt did not include conversationId');
    }
    const receiptPayload = this.rememberReceipt(receipt);
    this.directCache.set(targetKey, receipt.conversationId);
    this.directCache.set(target, receipt.conversationId);
    this.directCache.set(resolved.identity.toHexString(), receipt.conversationId);
    return {
      target: resolved.account
        ? {
            handle: resolved.account.handle,
            displayName: resolved.account.displayName,
            identity: resolved.account.identity.toHexString(),
            agentId: resolved.account.agentId ?? null,
          }
        : resolved.identity.toHexString(),
      conversationId: receipt.conversationId.toString(),
      receipt: receiptPayload,
    };
  }

  private shouldHydrate(payload: Record<string, unknown>) {
    return payload.hydrate !== false && payload.hydrate !== 'false';
  }

  private deliveryMessageKey(delivery: ModuleTypes.ConversationDelivery) {
    return `${delivery.conversationId.toString()}:${delivery.messageId.toString()}:${delivery.sequence.toString()}`;
  }

  private async hydrateDeliveryMessages(deliveries: ModuleTypes.ConversationDelivery[]) {
    const hydrated = new Map<string, ReturnType<typeof conversationMessageDto>>();
    const byConversation = new Map<string, ModuleTypes.ConversationDelivery[]>();
    for (const delivery of deliveries) {
      const key = delivery.conversationId.toString();
      const rows = byConversation.get(key) ?? [];
      rows.push(delivery);
      byConversation.set(key, rows);
    }

    for (const rows of byConversation.values()) {
      const conversationId = rows[0].conversationId;
      const minSequence = rows.reduce(
        (min, row) => (row.sequence < min ? row.sequence : min),
        rows[0].sequence
      );
      const maxSequence = rows.reduce(
        (max, row) => (row.sequence > max ? row.sequence : max),
        rows[0].sequence
      );
      const span = Number(maxSequence - minSequence + 1n);
      const limit = BigInt(Math.min(Math.max(span, rows.length, 1), 100));
      await this.client.requestConversationMessages({
        conversationId,
        afterSequence: minSequence > 0n ? minSequence - 1n : undefined,
        limit,
      });
      const requested = await this.client.waitForRequestedConversationMessages({
        conversationId,
        minSequence,
        maxSequence,
        timeoutMs: 2500,
      });
      for (const delivery of rows) {
        const message = requested.find(
          row =>
            row.id === delivery.messageId ||
            (row.sequence ?? row.id) === delivery.sequence
        );
        if (message) {
          hydrated.set(this.deliveryMessageKey(delivery), conversationMessageDto(message));
        }
      }
    }

    return hydrated;
  }

  private async hydrateDeliveryMessage(delivery: ModuleTypes.ConversationDelivery) {
    const messages = await this.hydrateDeliveryMessages([delivery]);
    return messages.get(this.deliveryMessageKey(delivery)) ?? null;
  }

  private async requestedConversationMessagesAfter(
    conversationId: bigint,
    afterSequence: bigint | undefined,
    limit: number
  ) {
    const requestLimit = Math.min(Math.max(limit, 10), 100);
    await this.client.requestConversationMessages({
      conversationId,
      afterSequence,
      limit: BigInt(requestLimit),
    });
    await sleep(150);
    return this.client
      .listRequestedConversationMessages(conversationId)
      .filter(row => (afterSequence !== undefined ? row.sequence > afterSequence : true))
      .sort((left, right) =>
        left.sequence < right.sequence ? -1 : left.sequence > right.sequence ? 1 : 0
      );
  }

  private async requestedInboxDeliveriesAfter(
    conversationId: bigint | undefined,
    afterSequence: bigint | undefined,
    limit: number
  ) {
    const requestLimit = Math.min(Math.max(limit, 10), 100);
    await this.client.requestInboxDeliveries({
      conversationId,
      afterSequence,
      limit: BigInt(requestLimit),
    });
    await sleep(150);

    const byKey = new Map<string, ModuleTypes.ConversationDelivery>();
    for (const delivery of [
      ...this.client.listRequestedInboxDeliveries({ conversationId }),
      ...this.client.listInboxDeliveries({ conversationId }),
    ]) {
      if (afterSequence !== undefined && delivery.sequence <= afterSequence) {
        continue;
      }
      byKey.set(this.deliveryMessageKey(delivery), delivery);
    }

    return Array.from(byKey.values())
      .sort((left, right) =>
        left.sequence < right.sequence ? -1 : left.sequence > right.sequence ? 1 : 0
      )
      .slice(0, limit);
  }

  private async wakeSnapshot(
    client: AgentRealtimeClient,
    payload: Record<string, unknown> = {}
  ) {
    const status = payloadString(payload, ['status']);
    const conversationId = payloadBigInt(payload, ['conversationId', 'conversation_id']);
    const includeDispatcher = payloadBoolean(payload, ['includeDispatcher', 'dispatcher'], true);
    const wakeId = payloadString(payload, ['wakeId', 'wake_id']);
    const requests = client
      .listWakeRequests({
        status,
        conversationId,
        includeDispatcher,
      })
      .filter(row => (wakeId ? row.wakeId === wakeId : true))
      .sort(sortWakeRequestsDesc);
    const attempts = client
      .listWakeAttempts(wakeId)
      .filter(row => (wakeId ? row.wakeId === wakeId : true))
      .map(wakeAttemptDto);

    return {
      identity: client.identityHex,
      profile: client.currentAgentWakeProfile()
        ? wakeProfileDto(client.currentAgentWakeProfile()!)
        : null,
      registrations: client
        .listWakeRegistrations()
        .map(row => wakeRegistrationDto(row, payloadBoolean(payload, ['showPrivate'], false))),
      policy: client.currentWakePolicy() ? wakePolicyDto(client.currentWakePolicy()!) : null,
      requests: requests.map(wakeRequestDto),
      attempts,
      deploymentPolicy:
        client.listDeploymentWakePolicies()[0]
          ? deploymentWakePolicyDto(client.listDeploymentWakePolicies()[0])
          : null,
    };
  }

  private async wakeContext(client: AgentRealtimeClient, wake: ModuleTypes.WakeRequestView) {
    const span = Number(wake.maxSequence - wake.minSequence + 1n);
    const limit = BigInt(Math.min(Math.max(span, 1), 50));
    await client.requestConversationMessages({
      conversationId: wake.conversationId,
      afterSequence: wake.minSequence > 0n ? wake.minSequence - 1n : undefined,
      limit,
    });
    await sleep(250);
    return client
      .listRequestedConversationMessages(wake.conversationId)
      .filter(row => row.sequence >= wake.minSequence && row.sequence <= wake.maxSequence)
      .map(conversationMessageDto);
  }

  async handle(payload: Record<string, unknown>): Promise<AgenttalkdResponse> {
    const id = String(payload.id ?? '');
    const cmd = String(payload.cmd ?? payload.command ?? '');
    const retriedAfterReconnect = payload.__retriedAfterReconnect === true;
    this.commandCount += 1;

    try {
      if (!cmd) {
        throw new Error('Missing cmd');
      }

      if (cmd === 'open_direct') {
        requestIdFromPayload(payload, 'open_direct_conversation', id);
      } else if (cmd === 'send_conversation') {
        requestIdFromPayload(payload, 'send_conversation_message', id);
      } else if (cmd === 'send_direct') {
        requestIdFromPayload(payload, 'send_direct_message', id);
      }

      if (cmd !== 'ping' && cmd !== 'stats' && cmd !== 'shutdown') {
        await this.ensureConnected(`command ${cmd}`);
      }

      if (cmd === 'ping') {
        return {
          id,
          ok: true,
          data: {
            pong: true,
            uptimeMs: Date.now() - this.startedAt,
            connected: this.client.connected,
            reconnecting: Boolean(this.reconnectPromise),
          },
        };
      }

      if (cmd === 'whoami') {
        const profile = this.client.currentAgentProfile();
        const retention = this.client.listRetentionPolicies()[0];
        const deploymentPolicy = this.client.listDeploymentPolicies()[0];
        const account = await this.currentAccountWithRefresh();
        return {
          id,
          ok: true,
          data: {
            identity: this.client.identityHex,
            agentId: profile?.agentId ?? null,
            handle: profile?.handle ?? null,
            account: account ? accountDto(account) : null,
            host: this.state.host,
            databaseName: this.state.databaseName,
            hotRetentionHours: Number(retention?.hotRetentionHours ?? 12n),
            archiveConfigured: retention?.archiveConfigured ?? false,
            deploymentPolicy: deploymentPolicy
              ? deploymentPolicyDto(deploymentPolicy)
              : null,
            needsInit: this.needsInit,
          },
        };
      }

      if (cmd === 'wake_status' || cmd === 'list_wake') {
        return await this.withProfile('wake', async client => {
          await sleep(150);
          return {
            id,
            ok: true,
            data: await this.wakeSnapshot(client, payload),
          };
        });
      }

      if (cmd === 'register_wake') {
        return await this.withProfile('wake', async client => {
          await client.registerWake({
            kind: String(payload.kind ?? 'local_daemon') as any,
            endpointRef: payloadString(payload, ['endpointRef', 'endpoint_ref']),
            secretHash: payloadString(payload, ['secretHash', 'secret_hash']),
            enabled: payloadBoolean(payload, ['enabled'], true),
            metadataJson: payloadString(payload, ['metadataJson', 'metadata_json']),
            agentId: payloadString(payload, ['agentId', 'agent_id']),
            registrationId: payloadString(payload, ['registrationId', 'registration_id']),
          });
          await sleep(250);
          return {
            id,
            ok: true,
            data: await this.wakeSnapshot(client, { ...payload, showPrivate: true }),
          };
        });
      }

      if (cmd === 'disable_wake_registration') {
        return await this.withProfile('wake', async client => {
          await client.disableWakeRegistration({
            registrationId: payloadString(payload, ['registrationId', 'registration_id']),
            kind: payloadString(payload, ['kind']) as any,
            agentId: payloadString(payload, ['agentId', 'agent_id']),
          });
          await sleep(250);
          return {
            id,
            ok: true,
            data: await this.wakeSnapshot(client, { ...payload, showPrivate: true }),
          };
        });
      }

      if (cmd === 'set_wake_policy') {
        return await this.withProfile('wake', async client => {
          await client.setWakePolicy({
            agentId: payloadString(payload, ['agentId', 'agent_id']),
            wakeOnDirectMessage: payloadBoolean(payload, ['wakeOnDirectMessage', 'direct']),
            wakeOnMention: payloadBoolean(payload, ['wakeOnMention', 'mention']),
            wakeOnGroupMessage: payloadBoolean(payload, ['wakeOnGroupMessage', 'group']),
            wakeOnHandoff: payloadBoolean(payload, ['wakeOnHandoff', 'handoff']),
            wakeOnBusinessInquiry: payloadBoolean(payload, [
              'wakeOnBusinessInquiry',
              'business',
            ]),
            acceptsNewConversations: payloadBoolean(payload, [
              'acceptsNewConversations',
              'accepts_new_conversations',
            ]),
            minWakeIntervalMs: payloadBigInt(payload, ['minWakeIntervalMs', 'min_interval_ms']),
            coalesceWindowMs: payloadBigInt(payload, ['coalesceWindowMs', 'coalesce_ms']),
            maxWakesPerMinute: payloadBigInt(payload, ['maxWakesPerMinute', 'max_per_minute']),
            maxConcurrentWakeJobs: payloadBigInt(payload, [
              'maxConcurrentWakeJobs',
              'max_concurrent',
            ]),
            expectedWakeLatencyMs: payloadBigInt(payload, [
              'expectedWakeLatencyMs',
              'latency_ms',
            ]),
            availabilityOverride: payloadString(payload, [
              'availabilityOverride',
              'availability',
            ]) as any,
            statusText: payloadString(payload, ['statusText', 'status_text']),
            allowedWakeSenderAgentIdsJson: payloadString(payload, [
              'allowedWakeSenderAgentIdsJson',
              'allowed_senders_json',
            ]),
            blockedWakeSenderAgentIdsJson: payloadString(payload, [
              'blockedWakeSenderAgentIdsJson',
              'blocked_senders_json',
            ]),
          });
          await sleep(250);
          return {
            id,
            ok: true,
            data: await this.wakeSnapshot(client, payload),
          };
        });
      }

      if (cmd === 'reset_wake_policy') {
        return await this.withProfile('wake', async client => {
          await client.resetWakePolicy(payloadString(payload, ['agentId', 'agent_id']));
          await sleep(250);
          return {
            id,
            ok: true,
            data: await this.wakeSnapshot(client, payload),
          };
        });
      }

      if (cmd === 'claim_wake') {
        return await this.withProfile('wake', async client => {
          const wakeId = payloadString(payload, ['wakeId', 'wake_id']);
          await client.claimWakeRequest({
            wakeId,
            leaseMs: payloadBigInt(payload, ['leaseMs', 'lease_ms']),
            registrationId: payloadString(payload, ['registrationId', 'registration_id']),
            metadataJson: payloadString(payload, ['metadataJson', 'metadata_json']),
          });
          await sleep(250);
          return {
            id,
            ok: true,
            data: await this.wakeSnapshot(client, {
              ...payload,
              wakeId,
              status: payloadString(payload, ['status'], 'leased'),
            }),
          };
        });
      }

      if (cmd === 'wait_wake') {
        return await this.withProfile('wake', async client => {
          const timeoutMs = payloadNumber(payload, ['timeoutMs', 'timeout_ms'], 30000, 300000);
          const status = payloadString(payload, ['status'], 'pending');
          const conversationId = payloadBigInt(payload, ['conversationId', 'conversation_id']);
          let wake =
            client
              .listWakeRequests({ status, conversationId, includeDispatcher: true })
              .sort(sortWakeRequestsDesc)[0] ??
            (await client.waitForWakeRequest({
              status,
              conversationId,
              timeoutMs,
            }));

          if (payloadBoolean(payload, ['claim'], true)) {
            await client.claimWakeRequest({
              wakeId: wake.wakeId,
              leaseMs: payloadBigInt(payload, ['leaseMs', 'lease_ms']),
              registrationId: payloadString(payload, ['registrationId', 'registration_id']),
              metadataJson: payloadString(payload, ['metadataJson', 'metadata_json']),
            });
            await sleep(250);
            wake =
              client
                .listWakeRequests({
                  includeDispatcher: true,
                })
                .find(row => row.wakeId === wake.wakeId) ?? wake;
          }

          const context = payloadBoolean(payload, ['context', 'hydrate'], false)
            ? await this.wakeContext(client, wake)
            : null;
          return {
            id,
            ok: true,
            data: {
              wake: wakeRequestDto(wake),
              attempts: client.listWakeAttempts(wake.wakeId).map(wakeAttemptDto),
              context,
            },
          };
        });
      }

      if (cmd === 'mark_wake_dispatched') {
        return await this.withProfile('wake', async client => {
          const wakeId = payloadString(payload, ['wakeId', 'wake_id']);
          if (!wakeId) {
            throw new Error('mark_wake_dispatched requires wakeId');
          }
          await client.markWakeDispatched(
            wakeId,
            payloadString(payload, ['attemptId', 'attempt_id']),
            payloadString(payload, ['metadataJson', 'metadata_json'])
          );
          await sleep(250);
          return {
            id,
            ok: true,
            data: await this.wakeSnapshot(client, { ...payload, wakeId }),
          };
        });
      }

      if (cmd === 'ack_wake') {
        return await this.withProfile('wake', async client => {
          const wakeId = payloadString(payload, ['wakeId', 'wake_id']);
          if (!wakeId) {
            throw new Error('ack_wake requires wakeId');
          }
          await client.ackWakeRequest(
            wakeId,
            payloadString(payload, ['attemptId', 'attempt_id']),
            payloadString(payload, ['metadataJson', 'metadata_json'])
          );
          await sleep(250);
          return {
            id,
            ok: true,
            data: await this.wakeSnapshot(client, { ...payload, wakeId }),
          };
        });
      }

      if (cmd === 'fail_wake') {
        return await this.withProfile('wake', async client => {
          const wakeId = payloadString(payload, ['wakeId', 'wake_id']);
          if (!wakeId) {
            throw new Error('fail_wake requires wakeId');
          }
          await client.failWakeRequest(wakeId, String(payload.error ?? 'wake failed'), {
            attemptId: payloadString(payload, ['attemptId', 'attempt_id']),
            retryAfterMs: payloadBigInt(payload, ['retryAfterMs', 'retry_after_ms']),
            metadataJson: payloadString(payload, ['metadataJson', 'metadata_json']),
          });
          await sleep(250);
          return {
            id,
            ok: true,
            data: await this.wakeSnapshot(client, { ...payload, wakeId }),
          };
        });
      }

      if (cmd === 'expire_wake_requests') {
        return await this.withProfile('wake', async client => {
          await client.expireWakeRequests(payloadBigInt(payload, ['limit']));
          await sleep(250);
          return {
            id,
            ok: true,
            data: await this.wakeSnapshot(client, payload),
          };
        });
      }

      if (cmd === 'init_account' || cmd === 'create_account') {
        const handle = String(payload.handle ?? '').trim();
        if (!handle) {
          throw new Error(`${cmd} requires handle`);
        }

        const role = payload.role === 'human' ? 'human' : 'agent';
        const displayName = String(payload.displayName ?? payload.display_name ?? handle);
        const bio = String(payload.bio ?? '');
        const normalizedHandle = normalizeAccountRef(handle);
        await this.client.requestAccountDirectory({ handle: normalizedHandle, limit: 1n });
        await sleep(250);
        const existingByIdentity = this.currentAccount();
        const existingByHandle = this.client.searchAccounts({ handle: normalizedHandle })[0];

        if (
          existingByHandle &&
          existingByHandle.identity.toHexString() !== this.client.identityHex
        ) {
          throw new Error(`Account handle is already owned by another identity: ${normalizedHandle}`);
        }

        if (existingByIdentity && existingByIdentity.handle !== normalizedHandle) {
          throw new Error(
            `This state already owns @${existingByIdentity.handle}; use a different AGENTTALK_STATE_DIR for @${normalizedHandle}`
          );
        }

        if (!existingByHandle) {
          await this.client.createAccount({
            handle: normalizedHandle,
            displayName,
            role,
            bio,
          });
          await this.client.requestAccountDirectory({ handle: normalizedHandle, limit: 1n });
          await sleep(250);
        }

        const account =
          this.client.searchAccounts({ handle: normalizedHandle })[0] ??
          existingByIdentity ??
          null;
        this.needsInit = false;
        this.lastConnectionError = undefined;
        return {
          id,
          ok: true,
          data: {
            identity: this.client.identityHex,
            account: account ? accountDto(account) : null,
            agentId: account?.agentId ?? null,
            host: this.state.host,
            databaseName: this.state.databaseName,
          },
        };
      }

      if (cmd === 'find' || cmd === 'account_search') {
        const query = String(payload.query ?? payload.q ?? payload.handle ?? '').trim();
        const handle =
          typeof payload.handle === 'string' ? normalizeAccountRef(payload.handle) : undefined;
        const role =
          payload.role === 'agent' || payload.role === 'human' ? payload.role : undefined;
        const online = typeof payload.online === 'boolean' ? payload.online : undefined;
        const limit = BigInt(Math.min(Number(payload.limit ?? 20), 50));

        let rows: ModuleTypes.Account[] = [];
        const normalized = handle ?? (query ? maybeAccountHandle(query) : undefined);
        if (normalized) {
          await this.client.requestAccountDirectory({ handle: normalized, role, online, limit });
          await sleep(250);
          rows = this.client.searchAccounts({ handle: normalized, role, online });
        }
        if (rows.length === 0) {
          await this.client.requestAccountDirectory({
            query: query || undefined,
            role,
            online,
            limit,
          });
          await sleep(250);
          rows = this.client.searchAccounts({
            query: query || undefined,
            handle,
            role,
            online,
          });
        }

        return {
          id,
          ok: true,
          data: {
            accounts: rows.map(accountDto),
          },
        };
      }

      if (cmd === 'account_entitlements') {
        return this.withProfile('account-admin', async client => ({
          id,
          ok: true,
          data: {
            entitlements: client.listAccountEntitlements().map(accountEntitlementDto),
            current: client.currentAccountEntitlement()
              ? accountEntitlementDto(client.currentAccountEntitlement()!)
              : null,
          },
        }));
      }

      if (cmd === 'bootstrap_operator_account') {
        return this.withProfile('account-admin', async client => {
          await client.bootstrapOperatorAccount();
          await sleep(250);
          return {
            id,
            ok: true,
            data: {
              identity: client.identityHex,
              entitlement: client.currentAccountEntitlement()
                ? accountEntitlementDto(client.currentAccountEntitlement()!)
                : null,
            },
          };
        });
      }

      if (cmd === 'set_account_type') {
        const handle = String(payload.handle ?? '').trim();
        const accountType = String(payload.accountType ?? payload.account_type ?? payload.type ?? '');
        if (!handle || !accountType) {
          throw new Error('set_account_type requires handle and account_type');
        }
        if (!['free', 'group', 'pro', 'operator'].includes(accountType)) {
          throw new Error('account_type must be free, group, pro, or operator');
        }
        const groupChatAllowed =
          typeof payload.groupChatAllowed === 'boolean'
            ? payload.groupChatAllowed
            : typeof payload.group_chat_allowed === 'boolean'
              ? payload.group_chat_allowed
              : accountType === 'group' || accountType === 'pro' || accountType === 'operator';
        return this.withProfile('account-admin', async client => {
          await client.setAccountType({
            handle: normalizeAccountRef(handle),
            accountType: accountType as 'free' | 'group' | 'pro' | 'operator',
            groupChatAllowed,
          });
          await sleep(250);
          const entitlement = client
            .listAccountEntitlements()
            .find(row => row.handle === normalizeAccountRef(handle));
          return {
            id,
            ok: true,
            data: {
              entitlement: entitlement ? accountEntitlementDto(entitlement) : null,
            },
          };
        });
      }

      if (cmd === 'resolve_account') {
        const handle = String(payload.handle ?? payload.target ?? '').trim();
        if (!handle) {
          throw new Error('resolve_account requires handle');
        }
        const resolved = await this.resolveAccount(handle);
        return {
          id,
          ok: true,
          data: {
            identity: resolved.identity.toHexString(),
            account: resolved.account
              ? {
                  handle: resolved.account.handle,
                  displayName: resolved.account.displayName,
                  role: resolved.account.role,
                  agentId: resolved.account.agentId ?? null,
                }
              : null,
          },
        };
      }

      if (cmd === 'conversation_list') {
        const limit = BigInt(Math.min(Number(payload.limit ?? 50), 100));
        await this.client.requestConversations({
          kind:
            payload.kind === 'direct' || payload.kind === 'group'
              ? payload.kind
              : undefined,
          limit,
        });
        await sleep(150);
        const conversations = this.client.listConversations();
        for (const conversation of conversations) {
          await this.client.requestConversationMembers(conversation.id);
        }
        await sleep(100);
        return {
          id,
          ok: true,
          data: {
            conversations: conversations.map(row => ({
              ...conversationDto(row),
              memberCount: this.client.listConversationMembers(row.id).length,
            })),
          },
        };
      }

      if (cmd === 'create_direct') {
        const target = String(payload.target ?? payload.to ?? '').trim();
        if (!target) {
          throw new Error('create_direct requires target');
        }
        const title = typeof payload.title === 'string' ? payload.title : '';
        const openingMessage =
          typeof payload.openingMessage === 'string'
            ? payload.openingMessage
            : typeof payload.message === 'string'
              ? payload.message
              : '';
        const resolved = await this.resolveAccount(target);
        const requestId = await this.client.createDirectConversation(
          resolved.identity,
          title,
          openingMessage,
          typeof payload.clientRequestId === 'string' ? payload.clientRequestId : undefined
        );
        const receipt = await this.client.waitForReceipt(
          requestId,
          5000,
          'create_direct_conversation'
        );
        if (!receipt.conversationId) {
          throw new Error('create_direct_conversation receipt did not include conversationId');
        }
        await this.client.requestConversations({ limit: 10n });
        await this.client.requestConversationMembers(receipt.conversationId);
        await sleep(150);
        const conversation = this.client
          .listConversations()
          .find(row => row.id === receipt.conversationId);
        return {
          id,
          ok: true,
          data: {
            conversationId: receipt.conversationId.toString(),
            conversation: conversation ? conversationDto(conversation) : null,
            members: this.client
              .listConversationMembers(receipt.conversationId)
              .map(conversationMemberDto),
            receipt: this.rememberReceipt(receipt),
          },
        };
      }

      if (cmd === 'create_group') {
        const title = String(payload.title ?? '').trim();
        if (!title) {
          throw new Error('create_group requires title');
        }
        const rawMembers = payload.members ?? payload.with;
        const refs = Array.isArray(rawMembers)
          ? rawMembers.map(String)
          : typeof rawMembers === 'string'
            ? rawMembers.split(',').map(value => value.trim()).filter(Boolean)
            : [];
        if (refs.length === 0) {
          throw new Error('create_group requires members');
        }
        const memberIdentities = [];
        for (const ref of refs) {
          memberIdentities.push((await this.resolveAccount(ref)).identity);
        }
        const requestId = await this.client.createGroupConversation(
          title,
          memberIdentities,
          '',
          typeof payload.clientRequestId === 'string' ? payload.clientRequestId : undefined
        );
        const receipt = await this.client.waitForReceipt(
          requestId,
          5000,
          'create_group_conversation'
        );
        if (!receipt.conversationId) {
          throw new Error('create_group_conversation receipt did not include conversationId');
        }
        await this.client.requestConversations({ limit: 10n });
        await this.client.requestConversationMembers(receipt.conversationId);
        await sleep(150);
        const conversation = this.client
          .listConversations()
          .find(row => row.id === receipt.conversationId);
        let messageReceipt: ReturnType<typeof receiptDto> | null = null;
        const message = typeof payload.message === 'string' ? payload.message : '';
        if (message) {
          const sendRequestId = await this.client.sendConversationMessage(
            receipt.conversationId,
            message,
            {
              kind: typeof payload.kind === 'string' ? (payload.kind as RichKind) : undefined,
              clientRequestId:
                typeof payload.messageClientRequestId === 'string'
                  ? payload.messageClientRequestId
                  : undefined,
            }
          );
          messageReceipt = this.rememberReceipt(
            await this.client.waitForReceipt(
              sendRequestId,
              5000,
              'send_conversation_message'
            )
          );
        }
        return {
          id,
          ok: true,
          data: {
            conversationId: receipt.conversationId.toString(),
            conversation: conversation ? conversationDto(conversation) : null,
            members: this.client
              .listConversationMembers(receipt.conversationId)
              .map(conversationMemberDto),
            receipt: this.rememberReceipt(receipt),
            messageReceipt,
          },
        };
      }

      if (cmd === 'add_conversation_member') {
        const conversationId = BigInt(String(payload.conversationId ?? payload.conversation_id));
        const memberRef = String(payload.member ?? payload.account ?? payload.target ?? '').trim();
        if (!memberRef) {
          throw new Error('add_conversation_member requires member');
        }
        const role =
          payload.role === 'mod' || payload.role === 'member' ? payload.role : 'member';
        const memberIdentity = (await this.resolveAccount(memberRef)).identity;
        await this.client.addConversationMember(conversationId, memberIdentity, role);
        await this.client.requestConversationMembers(conversationId);
        await sleep(250);
        return {
          id,
          ok: true,
          data: {
            conversationId: conversationId.toString(),
            memberIdentity: memberIdentity.toHexString(),
            role,
            members: this.client
              .listConversationMembers(conversationId)
              .map(conversationMemberDto),
          },
        };
      }

      if (cmd === 'open_direct') {
        const target = String(payload.target ?? '').trim();
        if (!target) {
          throw new Error('open_direct requires target');
        }
        return {
          id,
          ok: true,
          data: await this.openDirect(
            target,
            typeof payload.clientRequestId === 'string' ? payload.clientRequestId : undefined
          ),
        };
      }

      if (cmd === 'send_conversation') {
        const conversationId = BigInt(String(payload.conversationId ?? payload.conversation_id));
        const text = String(payload.text ?? payload.message ?? '').trim();
        if (!text) {
          throw new Error('send_conversation requires text');
        }
        const requestId = await this.client.sendConversationMessage(conversationId, text, {
          kind: typeof payload.kind === 'string' ? (payload.kind as RichKind) : undefined,
          clientRequestId:
            typeof payload.clientRequestId === 'string'
              ? payload.clientRequestId
              : typeof payload.client_request_id === 'string'
                ? payload.client_request_id
                : undefined,
        });
        const receipt = await this.client.waitForReceipt(
          requestId,
          5000,
          'send_conversation_message'
        );
        return { id, ok: true, data: { receipt: this.rememberReceipt(receipt) } };
      }

      if (cmd === 'send_direct') {
        const target = String(payload.target ?? '').trim();
        const text = String(payload.text ?? payload.message ?? '').trim();
        if (!target || !text) {
          throw new Error('send_direct requires target and text');
        }
        const targetKey = this.accountCacheKey(target);
        const cachedConversationId = this.directCache.get(targetKey) ?? this.directCache.get(target);
        const resolved = await this.resolveAccount(target);
        const requestId = await this.client.sendDirectMessage({
          targetIdentity: resolved.identity,
          text,
          kind: typeof payload.kind === 'string' ? (payload.kind as RichKind) : undefined,
          correlationId:
            typeof payload.correlationId === 'string'
              ? payload.correlationId
              : typeof payload.correlation_id === 'string'
                ? payload.correlation_id
                : undefined,
          metadataJson:
            typeof payload.metadataJson === 'string'
              ? payload.metadataJson
              : typeof payload.metadata_json === 'string'
                ? payload.metadata_json
                : undefined,
          clientRequestId:
            typeof payload.clientRequestId === 'string'
              ? payload.clientRequestId
              : typeof payload.client_request_id === 'string'
                ? payload.client_request_id
                : undefined,
        });
        const receipt = await this.client.waitForReceipt(
          requestId,
          5000,
          'send_direct_message'
        );
        if (receipt.conversationId) {
          this.directCache.set(targetKey, receipt.conversationId);
          this.directCache.set(target, receipt.conversationId);
          this.directCache.set(resolved.identity.toHexString(), receipt.conversationId);
        }
        return {
          id,
          ok: true,
          data: {
            reused: Boolean(cachedConversationId),
            receipt: this.rememberReceipt(receipt),
          },
        };
      }

      if (cmd === 'inbox') {
        const limit = Math.min(Number(payload.limit ?? payload.max ?? 10), 250);
        const conversationId =
          payload.conversationId !== undefined || payload.conversation_id !== undefined
            ? BigInt(String(payload.conversationId ?? payload.conversation_id))
            : undefined;
        const afterSequence =
          payload.afterSequence !== undefined || payload.after_sequence !== undefined
            ? BigInt(String(payload.afterSequence ?? payload.after_sequence))
            : undefined;
        await this.client.requestInboxDeliveries({
          conversationId,
          state: payload.state as 'unread' | 'delivered' | 'read' | undefined,
          afterSequence,
          limit: BigInt(limit),
        });
        await sleep(150);
        const requested = this.client.listRequestedInboxDeliveries({
          conversationId,
          state: payload.state as 'unread' | 'delivered' | 'read' | undefined,
        });
        const live = this.client.listInboxDeliveries({
            conversationId,
            state: payload.state as 'unread' | 'delivered' | 'read' | undefined,
          });
        const byKey = new Map<string, ModuleTypes.ConversationDelivery>();
        for (const delivery of [...requested, ...live]) {
          if (afterSequence !== undefined && delivery.sequence <= afterSequence) {
            continue;
          }
          byKey.set(this.deliveryMessageKey(delivery), delivery);
        }
        const deliveries = Array.from(byKey.values()).slice(0, limit);
        const hydrate = this.shouldHydrate(payload);
        const hydratedMessages = hydrate
          ? await this.hydrateDeliveryMessages(deliveries)
          : new Map<string, ReturnType<typeof conversationMessageDto>>();
        const items = [];
        for (const delivery of deliveries) {
          this.rememberConversationSequence(delivery.conversationId, delivery.sequence);
          items.push({
            delivery: deliveryDto(delivery),
            message: hydratedMessages.get(this.deliveryMessageKey(delivery)) ?? null,
          });
        }
        return {
          id,
          ok: true,
          data: {
            deliveries: deliveries.map(deliveryDto),
            items,
          },
        };
      }

      if (cmd === 'history') {
        const conversationId = BigInt(String(payload.conversationId ?? payload.conversation_id));
        const afterSequence =
          payload.afterSequence !== undefined || payload.after_sequence !== undefined
            ? BigInt(String(payload.afterSequence ?? payload.after_sequence))
            : undefined;
        const beforeSequence =
          payload.beforeSequence !== undefined || payload.before_sequence !== undefined
            ? BigInt(String(payload.beforeSequence ?? payload.before_sequence))
            : undefined;
        const requestedAfterSequence = afterSequence ?? (beforeSequence ? undefined : 0n);
        const limit = BigInt(Math.min(Number(payload.limit ?? 50), 100));
        await this.client.requestConversationMessages({
          conversationId,
          afterSequence: requestedAfterSequence,
          beforeSequence,
          limit,
        });
        await sleep(150);
        const messages = this.client.listRequestedConversationMessages(conversationId);
        for (const message of messages) {
          this.rememberConversationSequence(message.conversationId, message.sequence);
        }
        return {
          id,
          ok: true,
          data: {
            messages: messages.map(conversationMessageDto),
          },
        };
      }

      if (cmd === 'listen_once') {
        const conversationId =
          payload.conversationId !== undefined || payload.conversation_id !== undefined
            ? BigInt(String(payload.conversationId ?? payload.conversation_id))
            : undefined;
        const afterSequence =
          payload.afterSequence !== undefined || payload.after_sequence !== undefined
            ? BigInt(String(payload.afterSequence ?? payload.after_sequence))
            : undefined;
        const timeoutMs = payloadNumber(
          payload,
          ['timeoutMs', 'timeout_ms'],
          30000,
          15 * 60 * 1000
        );
        const limit = payloadNumber(payload, ['max', 'limit'], 1, 100);

        const snapshotDeliveries = await this.requestedInboxDeliveriesAfter(
          conversationId,
          afterSequence,
          limit
        );
        if (snapshotDeliveries.length > 0) {
          const hydratedMessages = this.shouldHydrate(payload)
            ? await this.hydrateDeliveryMessages(snapshotDeliveries)
            : new Map<string, ReturnType<typeof conversationMessageDto>>();
          const messages = snapshotDeliveries
            .map(delivery => hydratedMessages.get(this.deliveryMessageKey(delivery)) ?? null)
            .filter((message): message is ReturnType<typeof conversationMessageDto> =>
              Boolean(message)
            );
          const readThrough = snapshotDeliveries.reduce(
            (max, row) => (row.sequence > max ? row.sequence : max),
            snapshotDeliveries[0].sequence
          );
          await this.client.markConversationRead(snapshotDeliveries[0].conversationId, readThrough);
          for (const delivery of snapshotDeliveries) {
            this.rememberConversationSequence(delivery.conversationId, delivery.sequence);
          }
          return {
            id,
            ok: true,
            data: {
              source: 'snapshot_delivery',
              delivery: deliveryDto(snapshotDeliveries[0]),
              deliveries: snapshotDeliveries.map(deliveryDto),
              message: messages[0] ?? null,
              messages,
            },
          };
        }

        if (conversationId) {
          const snapshot = (await this.requestedConversationMessagesAfter(
            conversationId,
            afterSequence,
            limit
          ))
            .filter(row => row.authorIdentity.toHexString() !== this.client.identityHex)
            .slice(0, limit);
          if (snapshot.length > 0) {
            const readThrough = snapshot.reduce(
              (max, row) => (row.sequence > max ? row.sequence : max),
              snapshot[0].sequence
            );
            await this.client.markConversationRead(conversationId, readThrough);
            for (const message of snapshot) {
              this.rememberConversationSequence(message.conversationId, message.sequence);
            }
            const messages = snapshot.map(conversationMessageDto);
            return {
              id,
              ok: true,
              data: {
                source: 'snapshot',
                delivery: null,
                message: messages[0] ?? null,
                messages,
              },
            };
          }
        }

        const delivery = await this.client.waitForInboxDelivery({
          conversationId,
          afterSequence,
          timeoutMs,
        });
        const message = this.shouldHydrate(payload)
          ? await this.hydrateDeliveryMessage(delivery)
          : null;
        if (message) {
          await this.client.markConversationRead(delivery.conversationId, delivery.sequence);
        }
        this.rememberConversationSequence(delivery.conversationId, delivery.sequence);
        return {
          id,
          ok: true,
          data: {
            source: 'delivery',
            delivery: deliveryDto(delivery),
            message,
            messages: message ? [message] : [],
          },
        };
      }

      if (cmd === 'mark_read') {
        const conversationId = BigInt(String(payload.conversationId ?? payload.conversation_id));
        const sequence =
          payload.sequence !== undefined ? BigInt(String(payload.sequence)) : undefined;
        await this.client.markConversationRead(conversationId, sequence);
        return {
          id,
          ok: true,
          data: {
            conversationId: conversationId.toString(),
            sequence: sequence?.toString() ?? null,
          },
        };
      }

      if (cmd === 'stats') {
        return {
          id,
          ok: true,
          data: {
            uptimeMs: Date.now() - this.startedAt,
            commands: this.commandCount,
            connected: this.client.connected,
            reconnecting: Boolean(this.reconnectPromise),
            reconnectCount: this.reconnectCount,
            lastReconnectAt: this.lastReconnectAt
              ? new Date(this.lastReconnectAt).toISOString()
              : null,
            lastReconnectReason: this.lastReconnectReason ?? null,
            lastConnectionError: this.lastConnectionError ?? null,
            directCacheSize: this.directCache.size,
            cachedHandles: this.handleCache.size,
            cachedReceipts: this.receiptCache.size,
            cachedConversationSequences: this.conversationSequenceCache.size,
            clientCache: this.client.cacheStats(),
            needsInit: this.needsInit,
            inboxDeliveryCount: this.client.connected
              ? this.client.listInboxDeliveries().length
              : 0,
            requestedInboxDeliveryCount: this.client.connected
              ? this.client.listRequestedInboxDeliveries().length
              : 0,
            requestedConversationCount: this.client.connected
              ? this.client.listConversations().length
              : 0,
            receiptCount: this.client.connected
              ? this.client.listClientRequestReceipts().length
              : 0,
            connectionIdentity: this.client.identityHex,
            agentId: this.client.currentAgentProfile()?.agentId ?? null,
            profile: this.profile,
          },
        };
      }

      if (cmd === 'shutdown') {
        this.shuttingDown = true;
        return { id, ok: true, data: { shuttingDown: true } };
      }

      throw new Error(`Unknown daemon command: ${cmd}`);
    } catch (error) {
      if (!retriedAfterReconnect && !this.shuttingDown && this.isReconnectableError(error)) {
        const reason = coerceErrorText(error);
        try {
          await this.reconnect(`command ${cmd} failed: ${reason}`);
          return this.handle({ ...payload, __retriedAfterReconnect: true });
        } catch (reconnectError) {
          return {
            id,
            ok: false,
            error: coerceErrorText(reconnectError),
            reason,
            retryAfterMs: RECONNECT_MAX_MS,
          };
        }
      }
      return {
        id,
        ok: false,
        error: coerceErrorText(error),
      };
    }
  }
}

type RichKind =
  | 'chat'
  | 'task'
  | 'handoff'
  | 'tool_result'
  | 'approval_request'
  | 'status'
  | 'system';

async function serveLineInterface(
  daemon: AgenttalkDaemon,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  requireAuth = false
) {
  const rl = readline.createInterface({ input });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(trimmed) as Record<string, unknown>;
    } catch (error) {
      writeJsonLine(output, {
        id: '',
        ok: false,
        transport: 'daemon',
        daemon: true,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    if (requireAuth && !daemon.acceptsIpcSecret(payload.ipcSecret)) {
      writeJsonLine(output, {
        id: typeof payload.id === 'string' ? payload.id : '',
        ok: false,
        transport: 'daemon',
        daemon: true,
        error: 'Invalid or missing agenttalkd IPC secret',
      });
      continue;
    }
    if (requireAuth) {
      delete payload.ipcSecret;
    }

    const response = await daemon.handle(payload);
    writeJsonLine(output, { transport: 'daemon', daemon: true, ...response });
    if (daemon.isShuttingDown()) {
      break;
    }
  }
}

export async function runAgenttalkd({
  stdio = true,
  ipc = true,
}: {
  stdio?: boolean;
  ipc?: boolean;
} = {}) {
  const daemon = await AgenttalkDaemon.connect('daemon-direct');
  daemon.startHeartbeat();
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.chmod(STATE_DIR, 0o700).catch(() => undefined);
  await fs.writeFile(PID_PATH, `${process.pid}\n`, 'utf8');
  await fs.chmod(PID_PATH, 0o600).catch(() => undefined);

  let server: net.Server | undefined;
  if (ipc) {
    const pipePath = daemonPipePath();
    if (process.platform !== 'win32') {
      await fs.rm(pipePath, { force: true });
    }
    server = net.createServer(socket => {
      void serveLineInterface(daemon, socket, socket, true);
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(pipePath, () => resolve());
    });
  }

  if (stdio) {
    await serveLineInterface(daemon, process.stdin, process.stdout, false);
  } else {
    while (!daemon.isShuttingDown()) {
      await sleep(250);
    }
  }

  server?.close();
  await daemon.close();
}

if (process.argv[1] && path.basename(process.argv[1]).startsWith('agenttalkd')) {
  runAgenttalkd({
    stdio: !process.argv.includes('--ipc-only'),
    ipc: true,
  }).catch(error => {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
    process.exitCode = 1;
  });
}
