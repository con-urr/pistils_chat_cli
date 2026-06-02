import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { promises as fs } from 'node:fs';
import { setGlobalLogLevel } from 'spacetimedb';
import { z } from 'zod';
import type { AgentRealtimeClient, RichMessageInput } from '../agent-client';
import type * as ModuleTypes from '../module_bindings/types';
import {
  loadSupervisorConfigOrDefault,
  normalizeAgentName,
  normalizeControlProfile,
  normalizeWakeAccessMode,
  normalizeWakeSenderAgentIds,
  OPEN_WAKE_WARNING,
  redactConfig,
  saveSupervisorConfig,
  supervisorConfigPath,
  type SupervisorAgentConfig,
  type SupervisorConfig,
  type SupervisorWakePolicy,
  wakeAccessMode,
} from '../supervisor/config';
import { createWakeChangeRequest, listWakeChangeRequests } from '../supervisor/requests';
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

const supervisorWakePolicyPatchSchema = z
  .object({
    wakeOnDirectMessage: z.boolean().optional(),
    wakeOnMention: z.boolean().optional(),
    wakeOnGroupMessage: z.boolean().optional(),
    acceptsNewConversations: z.boolean().optional(),
    coalesceWindowMs: z.number().int().nonnegative().optional(),
    minWakeIntervalMs: z.number().int().nonnegative().optional(),
    maxWakesPerMinute: z.number().int().positive().optional(),
  })
  .strict();
const supervisorAgentPatchSchema = z
  .object({
    name: z.string().min(1),
    enabled: z.boolean().optional(),
    autoInit: z.boolean().optional(),
    maxConcurrentWakeJobs: z.number().int().positive().optional(),
    connectorTimeoutMs: z.number().int().positive().optional(),
    wake: z
      .object({
        enabled: z.boolean().optional(),
        accessMode: z.enum(['allow_list', 'allow-list', 'allowlist', 'open']).optional(),
        openWakeRiskAccepted: z.boolean().optional(),
        latencyMs: z.number().int().nonnegative().optional(),
        statusText: z.string().min(1).optional(),
        reasons: z.array(z.string().min(1)).optional(),
        allowedWakeSenderAgentIds: z.array(z.string().min(1)).optional(),
        blockedWakeSenderAgentIds: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
    connector: z
      .object({
        openclawAgentId: z.string().min(1).optional(),
        sendReplyText: z.boolean().optional(),
        hermesSkills: z.array(z.string().min(1)).optional(),
        reuseHermesSession: z.boolean().optional(),
        liveChat: z.boolean().optional(),
        liveChatIdleTimeoutMs: z.number().int().positive().optional(),
        liveChatMaxSessionMs: z.number().int().positive().optional(),
        startupTimeoutMs: z.number().int().positive().optional(),
        busyCommand: z.string().min(1).optional(),
        busyCommandTimeoutMs: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const supervisorConfigPatchSchema = z
  .object({
    host: z.string().min(1).optional(),
    databaseName: z.string().min(1).optional(),
    defaultWakePolicy: supervisorWakePolicyPatchSchema.optional(),
    agents: z.array(supervisorAgentPatchSchema).optional(),
  })
  .strict();
const supervisorConfigSetArgsSchema = z
  .object({
    config: supervisorConfigPatchSchema,
    dryRun: z.boolean().optional(),
  })
  .strict();

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

function wakeAccessJsonFromMcpArgs(
  args: Record<string, unknown>,
  options: { defaultAllowList?: boolean } = {}
) {
  const accessMode =
    typeof args.accessMode === 'string' ? normalizeWakeAccessMode(args.accessMode) : undefined;
  if (accessMode === 'open') {
    if (args.openWakeRiskAccepted !== true) {
      throw new Error(`${OPEN_WAKE_WARNING} Set openWakeRiskAccepted=true to confirm open wake mode.`);
    }
    return '';
  }
  if (accessMode === 'allow_list' || Array.isArray(args.allowedWakeSenderAgentIds)) {
    return JSON.stringify(
      normalizeWakeSenderAgentIds(
        Array.isArray(args.allowedWakeSenderAgentIds)
          ? (args.allowedWakeSenderAgentIds as string[])
          : [],
        'Allowed wake senders'
      )
    );
  }
  return options.defaultAllowList ? '[]' : undefined;
}

function blockedWakeAccessJsonFromMcpArgs(args: Record<string, unknown>) {
  return Array.isArray(args.blockedWakeSenderAgentIds)
    ? JSON.stringify(
        normalizeWakeSenderAgentIds(
          args.blockedWakeSenderAgentIds as string[],
          'Blocked wake senders'
        )
      )
    : undefined;
}

function currentMcpControlProfile() {
  const raw = process.env.AGENTTALK_CONTROL_PROFILE ?? process.env.AGENTTALK_PROFILE;
  return raw ? normalizeControlProfile(raw) : undefined;
}

function requireMcpWakeAdminAllowed(action: string) {
  if (currentMcpControlProfile() === 'plugin_managed') {
    throw new Error(
      `${action} denied: plugin-managed AgentTalk runtimes cannot mutate wake/admin state directly. Use the host plugin GUI or supervisor admin surface.`
    );
  }
}

async function supervisorConfigExists() {
  try {
    await fs.access(supervisorConfigPath());
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function supervisorAgentStatus(agent: SupervisorAgentConfig) {
  const wakeEnabled = agent.enabled && agent.wake.enabled === true;
  return {
    name: agent.name,
    handle: agent.handle,
    agentId: null,
    kind: agent.kind,
    enabled: agent.enabled,
    wakeEnabled: agent.wake.enabled === true,
    wakeable: wakeEnabled,
    availability: agent.enabled ? (wakeEnabled ? 'wakeable' : 'wake_off') : 'disabled',
    pendingWakes: 0,
    runningJobs: 0,
    lastWakeAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    failureCount: '0',
    connectorTimeoutMs: agent.connectorTimeoutMs,
    maxConcurrentWakeJobs: agent.maxConcurrentWakeJobs,
    wakeAccess: {
      mode: wakeAccessMode(agent.wake),
      allowedWakeSenderAgentIds: agent.wake.allowedWakeSenderAgentIds ?? [],
      blockedWakeSenderAgentIds: agent.wake.blockedWakeSenderAgentIds ?? [],
    },
    desiredWake: {
      enabled: agent.wake.enabled === true,
      accessMode: wakeAccessMode(agent.wake),
      allowedWakeSenderAgentIds: agent.wake.allowedWakeSenderAgentIds ?? [],
      blockedWakeSenderAgentIds: agent.wake.blockedWakeSenderAgentIds ?? [],
      maxConcurrentWakeJobs: agent.maxConcurrentWakeJobs,
      latencyMs: agent.wake.latencyMs,
    },
    effectiveWake: null,
    drift: null,
  };
}

async function supervisorStatusData() {
  const [config, configPresent] = await Promise.all([
    loadSupervisorConfigOrDefault(),
    supervisorConfigExists(),
  ]);
  return {
    implemented: true,
    running: false,
    processMonitor: 'not_available',
    configPresent,
    configPath: '[redacted]',
    host: config.host,
    databaseName: config.databaseName,
    agentCount: config.agents.length,
    enabledAgentCount: config.agents.filter(agent => agent.enabled).length,
    agents: config.agents.map(supervisorAgentStatus),
  };
}

function patchWakePolicy(
  current: SupervisorWakePolicy,
  patch: z.infer<typeof supervisorWakePolicyPatchSchema>
): SupervisorWakePolicy {
  return {
    ...current,
    ...patch,
  };
}

function patchSupervisorAgent(
  current: SupervisorAgentConfig,
  patch: z.infer<typeof supervisorAgentPatchSchema>
): SupervisorAgentConfig {
  const wakePatch = patch.wake;
  const requestedAccessMode = wakePatch?.accessMode
    ? normalizeWakeAccessMode(wakePatch.accessMode)
    : undefined;
  if (requestedAccessMode === 'open' && wakePatch?.openWakeRiskAccepted !== true) {
    throw new Error(`${OPEN_WAKE_WARNING} Set openWakeRiskAccepted=true to confirm open wake mode.`);
  }
  return {
    ...current,
    enabled: patch.enabled ?? current.enabled,
    autoInit: patch.autoInit ?? current.autoInit,
    maxConcurrentWakeJobs: patch.maxConcurrentWakeJobs ?? current.maxConcurrentWakeJobs,
    connectorTimeoutMs: patch.connectorTimeoutMs ?? current.connectorTimeoutMs,
    wake: wakePatch
      ? {
          ...current.wake,
          enabled: wakePatch.enabled ?? current.wake.enabled,
          accessMode: requestedAccessMode ?? current.wake.accessMode ?? 'allow_list',
          latencyMs: wakePatch.latencyMs ?? current.wake.latencyMs,
          statusText: wakePatch.statusText ?? current.wake.statusText,
          reasons: wakePatch.reasons ?? current.wake.reasons,
          allowedWakeSenderAgentIds: wakePatch.allowedWakeSenderAgentIds
            ? normalizeWakeSenderAgentIds(wakePatch.allowedWakeSenderAgentIds, 'Allowed wake senders')
            : current.wake.allowedWakeSenderAgentIds,
          blockedWakeSenderAgentIds: wakePatch.blockedWakeSenderAgentIds
            ? normalizeWakeSenderAgentIds(wakePatch.blockedWakeSenderAgentIds, 'Blocked wake senders')
            : current.wake.blockedWakeSenderAgentIds,
        }
      : current.wake,
    connector: patch.connector
      ? {
          ...current.connector,
          ...patch.connector,
        }
      : current.connector,
  };
}

function patchSupervisorConfig(
  current: SupervisorConfig,
  patch: z.infer<typeof supervisorConfigPatchSchema>
): SupervisorConfig {
  let next: SupervisorConfig = {
    ...current,
    host: patch.host ?? current.host,
    databaseName: patch.databaseName ?? current.databaseName,
    defaultWakePolicy: patch.defaultWakePolicy
      ? patchWakePolicy(current.defaultWakePolicy, patch.defaultWakePolicy)
      : current.defaultWakePolicy,
    agents: current.agents.map(agent => ({
      ...agent,
      wake: {
        ...agent.wake,
        reasons: [...agent.wake.reasons],
        allowedWakeSenderAgentIds: [...(agent.wake.allowedWakeSenderAgentIds ?? [])],
        blockedWakeSenderAgentIds: [...(agent.wake.blockedWakeSenderAgentIds ?? [])],
      },
      connector: agent.connector ? { ...agent.connector } : undefined,
    })),
  };

  for (const agentPatch of patch.agents ?? []) {
    const name = normalizeAgentName(agentPatch.name);
    const index = next.agents.findIndex(agent => agent.name === name);
    if (index < 0) {
      throw new Error(
        `Unknown supervisor agent '${agentPatch.name}'. MCP config_set only updates existing agents.`
      );
    }
    next = {
      ...next,
      agents: next.agents.map((agent, agentIndex) =>
        agentIndex === index ? patchSupervisorAgent(agent, agentPatch) : agent
      ),
    };
  }

  return next;
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
      accessMode: z.enum(['allow_list', 'allow-list', 'allowlist', 'open']).optional(),
      allowedWakeSenderAgentIds: z.array(z.string().min(1)).optional(),
      blockedWakeSenderAgentIds: z.array(z.string().min(1)).optional(),
      openWakeRiskAccepted: z.boolean().optional(),
    },
    async args =>
      withMcpClient('wake', async ({ client }) => {
        requireMcpWakeAdminAllowed('agenttalk_wake_enable');
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
          allowedWakeSenderAgentIdsJson: wakeAccessJsonFromMcpArgs(args, {
            defaultAllowList: true,
          }),
          blockedWakeSenderAgentIdsJson: blockedWakeAccessJsonFromMcpArgs(args),
        });
        await sleep(DIRECTORY_SYNC_DELAY_MS);
        return ok(wakeStatusData(client));
      })
  );

  registerTool(server, 'agenttalk_wake_disable', 'Disable wakeability for the current account.', {}, async () =>
    withMcpClient('wake', async ({ client }) => {
      requireMcpWakeAdminAllowed('agenttalk_wake_disable');
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
      accessMode: z.enum(['allow_list', 'allow-list', 'allowlist', 'open']).optional(),
      allowedWakeSenderAgentIds: z.array(z.string().min(1)).optional(),
      blockedWakeSenderAgentIds: z.array(z.string().min(1)).optional(),
      openWakeRiskAccepted: z.boolean().optional(),
    },
    async args =>
      withMcpClient('wake', async ({ client }) => {
        requireMcpWakeAdminAllowed('agenttalk_wake_policy_set');
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
          allowedWakeSenderAgentIdsJson: wakeAccessJsonFromMcpArgs(args),
          blockedWakeSenderAgentIdsJson: blockedWakeAccessJsonFromMcpArgs(args),
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
  registerTool(
    server,
    'agenttalk_supervisor_status',
    'Return safe local supervisor config/status without executing the supervisor.',
    {},
    async () => ok(await supervisorStatusData())
  );
  registerTool(
    server,
    'agenttalk_supervisor_config_get',
    'Return redacted local supervisor config without printing local paths or commands.',
    {},
    async () => {
      const [config, configPresent] = await Promise.all([
        loadSupervisorConfigOrDefault(),
        supervisorConfigExists(),
      ]);
      return ok({
        implemented: true,
        configPresent,
        configPath: '[redacted]',
        config: redactConfig(config),
      });
    }
  );
  registerTool(
    server,
    'agenttalk_supervisor_config_set',
    'Update safe supervisor config fields for existing agents. Does not create commands or execute shell.',
    {
      config: supervisorConfigPatchSchema,
      dryRun: z.boolean().optional(),
    },
    async args => {
      requireMcpWakeAdminAllowed('agenttalk_supervisor_config_set');
      const parsed = supervisorConfigSetArgsSchema.safeParse(args);
      if (!parsed.success) {
        return fail('invalid_supervisor_config', 'Supervisor config patch failed validation.', {
          reason: 'schema_validation_failed',
          details: parsed.error.flatten(),
        });
      }
      const current = await loadSupervisorConfigOrDefault();
      const next = patchSupervisorConfig(current, parsed.data.config);
      if (!parsed.data.dryRun) {
        await saveSupervisorConfig(next);
      }
      return ok({
        implemented: true,
        dryRun: parsed.data.dryRun === true,
        saved: parsed.data.dryRun !== true,
        configPath: '[redacted]',
        config: redactConfig(next),
        allowedUpdates: [
          'host',
          'databaseName',
          'defaultWakePolicy',
          'existing agent enabled/autoInit/limits/wake settings and wake sender access lists',
          'existing agent connector.openclawAgentId/sendReplyText/hermesSkills/reuseHermesSession/liveChat/busyCommand',
        ],
        blockedUpdates: [
          'new agents',
          'agent kind',
          'agent command',
          'agent repoPath',
          'agent stateDir',
        ],
      });
    }
  );
  registerTool(
    server,
    'agenttalk_supervisor_wake_change_request',
    'Record a human-visible plugin-managed request to change local wake settings. This does not apply the change.',
    {
      agentName: z.string().min(1),
      wakeEnabled: z.boolean().optional(),
      wakeAccessMode: z.enum(['allow_list', 'allow-list', 'allowlist', 'open']).optional(),
      allowedWakeSenderAgentIds: z.array(z.string().min(1)).optional(),
      blockedWakeSenderAgentIds: z.array(z.string().min(1)).optional(),
      reason: z.string().optional(),
      requestedBy: z.string().optional(),
    },
    async args => {
      const request = await createWakeChangeRequest({
        agentName: String(args.agentName),
        requestedBy: typeof args.requestedBy === 'string' ? args.requestedBy : 'mcp-runtime',
        reason: typeof args.reason === 'string' ? args.reason : undefined,
        desired: {
          wakeEnabled: typeof args.wakeEnabled === 'boolean' ? args.wakeEnabled : undefined,
          wakeAccessMode:
            typeof args.wakeAccessMode === 'string'
              ? normalizeWakeAccessMode(args.wakeAccessMode)
              : undefined,
          allowedWakeSenderAgentIds: Array.isArray(args.allowedWakeSenderAgentIds)
            ? normalizeWakeSenderAgentIds(args.allowedWakeSenderAgentIds, 'Allowed wake senders')
            : undefined,
          blockedWakeSenderAgentIds: Array.isArray(args.blockedWakeSenderAgentIds)
            ? normalizeWakeSenderAgentIds(args.blockedWakeSenderAgentIds, 'Blocked wake senders')
            : undefined,
        },
      });
      return ok({
        implemented: true,
        applied: false,
        humanApprovalRequired: true,
        request,
      });
    }
  );
  registerTool(
    server,
    'agenttalk_supervisor_wake_change_requests',
    'List local human-visible wake setting change requests.',
    {
      agentName: z.string().optional(),
      status: z.enum(['pending', 'approved', 'denied', 'all']).optional(),
    },
    async args =>
      ok({
        implemented: true,
        requests: await listWakeChangeRequests({
          agentName: typeof args.agentName === 'string' ? args.agentName : undefined,
          status:
            args.status === 'pending' ||
            args.status === 'approved' ||
            args.status === 'denied' ||
            args.status === 'all'
              ? args.status
              : 'pending',
        }),
      })
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
    async () => {
      const result = await supervisorStatusData();
      return {
        contents: [
          {
            uri: 'agenttalk://supervisor/status',
            mimeType: 'application/json',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
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
