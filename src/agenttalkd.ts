#!/usr/bin/env node
import { existsSync, readFileSync, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
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
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

function parseIdentity(value: string) {
  return Identity.fromString(value);
}

function coerceErrorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
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
  private reconnectPromise: Promise<void> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private client: AgentRealtimeClient,
    private state: AgenttalkState,
    private readonly profile: AgentSubscriptionProfile
  ) {}

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
    await saveState({ host, databaseName, token: client.token });
    await client.heartbeat('agenttalkd online', 'agenttalkd');
    return new AgenttalkDaemon(client, { host, databaseName, token: client.token }, profile);
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
    } catch (error) {
      this.lastConnectionError = coerceErrorText(error);
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
    return /disconnect|closed|websocket|socket|network|connection|econn|timed out waiting for receipt|timed out waiting for inbox/i.test(text);
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
          await client.heartbeat('agenttalkd reconnected', 'agenttalkd');
          this.client = client;
          this.state = {
            ...this.state,
            token: client.token,
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

  private async hydrateDeliveryMessage(delivery: ModuleTypes.ConversationDelivery) {
    await this.client.requestConversationMessages({
      conversationId: delivery.conversationId,
      afterSequence: delivery.sequence > 0n ? delivery.sequence - 1n : undefined,
      limit: 5n,
    });
    await sleep(100);
    const message = this.client
      .listRequestedConversationMessages(delivery.conversationId)
      .find(
        row =>
          row.id === delivery.messageId ||
          (row.sequence ?? row.id) === delivery.sequence
      );
    return message ? conversationMessageDto(message) : null;
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
        return {
          id,
          ok: true,
          data: {
            identity: this.client.identityHex,
            agentId: profile?.agentId ?? null,
            handle: profile?.handle ?? null,
            host: this.state.host,
            databaseName: this.state.databaseName,
            hotRetentionHours: Number(retention?.hotRetentionHours ?? 12n),
            archiveConfigured: retention?.archiveConfigured ?? false,
          },
        };
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
        const limit = Math.min(Number(payload.limit ?? payload.max ?? 10), 100);
        const deliveries = this.client
          .listInboxDeliveries({ state: payload.state as 'unread' | 'delivered' | 'read' | undefined })
          .slice(0, limit);
        const hydrate = this.shouldHydrate(payload);
        const items = [];
        for (const delivery of deliveries) {
          this.rememberConversationSequence(delivery.conversationId, delivery.sequence);
          items.push({
            delivery: deliveryDto(delivery),
            message: hydrate ? await this.hydrateDeliveryMessage(delivery) : null,
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
        const limit = BigInt(Math.min(Number(payload.limit ?? 50), 100));
        await this.client.requestConversationMessages({
          conversationId,
          afterSequence,
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
        const timeoutMs = Math.min(Number(payload.timeoutMs ?? payload.timeout_ms ?? 30000), 120000);
        const delivery = await this.client.waitForInboxDelivery({
          conversationId,
          afterSequence,
          timeoutMs,
        });
        this.rememberConversationSequence(delivery.conversationId, delivery.sequence);
        return {
          id,
          ok: true,
          data: {
            delivery: deliveryDto(delivery),
            message: this.shouldHydrate(payload)
              ? await this.hydrateDeliveryMessage(delivery)
              : null,
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
            inboxDeliveryCount: this.client.connected
              ? this.client.listInboxDeliveries().length
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
  output: NodeJS.WritableStream
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
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const response = await daemon.handle(payload);
    writeJsonLine(output, response);
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
  await fs.writeFile(PID_PATH, `${process.pid}\n`, 'utf8');

  let server: net.Server | undefined;
  if (ipc) {
    const pipePath = daemonPipePath();
    if (process.platform !== 'win32') {
      await fs.rm(pipePath, { force: true });
    }
    server = net.createServer(socket => {
      void serveLineInterface(daemon, socket, socket);
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(pipePath, () => resolve());
    });
  }

  if (stdio) {
    await serveLineInterface(daemon, process.stdin, process.stdout);
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
