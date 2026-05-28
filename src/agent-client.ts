import { Identity, type Timestamp } from 'spacetimedb';
import { DbConnection } from './module_bindings';
import type * as ModuleTypes from './module_bindings/types';

export type AgentRole = 'agent' | 'human';
export type AgentSubscriptionProfile =
  | 'directory'
  | 'identity'
  | 'direct'
  | 'direct-lite'
  | 'daemon-direct'
  | 'account-admin'
  | 'wake'
  | 'rooms'
  | 'ops'
  | 'all';

export type AgentClientOptions = {
  host?: string;
  databaseName?: string;
  token?: string;
  subscriptionProfile?: AgentSubscriptionProfile;
  subscriptions?: string[];
  includeFullConversationHistory?: boolean;
  onDisconnect?: (error?: Error) => void;
};

export type SignUpInput = {
  name: string;
  role?: AgentRole;
  bio?: string;
};

export type CreateAccountInput = {
  handle: string;
  displayName?: string;
  role?: AgentRole;
  bio?: string;
  clientRequestId?: string;
};

export type AccountType = 'free' | 'group' | 'pro' | 'operator';
export type AgentCredentialScope = 'plugin_runtime' | 'autonomous' | 'admin';

export type AccountDirectoryRequest = {
  query?: string;
  handle?: string;
  role?: AgentRole;
  online?: boolean;
  limit?: bigint;
};

export type RetentionPolicyInput = {
  hotMessageRetentionSeconds?: bigint;
  deliveryRetentionSeconds?: bigint;
  clientReceiptRetentionSeconds?: bigint;
  rateLimitBucketRetentionSeconds?: bigint;
  directoryRequestRetentionSeconds?: bigint;
  agentEventRetentionSeconds?: bigint;
};

export type DeploymentPolicyInput = {
  openBetaMode?: boolean;
  disableNewAccounts?: boolean;
  disableMessageSend?: boolean;
  maintenanceModeMessage?: string;
  maxMessageBytesDefault?: bigint;
  defaultSendRatePerMinute?: bigint;
  defaultOpenConversationRatePerMinute?: bigint;
  defaultHistoryRequestsPerMinute?: bigint;
  defaultInboxRequestsPerMinute?: bigint;
  defaultDirectorySearchRatePerMinute?: bigint;
  maxInboxPageSize?: bigint;
  maxHistoryPageSize?: bigint;
  maxPendingUnreadDeliveries?: bigint;
};

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export type WakeRegistrationInput = {
  kind: 'webhook' | 'local_daemon' | 'cloud_runner' | 'mcp_session' | 'push_gateway' | 'noop';
  endpointRef?: string;
  secretHash?: string;
  enabled?: boolean;
  metadataJson?: string;
  agentId?: string;
  registrationId?: string;
};

export type WakePolicyInput = {
  agentId?: string;
  wakeOnDirectMessage?: boolean;
  wakeOnMention?: boolean;
  wakeOnGroupMessage?: boolean;
  wakeOnHandoff?: boolean;
  wakeOnBusinessInquiry?: boolean;
  acceptsNewConversations?: boolean;
  minWakeIntervalMs?: bigint;
  coalesceWindowMs?: bigint;
  maxWakesPerMinute?: bigint;
  maxConcurrentWakeJobs?: bigint;
  expectedWakeLatencyMs?: bigint;
  availabilityOverride?: 'online' | 'wakeable' | 'sleeping' | 'offline' | 'unavailable';
  statusText?: string;
  allowedWakeSenderAgentIdsJson?: string;
  blockedWakeSenderAgentIdsJson?: string;
};

export type WakeClaimInput = {
  wakeId?: string;
  leaseMs?: bigint;
  registrationId?: string;
  metadataJson?: string;
};

export type ChannelDirectoryRequest = {
  query?: string;
  name?: string;
  limit?: bigint;
};

export type RoomOptions = {
  visibility?: 'public' | 'private';
  joinPolicy?: 'open' | 'password' | 'invite';
  password?: string;
};

export type RichMessageInput = {
  kind?: 'chat' | 'task' | 'handoff' | 'tool_result' | 'approval_request' | 'status' | 'system';
  replyToMessageId?: bigint;
  correlationId?: string;
  metadataJson?: string;
  artifactUrl?: string;
  artifactMimeType?: string;
  clientRequestId?: string;
};

function sameIdentity(left: Identity, right: Identity) {
  return left.toHexString() === right.toHexString();
}

function byTimestampAsc<T extends { sent: { toDate(): Date } }>(
  left: T,
  right: T
) {
  return left.sent.toDate().getTime() - right.sent.toDate().getTime();
}

function conversationSequence(row: { sequence?: bigint; id: bigint }) {
  return row.sequence ?? row.id;
}

function byConversationSequenceAsc<T extends { sequence?: bigint; id: bigint }>(
  left: T,
  right: T
) {
  const leftSequence = conversationSequence(left);
  const rightSequence = conversationSequence(right);
  if (leftSequence === rightSequence) {
    return 0;
  }
  return leftSequence < rightSequence ? -1 : 1;
}

function byLastActivityDesc<T extends { lastActivity: { toDate(): Date } }>(
  left: T,
  right: T
) {
  return right.lastActivity.toDate().getTime() - left.lastActivity.toDate().getTime();
}

function byNameAsc<T extends { name: string }>(left: T, right: T) {
  return left.name.localeCompare(right.name);
}

function makeClientRequestId(action: string) {
  const randomPart =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${action}:${randomPart}`;
}

function coerceError(error: unknown) {
  if (error instanceof Error) {
    return error;
  }

  if (typeof error === 'string') {
    return new Error(error);
  }

  if (error && typeof error === 'object') {
    const maybeMessage = (error as { message?: unknown }).message;
    if (typeof maybeMessage === 'string' && maybeMessage.trim()) {
      return new Error(maybeMessage);
    }
  }

  return new Error(String(error));
}

function getDbAccessor<T>(conn: DbConnection, snakeName: string, camelName: string) {
  const accessor = findDbAccessor<T>(conn, snakeName, camelName);
  if (!accessor) {
    throw new Error(`Missing subscribed table/view accessor: ${snakeName}`);
  }

  return accessor;
}

function findDbAccessor<T>(conn: DbConnection, snakeName: string, camelName: string) {
  const db = conn.db as unknown as Record<string, { iter(): Iterable<T> }>;
  const accessor = db[camelName] ?? db[snakeName];
  return accessor;
}

function uniqueSubscriptions(subscriptions: string[]) {
  return Array.from(new Set(subscriptions));
}

type ConnectionRuntimeState = {
  connected: boolean;
  disconnectedAt?: number;
  lastDisconnectError?: Error;
};

const DIRECTORY_SUBSCRIPTIONS = ['SELECT * FROM visible_requested_account_directory'];
const CHANNEL_DIRECTORY_SUBSCRIPTIONS = [
  'SELECT * FROM visible_requested_channel_directory',
];
const PUBLIC_WAKE_PROFILE_SUBSCRIPTIONS = [
  'SELECT * FROM visible_agent_wake_profile',
  'SELECT * FROM visible_self_agent_wake_profile',
];

const IDENTITY_SUBSCRIPTIONS = [
  ...DIRECTORY_SUBSCRIPTIONS,
  ...PUBLIC_WAKE_PROFILE_SUBSCRIPTIONS,
  'SELECT * FROM visible_user',
  'SELECT * FROM visible_self_agent_profile',
  'SELECT * FROM visible_agent_profile',
  'SELECT * FROM visible_retention_policy',
  'SELECT * FROM visible_deployment_policy',
];

const DIRECT_CONVERSATION_SUBSCRIPTIONS = [
  ...DIRECTORY_SUBSCRIPTIONS,
  ...PUBLIC_WAKE_PROFILE_SUBSCRIPTIONS,
  'SELECT * FROM visible_direct_conversation',
  'SELECT * FROM visible_self_agent_profile',
  'SELECT * FROM visible_agent_profile',
  'SELECT * FROM visible_conversation',
  'SELECT * FROM visible_conversation_member',
  'SELECT * FROM visible_inbox_delivery',
  'SELECT * FROM visible_unread_conversation_message',
  'SELECT * FROM visible_requested_conversation_message',
  'SELECT * FROM visible_conversation_read_cursor',
  'SELECT * FROM visible_client_request_receipt',
  'SELECT * FROM visible_retention_policy',
  'SELECT * FROM visible_deployment_policy',
];

const DAEMON_DIRECT_SUBSCRIPTIONS = [
  ...DIRECTORY_SUBSCRIPTIONS,
  'SELECT * FROM visible_self_agent_profile',
  'SELECT * FROM visible_direct_conversation',
  'SELECT * FROM visible_inbox_delivery',
  'SELECT * FROM visible_requested_inbox_delivery',
  'SELECT * FROM visible_requested_conversation_message',
  'SELECT * FROM visible_requested_conversation',
  'SELECT * FROM visible_requested_conversation_summary',
  'SELECT * FROM visible_requested_conversation_member',
  'SELECT * FROM visible_conversation_read_cursor',
  'SELECT * FROM visible_client_request_receipt',
  'SELECT * FROM visible_agent_delivery_counter',
  'SELECT * FROM visible_retention_policy',
  'SELECT * FROM visible_deployment_policy',
];

const ACCOUNT_ADMIN_SUBSCRIPTIONS = [
  ...IDENTITY_SUBSCRIPTIONS,
  'SELECT * FROM visible_account_entitlement',
  'SELECT * FROM visible_retention_cleanup_stat',
  'SELECT * FROM visible_retention_cleanup_stat_detail',
  'SELECT * FROM visible_scale_repair_stat',
  'SELECT * FROM visible_agent_delivery_counter',
  'SELECT * FROM visible_operator_scale_snapshot',
  'SELECT * FROM visible_rate_limit_pressure',
];

const WAKE_SUBSCRIPTIONS = [
  ...IDENTITY_SUBSCRIPTIONS,
  'SELECT * FROM visible_own_wake_registration',
  'SELECT * FROM visible_own_wake_policy',
  'SELECT * FROM visible_own_wake_request',
  'SELECT * FROM visible_dispatcher_wake_request',
  'SELECT * FROM visible_wake_attempt',
  'SELECT * FROM visible_requested_conversation_message',
  'SELECT * FROM visible_deployment_wake_policy',
  'SELECT * FROM visible_client_request_receipt',
  'SELECT * FROM visible_retention_policy',
];

const ROOM_SUBSCRIPTIONS = [
  ...DIRECTORY_SUBSCRIPTIONS,
  ...CHANNEL_DIRECTORY_SUBSCRIPTIONS,
  'SELECT * FROM visible_channel_member',
  'SELECT * FROM visible_channel_role',
  'SELECT * FROM visible_thread',
  'SELECT * FROM visible_watched_message',
  'SELECT * FROM visible_rich_message',
  'SELECT * FROM visible_room_config',
  'SELECT * FROM visible_room_removal_receipt',
];

const OPS_SUBSCRIPTIONS = [
  ...ACCOUNT_ADMIN_SUBSCRIPTIONS,
  ...DIRECT_CONVERSATION_SUBSCRIPTIONS,
  ...ROOM_SUBSCRIPTIONS,
  'SELECT * FROM visible_workspace',
  'SELECT * FROM visible_workspace_member',
  'SELECT * FROM visible_agent_session',
  'SELECT * FROM visible_capability_grant',
  'SELECT * FROM visible_rate_limit_bucket',
  'SELECT * FROM visible_task',
  'SELECT * FROM visible_task_claim',
  'SELECT * FROM visible_handoff',
  'SELECT * FROM visible_agent_event',
];

const SUBSCRIPTION_PROFILES: Record<AgentSubscriptionProfile, string[]> = {
  directory: DIRECTORY_SUBSCRIPTIONS,
  identity: IDENTITY_SUBSCRIPTIONS,
  direct: DIRECT_CONVERSATION_SUBSCRIPTIONS,
  'direct-lite': DAEMON_DIRECT_SUBSCRIPTIONS,
  'daemon-direct': DAEMON_DIRECT_SUBSCRIPTIONS,
  'account-admin': ACCOUNT_ADMIN_SUBSCRIPTIONS,
  wake: WAKE_SUBSCRIPTIONS,
  rooms: ROOM_SUBSCRIPTIONS,
  ops: OPS_SUBSCRIPTIONS,
  all: OPS_SUBSCRIPTIONS,
};

function subscriptionsForOptions(options: AgentClientOptions) {
  const base = options.subscriptions
    ? options.subscriptions
    : SUBSCRIPTION_PROFILES[options.subscriptionProfile ?? 'direct'];
  const subscriptions = [...base];

  if (options.includeFullConversationHistory) {
    subscriptions.push('SELECT * FROM visible_conversation_message');
  }

  return uniqueSubscriptions(subscriptions);
}

async function connectAndSubscribe(
  options: AgentClientOptions
): Promise<{
  conn: DbConnection;
  identity: Identity;
  token: string;
  state: ConnectionRuntimeState;
}> {
  const host =
    options.host ??
    process.env.SPACETIMEDB_HOST ??
    'https://maincloud.spacetimedb.com';
  const databaseName =
    options.databaseName ?? process.env.SPACETIMEDB_DB_NAME ?? 'crimsonconfidentialgibbon';

  let connectedIdentity: Identity | undefined;
  let connectedToken: string | undefined;
  let resolveConnect: (() => void) | undefined;
  let rejectConnect: ((error: Error) => void) | undefined;

  const connected = new Promise<void>((resolve, reject) => {
    resolveConnect = resolve;
    rejectConnect = reject;
  });
  const state: ConnectionRuntimeState = { connected: false };

  const conn = DbConnection.builder()
    .withUri(host)
    .withDatabaseName(databaseName)
    .withToken(options.token)
    .onConnect((_ctx: unknown, identity: Identity, token: string) => {
      state.connected = true;
      state.disconnectedAt = undefined;
      state.lastDisconnectError = undefined;
      connectedIdentity = identity;
      connectedToken = token;
      resolveConnect?.();
    })
    .onConnectError((...args: any[]) => {
      const err = args[args.length - 1];
      rejectConnect?.(coerceError(err));
    })
    .onDisconnect((_ctx: unknown, error?: Error) => {
      state.connected = false;
      state.disconnectedAt = Date.now();
      state.lastDisconnectError = error ? coerceError(error) : undefined;
      options.onDisconnect?.(state.lastDisconnectError);
    })
    .build();

  await connected;

  const subscriptions = subscriptionsForOptions(options);

  const subscribed = new Promise<void>((resolve, reject) => {
    conn
      .subscriptionBuilder()
      .onApplied(() => resolve())
      .onError((...args: any[]) => {
        const err = args[args.length - 1];
        reject(coerceError(err));
      })
      .subscribe(subscriptions);
  });

  await subscribed;

  if (!connectedIdentity || !connectedToken) {
    conn.disconnect();
    throw new Error('Connection succeeded without identity/token payload');
  }

  return {
    conn,
    identity: connectedIdentity,
    token: connectedToken,
    state,
  };
}

export class AgentRealtimeClient {
  private readonly accountHandleCache = new Map<string, ModuleTypes.Account>();
  private readonly directConversationCache = new Map<string, ModuleTypes.DirectConversationIndex>();
  private readonly conversationSequenceCache = new Map<string, bigint>();
  private readonly receiptCache = new Map<string, ModuleTypes.ClientRequestReceipt>();
  private readonly inFlightRequests = new Map<string, Promise<void>>();

  private constructor(
    private readonly conn: DbConnection,
    private readonly currentIdentity: Identity,
    private readonly currentToken: string,
    private readonly connectionState: ConnectionRuntimeState
  ) {}

  static async connect(options: AgentClientOptions = {}) {
    const { conn, identity, token, state } = await connectAndSubscribe(options);
    return new AgentRealtimeClient(conn, identity, token, state);
  }

  get identity() {
    return this.currentIdentity;
  }

  get token() {
    return this.currentToken;
  }

  get identityHex() {
    return this.currentIdentity.toHexString();
  }

  get connected() {
    return this.connectionState.connected;
  }

  get disconnectedAt() {
    return this.connectionState.disconnectedAt;
  }

  get lastDisconnectError() {
    return this.connectionState.lastDisconnectError;
  }

  disconnect() {
    this.connectionState.connected = false;
    this.conn.disconnect();
  }

  cacheStats() {
    return {
      handles: this.accountHandleCache.size,
      directConversations: this.directConversationCache.size,
      conversationSequences: this.conversationSequenceCache.size,
      receipts: this.receiptCache.size,
      inFlightRequests: this.inFlightRequests.size,
    };
  }

  private coalesceRequest(key: string, run: () => Promise<void>) {
    const existing = this.inFlightRequests.get(key);
    if (existing) {
      return existing;
    }
    const next = run().finally(() => {
      if (this.inFlightRequests.get(key) === next) {
        this.inFlightRequests.delete(key);
      }
    });
    this.inFlightRequests.set(key, next);
    return next;
  }

  private rememberAccount(row: ModuleTypes.Account) {
    this.accountHandleCache.set(row.handle, row);
    this.accountHandleCache.set(`@${row.handle}`, row);
    this.accountHandleCache.set(row.identity.toHexString(), row);
  }

  private rememberDirectConversation(row: ModuleTypes.DirectConversationIndex) {
    this.directConversationCache.set(row.pairKey, row);
    this.directConversationCache.set(row.conversationId.toString(), row);
  }

  private rememberReceipt(row: ModuleTypes.ClientRequestReceipt) {
    this.receiptCache.set(`${row.action}:${row.clientRequestId}`, row);
    this.receiptCache.set(row.clientRequestId, row);
  }

  private rememberConversationSequence(conversationId: bigint, sequence: bigint) {
    const key = conversationId.toString();
    const existing = this.conversationSequenceCache.get(key) ?? 0n;
    if (sequence > existing) {
      this.conversationSequenceCache.set(key, sequence);
    }
  }

  async signUp({ name, role = 'agent', bio = '' }: SignUpInput) {
    await this.conn.reducers.setProfile({ name, role, bio });
  }

  async createAccount({
    handle,
    displayName,
    role = 'agent',
    bio = '',
    clientRequestId,
  }: CreateAccountInput) {
    await this.conn.reducers.createAccount({
      handle,
      displayName: displayName ?? handle,
      role,
      bio,
      clientRequestId: clientRequestId ?? makeClientRequestId('account:create'),
    });
  }

  async requestAccountDirectory({
    query,
    handle,
    role,
    online,
    limit,
  }: AccountDirectoryRequest = {}) {
    await this.conn.reducers.requestAccountDirectory({
      query,
      handle,
      role,
      online,
      limit,
    });
  }

  async clearAccountDirectoryRequest() {
    await this.conn.reducers.clearAccountDirectoryRequest({});
  }

  async bootstrapOperatorAccount() {
    await this.conn.reducers.bootstrapOperatorAccount({});
  }

  async setRetentionPolicy(input: RetentionPolicyInput) {
    await this.conn.reducers.setRetentionPolicy({
      hotMessageRetentionSeconds: input.hotMessageRetentionSeconds,
      deliveryRetentionSeconds: input.deliveryRetentionSeconds,
      clientReceiptRetentionSeconds: input.clientReceiptRetentionSeconds,
      rateLimitBucketRetentionSeconds: input.rateLimitBucketRetentionSeconds,
      directoryRequestRetentionSeconds: input.directoryRequestRetentionSeconds,
      agentEventRetentionSeconds: input.agentEventRetentionSeconds,
    });
  }

  async resetRetentionPolicy() {
    await this.conn.reducers.resetRetentionPolicy({});
  }

  async setDeploymentPolicy(input: DeploymentPolicyInput) {
    await this.conn.reducers.setDeploymentPolicy({
      openBetaMode: input.openBetaMode,
      disableNewAccounts: input.disableNewAccounts,
      disableMessageSend: input.disableMessageSend,
      maintenanceModeMessage: input.maintenanceModeMessage,
      maxMessageBytesDefault: input.maxMessageBytesDefault,
      defaultSendRatePerMinute: input.defaultSendRatePerMinute,
      defaultOpenConversationRatePerMinute: input.defaultOpenConversationRatePerMinute,
      defaultHistoryRequestsPerMinute: input.defaultHistoryRequestsPerMinute,
      defaultInboxRequestsPerMinute: input.defaultInboxRequestsPerMinute,
      defaultDirectorySearchRatePerMinute: input.defaultDirectorySearchRatePerMinute,
      maxInboxPageSize: input.maxInboxPageSize,
      maxHistoryPageSize: input.maxHistoryPageSize,
      maxPendingUnreadDeliveries: input.maxPendingUnreadDeliveries,
    });
  }

  async resetDeploymentPolicy() {
    await this.conn.reducers.resetDeploymentPolicy({});
  }

  async setDeploymentWakePolicy(input: {
    disableWakeDispatch?: boolean;
    defaultWakeCoalesceWindowMs?: bigint;
    defaultMinWakeIntervalMs?: bigint;
    defaultMaxWakesPerMinute?: bigint;
    defaultWakeRequestTtlSeconds?: bigint;
    maxWakeAttempts?: bigint;
    maxWakePayloadBytes?: bigint;
    maxPendingWakeRequestsPerAgent?: bigint;
    maintenanceModeMessage?: string;
  }) {
    await this.conn.reducers.setDeploymentWakePolicy({
      disableWakeDispatch: input.disableWakeDispatch,
      defaultWakeCoalesceWindowMs: input.defaultWakeCoalesceWindowMs,
      defaultMinWakeIntervalMs: input.defaultMinWakeIntervalMs,
      defaultMaxWakesPerMinute: input.defaultMaxWakesPerMinute,
      defaultWakeRequestTtlSeconds: input.defaultWakeRequestTtlSeconds,
      maxWakeAttempts: input.maxWakeAttempts,
      maxWakePayloadBytes: input.maxWakePayloadBytes,
      maxPendingWakeRequestsPerAgent: input.maxPendingWakeRequestsPerAgent,
      maintenanceModeMessage: input.maintenanceModeMessage,
    });
  }

  async resetDeploymentWakePolicy() {
    await this.conn.reducers.resetDeploymentWakePolicy({});
  }

  async registerWake(input: WakeRegistrationInput) {
    await this.conn.reducers.registerWake({
      kind: input.kind,
      endpointRef: input.endpointRef,
      secretHash: input.secretHash,
      enabled: input.enabled,
      metadataJson: input.metadataJson,
      agentId: input.agentId,
      registrationId: input.registrationId,
    });
  }

  async disableWakeRegistration(input: {
    registrationId?: string;
    kind?: WakeRegistrationInput['kind'];
    agentId?: string;
  } = {}) {
    await this.conn.reducers.disableWakeRegistration({
      registrationId: input.registrationId,
      kind: input.kind,
      agentId: input.agentId,
    });
  }

  async setWakePolicy(input: WakePolicyInput) {
    await this.conn.reducers.setWakePolicy({
      agentId: input.agentId,
      wakeOnDirectMessage: input.wakeOnDirectMessage,
      wakeOnMention: input.wakeOnMention,
      wakeOnGroupMessage: input.wakeOnGroupMessage,
      wakeOnHandoff: input.wakeOnHandoff,
      wakeOnBusinessInquiry: input.wakeOnBusinessInquiry,
      acceptsNewConversations: input.acceptsNewConversations,
      minWakeIntervalMs: input.minWakeIntervalMs,
      coalesceWindowMs: input.coalesceWindowMs,
      maxWakesPerMinute: input.maxWakesPerMinute,
      maxConcurrentWakeJobs: input.maxConcurrentWakeJobs,
      expectedWakeLatencyMs: input.expectedWakeLatencyMs,
      availabilityOverride: input.availabilityOverride,
      statusText: input.statusText,
      allowedWakeSenderAgentIdsJson: input.allowedWakeSenderAgentIdsJson,
      blockedWakeSenderAgentIdsJson: input.blockedWakeSenderAgentIdsJson,
    });
  }

  async resetWakePolicy(agentId?: string) {
    await this.conn.reducers.resetWakePolicy({ agentId });
  }

  async claimWakeRequest(input: WakeClaimInput = {}) {
    await this.conn.reducers.claimWakeRequest({
      wakeId: input.wakeId,
      leaseMs: input.leaseMs,
      registrationId: input.registrationId,
      metadataJson: input.metadataJson,
    });
  }

  async markWakeDispatched(wakeId: string, attemptId?: string, metadataJson?: string) {
    await this.conn.reducers.markWakeDispatched({ wakeId, attemptId, metadataJson });
  }

  async ackWakeRequest(wakeId: string, attemptId?: string, metadataJson?: string) {
    await this.conn.reducers.ackWakeRequest({ wakeId, attemptId, metadataJson });
  }

  async failWakeRequest(
    wakeId: string,
    error: string,
    input: { attemptId?: string; retryAfterMs?: bigint; metadataJson?: string } = {}
  ) {
    await this.conn.reducers.failWakeRequest({
      wakeId,
      attemptId: input.attemptId,
      error,
      retryAfterMs: input.retryAfterMs,
      metadataJson: input.metadataJson,
    });
  }

  async expireWakeRequests(limit?: bigint) {
    await this.conn.reducers.expireWakeRequests({ limit });
  }

  async runRetentionCleanupNow() {
    await this.conn.reducers.runRetentionCleanupNow({});
  }

  async repairReversePaginationFields(limit?: bigint) {
    await this.conn.reducers.repairReversePaginationFields({ limit });
  }

  async repairScaleIndexes(limit?: bigint) {
    await this.conn.reducers.repairScaleIndexes({ limit });
  }

  async setAccountType({
    handle,
    accountType,
    groupChatAllowed,
  }: {
    handle: string;
    accountType: AccountType;
    groupChatAllowed: boolean;
  }) {
    await this.conn.reducers.setAccountType({
      handle,
      accountType,
      groupChatAllowed,
    });
  }

  async acceptWorkspaceInvite({
    code,
    name,
    role = 'agent',
    bio = '',
  }: SignUpInput & { code: string }) {
    await this.conn.reducers.acceptWorkspaceInvite({ code, name, role, bio });
  }

  async createWorkspace(slug: string, name: string, clientRequestId?: string) {
    await this.conn.reducers.createWorkspace({
      slug,
      name,
      clientRequestId: clientRequestId ?? makeClientRequestId('workspace:create'),
    });
  }

  async createWorkspaceInvite({
    workspaceId,
    code,
    workspaceRole = 'member',
    maxUses = 1n,
    ttlSeconds = 3600n,
    clientRequestId,
  }: {
    workspaceId: bigint;
    code: string;
    workspaceRole?: 'owner' | 'admin' | 'member';
    maxUses?: bigint;
    ttlSeconds?: bigint;
    clientRequestId?: string;
  }) {
    await this.conn.reducers.createWorkspaceInvite({
      workspaceId,
      code,
      workspaceRole,
      maxUses,
      ttlSeconds,
      clientRequestId: clientRequestId ?? makeClientRequestId('invite:create'),
    });
  }

  async grantCapability({
    granteeIdentity,
    workspaceId,
    channelId,
    capability,
    ttlSeconds = 3600n,
    clientRequestId,
  }: {
    granteeIdentity: Identity;
    workspaceId?: bigint;
    channelId?: bigint;
    capability: string;
    ttlSeconds?: bigint;
    clientRequestId?: string;
  }) {
    await this.conn.reducers.grantCapability({
      granteeIdentity,
      workspaceId,
      channelId,
      capability,
      ttlSeconds,
      clientRequestId: clientRequestId ?? makeClientRequestId('capability:grant'),
    });
  }

  async registerAgent({
    ownerIdentity,
    workspaceId,
    label,
    clientKind = 'agenttalk',
    ttlSeconds = 0n,
  }: {
    ownerIdentity?: Identity;
    workspaceId?: bigint;
    label: string;
    clientKind?: string;
    ttlSeconds?: bigint;
  }) {
    await this.conn.reducers.registerAgent({
      ownerIdentity,
      workspaceId,
      label,
      clientKind,
      ttlSeconds,
    });
  }

  async createChannel(name: string, topic: string, clientRequestId?: string) {
    await this.conn.reducers.createChannel({
      name,
      topic,
      visibility: undefined,
      joinPolicy: undefined,
      password: undefined,
      clientRequestId: clientRequestId ?? makeClientRequestId('channel:create'),
    });
  }

  async createRoom(
    name: string,
    topic: string,
    options: RoomOptions = {},
    clientRequestId?: string
  ) {
    await this.conn.reducers.createChannel({
      name,
      topic,
      visibility: options.visibility,
      joinPolicy: options.joinPolicy,
      password: options.password,
      clientRequestId: clientRequestId ?? makeClientRequestId('room:create'),
    });
  }

  async requestChannelDirectory({
    query,
    name,
    limit,
  }: ChannelDirectoryRequest = {}) {
    await this.conn.reducers.requestChannelDirectory({
      query,
      name,
      limit,
    });
  }

  async clearChannelDirectoryRequest() {
    await this.conn.reducers.clearChannelDirectoryRequest({});
  }

  async joinChannel(channelId: bigint, password?: string) {
    await this.conn.reducers.joinChannel({ channelId, password });
  }

  async leaveChannel(channelId: bigint) {
    await this.conn.reducers.leaveChannel({ channelId });
  }

  async setRoomConfig(channelId: bigint, options: Required<RoomOptions>) {
    await this.conn.reducers.setRoomConfig({
      channelId,
      visibility: options.visibility,
      joinPolicy: options.joinPolicy,
      password: options.password,
    });
  }

  async setRoomRole(
    channelId: bigint,
    memberIdentity: Identity,
    role: 'owner' | 'mod' | 'member'
  ) {
    await this.conn.reducers.setRoomRole({ channelId, memberIdentity, role });
  }

  async kickFromRoom(channelId: bigint, memberIdentity: Identity, reason = '') {
    await this.conn.reducers.kickFromRoom({ channelId, memberIdentity, reason });
  }

  async createThread(
    channelId: bigint,
    title: string,
    openingMessage: string,
    clientRequestId?: string
  ) {
    await this.conn.reducers.createThread({
      channelId,
      title,
      openingMessage,
      clientRequestId: clientRequestId ?? makeClientRequestId('thread:create'),
    });
  }

  async sendThreadMessage(
    threadId: bigint,
    text: string,
    input: RichMessageInput | string = {}
  ) {
    const rich =
      typeof input === 'string'
        ? ({ clientRequestId: input } satisfies RichMessageInput)
        : input;
    await this.conn.reducers.sendThreadMessage({
      threadId,
      text,
      kind: rich.kind,
      replyToMessageId: rich.replyToMessageId,
      correlationId: rich.correlationId,
      metadataJson: rich.metadataJson,
      artifactUrl: rich.artifactUrl,
      artifactMimeType: rich.artifactMimeType,
      clientRequestId: rich.clientRequestId ?? makeClientRequestId('message:send'),
    });
  }

  async watchThread(threadId: bigint) {
    await this.conn.reducers.watchThread({ threadId });
  }

  async unwatchThread(threadId: bigint) {
    await this.conn.reducers.unwatchThread({ threadId });
  }

  async repairAccessState() {
    await this.conn.reducers.repairAccessState({});
  }

  async createDirectConversation(
    targetIdentity: Identity,
    title = '',
    openingMessage = '',
    clientRequestId?: string
  ) {
    const requestId = clientRequestId ?? makeClientRequestId('conversation:create');
    await this.conn.reducers.createDirectConversation({
      targetIdentity,
      title,
      openingMessage,
      clientRequestId: requestId,
    });
    return requestId;
  }

  async openDirectConversation({
    targetAgentId,
    targetIdentity,
    title,
    clientRequestId,
  }: {
    targetAgentId?: string;
    targetIdentity?: Identity;
    title?: string;
    clientRequestId?: string;
  }) {
    const requestId = clientRequestId ?? makeClientRequestId('direct:open');
    await this.conn.reducers.openDirectConversation({
      targetAgentId,
      targetIdentity,
      title,
      clientRequestId: requestId,
    });
    return requestId;
  }

  async createGroupConversation(
    title: string,
    memberIdentities: Identity[],
    openingMessage = '',
    clientRequestId?: string
  ) {
    const requestId = clientRequestId ?? makeClientRequestId('conversation:create');
    await this.conn.reducers.createGroupConversation({
      title,
      memberIdentities,
      openingMessage,
      clientRequestId: requestId,
    });
    return requestId;
  }

  async bindAgentIdentity({
    identity,
    agentId,
    deviceLabel,
    credentialScope,
    credentialLabel,
  }: {
    identity: Identity;
    agentId: string;
    deviceLabel?: string;
    credentialScope?: AgentCredentialScope;
    credentialLabel?: string;
  }) {
    await this.conn.reducers.bindAgentIdentity({
      identity,
      agentId,
      deviceLabel,
      credentialScope,
      credentialLabel,
    });
  }

  async setAgentCredentialScope({
    identity,
    agentId,
    credentialScope,
    credentialLabel,
  }: {
    identity: Identity;
    agentId: string;
    credentialScope: AgentCredentialScope;
    credentialLabel?: string;
  }) {
    await this.conn.reducers.setAgentCredentialScope({
      identity,
      agentId,
      credentialScope,
      credentialLabel,
    });
  }

  async addConversationMember(
    conversationId: bigint,
    memberIdentity: Identity,
    role: 'mod' | 'member' = 'member'
  ) {
    await this.conn.reducers.addConversationMember({
      conversationId,
      memberIdentity,
      role,
    });
  }

  async leaveConversation(conversationId: bigint) {
    await this.conn.reducers.leaveConversation({ conversationId });
  }

  async sendConversationMessage(
    conversationId: bigint,
    text: string,
    input: RichMessageInput = {}
  ) {
    const requestId = input.clientRequestId ?? makeClientRequestId('conversation:send');
    await this.conn.reducers.sendConversationMessage({
      conversationId,
      text,
      kind: input.kind ?? 'chat',
      replyToMessageId: input.replyToMessageId,
      correlationId: input.correlationId,
      metadataJson: input.metadataJson,
      artifactUrl: input.artifactUrl,
      artifactMimeType: input.artifactMimeType,
      clientRequestId: requestId,
    });
    return requestId;
  }

  async sendDirectMessage({
    targetAgentId,
    targetIdentity,
    text,
    kind = 'chat',
    metadataJson,
    correlationId,
    clientRequestId,
  }: {
    targetAgentId?: string;
    targetIdentity?: Identity;
    text: string;
    kind?: RichMessageInput['kind'];
    metadataJson?: string;
    correlationId?: string;
    clientRequestId?: string;
  }) {
    const requestId = clientRequestId ?? makeClientRequestId('direct:send');
    await this.conn.reducers.sendDirectMessage({
      targetAgentId,
      targetIdentity,
      text,
      kind,
      metadataJson,
      correlationId,
      clientRequestId: requestId,
    });
    return requestId;
  }

  async heartbeat(statusText?: string, clientKind = 'agenttalk') {
    await this.conn.reducers.heartbeat({
      statusText,
      clientKind,
    });
  }

  async createTask(
    channelId: bigint,
    title: string,
    description: string,
    priority: 'low' | 'normal' | 'high' | 'urgent' = 'normal',
    assignedTo?: Identity,
    correlationId?: string
  ) {
    await this.conn.reducers.createTask({
      channelId,
      title,
      description,
      priority,
      assignedTo,
      correlationId,
      clientRequestId: makeClientRequestId('task:create'),
    });
  }

  async claimTask(taskId: bigint) {
    await this.conn.reducers.claimTask({ taskId });
  }

  async updateTaskStatus(
    taskId: bigint,
    status: 'open' | 'claimed' | 'in_progress' | 'blocked' | 'done' | 'cancelled'
  ) {
    await this.conn.reducers.updateTaskStatus({ taskId, status });
  }

  async createHandoff(
    channelId: bigint,
    summary: string,
    toIdentity?: Identity,
    contextJson?: string
  ) {
    await this.conn.reducers.createHandoff({
      channelId,
      toIdentity,
      summary,
      contextJson,
      clientRequestId: makeClientRequestId('handoff:create'),
    });
  }

  async acceptHandoff(handoffId: bigint) {
    await this.conn.reducers.acceptHandoff({ handoffId });
  }

  async emitAgentEvent({
    kind,
    channelId,
    threadId,
    conversationId,
    targetIdentity,
    text,
    metadataJson,
  }: {
    kind: 'typing' | 'heartbeat' | 'mention' | 'joined_thread' | 'joined_conversation' | 'status';
    channelId?: bigint;
    threadId?: bigint;
    conversationId?: bigint;
    targetIdentity?: Identity;
    text?: string;
    metadataJson?: string;
  }) {
    await this.conn.reducers.emitAgentEvent({
      kind,
      channelId,
      threadId,
      conversationId,
      targetIdentity,
      text,
      metadataJson,
    });
  }

  listUsers() {
    return Array.from(
      getDbAccessor<ModuleTypes.User>(this.conn, 'visible_user', 'visibleUser').iter()
    );
  }

  listAccounts() {
    const accessors = [
      findDbAccessor<ModuleTypes.Account>(
        this.conn,
        'visible_requested_account_directory',
        'visibleRequestedAccountDirectory'
      ),
      findDbAccessor<ModuleTypes.Account>(
        this.conn,
        'public_account_directory',
        'publicAccountDirectory'
      ),
      findDbAccessor<ModuleTypes.Account>(
        this.conn,
        'visible_account',
        'visibleAccount'
      ),
    ].filter(Boolean) as Array<{ iter(): Iterable<ModuleTypes.Account> }>;

    if (accessors.length === 0) {
      return [];
    }

    const byIdentity = new Map<string, ModuleTypes.Account>();
    for (const accessor of accessors) {
      for (const row of accessor.iter()) {
        byIdentity.set(row.identity.toHexString(), row);
      }
    }

    const rows = Array.from(byIdentity.values()).sort((left, right) =>
      left.handle.localeCompare(right.handle)
    );
    for (const row of rows) {
      this.rememberAccount(row);
    }
    return rows;
  }

  listAgentProfiles() {
    const accessor = findDbAccessor<ModuleTypes.AgentProfile>(
      this.conn,
      'visible_agent_profile',
      'visibleAgentProfile'
    );
    return accessor ? Array.from(accessor.iter()) : [];
  }

  listSelfAgentProfiles() {
    const accessor = findDbAccessor<ModuleTypes.AgentProfile>(
      this.conn,
      'visible_self_agent_profile',
      'visibleSelfAgentProfile'
    );
    return accessor ? Array.from(accessor.iter()) : [];
  }

  currentAgentProfile() {
    const self = this.listSelfAgentProfiles()[0];
    if (self) {
      return self;
    }
    const profiles = this.listAgentProfiles();
    const ownAccount = this.listAccounts().find(row =>
      sameIdentity(row.identity, this.currentIdentity)
    );
    if (ownAccount?.agentId) {
      const profile = profiles.find(row => row.agentId === ownAccount.agentId);
      if (profile) {
        return profile;
      }
    }
    return ownAccount
      ? profiles.find(row => row.handle === ownAccount.handle)
      : profiles[0];
  }

  listRetentionPolicies() {
    const accessor = findDbAccessor<ModuleTypes.RetentionPolicyView>(
      this.conn,
      'visible_retention_policy',
      'visibleRetentionPolicy'
    );
    return accessor ? Array.from(accessor.iter()) : [];
  }

  listRetentionCleanupStats() {
    const accessor = findDbAccessor<ModuleTypes.RetentionCleanupStat>(
      this.conn,
      'visible_retention_cleanup_stat',
      'visibleRetentionCleanupStat'
    );
    return accessor ? Array.from(accessor.iter()) : [];
  }

  listRetentionCleanupStatDetails() {
    const accessor = findDbAccessor<ModuleTypes.RetentionCleanupStatDetailView>(
      this.conn,
      'visible_retention_cleanup_stat_detail',
      'visibleRetentionCleanupStatDetail'
    );
    return accessor ? Array.from(accessor.iter()) : [];
  }

  listScaleRepairStats() {
    const accessor = findDbAccessor<ModuleTypes.ScaleRepairStatView>(
      this.conn,
      'visible_scale_repair_stat',
      'visibleScaleRepairStat'
    );
    return accessor ? Array.from(accessor.iter()) : [];
  }

  listAgentDeliveryCounters() {
    const accessor = findDbAccessor<ModuleTypes.AgentDeliveryCounterView>(
      this.conn,
      'visible_agent_delivery_counter',
      'visibleAgentDeliveryCounter'
    );
    return accessor ? Array.from(accessor.iter()) : [];
  }

  listOperatorScaleSnapshots() {
    const accessor = findDbAccessor<ModuleTypes.OperatorScaleSnapshotView>(
      this.conn,
      'visible_operator_scale_snapshot',
      'visibleOperatorScaleSnapshot'
    );
    return accessor ? Array.from(accessor.iter()) : [];
  }

  listRateLimitPressure() {
    const accessor = findDbAccessor<ModuleTypes.RateLimitPressureView>(
      this.conn,
      'visible_rate_limit_pressure',
      'visibleRateLimitPressure'
    );
    return accessor ? Array.from(accessor.iter()) : [];
  }

  listDeploymentPolicies() {
    const accessor = findDbAccessor<ModuleTypes.DeploymentPolicyView>(
      this.conn,
      'visible_deployment_policy',
      'visibleDeploymentPolicy'
    );
    return accessor ? Array.from(accessor.iter()) : [];
  }

  listDeploymentWakePolicies() {
    const accessor = findDbAccessor<ModuleTypes.DeploymentWakePolicyView>(
      this.conn,
      'visible_deployment_wake_policy',
      'visibleDeploymentWakePolicy'
    );
    return accessor ? Array.from(accessor.iter()) : [];
  }

  listAgentWakeProfiles() {
    const accessors = [
      findDbAccessor<ModuleTypes.AgentWakeProfileView>(
        this.conn,
        'visible_agent_wake_profile',
        'visibleAgentWakeProfile'
      ),
      findDbAccessor<ModuleTypes.AgentWakeProfileView>(
        this.conn,
        'visible_self_agent_wake_profile',
        'visibleSelfAgentWakeProfile'
      ),
    ].filter(Boolean) as Array<{ iter(): Iterable<ModuleTypes.AgentWakeProfileView> }>;
    const byAgent = new Map<string, ModuleTypes.AgentWakeProfileView>();
    for (const accessor of accessors) {
      for (const row of accessor.iter()) {
        byAgent.set(row.agentId, row);
      }
    }
    return Array.from(byAgent.values()).sort((left, right) =>
      left.handle.localeCompare(right.handle)
    );
  }

  wakeProfileForAgent(agentId: string) {
    return this.listAgentWakeProfiles().find(row => row.agentId === agentId);
  }

  currentAgentWakeProfile() {
    const profile = this.currentAgentProfile();
    return profile ? this.wakeProfileForAgent(profile.agentId) : undefined;
  }

  listWakeRegistrations() {
    const accessor = findDbAccessor<ModuleTypes.WakeRegistrationView>(
      this.conn,
      'visible_own_wake_registration',
      'visibleOwnWakeRegistration'
    );
    return accessor ? Array.from(accessor.iter()) : [];
  }

  listWakePolicies() {
    const accessor = findDbAccessor<ModuleTypes.AgentWakePolicy>(
      this.conn,
      'visible_own_wake_policy',
      'visibleOwnWakePolicy'
    );
    return accessor ? Array.from(accessor.iter()) : [];
  }

  currentWakePolicy() {
    const profile = this.currentAgentProfile();
    return profile
      ? this.listWakePolicies().find(row => row.agentId === profile.agentId)
      : undefined;
  }

  listWakeRequests({
    status,
    conversationId,
    includeDispatcher = false,
  }: {
    status?: string;
    conversationId?: bigint;
    includeDispatcher?: boolean;
  } = {}) {
    const ownAccessor = findDbAccessor<ModuleTypes.WakeRequestView>(
      this.conn,
      'visible_own_wake_request',
      'visibleOwnWakeRequest'
    );
    const dispatcherAccessor = includeDispatcher
      ? findDbAccessor<ModuleTypes.WakeRequestView>(
          this.conn,
          'visible_dispatcher_wake_request',
          'visibleDispatcherWakeRequest'
        )
      : undefined;
    const byId = new Map<string, ModuleTypes.WakeRequestView>();
    for (const accessor of [ownAccessor, dispatcherAccessor].filter(Boolean) as Array<{
      iter(): Iterable<ModuleTypes.WakeRequestView>;
    }>) {
      for (const row of accessor.iter()) {
        if (status && row.status !== status) {
          continue;
        }
        if (conversationId && row.conversationId !== conversationId) {
          continue;
        }
        byId.set(row.wakeId, row);
      }
    }
    return Array.from(byId.values()).sort(
      (left, right) => left.createdAt.toDate().getTime() - right.createdAt.toDate().getTime()
    );
  }

  listWakeAttempts(wakeId?: string) {
    const accessor = findDbAccessor<ModuleTypes.WakeAttemptView>(
      this.conn,
      'visible_wake_attempt',
      'visibleWakeAttempt'
    );
    const rows = accessor ? Array.from(accessor.iter()) : [];
    return rows
      .filter(row => (wakeId ? row.wakeId === wakeId : true))
      .sort((left, right) => Number(left.attemptNumber - right.attemptNumber));
  }

  listAccountEntitlements() {
    return Array.from(
      getDbAccessor<ModuleTypes.AccountEntitlement>(
        this.conn,
        'visible_account_entitlement',
        'visibleAccountEntitlement'
      ).iter()
    ).sort((left, right) => left.handle.localeCompare(right.handle));
  }

  currentAccountEntitlement() {
    return this.listAccountEntitlements().find(row =>
      sameIdentity(row.identity, this.currentIdentity)
    );
  }

  searchAccounts({
    query,
    handle,
    role,
    online,
  }: {
    query?: string;
    handle?: string;
    role?: AgentRole;
    online?: boolean;
  } = {}) {
    const normalizedQuery = query?.trim().toLowerCase();
    const normalizedHandle = handle?.trim().toLowerCase();

    return this.listAccounts().filter(row => {
      if (normalizedHandle && row.handle !== normalizedHandle) {
        return false;
      }
      if (role && row.role !== role) {
        return false;
      }
      if (online !== undefined && row.online !== online) {
        return false;
      }
      if (!normalizedQuery) {
        return true;
      }

      return (
        row.handle.includes(normalizedQuery) ||
        row.displayName.toLowerCase().includes(normalizedQuery) ||
        (row.bio ?? '').toLowerCase().includes(normalizedQuery)
      );
    });
  }

  listWorkspaces() {
    return Array.from(
      getDbAccessor<ModuleTypes.Workspace>(
        this.conn,
        'visible_workspace',
        'visibleWorkspace'
      ).iter()
    );
  }

  listWorkspaceMembers() {
    return Array.from(
      getDbAccessor<ModuleTypes.WorkspaceMember>(
        this.conn,
        'visible_workspace_member',
        'visibleWorkspaceMember'
      ).iter()
    );
  }

  listRoomConfigs() {
    return Array.from(
      getDbAccessor<ModuleTypes.RoomConfig>(
        this.conn,
        'visible_room_config',
        'visibleRoomConfig'
      ).iter()
    );
  }

  listChannelRoles() {
    return Array.from(
      getDbAccessor<ModuleTypes.ChannelRole>(
        this.conn,
        'visible_channel_role',
        'visibleChannelRole'
      ).iter()
    );
  }

  listRoomRemovalReceipts(channelId?: bigint) {
    return Array.from(
      getDbAccessor<ModuleTypes.RoomRemovalReceipt>(
        this.conn,
        'visible_room_removal_receipt',
        'visibleRoomRemovalReceipt'
      ).iter()
    )
      .filter(row => (channelId ? row.channelId === channelId : true))
      .sort((left, right) => right.removedAt.toDate().getTime() - left.removedAt.toDate().getTime());
  }

  listCapabilityGrants() {
    return Array.from(
      getDbAccessor<ModuleTypes.CapabilityGrant>(
        this.conn,
        'visible_capability_grant',
        'visibleCapabilityGrant'
      ).iter()
    );
  }

  listRateLimitBuckets() {
    return Array.from(
      getDbAccessor<ModuleTypes.RateLimitBucket>(
        this.conn,
        'visible_rate_limit_bucket',
        'visibleRateLimitBucket'
      ).iter()
    );
  }

  listChannels() {
    const byId = new Map<string, ModuleTypes.Channel>();

    const requestedAccessor = findDbAccessor<ModuleTypes.Channel>(
      this.conn,
      'visible_requested_channel_directory',
      'visibleRequestedChannelDirectory'
    );
    if (requestedAccessor) {
      for (const row of Array.from(requestedAccessor.iter())) {
        byId.set(row.id.toString(), row);
      }
    }

    const publicAccessor = findDbAccessor<ModuleTypes.Channel>(
      this.conn,
      'public_channel_directory',
      'publicChannelDirectory'
    );
    if (publicAccessor) {
      for (const row of Array.from(publicAccessor.iter())) {
        byId.set(row.id.toString(), row);
      }
    }

    const workspaceAccessor = findDbAccessor<ModuleTypes.Channel>(
      this.conn,
      'visible_workspace_channel',
      'visibleWorkspaceChannel'
    );
    if (workspaceAccessor) {
      for (const row of Array.from(
        workspaceAccessor.iter()
      )) {
        byId.set(row.id.toString(), row);
      }
    }

    return Array.from(byId.values()).sort(byNameAsc);
  }

  listMemberships() {
    return Array.from(
      getDbAccessor<ModuleTypes.ChannelMember>(
        this.conn,
        'visible_channel_member',
        'visibleChannelMember'
      ).iter()
    );
  }

  listJoinedChannels(identity: Identity = this.currentIdentity) {
    const membershipIds = new Set(
      this.listMemberships()
        .filter(row => sameIdentity(row.memberIdentity, identity))
        .map(row => row.channelId.toString())
    );

    return this.listChannels().filter(channelRow =>
      membershipIds.has(channelRow.id.toString())
    );
  }

  listThreads(channelId?: bigint) {
    const rows = Array.from(
      getDbAccessor<ModuleTypes.Thread>(this.conn, 'visible_thread', 'visibleThread').iter()
    );
    return rows
      .filter(row => (channelId ? row.channelId === channelId : true))
      .sort(byLastActivityDesc);
  }

  listMessages(threadId?: bigint) {
    const rows = Array.from(
      getDbAccessor<ModuleTypes.Message>(
        this.conn,
        'visible_watched_message',
        'visibleWatchedMessage'
      ).iter()
    );
    return rows
      .filter(row => (threadId ? row.threadId === threadId : true))
      .sort(byTimestampAsc);
  }

  onMessageInsert(callback: (row: ModuleTypes.Message) => void) {
    const wrapped = (_ctx: unknown, row: ModuleTypes.Message) => {
      callback(row);
    };

    const visibleMessage = getDbAccessor<ModuleTypes.Message>(
      this.conn,
      'visible_watched_message',
      'visibleWatchedMessage'
    ) as unknown as {
      onInsert(handler: typeof wrapped): void;
      removeOnInsert(handler: typeof wrapped): void;
    };

    visibleMessage.onInsert(wrapped);

    return () => {
      visibleMessage.removeOnInsert(wrapped);
    };
  }

  listRichMessages(threadId?: bigint) {
    const rows = Array.from(
      getDbAccessor<ModuleTypes.RichMessage>(
        this.conn,
        'visible_rich_message',
        'visibleRichMessage'
      ).iter()
    );
    return rows
      .filter(row => (threadId ? row.threadId === threadId : true))
      .sort(byTimestampAsc);
  }

  listConversations() {
    const broadRows = Array.from(
      getDbAccessor<ModuleTypes.Conversation>(
        this.conn,
        'visible_conversation',
        'visibleConversation'
      ).iter()
    );
    const requestedRows = Array.from(
      getDbAccessor<ModuleTypes.Conversation>(
        this.conn,
        'visible_requested_conversation',
        'visibleRequestedConversation'
      ).iter()
    );
    const byId = new Map<string, ModuleTypes.Conversation>();
    for (const row of [...broadRows, ...requestedRows]) {
      byId.set(row.id.toString(), row);
    }
    return Array.from(byId.values()).sort(byLastActivityDesc);
  }

  listConversationSummaries(conversationId?: bigint) {
    const accessor = findDbAccessor<ModuleTypes.ConversationParticipantSummaryView>(
      this.conn,
      'visible_requested_conversation_summary',
      'visibleRequestedConversationSummary'
    );
    const rows = accessor ? Array.from(accessor.iter()) : [];
    return rows
      .filter(row => (conversationId ? row.conversationId === conversationId : true))
      .sort(byLastActivityDesc);
  }

  listDirectConversations() {
    const rows = Array.from(
      getDbAccessor<ModuleTypes.DirectConversationIndex>(
        this.conn,
        'visible_direct_conversation',
        'visibleDirectConversation'
      ).iter()
    );
    for (const row of rows) {
      this.rememberDirectConversation(row);
    }
    return rows;
  }

  listConversationMembers(conversationId?: bigint) {
    const broadRows = Array.from(
      getDbAccessor<ModuleTypes.ConversationMember>(
        this.conn,
        'visible_conversation_member',
        'visibleConversationMember'
      ).iter()
    );
    const requestedRows = Array.from(
      getDbAccessor<ModuleTypes.ConversationMember>(
        this.conn,
        'visible_requested_conversation_member',
        'visibleRequestedConversationMember'
      ).iter()
    );
    const byId = new Map<string, ModuleTypes.ConversationMember>();
    for (const row of [...broadRows, ...requestedRows]) {
      if (conversationId && row.conversationId !== conversationId) {
        continue;
      }
      byId.set(row.id.toString(), row);
    }
    return Array.from(byId.values());
  }

  async requestConversations({
    kind,
    beforeLastActivity,
    limit,
  }: {
    kind?: 'direct' | 'group';
    beforeLastActivity?: Timestamp;
    limit?: bigint;
  } = {}) {
    const key = [
      'conversation:list',
      kind ?? '',
      beforeLastActivity?.toDate().getTime().toString() ?? '',
      limit?.toString() ?? '',
    ].join(':');
    await this.coalesceRequest(key, () =>
      this.conn.reducers.requestConversations({
        kind,
        beforeLastActivity,
        limit,
      })
    );
  }

  async clearConversationListRequest() {
    await this.conn.reducers.clearConversationListRequest({});
  }

  async requestConversationMembers(conversationId: bigint) {
    await this.coalesceRequest(`conversation:members:${conversationId.toString()}`, () =>
      this.conn.reducers.requestConversationMembers({ conversationId })
    );
  }

  async clearConversationMemberRequest(conversationId: bigint) {
    await this.conn.reducers.clearConversationMemberRequest({ conversationId });
  }

  async requestConversationMessages({
    conversationId,
    afterSequence,
    beforeSequence,
    limit,
  }: {
    conversationId: bigint;
    afterSequence?: bigint;
    beforeSequence?: bigint;
    limit?: bigint;
  }) {
    const key = [
      'conversation:history',
      conversationId.toString(),
      afterSequence?.toString() ?? '',
      beforeSequence?.toString() ?? '',
      limit?.toString() ?? '',
    ].join(':');
    await this.coalesceRequest(key, () =>
      this.conn.reducers.requestConversationMessages({
        conversationId,
        afterSequence,
        beforeSequence,
        limit,
      })
    );
  }

  async clearConversationMessageRequest(conversationId: bigint) {
    await this.conn.reducers.clearConversationMessageRequest({ conversationId });
  }

  async markConversationRead(conversationId: bigint, sequence?: bigint) {
    await this.conn.reducers.markConversationRead({ conversationId, sequence });
  }

  listConversationReadCursors(conversationId?: bigint) {
    return Array.from(
      getDbAccessor<ModuleTypes.ConversationReadCursor>(
        this.conn,
        'visible_conversation_read_cursor',
        'visibleConversationReadCursor'
      ).iter()
    ).filter(row => (conversationId ? row.conversationId === conversationId : true));
  }

  conversationReadSequence(conversationId: bigint) {
    return (
      this.listConversationReadCursors(conversationId).find(row =>
        sameIdentity(row.memberIdentity, this.currentIdentity)
      )?.lastReadSequence ?? 0n
    );
  }

  listUnreadConversationMessages(conversationId?: bigint) {
    const rows = Array.from(
      getDbAccessor<ModuleTypes.ConversationMessage>(
        this.conn,
        'visible_unread_conversation_message',
        'visibleUnreadConversationMessage'
      ).iter()
    );
    return rows
      .filter(row => (conversationId ? row.conversationId === conversationId : true))
      .sort(byConversationSequenceAsc);
  }

  listInboxDeliveries({
    conversationId,
    state,
  }: {
    conversationId?: bigint;
    state?: 'unread' | 'delivered' | 'read';
  } = {}) {
    const rows = Array.from(
      getDbAccessor<ModuleTypes.ConversationDelivery>(
        this.conn,
        'visible_inbox_delivery',
        'visibleInboxDelivery'
      ).iter()
    );
    const filtered = rows
      .filter(row => (conversationId ? row.conversationId === conversationId : true))
      .filter(row => (state ? row.state === state : true))
      .sort((left, right) => {
        const sent = right.sent.toDate().getTime() - left.sent.toDate().getTime();
        if (sent !== 0) {
          return sent;
        }
        return right.sequence > left.sequence ? 1 : right.sequence < left.sequence ? -1 : 0;
      });
    for (const row of filtered) {
      this.rememberConversationSequence(row.conversationId, row.sequence);
    }
    return filtered;
  }

  async requestInboxDeliveries({
    conversationId,
    state,
    afterSequence,
    beforeSent,
    limit,
  }: {
    conversationId?: bigint;
    state?: 'unread' | 'delivered' | 'read';
    afterSequence?: bigint;
    beforeSent?: Timestamp;
    limit?: bigint;
  } = {}) {
    const key = [
      'inbox:request',
      conversationId?.toString() ?? '',
      state ?? '',
      afterSequence?.toString() ?? '',
      beforeSent?.toDate().getTime().toString() ?? '',
      limit?.toString() ?? '',
    ].join(':');
    await this.coalesceRequest(key, () =>
      this.conn.reducers.requestInboxDeliveries({
        conversationId,
        state,
        afterSequence,
        beforeSent,
        limit,
      })
    );
  }

  async clearInboxDeliveryRequest() {
    await this.conn.reducers.clearInboxDeliveryRequest({});
  }

  listRequestedInboxDeliveries({
    conversationId,
    state,
  }: {
    conversationId?: bigint;
    state?: 'unread' | 'delivered' | 'read';
  } = {}) {
    const rows = Array.from(
      getDbAccessor<ModuleTypes.ConversationDelivery>(
        this.conn,
        'visible_requested_inbox_delivery',
        'visibleRequestedInboxDelivery'
      ).iter()
    );
    const filtered = rows
      .filter(row => (conversationId ? row.conversationId === conversationId : true))
      .filter(row => (state ? row.state === state : true))
      .sort((left, right) => {
        const sent = right.sent.toDate().getTime() - left.sent.toDate().getTime();
        if (sent !== 0) {
          return sent;
        }
        return right.sequence > left.sequence ? 1 : right.sequence < left.sequence ? -1 : 0;
      });
    for (const row of filtered) {
      this.rememberConversationSequence(row.conversationId, row.sequence);
    }
    return filtered;
  }

  listClientRequestReceipts(action?: string, clientRequestId?: string) {
    const rows = Array.from(
      getDbAccessor<ModuleTypes.ClientRequestReceipt>(
        this.conn,
        'visible_client_request_receipt',
        'visibleClientRequestReceipt'
      ).iter()
    );
    const filtered = rows
      .filter(row => (action ? row.action === action : true))
      .filter(row =>
        clientRequestId ? row.clientRequestId === clientRequestId : true
      )
      .sort((left, right) => right.createdAt.toDate().getTime() - left.createdAt.toDate().getTime());
    for (const row of filtered) {
      this.rememberReceipt(row);
      if (row.conversationId && row.sequence) {
        this.rememberConversationSequence(row.conversationId, row.sequence);
      }
    }
    return filtered;
  }

  waitForReceipt(
    clientRequestId: string,
    timeoutMs = 5000,
    action?: string
  ): Promise<ModuleTypes.ClientRequestReceipt> {
    const existing = this.listClientRequestReceipts(action, clientRequestId)[0];
    if (existing) {
      return Promise.resolve(existing);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for receipt ${clientRequestId}`));
      }, timeoutMs);

      const visibleReceipt = getDbAccessor<ModuleTypes.ClientRequestReceipt>(
        this.conn,
        'visible_client_request_receipt',
        'visibleClientRequestReceipt'
      ) as unknown as {
        onInsert(handler: (ctx: unknown, row: ModuleTypes.ClientRequestReceipt) => void): void;
        onUpdate(handler: (ctx: unknown, oldRow: ModuleTypes.ClientRequestReceipt, row: ModuleTypes.ClientRequestReceipt) => void): void;
        removeOnInsert(handler: (ctx: unknown, row: ModuleTypes.ClientRequestReceipt) => void): void;
        removeOnUpdate(handler: (ctx: unknown, oldRow: ModuleTypes.ClientRequestReceipt, row: ModuleTypes.ClientRequestReceipt) => void): void;
      };

      const matches = (row: ModuleTypes.ClientRequestReceipt) =>
        row.clientRequestId === clientRequestId && (!action || row.action === action);
      const onInsert = (_ctx: unknown, row: ModuleTypes.ClientRequestReceipt) => {
        if (matches(row)) {
          this.rememberReceipt(row);
          if (row.conversationId && row.sequence) {
            this.rememberConversationSequence(row.conversationId, row.sequence);
          }
          cleanup();
          resolve(row);
        }
      };
      const onUpdate = (
        _ctx: unknown,
        _oldRow: ModuleTypes.ClientRequestReceipt,
        row: ModuleTypes.ClientRequestReceipt
      ) => {
        if (matches(row)) {
          this.rememberReceipt(row);
          if (row.conversationId && row.sequence) {
            this.rememberConversationSequence(row.conversationId, row.sequence);
          }
          cleanup();
          resolve(row);
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        visibleReceipt.removeOnInsert(onInsert);
        visibleReceipt.removeOnUpdate(onUpdate);
      };

      visibleReceipt.onInsert(onInsert);
      visibleReceipt.onUpdate(onUpdate);
    });
  }

  waitForDirectConversation(pairKey: string, timeoutMs = 5000) {
    const existing = this.listDirectConversations().find(row => row.pairKey === pairKey);
    if (existing) {
      return Promise.resolve(existing);
    }

    return new Promise<ModuleTypes.DirectConversationIndex>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for direct conversation ${pairKey}`));
      }, timeoutMs);
      const visibleDirect = getDbAccessor<ModuleTypes.DirectConversationIndex>(
        this.conn,
        'visible_direct_conversation',
        'visibleDirectConversation'
      ) as unknown as {
        onInsert(handler: (ctx: unknown, row: ModuleTypes.DirectConversationIndex) => void): void;
        removeOnInsert(handler: (ctx: unknown, row: ModuleTypes.DirectConversationIndex) => void): void;
      };
      const onInsert = (_ctx: unknown, row: ModuleTypes.DirectConversationIndex) => {
        if (row.pairKey === pairKey) {
          this.rememberDirectConversation(row);
          cleanup();
          resolve(row);
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        visibleDirect.removeOnInsert(onInsert);
      };
      visibleDirect.onInsert(onInsert);
    });
  }

  waitForInboxDelivery({
    afterSequence,
    conversationId,
    timeoutMs = 30000,
  }: {
    afterSequence?: bigint;
    conversationId?: bigint;
    timeoutMs?: number;
  } = {}) {
    const existing = this.listInboxDeliveries({ conversationId }).find(row =>
      afterSequence ? row.sequence > afterSequence : true
    );
    if (existing) {
      return Promise.resolve(existing);
    }

    return new Promise<ModuleTypes.ConversationDelivery>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for inbox delivery'));
      }, timeoutMs);
      const visibleDelivery = getDbAccessor<ModuleTypes.ConversationDelivery>(
        this.conn,
        'visible_inbox_delivery',
        'visibleInboxDelivery'
      ) as unknown as {
        onInsert(handler: (ctx: unknown, row: ModuleTypes.ConversationDelivery) => void): void;
        removeOnInsert(handler: (ctx: unknown, row: ModuleTypes.ConversationDelivery) => void): void;
      };
      const onInsert = (_ctx: unknown, row: ModuleTypes.ConversationDelivery) => {
        if (conversationId && row.conversationId !== conversationId) {
          return;
        }
        if (afterSequence && row.sequence <= afterSequence) {
          return;
        }
        this.rememberConversationSequence(row.conversationId, row.sequence);
        cleanup();
        resolve(row);
      };
      const cleanup = () => {
        clearTimeout(timer);
        visibleDelivery.removeOnInsert(onInsert);
      };
      visibleDelivery.onInsert(onInsert);
    });
  }

  waitForWakeRequest({
    status = 'pending',
    conversationId,
    timeoutMs = 30000,
  }: {
    status?: string;
    conversationId?: bigint;
    timeoutMs?: number;
  } = {}) {
    const existing = this.listWakeRequests({
      status,
      conversationId,
      includeDispatcher: true,
    })[0];
    if (existing) {
      return Promise.resolve(existing);
    }

    return new Promise<ModuleTypes.WakeRequestView>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for wake request'));
      }, timeoutMs);
      const visibleWake = getDbAccessor<ModuleTypes.WakeRequestView>(
        this.conn,
        'visible_dispatcher_wake_request',
        'visibleDispatcherWakeRequest'
      ) as unknown as {
        onInsert(handler: (ctx: unknown, row: ModuleTypes.WakeRequestView) => void): void;
        onUpdate(handler: (ctx: unknown, oldRow: ModuleTypes.WakeRequestView, row: ModuleTypes.WakeRequestView) => void): void;
        removeOnInsert(handler: (ctx: unknown, row: ModuleTypes.WakeRequestView) => void): void;
        removeOnUpdate(handler: (ctx: unknown, oldRow: ModuleTypes.WakeRequestView, row: ModuleTypes.WakeRequestView) => void): void;
      };
      const matches = (row: ModuleTypes.WakeRequestView) => {
        if (status && row.status !== status) {
          return false;
        }
        if (conversationId && row.conversationId !== conversationId) {
          return false;
        }
        return true;
      };
      const onInsert = (_ctx: unknown, row: ModuleTypes.WakeRequestView) => {
        if (matches(row)) {
          cleanup();
          resolve(row);
        }
      };
      const onUpdate = (
        _ctx: unknown,
        _oldRow: ModuleTypes.WakeRequestView,
        row: ModuleTypes.WakeRequestView
      ) => {
        if (matches(row)) {
          cleanup();
          resolve(row);
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        visibleWake.removeOnInsert(onInsert);
        visibleWake.removeOnUpdate(onUpdate);
      };
      visibleWake.onInsert(onInsert);
      visibleWake.onUpdate(onUpdate);
    });
  }

  listRequestedConversationMessages(conversationId?: bigint) {
    const rows = Array.from(
      getDbAccessor<ModuleTypes.ConversationMessage>(
        this.conn,
        'visible_requested_conversation_message',
        'visibleRequestedConversationMessage'
      ).iter()
    );
    const filtered = rows
      .filter(row => (conversationId ? row.conversationId === conversationId : true))
      .sort(byConversationSequenceAsc);
    for (const row of filtered) {
      this.rememberConversationSequence(row.conversationId, row.sequence);
    }
    return filtered;
  }

  listConversationMessages(conversationId?: bigint) {
    return this.listRequestedConversationMessages(conversationId);
  }

  async waitForRequestedConversationMessages({
    conversationId,
    minSequence,
    maxSequence,
    timeoutMs = 5000,
  }: {
    conversationId: bigint;
    minSequence: bigint;
    maxSequence: bigint;
    timeoutMs?: number;
  }) {
    const deadline = Date.now() + timeoutMs;
    let latest: ModuleTypes.ConversationMessage[] = [];
    const expectedCount = Number(maxSequence - minSequence + 1n);
    while (Date.now() <= deadline) {
      latest = this.listRequestedConversationMessages(conversationId)
        .filter(row => row.sequence >= minSequence && row.sequence <= maxSequence);
      if (
        latest.length >= expectedCount ||
        latest.some(row => row.sequence === maxSequence)
      ) {
        return latest;
      }
      await sleep(100);
    }
    return latest;
  }

  onConversationMessageInsert(
    callback: (row: ModuleTypes.ConversationMessage) => void
  ) {
    const wrapped = (_ctx: unknown, row: ModuleTypes.ConversationMessage) => {
      callback(row);
    };

    const visibleMessage = getDbAccessor<ModuleTypes.ConversationMessage>(
      this.conn,
      'visible_requested_conversation_message',
      'visibleRequestedConversationMessage'
    ) as unknown as {
      onInsert(handler: typeof wrapped): void;
      removeOnInsert(handler: typeof wrapped): void;
    };

    visibleMessage.onInsert(wrapped);

    return () => {
      visibleMessage.removeOnInsert(wrapped);
    };
  }

  onUnreadConversationMessageInsert(
    callback: (row: ModuleTypes.ConversationMessage) => void
  ) {
    const wrapped = (_ctx: unknown, row: ModuleTypes.ConversationMessage) => {
      callback(row);
    };

    const visibleMessage = getDbAccessor<ModuleTypes.ConversationMessage>(
      this.conn,
      'visible_unread_conversation_message',
      'visibleUnreadConversationMessage'
    ) as unknown as {
      onInsert(handler: typeof wrapped): void;
      removeOnInsert(handler: typeof wrapped): void;
    };

    visibleMessage.onInsert(wrapped);

    return () => {
      visibleMessage.removeOnInsert(wrapped);
    };
  }

  onWakeRequestInsert(callback: (row: ModuleTypes.WakeRequestView) => void) {
    const wrapped = (_ctx: unknown, row: ModuleTypes.WakeRequestView) => {
      callback(row);
    };

    const visibleWake = getDbAccessor<ModuleTypes.WakeRequestView>(
      this.conn,
      'visible_dispatcher_wake_request',
      'visibleDispatcherWakeRequest'
    ) as unknown as {
      onInsert(handler: typeof wrapped): void;
      removeOnInsert(handler: typeof wrapped): void;
    };

    visibleWake.onInsert(wrapped);

    return () => {
      visibleWake.removeOnInsert(wrapped);
    };
  }

  listTasks(channelId?: bigint) {
    return Array.from(
      getDbAccessor<ModuleTypes.AgentTask>(
        this.conn,
        'visible_task',
        'visibleTask'
      ).iter()
    ).filter(row => (channelId ? row.channelId === channelId : true));
  }

  listTaskClaims(taskId?: bigint) {
    return Array.from(
      getDbAccessor<ModuleTypes.TaskClaim>(
        this.conn,
        'visible_task_claim',
        'visibleTaskClaim'
      ).iter()
    ).filter(row => (taskId ? row.taskId === taskId : true));
  }

  listHandoffs(channelId?: bigint) {
    return Array.from(
      getDbAccessor<ModuleTypes.Handoff>(
        this.conn,
        'visible_handoff',
        'visibleHandoff'
      ).iter()
    ).filter(row => (channelId ? row.channelId === channelId : true));
  }

  onAgentEvent(callback: (row: ModuleTypes.AgentEvent) => void) {
    const wrapped = (_ctx: unknown, row: ModuleTypes.AgentEvent) => {
      callback(row);
    };

    const visibleEvent = getDbAccessor<ModuleTypes.AgentEvent>(
      this.conn,
      'visible_agent_event',
      'visibleAgentEvent'
    ) as unknown as {
      onInsert(handler: typeof wrapped): void;
      removeOnInsert(handler: typeof wrapped): void;
    };

    visibleEvent.onInsert(wrapped);

    return () => {
      visibleEvent.removeOnInsert(wrapped);
    };
  }
}

export type AgentTalkWakeHandlerContext = {
  wake: ModuleTypes.WakeRequestView;
  attemptId: string;
};

export type AgentTalkWakeHandler = (
  context: AgentTalkWakeHandlerContext,
  client: AgentTalkWakeClient
) => Promise<void> | void;

export class AgentTalkWakeClient {
  constructor(public readonly realtime: AgentRealtimeClient) {}

  static async connect(options: Omit<AgentClientOptions, 'subscriptionProfile'> = {}) {
    const realtime = await AgentRealtimeClient.connect({
      ...options,
      subscriptionProfile: 'wake',
    });
    return new AgentTalkWakeClient(realtime);
  }

  get identityHex() {
    return this.realtime.identityHex;
  }

  disconnect() {
    this.realtime.disconnect();
  }

  async registerWake(input: WakeRegistrationInput) {
    await this.realtime.registerWake(input);
  }

  async registerWakeHandler(handler: AgentTalkWakeHandler) {
    const inFlightWakeIds = new Set<string>();
    const run = async (wake: ModuleTypes.WakeRequestView) => {
      if (inFlightWakeIds.has(wake.wakeId)) {
        return;
      }
      inFlightWakeIds.add(wake.wakeId);
      let attemptId: string | undefined;
      try {
        await this.realtime.claimWakeRequest({ wakeId: wake.wakeId });
        await sleep(250);
        const claimedWake =
          this.realtime
            .listWakeRequests({ includeDispatcher: true })
            .find(row => row.wakeId === wake.wakeId) ?? wake;
        const latestAttempt = this.realtime
          .listWakeAttempts(wake.wakeId)
          .sort((left, right) =>
            left.attemptNumber < right.attemptNumber
              ? 1
              : left.attemptNumber > right.attemptNumber
                ? -1
                : 0
          )[0];
        attemptId = latestAttempt?.attemptId;
        if (!attemptId) {
          throw new Error(`Wake ${wake.wakeId} was claimed but no attempt row is visible`);
        }
        await handler({ wake: claimedWake, attemptId }, this);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attemptId) {
          await this.failWake(wake.wakeId, message, attemptId);
        }
      } finally {
        inFlightWakeIds.delete(wake.wakeId);
      }
    };

    const detach = this.realtime.onWakeRequestInsert(wake => {
      if (wake.status === 'pending') {
        void run(wake);
      }
    });

    for (const wake of this.realtime.listWakeRequests({
      status: 'pending',
      includeDispatcher: true,
    })) {
      void run(wake);
    }

    return detach;
  }

  async fetchWakeContext(wake: ModuleTypes.WakeRequestView) {
    const afterSequence = wake.minSequence > 0n ? wake.minSequence - 1n : undefined;
    const span = Number(wake.maxSequence - wake.minSequence + 1n);
    await this.realtime.requestConversationMessages({
      conversationId: wake.conversationId,
      afterSequence,
      limit: BigInt(Math.min(Math.max(span, 1), 100)),
    });
    return this.realtime.waitForRequestedConversationMessages({
      conversationId: wake.conversationId,
      minSequence: wake.minSequence,
      maxSequence: wake.maxSequence,
    });
  }

  async ackWake(wakeId: string, attemptId?: string) {
    await this.realtime.ackWakeRequest(wakeId, attemptId);
  }

  async failWake(wakeId: string, error: string, attemptId?: string) {
    await this.realtime.failWakeRequest(wakeId, error, { attemptId });
  }

  async replyToWake(wake: ModuleTypes.WakeRequestView, text: string, input: RichMessageInput = {}) {
    return this.realtime.sendConversationMessage(wake.conversationId, text, input);
  }
}
