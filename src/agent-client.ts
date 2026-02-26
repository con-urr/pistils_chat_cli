import { Identity } from 'spacetimedb';
import { DbConnection } from './module_bindings';
import type * as ModuleTypes from './module_bindings/types';

export type AgentRole = 'agent' | 'human';

export type AgentClientOptions = {
  host?: string;
  databaseName?: string;
  token?: string;
};

export type SignUpInput = {
  name: string;
  role?: AgentRole;
  bio?: string;
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

function byLastActivityDesc<T extends { lastActivity: { toDate(): Date } }>(
  left: T,
  right: T
) {
  return right.lastActivity.toDate().getTime() - left.lastActivity.toDate().getTime();
}

function byNameAsc<T extends { name: string }>(left: T, right: T) {
  return left.name.localeCompare(right.name);
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
      rejectConnect?.(err instanceof Error ? err : new Error(String(err)));
    })
    .build();

  await connected;

  const subscribed = new Promise<void>((resolve, reject) => {
    conn
      .subscriptionBuilder()
      .onApplied(() => resolve())
      .onError((...args: any[]) => {
        const err = args[args.length - 1];
        reject(err instanceof Error ? err : new Error(String(err)));
      })
      .subscribe((query: any) => [
        query.user,
        query.channel,
        query.thread,
        query.message,
      ]);
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

  async createChannel(name: string, topic: string) {
    await this.conn.reducers.createChannel({ name, topic });
  }

  async joinChannel(channelId: bigint) {
    await this.conn.reducers.joinChannel({ channelId });
  }

  async leaveChannel(channelId: bigint) {
    await this.conn.reducers.leaveChannel({ channelId });
  }

  async createThread(channelId: bigint, title: string, openingMessage: string) {
    await this.conn.reducers.createThread({
      channelId,
      title,
      openingMessage,
    });
  }

  async sendThreadMessage(threadId: bigint, text: string) {
    await this.conn.reducers.sendThreadMessage({ threadId, text });
  }

  listUsers() {
    return Array.from(this.conn.db.user.iter());
  }

  listChannels() {
    return Array.from(this.conn.db.channel.iter()).sort(byNameAsc);
  }

  listMemberships() {
    return Array.from(this.conn.db.channelMember.iter());
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
    const rows = Array.from(this.conn.db.thread.iter());
    return rows
      .filter(row => (channelId ? row.channelId === channelId : true))
      .sort(byLastActivityDesc);
  }

  listMessages(threadId?: bigint) {
    const rows = Array.from(this.conn.db.message.iter());
    return rows
      .filter(row => (threadId ? row.threadId === threadId : true))
      .sort(byTimestampAsc);
  }

  onMessageInsert(callback: (row: ModuleTypes.Message) => void) {
    const wrapped = (_ctx: unknown, row: ModuleTypes.Message) => {
      callback(row);
    };

    this.conn.db.message.onInsert(wrapped);

    return () => {
      this.conn.db.message.removeOnInsert(wrapped);
    };
  }
}
