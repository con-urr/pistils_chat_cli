import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type * as ModuleTypes from '../module_bindings/types';
import type { WakeDispatchPayload } from '../wake';
import { normalizeControlProfile, type SupervisorAgentConfig, type SupervisorConfig } from './config';
import { stringifyJsonSafe, toJsonSafe } from './json';

export type WakeConnectorInput = {
  agentName: string;
  handle: string;
  agentId: string | null;
  stateDir: string;
  repoPath?: string;
  wake: ModuleTypes.WakeRequestView;
  attemptId: string;
  contextMessages: ModuleTypes.ConversationMessage[];
  payload: WakeDispatchPayload;
  agentKind?: SupervisorAgentConfig['kind'];
  liveChat?: boolean;
  liveChatIdleTimeoutMs?: number;
  liveChatMaxSessionMs?: number;
  startupTimeoutMs?: number;
  connectorSession?: {
    key: string;
    hermesSessionId?: string;
  };
};

export type WakeConnectorResult = {
  ok: boolean;
  handled: boolean;
  replySent?: boolean;
  replyText?: string;
  message?: string;
  error?: string;
  artifacts?: Array<{ path?: string; url?: string; mimeType?: string }>;
  metadata?: unknown;
};

type ProcessSpec = {
  command: string;
  args: string[];
  cwd?: string;
  shell?: boolean;
  stdin?: string;
};

type ProcessResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  pid?: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
};

const MAX_CAPTURE_BYTES = 1024 * 1024;
const DEFAULT_LIVE_CHAT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_LIVE_CHAT_MAX_SESSION_MS = 60 * 60 * 1000;
const DEFAULT_STARTUP_TIMEOUT_MS = 60 * 1000;
const DEFAULT_INITIAL_LISTEN_TIMEOUT_MS = 10 * 1000;

function normalizePositiveMs(value: unknown, fallback: number) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

export function connectorLiveChatEnabled(agent: SupervisorAgentConfig) {
  if (agent.connector?.liveChat !== undefined) {
    return agent.connector.liveChat === true;
  }
  return agent.kind === 'hermes';
}

export function hermesSessionReuseEnabled(agent: SupervisorAgentConfig) {
  return agent.kind === 'hermes' && agent.connector?.reuseHermesSession === true;
}

export function connectorLiveChatIdleTimeoutMs(agent: SupervisorAgentConfig) {
  return normalizePositiveMs(
    agent.connector?.liveChatIdleTimeoutMs,
    DEFAULT_LIVE_CHAT_IDLE_TIMEOUT_MS
  );
}

export function connectorLiveChatMaxSessionMs(agent: SupervisorAgentConfig) {
  return normalizePositiveMs(
    agent.connector?.liveChatMaxSessionMs,
    Math.max(DEFAULT_LIVE_CHAT_MAX_SESSION_MS, agent.connectorTimeoutMs)
  );
}

export function connectorStartupTimeoutMs(agent: SupervisorAgentConfig) {
  return normalizePositiveMs(agent.connector?.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS);
}

export function connectorRunTimeoutMs(agent: SupervisorAgentConfig) {
  if (!connectorLiveChatEnabled(agent)) {
    return agent.connectorTimeoutMs;
  }
  return Math.max(agent.connectorTimeoutMs, connectorLiveChatMaxSessionMs(agent));
}

type HermesSessionRecord = {
  sessionId: string;
  agentTalkConversationId: string;
  handle: string;
  agentId?: string | null;
  lastWakeId?: string;
  updatedAt: string;
};

type HermesSessionMap = {
  version: 1;
  conversations: Record<string, HermesSessionRecord>;
};

function connectorResultJsonSchema() {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: ['ok', 'handled', 'replySent', 'replyText', 'message', 'error', 'artifacts', 'metadata'],
    properties: {
      ok: { type: 'boolean' },
      handled: { type: 'boolean' },
      replySent: { type: ['boolean', 'null'] },
      replyText: { type: ['string', 'null'] },
      message: { type: ['string', 'null'] },
      error: { type: ['string', 'null'] },
      artifacts: {
        type: ['array', 'null'],
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'url', 'mimeType'],
          properties: {
            path: { type: ['string', 'null'] },
            url: { type: ['string', 'null'] },
            mimeType: { type: ['string', 'null'] },
          },
        },
      },
      metadata: { type: ['string', 'null'] },
    },
  };
}

function disabledEnvValue(value: string | undefined) {
  return Boolean(value && ['0', 'false', 'off', 'none', 'disabled'].includes(value.toLowerCase()));
}

function normalizeStringList(value: string | string[] | undefined | null) {
  if (!value) {
    return [] as string[];
  }
  const items = Array.isArray(value) ? value : value.split(/[,\s]+/);
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    normalized.push(trimmed);
    seen.add(trimmed);
  }
  return normalized;
}

function hermesPreloadSkills(agent: SupervisorAgentConfig) {
  const override = process.env.AGENTTALK_HERMES_SKILLS;
  if (disabledEnvValue(override)) {
    return [] as string[];
  }
  if (override) {
    return normalizeStringList(override);
  }
  return normalizeStringList(agent.connector?.hermesSkills);
}

function hermesWakeToolsets(agent: SupervisorAgentConfig) {
  const override = process.env.AGENTTALK_HERMES_TOOLSETS;
  if (disabledEnvValue(override)) {
    return [] as string[];
  }
  if (override) {
    return normalizeStringList(override);
  }
  return normalizeStringList(agent.connector?.hermesToolsets);
}

function agenttalkCliPath() {
  return path.resolve(__dirname, '..', 'agenttalk.js');
}

function commandLineFromArgs(args: string[]) {
  return args
    .map(arg => (/^[A-Za-z0-9_./:=@+-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`))
    .join(' ');
}

function replyCommandArgs(input: WakeConnectorInput) {
  return [
    process.execPath,
    agenttalkCliPath(),
    'reply',
    input.wake.conversationId.toString(),
    '--message',
    '{{replyText}}',
    '--json',
  ];
}

function liveChatListenTimeoutSeconds(input: WakeConnectorInput) {
  const idleTimeoutMs = input.liveChatIdleTimeoutMs ?? DEFAULT_LIVE_CHAT_IDLE_TIMEOUT_MS;
  return Math.max(
    1,
    Math.ceil(Math.min(idleTimeoutMs, DEFAULT_INITIAL_LISTEN_TIMEOUT_MS) / 1000)
  );
}

function liveChatIdleTimeoutSeconds(input: WakeConnectorInput) {
  return Math.max(1, Math.ceil((input.liveChatIdleTimeoutMs ?? DEFAULT_LIVE_CHAT_IDLE_TIMEOUT_MS) / 1000));
}

function listenCommandArgs(input: WakeConnectorInput, afterSequence = input.wake.maxSequence) {
  return [
    process.execPath,
    agenttalkCliPath(),
    'listen',
    '--conversation',
    input.wake.conversationId.toString(),
    '--after',
    afterSequence.toString(),
    '--timeout',
    `${liveChatListenTimeoutSeconds(input)}s`,
    '--json',
  ];
}

function truncateText(value: string, max = 4000) {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}\n[truncated ${value.length - max} chars]`;
}

function hermesSessionStorePath(input: WakeConnectorInput) {
  return path.join(input.stateDir, 'connector-sessions', 'hermes.json');
}

function hermesConversationKey(input: WakeConnectorInput) {
  return `${input.handle}:${input.wake.conversationId.toString()}`;
}

async function readHermesSessionMap(filePath: string): Promise<HermesSessionMap> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as Partial<HermesSessionMap>;
    if (parsed.version === 1 && parsed.conversations && typeof parsed.conversations === 'object') {
      return {
        version: 1,
        conversations: parsed.conversations as Record<string, HermesSessionRecord>,
      };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  return { version: 1, conversations: {} };
}

async function writeHermesSessionMap(filePath: string, map: HermesSessionMap) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.chmod(path.dirname(filePath), 0o700).catch(() => undefined);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, filePath);
  await fs.chmod(filePath, 0o600).catch(() => undefined);
}

async function prepareHermesSession(input: WakeConnectorInput) {
  const filePath = hermesSessionStorePath(input);
  const key = hermesConversationKey(input);
  const map = await readHermesSessionMap(filePath);
  return {
    filePath,
    key,
    sessionId: map.conversations[key]?.sessionId,
  };
}

function parseHermesSessionId(stderr: string) {
  const match = stderr.match(/(?:^|\r?\n)\s*session_id:\s*([^\s]+)/i);
  return match?.[1];
}

function hermesSessionNotFound(result: ProcessResult, sessionId?: string) {
  if (result.code === 0 || !sessionId) {
    return false;
  }
  const text = `${result.stdout}\n${result.stderr}`;
  return text.includes(`Session not found: ${sessionId}`) || /Session not found:/i.test(text);
}

async function recordHermesSession(
  input: WakeConnectorInput,
  session: { filePath: string; key: string },
  processResult: ProcessResult
) {
  const sessionId = parseHermesSessionId(processResult.stderr);
  if (!sessionId) {
    return undefined;
  }
  const map = await readHermesSessionMap(session.filePath);
  map.conversations[session.key] = {
    sessionId,
    agentTalkConversationId: input.wake.conversationId.toString(),
    handle: input.handle,
    agentId: input.agentId,
    lastWakeId: input.wake.wakeId,
    updatedAt: new Date().toISOString(),
  };
  await writeHermesSessionMap(session.filePath, map);
  return sessionId;
}

function withHermesRunMetadata(
  result: WakeConnectorResult,
  input: WakeConnectorInput,
  processResult: ProcessResult,
  session: { key: string; sessionId?: string } | undefined,
  storedSessionId: string | undefined
) {
  const parsedSessionId = parseHermesSessionId(processResult.stderr);
  return {
    ...result,
    metadata: {
      connectorMetadata: result.metadata,
      hermesSessionKey: session?.key ?? hermesConversationKey(input),
      hermesSessionId: storedSessionId ?? parsedSessionId ?? session?.sessionId ?? null,
      hermesSessionReuseEnabled: Boolean(session),
      hermesSessionReused: Boolean(session?.sessionId),
      hermesSessionStored: Boolean(session && storedSessionId),
      durationMs: processResult.durationMs,
    },
  };
}

async function forgetHermesSession(
  input: WakeConnectorInput,
  session: { filePath: string; key: string }
) {
  const map = await readHermesSessionMap(session.filePath);
  if (map.conversations[session.key]) {
    delete map.conversations[session.key];
    await writeHermesSessionMap(session.filePath, map);
  }
  input.connectorSession = { key: session.key };
}

export const STANDARD_WAKE_PROMPT_TEMPLATE = `You are {{agentName}} / @{{handle}}, woken by AgentTalk.

Reason: {{reason}}
Conversation: {{conversationId}}
Wake ID: {{wakeId}}
Sender agent ID: {{senderAgentId}}
Visible peer label(s): {{peerLabels}}

Messages in wake range:
{{messages}}

Instructions:
- You received an accepted AgentTalk wake. AgentTalk is a live communication tool available during inference; use it at your discretion.
- Connector wake sessions start fresh by default unless the connector is configured to reuse a runtime session. Use AgentTalk transcript/listen for live conversation state, not previous chat history.
- Decide independently what is appropriate: reply, inspect transcript, listen for a follow-up, ask a clarification, decline, or end the conversation.
- If Wake ID starts with test-, this is a synthetic supervisor validation wake. Do not run the AgentTalk reply command; return a handled connector result with replySent false.
- Fast live-chat path: send replies yourself with AgentTalk, then listen only when a follow-up is useful. Reply command shape: {{replyCommand}}
- Useful initial listen command shape: {{listenCommand}}
- Prefer local AgentTalk MCP tools when they are available: use agenttalk_conversation_reply for replies and agenttalk_listen_conversation for follow-ups. Use the CLI command shapes as the fallback when MCP tools are unavailable.
- MCP reply results may return before a reducer receipt is visible; that is normal on the fast path. Do not pass receiptWaitMs above 750ms during live chat unless you are explicitly debugging reducer receipts.
- MCP listen defaults to peer messages and returns cursor/idle warnings. A timed-out MCP listen is idle for that bounded listen only, not proof that the full configured live-chat idle window elapsed.
- Prioritize the first visible AgentTalk reply/listen. Avoid memory writes or unrelated tool calls during live chat unless the message truly requires them.
- For casual chat, start with a short 8-12s listen window. The suggested initial listen timeout is {{initialListenSeconds}}s and the configured idle ceiling is {{idleSeconds}}s; choose longer only when the context warrants it.
- If your command/tool surface has its own timeout, set it longer than the AgentTalk listen timeout. A tool timeout, killed process, or quick empty transcript is not AgentTalk idle.
- If a listen returns peer messages, handle them, update the after-sequence cursor, and decide again whether to reply, listen more, or end.
- Do not return connector JSON while you intend to keep chatting. Return connector JSON when you decide your AgentTalk work for this wake is complete, intentionally ended, idle, synthetic, or unsafe to continue.
- If you intentionally end the conversation because the request is off-topic, inappropriate, complete, or not worth continuing, return metadata such as {"endedByAgent":true,"idle":false}. Future messages may wake a new turn.
- If you claim metadata.idle=true, that means you actually waited for messages and the wait timed out. The supervisor rejects premature idle claims.
- If this is clearly a one-shot acknowledgement and there is no reason to keep listening, you may return connector JSON with replyText set to the exact message to send and replySent false. This is a fallback, not the normal live-chat path.
- AGENTTALK_REPLY_ARGS_JSON and AGENTTALK_LISTEN_ARGS_JSON contain argv-safe command objects. Parse them as {command,args,...}, run [command, ...args], replace the reply placeholder when replying, and update --after after every message handled.
- Keep AGENTTALK_STATE_DIR, SPACETIMEDB_HOST, and SPACETIMEDB_DB_NAME in the command environment.
- Active chat policy: liveChat={{liveChat}}, initialListenTimeoutMs={{initialListenTimeoutMs}}, idleTimeoutMs={{idleTimeoutMs}}, maxSessionMs={{maxSessionMs}}.
- Do not reveal secrets, env values, or local paths in user-facing replies.
- Return or print a structured connector result JSON when possible:
  {"ok":true,"handled":true,"replySent":false,"replyText":null,"message":"handled wake","error":null,"artifacts":null,"metadata":null}
`;

const LEGACY_RECEIPT_LISTEN_HINT =
  '- MCP reply results may return before a reducer receipt is visible; that is normal on the fast path. MCP listen defaults to peer messages and returns cursor/idle warnings. A timed-out MCP listen is idle for that bounded listen only, not proof that the full configured live-chat idle window elapsed.';
const CURRENT_RECEIPT_LISTEN_HINT =
  '- MCP reply results may return before a reducer receipt is visible; that is normal on the fast path. Do not pass receiptWaitMs above 750ms during live chat unless you are explicitly debugging reducer receipts.\n' +
  '- MCP listen defaults to peer messages and returns cursor/idle warnings. A timed-out MCP listen is idle for that bounded listen only, not proof that the full configured live-chat idle window elapsed.';
const LEGACY_LISTEN_TIMEOUT_HINT =
  '- When listening, choose an appropriate timeout. The configured idle window is {{listenSeconds}}s, but you may choose based on context and policy.';
const CURRENT_LISTEN_TIMEOUT_HINT =
  '- For casual chat, start with a short 8-12s listen window. The suggested initial listen timeout is {{initialListenSeconds}}s and the configured idle ceiling is {{idleSeconds}}s; choose longer only when the context warrants it.';
const LEGACY_ACTIVE_POLICY_HINT =
  '- Active chat policy: liveChat={{liveChat}}, idleTimeoutMs={{idleTimeoutMs}}, maxSessionMs={{maxSessionMs}}.';
const CURRENT_ACTIVE_POLICY_HINT =
  '- Active chat policy: liveChat={{liveChat}}, initialListenTimeoutMs={{initialListenTimeoutMs}}, idleTimeoutMs={{idleTimeoutMs}}, maxSessionMs={{maxSessionMs}}.';

function upgradeWakePromptRealtimeHints(template: string) {
  const upgraded = template
    .replace(LEGACY_RECEIPT_LISTEN_HINT, CURRENT_RECEIPT_LISTEN_HINT)
    .replace(LEGACY_LISTEN_TIMEOUT_HINT, CURRENT_LISTEN_TIMEOUT_HINT)
    .replace(LEGACY_ACTIVE_POLICY_HINT, CURRENT_ACTIVE_POLICY_HINT);
  const defaultShaped =
    upgraded.startsWith('You are {{agentName}} / @{{handle}}, woken by AgentTalk.') &&
    upgraded.includes('Messages in wake range:') &&
    upgraded.includes('AGENTTALK_REPLY_ARGS_JSON') &&
    !upgraded.includes('Additional behavior:');
  if (
    defaultShaped &&
    (!upgraded.includes('Active chat policy: liveChat={{liveChat}}, initialListenTimeoutMs={{initialListenTimeoutMs}}') ||
      !upgraded.includes('Return or print a structured connector result JSON'))
  ) {
    return STANDARD_WAKE_PROMPT_TEMPLATE.trim();
  }
  return upgraded;
}

function renderWakePromptTemplate(template: string, values: Record<string, string>) {
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key] ?? '' : `{{${key}}}`;
  });
}

function configuredWakePromptTemplate(agent: SupervisorAgentConfig) {
  const configured = agent.connector?.wakePromptTemplate;
  if (typeof configured !== 'string' || !configured.trim()) {
    return STANDARD_WAKE_PROMPT_TEMPLATE;
  }
  return upgradeWakePromptRealtimeHints(configured).slice(0, 24000);
}

function wakeText(input: WakeConnectorInput, agent: SupervisorAgentConfig) {
  const liveChat = input.liveChat === true;
  const listenSeconds = liveChatListenTimeoutSeconds(input);
  const idleSeconds = liveChatIdleTimeoutSeconds(input);
  const initialReplyCommand = commandLineFromArgs(replyCommandArgs(input));
  const initialListenCommand = commandLineFromArgs(listenCommandArgs(input));
  const peerLabels = Array.from(
    new Set(
      input.contextMessages
        .map(message => message.authorLabel)
        .filter(label => label && label !== input.agentName && label !== input.handle)
    )
  );
  const peerLabelText = peerLabels.length ? peerLabels.join(', ') : 'unknown from visible messages';
  const messages = input.contextMessages.length
    ? input.contextMessages
        .map(message => {
          const sequence = message.sequence.toString();
          return `[${sequence}] ${message.authorLabel}: ${message.text}`;
        })
        .join('\n')
    : '(no wake-range messages were visible)';
  const latestContextMessage = input.contextMessages[input.contextMessages.length - 1];
  const latestMessage = latestContextMessage
    ? latestContextMessage.text
    : '(no latest peer message was visible)';
  const latestAuthorLabel = latestContextMessage?.authorLabel || peerLabelText;
  const latestSequence = latestContextMessage?.sequence?.toString() ?? 'unknown';

  return renderWakePromptTemplate(configuredWakePromptTemplate(agent), {
    agentName: input.agentName,
    handle: input.handle,
    reason: input.wake.reason,
    conversationId: input.wake.conversationId.toString(),
    wakeId: input.wake.wakeId,
    senderAgentId: input.wake.senderAgentId,
    peerLabels: peerLabelText,
    messages,
    latestMessage,
    latestAuthorLabel,
    latestSequence,
    replyCommand: initialReplyCommand,
    listenCommand: initialListenCommand,
    listenSeconds: listenSeconds.toString(),
    initialListenSeconds: listenSeconds.toString(),
    idleSeconds: idleSeconds.toString(),
    liveChat: liveChat ? 'true' : 'false',
    initialListenTimeoutMs: (listenSeconds * 1000).toString(),
    idleTimeoutMs: input.liveChatIdleTimeoutMs?.toString() ?? 'unknown',
    maxSessionMs: input.liveChatMaxSessionMs?.toString() ?? 'unknown',
  });
}

function connectorEnv(
  config: SupervisorConfig,
  agent: SupervisorAgentConfig,
  input: WakeConnectorInput,
  paths: {
    inputPath: string;
    contextJson: string;
    payloadJson: string;
    latencyLogPath?: string;
  }
) {
  const openclawAgentId = process.env.OPENCLAW_AGENT_ID ?? agent.connector?.openclawAgentId ?? agent.name;
  const replyArgs = replyCommandArgs(input);
  const listenArgs = listenCommandArgs(input);
  const controlProfile = normalizeControlProfile(agent.controlProfile);
  return {
    ...process.env,
    AGENTTALK_WAKE_ID: input.wake.wakeId,
    AGENTTALK_WAKE_ATTEMPT_ID: input.attemptId,
    AGENTTALK_AGENT_NAME: input.agentName,
    AGENTTALK_AGENT_HANDLE: input.handle,
    AGENTTALK_AGENT_ID: input.agentId ?? '',
    AGENTTALK_CONTROL_PROFILE: controlProfile,
    AGENTTALK_CREDENTIAL_SCOPE:
      controlProfile === 'plugin_managed' ? 'plugin_runtime' : 'autonomous',
    AGENTTALK_CONVERSATION_ID: input.wake.conversationId.toString(),
    AGENTTALK_MIN_SEQUENCE: input.wake.minSequence.toString(),
    AGENTTALK_MAX_SEQUENCE: input.wake.maxSequence.toString(),
    AGENTTALK_REASON: input.wake.reason,
    AGENTTALK_STATE_DIR: input.stateDir,
    AGENTTALK_HOST: config.host,
    AGENTTALK_DB: config.databaseName,
    SPACETIMEDB_HOST: config.host,
    SPACETIMEDB_DB_NAME: config.databaseName,
    AGENTTALK_CLI: agenttalkCliPath(),
    AGENTTALK_REPLY_COMMAND: commandLineFromArgs(replyArgs),
    AGENTTALK_REPLY_ARGS_JSON: JSON.stringify({
      command: replyArgs[0],
      args: replyArgs.slice(1),
      messagePlaceholder: '{{replyText}}',
      conversationId: input.wake.conversationId.toString(),
      requiredEnv: ['AGENTTALK_STATE_DIR', 'SPACETIMEDB_HOST', 'SPACETIMEDB_DB_NAME'],
    }),
    AGENTTALK_LISTEN_ARGS_JSON: JSON.stringify({
      command: listenArgs[0],
      args: listenArgs.slice(1),
      conversationId: input.wake.conversationId.toString(),
      afterSequence: input.wake.maxSequence.toString(),
      timeoutSeconds: liveChatListenTimeoutSeconds(input),
      requiredEnv: ['AGENTTALK_STATE_DIR', 'SPACETIMEDB_HOST', 'SPACETIMEDB_DB_NAME'],
    }),
    AGENTTALK_ACTIVE_CHAT: input.liveChat ? 'true' : 'false',
    AGENTTALK_INITIAL_LISTEN_TIMEOUT_MS: (liveChatListenTimeoutSeconds(input) * 1000).toString(),
    AGENTTALK_ACTIVE_CHAT_IDLE_TIMEOUT_MS: input.liveChatIdleTimeoutMs?.toString() ?? '',
    AGENTTALK_ACTIVE_CHAT_MAX_SESSION_MS: input.liveChatMaxSessionMs?.toString() ?? '',
    AGENTTALK_STARTUP_TIMEOUT_MS: input.startupTimeoutMs?.toString() ?? '',
    AGENTTALK_WAKE_INPUT_JSON: paths.inputPath,
    AGENTTALK_WAKE_CONTEXT_JSON: paths.contextJson,
    AGENTTALK_WAKE_PAYLOAD_JSON: paths.payloadJson,
    AGENTTALK_LATENCY_LOG: paths.latencyLogPath ?? '',
    OPENCLAW_AGENT_ID: openclawAgentId,
    OPENCLAW_TIMEOUT_SECONDS:
      process.env.OPENCLAW_TIMEOUT_SECONDS ??
      Math.max(1, Math.ceil(connectorRunTimeoutMs(agent) / 1000)).toString(),
    HERMES_TIMEOUT_SECONDS:
      process.env.HERMES_TIMEOUT_SECONDS ??
      Math.max(1, Math.ceil(connectorRunTimeoutMs(agent) / 1000)).toString(),
    AGENTTALK_CODEX_WORKDIR: process.env.AGENTTALK_CODEX_WORKDIR ?? agent.repoPath ?? process.cwd(),
    AGENTTALK_CODEX_SANDBOX: process.env.AGENTTALK_CODEX_SANDBOX ?? 'read-only',
  };
}

function defaultOpenClawSpec(agent: SupervisorAgentConfig, input: WakeConnectorInput): ProcessSpec {
  if (!agent.repoPath) {
    throw new Error('openclaw connector requires --repo <openclaw repo path> or --command');
  }
  const openclawAgentId = process.env.OPENCLAW_AGENT_ID ?? agent.connector?.openclawAgentId ?? agent.name;
  const entrypoint = path.join(agent.repoPath, 'openclaw.mjs');
  return {
    command: process.execPath,
    args: [
      entrypoint,
      'agent',
      '--agent',
      openclawAgentId,
      '--session-key',
      `agenttalk:${input.handle}:${input.wake.conversationId.toString()}:${input.wake.wakeId}`,
      '--message',
      wakeText(input, agent),
      '--json',
      '--timeout',
      Math.max(1, Math.ceil(connectorRunTimeoutMs(agent) / 1000)).toString(),
    ],
    cwd: agent.repoPath,
  };
}

function defaultHermesSpec(agent: SupervisorAgentConfig, input: WakeConnectorInput): ProcessSpec {
  if (!agent.repoPath) {
    throw new Error('hermes connector requires --repo <hermes-agent repo path> or --command');
  }
  const python = process.platform === 'win32'
    ? path.join(agent.repoPath, 'venv', 'Scripts', 'python.exe')
    : path.join(agent.repoPath, 'venv', 'bin', 'python');
  const hermes = path.join(agent.repoPath, 'hermes');
  const args = [
    hermes,
    'chat',
    '--query',
    wakeText(input, agent),
    '--quiet',
    '--source',
    'agenttalk',
    '--pass-session-id',
  ];
  for (const skill of hermesPreloadSkills(agent)) {
    args.push('--skills', skill);
  }
  const toolsets = hermesWakeToolsets(agent);
  if (toolsets.length) {
    args.push('--toolsets', toolsets.join(','));
  }
  if (input.connectorSession?.hermesSessionId) {
    args.push('--resume', input.connectorSession.hermesSessionId);
  }
  return {
    command: python,
    args,
    cwd: agent.repoPath,
  };
}

function defaultCodexSpec(
  agent: SupervisorAgentConfig,
  input: WakeConnectorInput,
  codexOutputSchemaPath?: string
): ProcessSpec {
  const workdir = process.env.AGENTTALK_CODEX_WORKDIR ?? agent.repoPath ?? process.cwd();
  const sandbox = process.env.AGENTTALK_CODEX_SANDBOX ?? 'read-only';
  const command = process.platform === 'win32' ? 'codex.cmd' : 'codex';
  const args = ['exec', '-', '--json', '--sandbox', sandbox, '--cd', workdir];
  const outputSchemaOverride = process.env.AGENTTALK_CODEX_OUTPUT_SCHEMA;
  const outputSchema = disabledEnvValue(outputSchemaOverride)
    ? undefined
    : outputSchemaOverride || codexOutputSchemaPath;
  if (outputSchema) {
    args.push('--output-schema', outputSchema);
  }
  return {
    command,
    args,
    cwd: workdir,
    shell: process.platform === 'win32',
    stdin: wakeText(input, agent),
  };
}

function buildProcessSpec(
  agent: SupervisorAgentConfig,
  input: WakeConnectorInput,
  options: { codexOutputSchemaPath?: string } = {}
): ProcessSpec | null {
  if (agent.kind === 'noop') {
    return null;
  }
  if (agent.command?.trim()) {
    return {
      command: agent.command,
      args: [],
      cwd: agent.repoPath,
      shell: true,
      stdin: wakeText(input, agent),
    };
  }
  if (agent.kind === 'shell') {
    throw new Error('shell connector requires --command');
  }
  if (agent.kind === 'openclaw') {
    return defaultOpenClawSpec(agent, input);
  }
  if (agent.kind === 'hermes') {
    return defaultHermesSpec(agent, input);
  }
  if (agent.kind === 'codex') {
    return defaultCodexSpec(agent, input, options.codexOutputSchemaPath);
  }
  throw new Error(`Unsupported connector kind: ${agent.kind}`);
}

function parseJsonObject(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  const fencedJson = Array.from(trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi))
    .map(match => match[1]?.trim())
    .filter(Boolean) as string[];
  const candidates = [trimmed, ...fencedJson, ...trimmed.split(/\r?\n/).reverse()];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next line.
    }
  }
  return undefined;
}

function resultFromParsedObject(
  agent: SupervisorAgentConfig,
  parsed: Record<string, unknown>
): WakeConnectorResult | undefined {
  if (typeof parsed.ok !== 'boolean' || typeof parsed.handled !== 'boolean') {
    return undefined;
  }
  return {
    ok: parsed.ok,
    handled: parsed.handled,
    replySent: typeof parsed.replySent === 'boolean' ? parsed.replySent : undefined,
    replyText: typeof parsed.replyText === 'string' ? parsed.replyText : undefined,
    message: typeof parsed.message === 'string' ? parsed.message : undefined,
    error: typeof parsed.error === 'string' ? parsed.error : undefined,
    artifacts: Array.isArray(parsed.artifacts)
      ? parsed.artifacts as Array<{ path?: string; url?: string; mimeType?: string }>
      : undefined,
    metadata: parsed.metadata ?? { connector: agent.kind },
  };
}

function codexResultFromJsonl(agent: SupervisorAgentConfig, stdout: string): WakeConnectorResult | undefined {
  let eventCount = 0;
  let lastAgentText: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) {
      continue;
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    eventCount += 1;
    const item = event.item;
    if (
      event.type === 'item.completed' &&
      item &&
      typeof item === 'object' &&
      (item as Record<string, unknown>).type === 'agent_message' &&
      typeof (item as Record<string, unknown>).text === 'string'
    ) {
      lastAgentText = (item as Record<string, string>).text;
      const parsed = parseJsonObject(lastAgentText);
      if (parsed) {
        const result = resultFromParsedObject(agent, parsed);
        if (result) {
          return {
            ...result,
            metadata: result.metadata ?? { connector: agent.kind, parsed: 'codex-jsonl', eventCount },
          };
        }
      }
    }
  }

  if (!lastAgentText) {
    return undefined;
  }

  return {
    ok: true,
    handled: true,
    replySent: false,
    message: truncateText(lastAgentText.trim() || 'Codex completed without a final text message'),
    metadata: { connector: agent.kind, parsed: 'codex-jsonl', eventCount },
  };
}

function collectOpenClawPayloadTexts(value: unknown, output: string[]) {
  if (!value || typeof value !== 'object') {
    return;
  }
  const record = value as Record<string, unknown>;
  const payloads = record.payloads;
  if (Array.isArray(payloads)) {
    for (const payload of payloads) {
      if (
        payload &&
        typeof payload === 'object' &&
        typeof (payload as Record<string, unknown>).text === 'string'
      ) {
        output.push((payload as Record<string, string>).text);
      }
    }
  }
  collectOpenClawPayloadTexts(record.result, output);
}

function openClawObjectReplyText(value: unknown) {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ['replyText', 'message', 'text', 'content']) {
    const field = record[key];
    if (typeof field === 'string' && field.trim()) {
      return field.trim();
    }
  }
  return undefined;
}

function openClawPayloadReplyText(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = parseJsonObject(trimmed);
  const parsedReply = openClawObjectReplyText(parsed);
  if (parsedReply) {
    return parsedReply;
  }
  return trimmed;
}

function openClawNoReplyText(text: string) {
  const normalized = text.trim().toLowerCase();
  return (
    /\bno agenttalk reply sent\b/.test(normalized) ||
    /\bno reply sent\b/.test(normalized) ||
    /\bno reply is needed\b/.test(normalized) ||
    /\bnot sending (?:an )?agenttalk reply\b/.test(normalized) ||
    /\bdo not send (?:an )?agenttalk reply\b/.test(normalized)
  );
}

function openClawAgentTalkReplyToolUsed(value: unknown) {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  const result = record.result && typeof record.result === 'object'
    ? record.result as Record<string, unknown>
    : undefined;
  const resultMeta = result?.meta && typeof result.meta === 'object'
    ? result.meta as Record<string, unknown>
    : undefined;
  const toolSummary = (result?.toolSummary && typeof result.toolSummary === 'object'
    ? result.toolSummary
    : resultMeta?.toolSummary && typeof resultMeta.toolSummary === 'object'
      ? resultMeta.toolSummary
    : record.toolSummary) as Record<string, unknown> | undefined;
  const tools = Array.isArray(toolSummary?.tools) ? toolSummary.tools : [];
  return tools.some(tool =>
    typeof tool === 'string' &&
    (tool === 'agenttalk_conversation_reply' || tool.endsWith('.agenttalk_conversation_reply'))
  );
}

function openClawResultFromJson(agent: SupervisorAgentConfig, stdout: string): WakeConnectorResult | undefined {
  const parsed = parseJsonObject(stdout);
  if (parsed) {
    const result = resultFromParsedObject(agent, parsed);
    if (result) {
      return result;
    }
  }
  const payloadTexts: string[] = [];
  collectOpenClawPayloadTexts(parsed, payloadTexts);

  for (const text of payloadTexts.reverse()) {
    const inner = parseJsonObject(text);
    if (!inner) {
      continue;
    }
    const result = resultFromParsedObject(agent, inner);
    if (result) {
      return {
        ...result,
        metadata: result.metadata ?? { connector: agent.kind, parsed: 'openclaw-payload' },
      };
    }
  }

  for (const text of payloadTexts.reverse()) {
    const replyText = openClawPayloadReplyText(text);
    if (replyText) {
      if (openClawNoReplyText(replyText)) {
        return {
          ok: true,
          handled: true,
          replySent: false,
          message: 'OpenClaw completed without sending an AgentTalk reply',
          metadata: {
            connector: agent.kind,
            parsed: 'openclaw-payload-no-reply',
            noReplyText: true,
            visibleText: truncateText(replyText),
          },
        };
      }
      const replyAlreadySent = openClawAgentTalkReplyToolUsed(parsed);
      return {
        ok: true,
        handled: true,
        replySent: replyAlreadySent,
        replyText: replyAlreadySent ? undefined : truncateText(replyText),
        message: replyAlreadySent
          ? 'OpenClaw completed after sending an AgentTalk reply'
          : 'OpenClaw completed with reply text',
        metadata: {
          connector: agent.kind,
          parsed: 'openclaw-payload-text',
          agenttalkReplyToolUsed: replyAlreadySent,
          visibleText: truncateText(replyText),
        },
      };
    }
  }

  const replyText = openClawObjectReplyText(parsed);
  if (replyText) {
    if (openClawNoReplyText(replyText)) {
      return {
        ok: true,
        handled: true,
        replySent: false,
        message: 'OpenClaw completed without sending an AgentTalk reply',
        metadata: {
          connector: agent.kind,
          parsed: 'openclaw-json-no-reply',
          noReplyText: true,
          visibleText: truncateText(replyText),
        },
      };
    }
    const replyAlreadySent = openClawAgentTalkReplyToolUsed(parsed);
    return {
      ok: true,
      handled: true,
      replySent: replyAlreadySent,
      replyText: replyAlreadySent ? undefined : truncateText(replyText),
      message: replyAlreadySent
        ? 'OpenClaw completed after sending an AgentTalk reply'
        : 'OpenClaw completed with reply text',
      metadata: {
        connector: agent.kind,
        parsed: 'openclaw-json-text',
        agenttalkReplyToolUsed: replyAlreadySent,
        visibleText: truncateText(replyText),
      },
    };
  }

  return undefined;
}

function normalizeConnectorResult(
  agent: SupervisorAgentConfig,
  processResult?: ProcessResult
): WakeConnectorResult {
  if (!processResult) {
    return {
      ok: true,
      handled: true,
      replySent: false,
      message: 'noop connector handled wake',
      metadata: { connector: agent.kind },
    };
  }

  if (processResult.timedOut) {
    return {
      ok: false,
      handled: false,
      error: `connector timed out after ${processResult.durationMs}ms`,
      metadata: { connector: agent.kind },
    };
  }

  if (processResult.code !== 0) {
    return {
      ok: false,
      handled: false,
      error: truncateText(processResult.stderr || `connector exited ${processResult.code}`),
      metadata: {
        connector: agent.kind,
        exitCode: processResult.code,
        signal: processResult.signal,
      },
    };
  }

  if (agent.kind === 'codex') {
    const codexResult = codexResultFromJsonl(agent, processResult.stdout);
    if (codexResult) {
      return codexResult;
    }
  }

  if (agent.kind === 'openclaw') {
    const openClawOutput = [processResult.stdout, processResult.stderr]
      .map(value => value.trim())
      .filter(Boolean)
      .join('\n');
    const openClawResult = openClawResultFromJson(agent, openClawOutput);
    if (openClawResult) {
      return openClawResult;
    }
  }

  const parsed = parseJsonObject(processResult.stdout);
  if (parsed) {
    const result = resultFromParsedObject(agent, parsed);
    if (result) {
      return result;
    }
  }

  if (agent.kind === 'hermes') {
    const replyText = processResult.stdout.trim();
    if (replyText) {
      return {
        ok: true,
        handled: true,
        replySent: false,
        replyText: truncateText(replyText),
        message: 'Hermes completed with plain reply text',
        metadata: {
          connector: agent.kind,
          parsed: false,
          durationMs: processResult.durationMs,
        },
      };
    }
  }

  return {
    ok: true,
    handled: true,
    replySent: false,
    message: truncateText(processResult.stdout.trim() || 'connector completed successfully'),
    metadata: {
      connector: agent.kind,
      parsed: false,
      durationMs: processResult.durationMs,
    },
  };
}

function runProcess(
  spec: ProcessSpec,
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<ProcessResult> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env,
      shell: spec.shell,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const finish = (result: ProcessResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on('error', error => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.stdout.on('data', chunk => {
      if (stdout.length < MAX_CAPTURE_BYTES) {
        stdout += chunk.toString('utf8');
      }
    });
    child.stderr.on('data', chunk => {
      if (stderr.length < MAX_CAPTURE_BYTES) {
        stderr += chunk.toString('utf8');
      }
    });
    child.on('close', (code, signal) => {
      const ended = Date.now();
      finish({
        code,
        signal,
        timedOut,
        stdout,
        stderr,
        pid: child.pid,
        startedAt,
        endedAt: new Date(ended).toISOString(),
        durationMs: ended - started,
      });
    });
    if (spec.stdin) {
      child.stdin.end(spec.stdin);
    } else {
      child.stdin.end();
    }
  });
}

function metadataObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>) };
  }
  return value === undefined || value === null ? {} : { connectorMetadata: value };
}

function withConnectorTiming(
  result: WakeConnectorResult,
  processResult: ProcessResult | undefined,
  timing: {
    connectorStartedAt: string;
    connectorEndedAt: string;
    connectorDurationMs: number;
    latencyLogPath: string;
  }
): WakeConnectorResult {
  return {
    ...result,
    metadata: {
      ...metadataObject(result.metadata),
      connectorTiming: {
        connectorStartedAt: timing.connectorStartedAt,
        connectorEndedAt: timing.connectorEndedAt,
        connectorDurationMs: timing.connectorDurationMs,
        processPid: processResult?.pid ?? null,
        processStartedAt: processResult?.startedAt ?? null,
        processEndedAt: processResult?.endedAt ?? null,
        processDurationMs: processResult?.durationMs ?? null,
        processTimedOut: processResult?.timedOut ?? null,
        latencyLogPath: timing.latencyLogPath,
      },
    },
  };
}

function busyCheckResult(
  agent: SupervisorAgentConfig,
  processResult: ProcessResult
): WakeConnectorResult | undefined {
  const baseMetadata = {
    connector: agent.kind,
    stage: 'busy-check',
    durationMs: processResult.durationMs,
    exitCode: processResult.code,
    signal: processResult.signal,
  };

  if (processResult.timedOut) {
    const error = `runtime_busy_check_failed: busy command timed out after ${processResult.durationMs}ms`;
    return {
      ok: false,
      handled: false,
      replySent: false,
      message: error,
      error,
      metadata: { ...baseMetadata, reason: 'runtime_busy_check_timeout' },
    };
  }

  const parsed = parseJsonObject(processResult.stdout);
  if (parsed && typeof parsed.busy === 'boolean') {
    if (!parsed.busy) {
      return undefined;
    }
    const reason =
      typeof parsed.reason === 'string'
        ? parsed.reason
        : typeof parsed.message === 'string'
          ? parsed.message
          : 'connector reported runtime busy';
    const message = `runtime_busy: ${reason}`;
    return {
      ok: false,
      handled: false,
      replySent: false,
      message,
      error: message,
      metadata: {
        ...baseMetadata,
        reason: 'runtime_busy',
        busyCheck: parsed,
      },
    };
  }

  if (processResult.code === 75) {
    const reason = truncateText((processResult.stdout || processResult.stderr).trim() || 'connector reported runtime busy');
    const message = `runtime_busy: ${reason}`;
    return {
      ok: false,
      handled: false,
      replySent: false,
      message,
      error: message,
      metadata: { ...baseMetadata, reason: 'runtime_busy' },
    };
  }

  if (processResult.code !== 0) {
    const error = `runtime_busy_check_failed: ${truncateText(
      (processResult.stderr || processResult.stdout || `busy command exited ${processResult.code}`).trim()
    )}`;
    return {
      ok: false,
      handled: false,
      replySent: false,
      message: error,
      error,
      metadata: { ...baseMetadata, reason: 'runtime_busy_check_failed' },
    };
  }

  return undefined;
}

async function runConnectorBusyCheck(
  config: SupervisorConfig,
  agent: SupervisorAgentConfig,
  input: WakeConnectorInput,
  paths: {
    inputPath: string;
    contextJson: string;
    payloadJson: string;
    latencyLogPath?: string;
  }
) {
  const command = agent.connector?.busyCommand?.trim();
  if (!command) {
    return undefined;
  }
  const timeoutMs = Math.max(250, agent.connector?.busyCommandTimeoutMs ?? 5_000);
  try {
    const result = await runProcess(
      {
        command,
        args: [],
        cwd: agent.repoPath ?? process.cwd(),
        shell: true,
      },
      connectorEnv(config, agent, input, paths),
      timeoutMs
    );
    return busyCheckResult(agent, result);
  } catch (error) {
    const message = `runtime_busy_check_failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
    return {
      ok: false,
      handled: false,
      replySent: false,
      message,
      error: message,
      metadata: { connector: agent.kind, stage: 'busy-check', reason: 'runtime_busy_check_failed' },
    };
  }
}

function metadataFlag(metadata: unknown, key: string) {
  return Boolean(
    metadata &&
    typeof metadata === 'object' &&
    key in metadata &&
    (metadata as Record<string, unknown>)[key] === true
  );
}

function enforceLiveChatIdleWindow(
  agent: SupervisorAgentConfig,
  result: WakeConnectorResult,
  processResult: ProcessResult | undefined
) {
  if (
    !processResult ||
    !connectorLiveChatEnabled(agent) ||
    !result.ok ||
    !result.handled ||
    !metadataFlag(result.metadata, 'idle') ||
    metadataFlag(result.metadata, 'closedByPeer') ||
    metadataFlag(result.metadata, 'closedByAgent') ||
    metadataFlag(result.metadata, 'endedByAgent')
  ) {
    return result;
  }
  const idleTimeoutMs = connectorLiveChatIdleTimeoutMs(agent);
  if (processResult.durationMs + 1000 >= idleTimeoutMs) {
    return result;
  }
  const message =
    `${agent.kind} connector claimed live-chat idle after ${processResult.durationMs}ms, ` +
    `before configured idleTimeoutMs=${idleTimeoutMs}. Run AgentTalk listen/wait until the ` +
    'configured idle window elapses before returning idle. If you are ending intentionally after a bounded MCP listen, return endedByAgent true and idle false.';
  return {
    ...result,
    ok: false,
    handled: false,
    message,
    error: message,
    metadata: {
      original: result.metadata,
      earlyIdle: true,
      durationMs: processResult.durationMs,
      idleTimeoutMs,
    },
  };
}

export async function executeWakeConnector(
  config: SupervisorConfig,
  agent: SupervisorAgentConfig,
  input: WakeConnectorInput,
  runDir: string
): Promise<WakeConnectorResult> {
  await fs.mkdir(runDir, { recursive: true });
  await fs.chmod(runDir, 0o700).catch(() => undefined);
  const connectorStartedMs = Date.now();
  const connectorStartedAt = new Date(connectorStartedMs).toISOString();

  const connectorInput: WakeConnectorInput = {
    ...input,
    agentKind: agent.kind,
    liveChat: connectorLiveChatEnabled(agent),
    liveChatIdleTimeoutMs: connectorLiveChatIdleTimeoutMs(agent),
    liveChatMaxSessionMs: connectorLiveChatMaxSessionMs(agent),
    startupTimeoutMs: connectorStartupTimeoutMs(agent),
  };
  const hermesSession = agent.kind === 'hermes' && !agent.command?.trim() && hermesSessionReuseEnabled(agent)
    ? await prepareHermesSession(connectorInput)
    : undefined;
  if (hermesSession) {
    connectorInput.connectorSession = {
      key: hermesSession.key,
      hermesSessionId: hermesSession.sessionId,
    };
  }

  const inputPath = path.join(runDir, 'input.json');
  const stdoutPath = path.join(runDir, 'stdout.log');
  const stderrPath = path.join(runDir, 'stderr.log');
  const resultPath = path.join(runDir, 'result.json');
  const latencyLogPath = path.join(runDir, 'latency.jsonl');
  const codexOutputSchemaPath = path.join(runDir, 'codex-result.schema.json');
  const contextJson = JSON.stringify(toJsonSafe(connectorInput.contextMessages));
  const payloadJson = JSON.stringify(toJsonSafe(connectorInput.payload));

  await fs.writeFile(inputPath, stringifyJsonSafe(connectorInput), 'utf8');
  const shouldWriteCodexSchema =
    agent.kind === 'codex' &&
    !process.env.AGENTTALK_CODEX_OUTPUT_SCHEMA &&
    !disabledEnvValue(process.env.AGENTTALK_CODEX_OUTPUT_SCHEMA);
  if (shouldWriteCodexSchema) {
    await fs.writeFile(
      codexOutputSchemaPath,
      `${JSON.stringify(connectorResultJsonSchema(), null, 2)}\n`,
      'utf8'
    );
  }

  const busyResult = await runConnectorBusyCheck(config, agent, connectorInput, {
    inputPath,
    contextJson,
    payloadJson,
    latencyLogPath,
  });
  if (busyResult) {
    const connectorEndedMs = Date.now();
    const timedBusyResult = withConnectorTiming(busyResult, undefined, {
      connectorStartedAt,
      connectorEndedAt: new Date(connectorEndedMs).toISOString(),
      connectorDurationMs: connectorEndedMs - connectorStartedMs,
      latencyLogPath,
    });
    await fs.writeFile(stdoutPath, '', 'utf8');
    await fs.writeFile(stderrPath, '', 'utf8');
    await fs.writeFile(resultPath, stringifyJsonSafe(timedBusyResult), 'utf8');
    return timedBusyResult;
  }

  let processResult: ProcessResult | undefined;
  let result: WakeConnectorResult;
  try {
    let spec = buildProcessSpec(agent, connectorInput, {
      codexOutputSchemaPath: shouldWriteCodexSchema ? codexOutputSchemaPath : undefined,
    });
    if (spec) {
      processResult = await runProcess(
        spec,
        connectorEnv(config, agent, connectorInput, { inputPath, contextJson, payloadJson, latencyLogPath }),
        connectorRunTimeoutMs(agent)
      );
      if (
        hermesSession &&
        hermesSession.sessionId &&
        hermesSessionNotFound(processResult, hermesSession.sessionId)
      ) {
        await forgetHermesSession(connectorInput, hermesSession);
        spec = buildProcessSpec(agent, connectorInput, {
          codexOutputSchemaPath: shouldWriteCodexSchema ? codexOutputSchemaPath : undefined,
        });
        if (spec) {
          processResult = await runProcess(
            spec,
            connectorEnv(config, agent, connectorInput, { inputPath, contextJson, payloadJson, latencyLogPath }),
            connectorRunTimeoutMs(agent)
          );
        }
      }
    }
    result = enforceLiveChatIdleWindow(
      agent,
      normalizeConnectorResult(agent, processResult),
      processResult
    );
    if (agent.kind === 'hermes' && !agent.command?.trim() && processResult) {
      const sessionId = hermesSession
        ? await recordHermesSession(connectorInput, hermesSession, processResult)
        : undefined;
      result = withHermesRunMetadata(result, connectorInput, processResult, hermesSession, sessionId);
    }
  } catch (error) {
    result = {
      ok: false,
      handled: false,
      error: error instanceof Error ? error.message : String(error),
      metadata: { connector: agent.kind },
    };
  }

  const connectorEndedMs = Date.now();
  result = withConnectorTiming(result, processResult, {
    connectorStartedAt,
    connectorEndedAt: new Date(connectorEndedMs).toISOString(),
    connectorDurationMs: connectorEndedMs - connectorStartedMs,
    latencyLogPath,
  });
  await fs.writeFile(stdoutPath, processResult?.stdout ?? '', 'utf8');
  await fs.writeFile(stderrPath, processResult?.stderr ?? '', 'utf8');
  await fs.writeFile(resultPath, stringifyJsonSafe(result), 'utf8');

  return result;
}
