import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { setGlobalLogLevel } from 'spacetimedb';
import { z } from 'zod';
import type { AgentRealtimeClient, RichMessageInput } from '../agent-client';
import type * as ModuleTypes from '../module_bindings/types';
import {
  clampTimeoutMs,
  currentAccount,
  loadMcpState,
  normalizeAccountRef,
  normalizeRole,
  parseBigIntInput,
  resolveAccount,
  resolveMcpConnectConfig,
  resolveTargetIdentity,
  sanitizeForMcp,
  sleep,
  stateDir,
  statePath,
  withMcpClient,
} from './context';
import { errorMessage, fail, ok, toolResult, type AgentTalkMcpResult } from './result';
export { runWithMcpRequestOverrides } from './context';

type ToolShape = Record<string, z.ZodTypeAny>;
type ToolHandler = (args: Record<string, unknown>) => Promise<AgentTalkMcpResult<unknown>>;

const DIRECTORY_SYNC_DELAY_MS = 250;
const DEFAULT_INBOX_WAIT_MS = 0;
const MAX_INBOX_WAIT_MS = 30_000;
const DEFAULT_LISTEN_WAIT_MS = 30_000;
const MAX_LISTEN_WAIT_MS = 120_000;

const roleSchema = z.enum(['agent', 'human']).optional();
const messageKindSchema = z
  .enum(['chat', 'task', 'handoff', 'tool_result', 'approval_request', 'status', 'system'])
  .optional();
const wakeStatusSchema = z
  .enum(['pending', 'leased', 'dispatched', 'acked', 'failed', 'suppressed', 'expired'])
  .optional();

function registerTool(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: ToolShape,
  handler: ToolHandler
) {
  const register = server.registerTool.bind(server) as (
    toolName: string,
    config: {
      title: string;
      description: string;
      inputSchema: ToolShape;
    },
    callback: (args: unknown) => Promise<CallToolResult>
  ) => unknown;
  register(
    name,
    {
      title: name,
      description,
      inputSchema,
    },
    async (args: unknown): Promise<CallToolResult> => {
      try {
        const result = await handler((args ?? {}) as Record<string, unknown>);
        return toolResult(result);
      } catch (error) {
        return toolResult(
          fail('tool_failed', errorMessage(error), {
            reason: 'exception',
          })
        );
      }
    }
  );
}

function richInput(args: Record<string, unknown>): RichMessageInput {
  return {
    kind: (args.kind as RichMessageInput['kind'] | undefined) ?? 'chat',
    replyToMessageId: parseBigIntInput(args.replyToMessageId, 'replyToMessageId'),
    correlationId: typeof args.correlationId === 'string' ? args.correlationId : undefined,
    metadataJson: typeof args.metadataJson === 'string' ? args.metadataJson : undefined,
    artifactUrl: typeof args.artifactUrl === 'string' ? args.artifactUrl : undefined,
    artifactMimeType:
      typeof args.artifactMimeType === 'string' ? args.artifactMimeType : undefined,
    clientRequestId:
      typeof args.clientRequestId === 'string' ? args.clientRequestId : undefined,
  };
}

function profileData(client: AgentRealtimeClient) {
  const account = currentAccount(client);
  const profile = client.currentAgentProfile();
  const entitlement = client.currentAccountEntitlement();
  return {
    identity: client.identityHex,
    account: sanitizeForMcp(account ?? null),
    profile: sanitizeForMcp(profile ?? null),
    entitlement: sanitizeForMcp(entitlement ?? null),
  };
}

async function searchAccounts(
  client: AgentRealtimeClient,
  args: Record<string, unknown>,
  defaultLimit = 20
) {
  const query = typeof args.query === 'string' ? args.query : undefined;
  const handle =
    typeof args.handle === 'string' && args.handle.trim()
      ? normalizeAccountRef(args.handle)
      : undefined;
  const role = normalizeRole(typeof args.role === 'string' ? args.role : undefined);
  const online = typeof args.online === 'boolean' ? args.online : undefined;
  const limit = parseBigIntInput(args.limit, 'limit') ?? BigInt(defaultLimit);
  await client.requestAccountDirectory({ query, handle, role, online, limit });
  await sleep(DIRECTORY_SYNC_DELAY_MS);
  return client.searchAccounts({ query, handle, role, online }).slice(0, Number(limit));
}

async function receiptOrLatest(
  client: AgentRealtimeClient,
  clientRequestId: string,
  action: string
) {
  try {
    return await client.waitForReceipt(clientRequestId, 5000, action);
  } catch {
    return client.listClientRequestReceipts(action, clientRequestId)[0] ?? null;
  }
}

function wakeStatusData(client: AgentRealtimeClient, wakeId?: string) {
  const profile = client.currentAgentWakeProfile();
  const policy = client.currentWakePolicy();
  const registrations = client.listWakeRegistrations();
  const requests = client.listWakeRequests({
    includeDispatcher: true,
  });
  const filteredRequests = wakeId
    ? requests.filter(request => request.wakeId === wakeId)
    : requests;
  return {
    profile: sanitizeForMcp(profile ?? null),
    policy: sanitizeForMcp(policy ?? null),
    registrations: sanitizeForMcp(registrations),
    requests: sanitizeForMcp(filteredRequests),
    attempts: sanitizeForMcp(client.listWakeAttempts(wakeId)),
  };
}

async function waitForConversationMessage(
  client: AgentRealtimeClient,
  conversationId: bigint,
  afterSequence: bigint | undefined,
  timeoutMs: number
) {
  await client.requestConversationMessages({
    conversationId,
    afterSequence,
    limit: 20n,
  });
  await sleep(DIRECTORY_SYNC_DELAY_MS);
  const existing = client
    .listConversationMessages(conversationId)
    .find(row => (afterSequence ? row.sequence > afterSequence : true));
  if (existing) {
    return existing;
  }

  return await new Promise<ModuleTypes.ConversationMessage | null>(resolve => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
    const detach = client.onConversationMessageInsert(row => {
      if (row.conversationId !== conversationId) {
        return;
      }
      if (afterSequence && row.sequence <= afterSequence) {
        return;
      }
      cleanup();
      resolve(row);
    });
    const cleanup = () => {
      clearTimeout(timer);
      detach();
    };
  });
}

function registerIdentityTools(server: McpServer) {
  registerTool(server, 'agenttalk_whoami', 'Return the current AgentTalk identity safely.', {}, async () =>
    withMcpClient('direct', async ({ client, config }) =>
      ok({
        host: config.host,
        databaseName: config.databaseName,
        ...profileData(client),
      })
    )
  );

  registerTool(
    server,
    'agenttalk_doctor',
    'Check local AgentTalk MCP configuration and backend connectivity without printing secrets.',
    {},
    async () => {
      const state = await loadMcpState();
      const config = resolveMcpConnectConfig(state);
      return withMcpClient('direct', async ({ client }) =>
        ok({
          configured: {
            host: config.host,
            databaseName: config.databaseName,
            stateDirConfigured: Boolean(process.env.AGENTTALK_STATE_DIR),
            hasStateFile: Boolean(state.token || state.host || state.databaseName),
            hasToken: Boolean(config.token),
            stateDir: stateDir() ? '[redacted]' : null,
            statePath: statePath() ? '[redacted]' : null,
          },
          connected: true,
          identity: client.identityHex,
          account: sanitizeForMcp(currentAccount(client) ?? null),
        })
      );
    }
  );

  registerTool(
    server,
    'agenttalk_init_account',
    'Create or bind the current local identity to an AgentTalk account.',
    {
      handle: z.string().min(1),
      displayName: z.string().optional(),
      role: roleSchema,
      bio: z.string().optional(),
      clientRequestId: z.string().optional(),
    },
    async args =>
      withMcpClient('account-admin', async ({ client }) => {
        const handle = normalizeAccountRef(String(args.handle));
        await client.createAccount({
          handle,
          displayName: typeof args.displayName === 'string' ? args.displayName : undefined,
          role: normalizeRole(typeof args.role === 'string' ? args.role : undefined) ?? 'agent',
          bio: typeof args.bio === 'string' ? args.bio : '',
          clientRequestId:
            typeof args.clientRequestId === 'string' ? args.clientRequestId : undefined,
        });
        await client.requestAccountDirectory({ handle, limit: 1n });
        await sleep(DIRECTORY_SYNC_DELAY_MS);
        const account = client.searchAccounts({ handle })[0] ?? currentAccount(client) ?? null;
        return ok({
          account: sanitizeForMcp(account),
          identity: client.identityHex,
        });
      })
  );

  registerTool(
    server,
    'agenttalk_search_accounts',
    'Search the AgentTalk account directory.',
    {
      query: z.string().optional(),
      handle: z.string().optional(),
      role: roleSchema,
      online: z.boolean().optional(),
      limit: z.union([z.string(), z.number()]).optional(),
    },
    async args =>
      withMcpClient('directory', async ({ client }) =>
        ok({
          accounts: sanitizeForMcp(await searchAccounts(client, args)),
        })
      )
  );
}

function registerConversationTools(server: McpServer) {
  registerTool(
    server,
    'agenttalk_chat_start',
    'Send a direct AgentTalk message to a handle or identity.',
    {
      target: z.string().min(1),
      message: z.string().min(1),
      kind: messageKindSchema,
      metadataJson: z.string().optional(),
      correlationId: z.string().optional(),
      clientRequestId: z.string().optional(),
    },
    async args =>
      withMcpClient('direct', async ({ client }) => {
        const target = String(args.target);
        const targetAccount = await resolveAccount(client, target);
        const targetIdentity = targetAccount ? undefined : await resolveTargetIdentity(client, target);
        const requestId = await client.sendDirectMessage({
          targetAgentId: targetAccount?.agentId ?? undefined,
          targetIdentity,
          text: String(args.message),
          kind: (args.kind as RichMessageInput['kind'] | undefined) ?? 'chat',
          metadataJson: typeof args.metadataJson === 'string' ? args.metadataJson : undefined,
          correlationId: typeof args.correlationId === 'string' ? args.correlationId : undefined,
          clientRequestId:
            typeof args.clientRequestId === 'string' ? args.clientRequestId : undefined,
        });
        const receipt = await receiptOrLatest(client, requestId, 'direct:send');
        return ok(
          {
            clientRequestId: requestId,
            receipt: sanitizeForMcp(receipt),
            target: sanitizeForMcp(targetAccount ?? targetIdentity?.toHexString() ?? target),
          },
          [
            {
              label: 'Read your inbox',
              tool: 'agenttalk_inbox',
              args: { limit: 10 },
            },
          ]
        );
      })
  );

  registerTool(
    server,
    'agenttalk_conversation_reply',
    'Send a message into an existing AgentTalk conversation.',
    {
      conversationId: z.union([z.string(), z.number()]),
      message: z.string().min(1),
      kind: messageKindSchema,
      replyToMessageId: z.union([z.string(), z.number()]).optional(),
      metadataJson: z.string().optional(),
      correlationId: z.string().optional(),
      artifactUrl: z.string().optional(),
      artifactMimeType: z.string().optional(),
      clientRequestId: z.string().optional(),
    },
    async args =>
      withMcpClient('direct', async ({ client }) => {
        const conversationId = parseBigIntInput(args.conversationId, 'conversationId');
        if (!conversationId) {
          throw new Error('conversationId is required');
        }
        const requestId = await client.sendConversationMessage(
          conversationId,
          String(args.message),
          richInput(args)
        );
        const receipt = await receiptOrLatest(client, requestId, 'conversation:send');
        return ok({
          clientRequestId: requestId,
          receipt: sanitizeForMcp(receipt),
        });
      })
  );

  registerTool(
    server,
    'agenttalk_conversation_list',
    'List conversations visible to the current AgentTalk identity.',
    {
      kind: z.enum(['direct', 'group']).optional(),
      limit: z.union([z.string(), z.number()]).optional(),
    },
    async args =>
      withMcpClient('direct', async ({ client }) => {
        const kind = args.kind === 'direct' || args.kind === 'group' ? args.kind : undefined;
        const limit = parseBigIntInput(args.limit, 'limit') ?? 20n;
        await client.requestConversations({ kind, limit });
        await sleep(DIRECTORY_SYNC_DELAY_MS);
        return ok({
          conversations: sanitizeForMcp(client.listConversations().slice(0, Number(limit))),
          summaries: sanitizeForMcp(client.listConversationSummaries()),
        });
      })
  );

  registerTool(
    server,
    'agenttalk_conversation_messages',
    'Fetch a bounded page of messages for a conversation.',
    {
      conversationId: z.union([z.string(), z.number()]),
      afterSequence: z.union([z.string(), z.number()]).optional(),
      beforeSequence: z.union([z.string(), z.number()]).optional(),
      limit: z.union([z.string(), z.number()]).optional(),
    },
    async args =>
      withMcpClient('direct', async ({ client }) => {
        const conversationId = parseBigIntInput(args.conversationId, 'conversationId');
        if (!conversationId) {
          throw new Error('conversationId is required');
        }
        const afterSequence = parseBigIntInput(args.afterSequence, 'afterSequence');
        const beforeSequence = parseBigIntInput(args.beforeSequence, 'beforeSequence');
        const limit = parseBigIntInput(args.limit, 'limit') ?? 20n;
        await client.requestConversationMessages({
          conversationId,
          afterSequence,
          beforeSequence,
          limit,
        });
        await sleep(DIRECTORY_SYNC_DELAY_MS);
        return ok({
          messages: sanitizeForMcp(client.listConversationMessages(conversationId)),
        });
      })
  );

  registerTool(
    server,
    'agenttalk_inbox',
    'Read the current account inbox with an optional bounded wait.',
    {
      conversationId: z.union([z.string(), z.number()]).optional(),
      state: z.enum(['unread', 'delivered', 'read']).optional(),
      limit: z.union([z.string(), z.number()]).optional(),
      waitMs: z.number().optional(),
    },
    async args =>
      withMcpClient('direct', async ({ client }) => {
        const conversationId = parseBigIntInput(args.conversationId, 'conversationId');
        const state =
          args.state === 'unread' || args.state === 'delivered' || args.state === 'read'
            ? args.state
            : undefined;
        const limit = parseBigIntInput(args.limit, 'limit') ?? 20n;
        const waitMs = clampTimeoutMs(
          typeof args.waitMs === 'number' ? args.waitMs : undefined,
          DEFAULT_INBOX_WAIT_MS,
          MAX_INBOX_WAIT_MS
        );
        await client.requestInboxDeliveries({ conversationId, state, limit });
        await sleep(DIRECTORY_SYNC_DELAY_MS);
        let deliveries = client.listRequestedInboxDeliveries({ conversationId, state });
        if (deliveries.length === 0 && waitMs > 0) {
          await client.waitForInboxDelivery({ conversationId, timeoutMs: waitMs }).catch(() => null);
          await client.requestInboxDeliveries({ conversationId, state, limit });
          await sleep(DIRECTORY_SYNC_DELAY_MS);
          deliveries = client.listRequestedInboxDeliveries({ conversationId, state });
        }
        return ok({
          deliveries: sanitizeForMcp(deliveries.slice(0, Number(limit))),
        });
      })
  );

  registerTool(
    server,
    'agenttalk_listen_conversation',
    'Wait for at most 120 seconds for one message in a conversation.',
    {
      conversationId: z.union([z.string(), z.number()]),
      afterSequence: z.union([z.string(), z.number()]).optional(),
      timeoutMs: z.number().optional(),
    },
    async args =>
      withMcpClient('direct', async ({ client }) => {
        const conversationId = parseBigIntInput(args.conversationId, 'conversationId');
        if (!conversationId) {
          throw new Error('conversationId is required');
        }
        const afterSequence = parseBigIntInput(args.afterSequence, 'afterSequence');
        const timeoutMs = clampTimeoutMs(
          typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
          DEFAULT_LISTEN_WAIT_MS,
          MAX_LISTEN_WAIT_MS
        );
        const message = await waitForConversationMessage(
          client,
          conversationId,
          afterSequence,
          timeoutMs
        );
        return ok({
          timeoutMs,
          message: sanitizeForMcp(message),
          timedOut: !message,
        });
      })
  );

  registerTool(
    server,
    'agenttalk_mark_read',
    'Mark a conversation read up to an optional sequence.',
    {
      conversationId: z.union([z.string(), z.number()]),
      sequence: z.union([z.string(), z.number()]).optional(),
    },
    async args =>
      withMcpClient('direct', async ({ client }) => {
        const conversationId = parseBigIntInput(args.conversationId, 'conversationId');
        if (!conversationId) {
          throw new Error('conversationId is required');
        }
        const sequence = parseBigIntInput(args.sequence, 'sequence');
        await client.markConversationRead(conversationId, sequence);
        return ok({
          conversationId: conversationId.toString(),
          sequence: sequence?.toString() ?? null,
        });
      })
  );
}

function registerWakeTools(server: McpServer) {
  registerTool(
    server,
    'agenttalk_wake_status',
    'Return safe wake profile, policy, registration, request, and attempt state.',
    {
      wakeId: z.string().optional(),
    },
    async args =>
      withMcpClient('wake', async ({ client }) =>
        ok(wakeStatusData(client, typeof args.wakeId === 'string' ? args.wakeId : undefined))
      )
  );

  registerTool(
    server,
    'agenttalk_wake_enable',
    'Enable wakeability for the current AgentTalk account.',
    {
      expectedWakeLatencyMs: z.union([z.string(), z.number()]).optional(),
      statusText: z.string().optional(),
    },
    async args =>
      withMcpClient('wake', async ({ client }) => {
        const profile = client.currentAgentProfile();
        if (!profile) {
          throw new Error('No current AgentTalk account profile found. Run agenttalk_init_account first.');
        }
        await client.registerWake({
          agentId: profile.agentId,
          kind: 'local_daemon',
          enabled: true,
          metadataJson: JSON.stringify({ source: 'agenttalk-mcp' }),
        });
        await client.setWakePolicy({
          agentId: profile.agentId,
          wakeOnDirectMessage: true,
          wakeOnMention: true,
          wakeOnGroupMessage: false,
          wakeOnHandoff: true,
          wakeOnBusinessInquiry: true,
          acceptsNewConversations: true,
          availabilityOverride: 'wakeable',
          expectedWakeLatencyMs: parseBigIntInput(
            args.expectedWakeLatencyMs,
            'expectedWakeLatencyMs'
          ),
          statusText: typeof args.statusText === 'string' ? args.statusText : undefined,
        });
        await sleep(DIRECTORY_SYNC_DELAY_MS);
        return ok(wakeStatusData(client));
      })
  );

  registerTool(server, 'agenttalk_wake_disable', 'Disable wakeability for the current account.', {}, async () =>
    withMcpClient('wake', async ({ client }) => {
      const profile = client.currentAgentProfile();
      if (!profile) {
        throw new Error('No current AgentTalk account profile found.');
      }
      await client.setWakePolicy({
        agentId: profile.agentId,
        wakeOnDirectMessage: false,
        wakeOnMention: false,
        wakeOnGroupMessage: false,
        wakeOnHandoff: false,
        wakeOnBusinessInquiry: false,
        acceptsNewConversations: false,
        availabilityOverride: 'offline',
      });
      await client.disableWakeRegistration({ agentId: profile.agentId });
      await sleep(DIRECTORY_SYNC_DELAY_MS);
      return ok(wakeStatusData(client));
    })
  );

  registerTool(server, 'agenttalk_wake_policy_get', 'Return the current wake policy.', {}, async () =>
    withMcpClient('wake', async ({ client }) =>
      ok({
        policy: sanitizeForMcp(client.currentWakePolicy() ?? null),
      })
    )
  );

  registerTool(
    server,
    'agenttalk_wake_policy_set',
    'Set wake policy fields for the current account.',
    {
      wakeOnDirectMessage: z.boolean().optional(),
      wakeOnMention: z.boolean().optional(),
      wakeOnGroupMessage: z.boolean().optional(),
      wakeOnHandoff: z.boolean().optional(),
      wakeOnBusinessInquiry: z.boolean().optional(),
      acceptsNewConversations: z.boolean().optional(),
      minWakeIntervalMs: z.union([z.string(), z.number()]).optional(),
      coalesceWindowMs: z.union([z.string(), z.number()]).optional(),
      maxWakesPerMinute: z.union([z.string(), z.number()]).optional(),
      maxConcurrentWakeJobs: z.union([z.string(), z.number()]).optional(),
      expectedWakeLatencyMs: z.union([z.string(), z.number()]).optional(),
      availabilityOverride: z
        .enum(['online', 'wakeable', 'sleeping', 'offline', 'unavailable'])
        .optional(),
      statusText: z.string().optional(),
    },
    async args =>
      withMcpClient('wake', async ({ client }) => {
        const profile = client.currentAgentProfile();
        if (!profile) {
          throw new Error('No current AgentTalk account profile found.');
        }
        await client.setWakePolicy({
          agentId: profile.agentId,
          wakeOnDirectMessage:
            typeof args.wakeOnDirectMessage === 'boolean'
              ? args.wakeOnDirectMessage
              : undefined,
          wakeOnMention: typeof args.wakeOnMention === 'boolean' ? args.wakeOnMention : undefined,
          wakeOnGroupMessage:
            typeof args.wakeOnGroupMessage === 'boolean' ? args.wakeOnGroupMessage : undefined,
          wakeOnHandoff:
            typeof args.wakeOnHandoff === 'boolean' ? args.wakeOnHandoff : undefined,
          wakeOnBusinessInquiry:
            typeof args.wakeOnBusinessInquiry === 'boolean'
              ? args.wakeOnBusinessInquiry
              : undefined,
          acceptsNewConversations:
            typeof args.acceptsNewConversations === 'boolean'
              ? args.acceptsNewConversations
              : undefined,
          minWakeIntervalMs: parseBigIntInput(args.minWakeIntervalMs, 'minWakeIntervalMs'),
          coalesceWindowMs: parseBigIntInput(args.coalesceWindowMs, 'coalesceWindowMs'),
          maxWakesPerMinute: parseBigIntInput(args.maxWakesPerMinute, 'maxWakesPerMinute'),
          maxConcurrentWakeJobs: parseBigIntInput(
            args.maxConcurrentWakeJobs,
            'maxConcurrentWakeJobs'
          ),
          expectedWakeLatencyMs: parseBigIntInput(
            args.expectedWakeLatencyMs,
            'expectedWakeLatencyMs'
          ),
          availabilityOverride:
            typeof args.availabilityOverride === 'string'
              ? (args.availabilityOverride as
                  | 'online'
                  | 'wakeable'
                  | 'sleeping'
                  | 'offline'
                  | 'unavailable')
              : undefined,
          statusText: typeof args.statusText === 'string' ? args.statusText : undefined,
        });
        await sleep(DIRECTORY_SYNC_DELAY_MS);
        return ok(wakeStatusData(client));
      })
  );

  registerTool(
    server,
    'agenttalk_wake_requests',
    'List wake requests visible to the current account or dispatcher.',
    {
      status: wakeStatusSchema,
      conversationId: z.union([z.string(), z.number()]).optional(),
      includeDispatcher: z.boolean().optional(),
    },
    async args =>
      withMcpClient('wake', async ({ client }) => {
        const conversationId = parseBigIntInput(args.conversationId, 'conversationId');
        const requests = client.listWakeRequests({
          status: typeof args.status === 'string' ? args.status : undefined,
          conversationId,
          includeDispatcher: args.includeDispatcher !== false,
        });
        return ok({
          requests: sanitizeForMcp(requests),
        });
      })
  );

  registerTool(
    server,
    'agenttalk_wake_ack',
    'Ack a wake request after a connector succeeds.',
    {
      wakeId: z.string().min(1),
      attemptId: z.string().optional(),
      metadataJson: z.string().optional(),
    },
    async args =>
      withMcpClient('wake', async ({ client }) => {
        await client.ackWakeRequest(
          String(args.wakeId),
          typeof args.attemptId === 'string' ? args.attemptId : undefined,
          typeof args.metadataJson === 'string' ? args.metadataJson : undefined
        );
        await sleep(DIRECTORY_SYNC_DELAY_MS);
        return ok(wakeStatusData(client, String(args.wakeId)));
      })
  );

  registerTool(
    server,
    'agenttalk_wake_fail',
    'Fail a wake request after a connector error or timeout.',
    {
      wakeId: z.string().min(1),
      error: z.string().min(1),
      attemptId: z.string().optional(),
      retryAfterMs: z.union([z.string(), z.number()]).optional(),
      metadataJson: z.string().optional(),
    },
    async args =>
      withMcpClient('wake', async ({ client }) => {
        await client.failWakeRequest(String(args.wakeId), String(args.error), {
          attemptId: typeof args.attemptId === 'string' ? args.attemptId : undefined,
          retryAfterMs: parseBigIntInput(args.retryAfterMs, 'retryAfterMs'),
          metadataJson: typeof args.metadataJson === 'string' ? args.metadataJson : undefined,
        });
        await sleep(DIRECTORY_SYNC_DELAY_MS);
        return ok(wakeStatusData(client, String(args.wakeId)));
      })
  );
}

function registerSupervisorTools(server: McpServer) {
  const unavailable = () =>
    ok({
      implemented: false,
      status: 'not_implemented',
      message:
        'agenttalk-supervisor is planned in the next slice. This MCP server does not expose shell execution.',
    });

  registerTool(
    server,
    'agenttalk_supervisor_status',
    'Return local supervisor status when supervisor support is implemented.',
    {},
    async () => unavailable()
  );
  registerTool(
    server,
    'agenttalk_supervisor_config_get',
    'Return local supervisor config when supervisor support is implemented.',
    {},
    async () => unavailable()
  );
  registerTool(
    server,
    'agenttalk_supervisor_config_set',
    'Reserved schema-validated supervisor config setter. Does not execute shell commands.',
    {
      config: z.record(z.string(), z.unknown()).optional(),
    },
    async () => unavailable()
  );
}

function registerResources(server: McpServer) {
  server.registerResource(
    'agenttalk-me',
    'agenttalk://me',
    {
      title: 'Current AgentTalk Identity',
      mimeType: 'application/json',
    },
    async () => {
      const result = await withMcpClient('direct', async ({ client, config }) => ({
        host: config.host,
        databaseName: config.databaseName,
        ...profileData(client),
      }));
      return {
        contents: [
          {
            uri: 'agenttalk://me',
            mimeType: 'application/json',
            text: JSON.stringify(sanitizeForMcp(result), null, 2),
          },
        ],
      };
    }
  );

  server.registerResource(
    'agenttalk-wake-status',
    'agenttalk://wake/status',
    {
      title: 'AgentTalk Wake Status',
      mimeType: 'application/json',
    },
    async () => {
      const result = await withMcpClient('wake', async ({ client }) => wakeStatusData(client));
      return {
        contents: [
          {
            uri: 'agenttalk://wake/status',
            mimeType: 'application/json',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  server.registerResource(
    'agenttalk-supervisor-status',
    'agenttalk://supervisor/status',
    {
      title: 'AgentTalk Supervisor Status',
      mimeType: 'application/json',
    },
    async () => ({
      contents: [
        {
          uri: 'agenttalk://supervisor/status',
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              implemented: false,
              status: 'not_implemented',
            },
            null,
            2
          ),
        },
      ],
    })
  );
}

export function createAgentTalkMcpServer() {
  setGlobalLogLevel('error');
  const server = new McpServer({
    name: 'agenttalk',
    version: '0.1.1',
  });
  registerIdentityTools(server);
  registerConversationTools(server);
  registerWakeTools(server);
  registerSupervisorTools(server);
  registerResources(server);
  return server;
}

function redirectConsoleToStderr() {
  const write = (...args: unknown[]) => {
    const line = args
      .map(arg => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
      .join(' ')
      .trim();
    if (line) {
      process.stderr.write(`${line}\n`);
    }
  };
  console.log = write;
  console.info = write;
  console.warn = write;
  console.debug = write;
}

export async function runAgentTalkMcpServer() {
  redirectConsoleToStderr();
  const server = createAgentTalkMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
