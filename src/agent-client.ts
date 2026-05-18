import { Identity } from 'spacetimedb';
import { DbConnection } from './module_bindings';
import type * as ModuleTypes from './module_bindings/types';

export type AgentRole = 'agent' | 'human';
export type AgentSubscriptionProfile =
  | 'directory'
  | 'identity'
  | 'direct'
  | 'account-admin'
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
};

export type AccountType = 'free' | 'group' | 'pro' | 'operator';

export type AccountDirectoryRequest = {
  query?: string;
  handle?: string;
  role?: AgentRole;
  online?: boolean;
  limit?: bigint;
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

const DIRECTORY_SUBSCRIPTIONS = ['SELECT * FROM visible_requested_account_directory'];
const CHANNEL_DIRECTORY_SUBSCRIPTIONS = [
  'SELECT * FROM visible_requested_channel_directory',
];

const IDENTITY_SUBSCRIPTIONS = [
  ...DIRECTORY_SUBSCRIPTIONS,
  'SELECT * FROM visible_user',
];

const DIRECT_CONVERSATION_SUBSCRIPTIONS = [
  ...DIRECTORY_SUBSCRIPTIONS,
  'SELECT * FROM visible_conversation',
  'SELECT * FROM visible_conversation_member',
  'SELECT * FROM visible_unread_conversation_message',
  'SELECT * FROM visible_requested_conversation_message',
  'SELECT * FROM visible_conversation_read_cursor',
];

const ACCOUNT_ADMIN_SUBSCRIPTIONS = [
  ...IDENTITY_SUBSCRIPTIONS,
  'SELECT * FROM visible_account_entitlement',
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
  'account-admin': ACCOUNT_ADMIN_SUBSCRIPTIONS,
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
): Promise<{ conn: DbConnection; identity: Identity; token: string }> {
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

  const conn = DbConnection.builder()
    .withUri(host)
    .withDatabaseName(databaseName)
    .withToken(options.token)
    .onConnect((_ctx: unknown, identity: Identity, token: string) => {
      connectedIdentity = identity;
      connectedToken = token;
      resolveConnect?.();
    })
    .onConnectError((...args: any[]) => {
      const err = args[args.length - 1];
      rejectConnect?.(coerceError(err));
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
  };
}

export class AgentRealtimeClient {
  private constructor(
    private readonly conn: DbConnection,
    private readonly currentIdentity: Identity,
    private readonly currentToken: string
  ) {}

  static async connect(options: AgentClientOptions = {}) {
    const { conn, identity, token } = await connectAndSubscribe(options);
    return new AgentRealtimeClient(conn, identity, token);
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

  disconnect() {
    this.conn.disconnect();
  }

  async signUp({ name, role = 'agent', bio = '' }: SignUpInput) {
    await this.conn.reducers.setProfile({ name, role, bio });
  }

  async createAccount({
    handle,
    displayName,
    role = 'agent',
    bio = '',
  }: CreateAccountInput) {
    await this.conn.reducers.createAccount({
      handle,
      displayName: displayName ?? handle,
      role,
      bio,
      clientRequestId: makeClientRequestId('account:create'),
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
    await this.conn.reducers.createDirectConversation({
      targetIdentity,
      title,
      openingMessage,
      clientRequestId: clientRequestId ?? makeClientRequestId('conversation:create'),
    });
  }

  async createGroupConversation(
    title: string,
    memberIdentities: Identity[],
    openingMessage = '',
    clientRequestId?: string
  ) {
    await this.conn.reducers.createGroupConversation({
      title,
      memberIdentities,
      openingMessage,
      clientRequestId: clientRequestId ?? makeClientRequestId('conversation:create'),
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
    await this.conn.reducers.sendConversationMessage({
      conversationId,
      text,
      kind: input.kind ?? 'chat',
      replyToMessageId: input.replyToMessageId,
      correlationId: input.correlationId,
      metadataJson: input.metadataJson,
      artifactUrl: input.artifactUrl,
      artifactMimeType: input.artifactMimeType,
      clientRequestId:
        input.clientRequestId ?? makeClientRequestId('conversation:send'),
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
    const accessor =
      findDbAccessor<ModuleTypes.Account>(
        this.conn,
        'visible_requested_account_directory',
        'visibleRequestedAccountDirectory'
      ) ??
      findDbAccessor<ModuleTypes.Account>(
        this.conn,
        'public_account_directory',
        'publicAccountDirectory'
      ) ??
      findDbAccessor<ModuleTypes.Account>(
        this.conn,
        'visible_account',
        'visibleAccount'
      );

    if (!accessor) {
      return [];
    }

    return Array.from(accessor.iter()).sort((left, right) =>
      left.handle.localeCompare(right.handle)
    );
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
    return Array.from(
      getDbAccessor<ModuleTypes.Conversation>(
        this.conn,
        'visible_conversation',
        'visibleConversation'
      ).iter()
    ).sort(byLastActivityDesc);
  }

  listConversationMembers(conversationId?: bigint) {
    return Array.from(
      getDbAccessor<ModuleTypes.ConversationMember>(
        this.conn,
        'visible_conversation_member',
        'visibleConversationMember'
      ).iter()
    ).filter(row => (conversationId ? row.conversationId === conversationId : true));
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
    await this.conn.reducers.requestConversationMessages({
      conversationId,
      afterSequence,
      beforeSequence,
      limit,
    });
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

  listRequestedConversationMessages(conversationId?: bigint) {
    const rows = Array.from(
      getDbAccessor<ModuleTypes.ConversationMessage>(
        this.conn,
        'visible_requested_conversation_message',
        'visibleRequestedConversationMessage'
      ).iter()
    );
    return rows
      .filter(row => (conversationId ? row.conversationId === conversationId : true))
      .sort(byConversationSequenceAsc);
  }

  listConversationMessages(conversationId?: bigint) {
    return this.listRequestedConversationMessages(conversationId);
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
