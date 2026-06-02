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
  durationMs: number;
};

const MAX_CAPTURE_BYTES = 1024 * 1024;
const DEFAULT_HERMES_LIVE_CHAT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_HERMES_LIVE_CHAT_MAX_SESSION_MS = 60 * 60 * 1000;
const DEFAULT_HERMES_STARTUP_TIMEOUT_MS = 60 * 1000;

function normalizePositiveMs(value: unknown, fallback: number) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

export function hermesLiveChatEnabled(agent: SupervisorAgentConfig) {
  return agent.kind === 'hermes' && agent.connector?.liveChat !== false;
}

export function hermesLiveChatIdleTimeoutMs(agent: SupervisorAgentConfig) {
  return normalizePositiveMs(
    agent.connector?.liveChatIdleTimeoutMs,
    DEFAULT_HERMES_LIVE_CHAT_IDLE_TIMEOUT_MS
  );
}

export function hermesLiveChatMaxSessionMs(agent: SupervisorAgentConfig) {
  return normalizePositiveMs(
    agent.connector?.liveChatMaxSessionMs,
    Math.max(DEFAULT_HERMES_LIVE_CHAT_MAX_SESSION_MS, agent.connectorTimeoutMs)
  );
}

export function hermesStartupTimeoutMs(agent: SupervisorAgentConfig) {
  return normalizePositiveMs(agent.connector?.startupTimeoutMs, DEFAULT_HERMES_STARTUP_TIMEOUT_MS);
}

export function connectorRunTimeoutMs(agent: SupervisorAgentConfig) {
  if (!hermesLiveChatEnabled(agent)) {
    return agent.connectorTimeoutMs;
  }
  return Math.max(agent.connectorTimeoutMs, hermesLiveChatMaxSessionMs(agent));
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
  return Math.max(1, Math.ceil((input.liveChatIdleTimeoutMs ?? DEFAULT_HERMES_LIVE_CHAT_IDLE_TIMEOUT_MS) / 1000));
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

function wakeText(input: WakeConnectorInput) {
  const liveChat = input.liveChat === true;
  const listenSeconds = liveChatListenTimeoutSeconds(input);
  const initialListenCommand = commandLineFromArgs(listenCommandArgs(input));
  const messages = input.contextMessages.length
    ? input.contextMessages
        .map(message => {
          const sequence = message.sequence.toString();
          return `[${sequence}] ${message.authorLabel}: ${message.text}`;
        })
        .join('\n')
    : '(no wake-range messages were visible)';

  return `You are ${input.agentName} / @${input.handle}, woken by AgentTalk.

Reason: ${input.wake.reason}
Conversation: ${input.wake.conversationId.toString()}
Wake ID: ${input.wake.wakeId}

Messages in wake range:
${messages}

Instructions:
- AgentTalk is your live communication tool. Treat this wake as a peer asking to talk, not as a one-shot callback.
- Stay in inference for this AgentTalk conversation. Use AgentTalk commands as tools at your own discretion, the same way you would use a terminal or browser while pursuing a task.
- Decide whether you need to reply.
- If Wake ID starts with test-, this is a synthetic supervisor validation wake. Do not run the AgentTalk reply command; return a handled connector result with replySent false.
- For live chat, send an immediate AgentTalk reply yourself, then actually run an AgentTalk listen command for follow-up messages in Conversation ${input.wake.conversationId.toString()} after sequence ${input.wake.maxSequence.toString()}. Continue the chat until the peer explicitly says goodbye/done, a listen command times out for the configured idle window, or your hard session budget is nearly exhausted.
- Initial live-chat listen command shape: ${initialListenCommand}
- Required active-chat loop when liveChat=true: reply, listen for up to ${listenSeconds}s, handle any peer messages returned by listen, update the after-sequence cursor, and listen again. Do not call the session idle just because there is no immediate message; only call it idle after an AgentTalk listen command blocks until timeout with no peer messages.
- Do not return connector JSON while you intend to keep chatting. Return connector JSON only when the chat is complete, substantially idle, synthetic, or unsafe to continue.
- If this is clearly a one-shot acknowledgement and there is no reason to keep listening, you may return structured JSON with replyText set to the exact message to send and replySent false. This is a fallback, not the normal live-chat path.
- If you send through AGENTTALK_REPLY_ARGS_JSON, parse it as a JSON object with command, args, and messagePlaceholder; build argv as [command, ...args], replace every exact messagePlaceholder occurrence with your reply text, preserve the required environment variables, then set replySent based on the command result.
- If you listen through AGENTTALK_LISTEN_ARGS_JSON, parse it as a JSON object with command and args; build argv as [command, ...args], preserve the required environment variables, and update the --after cursor after every message you handle.
- Keep AGENTTALK_STATE_DIR, SPACETIMEDB_HOST, and SPACETIMEDB_DB_NAME in the command environment.
- Active chat policy: liveChat=${liveChat ? 'true' : 'false'}, idleTimeoutMs=${input.liveChatIdleTimeoutMs?.toString() ?? 'unknown'}, maxSessionMs=${input.liveChatMaxSessionMs?.toString() ?? 'unknown'}.
- Do not reveal secrets, env values, or local paths in user-facing replies.
- Return or print a structured connector result JSON when possible:
  {"ok":true,"handled":true,"replySent":false,"replyText":null,"message":"handled wake","error":null,"artifacts":null,"metadata":null}
`;
}

function connectorEnv(
  config: SupervisorConfig,
  agent: SupervisorAgentConfig,
  input: WakeConnectorInput,
  paths: {
    inputPath: string;
    contextJson: string;
    payloadJson: string;
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
    AGENTTALK_ACTIVE_CHAT_IDLE_TIMEOUT_MS: input.liveChatIdleTimeoutMs?.toString() ?? '',
    AGENTTALK_ACTIVE_CHAT_MAX_SESSION_MS: input.liveChatMaxSessionMs?.toString() ?? '',
    AGENTTALK_STARTUP_TIMEOUT_MS: input.startupTimeoutMs?.toString() ?? '',
    AGENTTALK_WAKE_INPUT_JSON: paths.inputPath,
    AGENTTALK_WAKE_CONTEXT_JSON: paths.contextJson,
    AGENTTALK_WAKE_PAYLOAD_JSON: paths.payloadJson,
    OPENCLAW_AGENT_ID: openclawAgentId,
    OPENCLAW_TIMEOUT_SECONDS:
      process.env.OPENCLAW_TIMEOUT_SECONDS ??
      Math.max(1, Math.ceil(agent.connectorTimeoutMs / 1000)).toString(),
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
      `agenttalk:${input.handle}:${input.wake.conversationId.toString()}`,
      '--message',
      wakeText(input),
      '--json',
      '--timeout',
      Math.max(1, Math.ceil(agent.connectorTimeoutMs / 1000)).toString(),
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
    wakeText(input),
    '--quiet',
    '--source',
    'agenttalk',
    '--pass-session-id',
  ];
  for (const skill of hermesPreloadSkills(agent)) {
    args.push('--skills', skill);
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
    stdin: wakeText(input),
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
      stdin: wakeText(input),
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

function openClawResultFromJson(agent: SupervisorAgentConfig, stdout: string): WakeConnectorResult | undefined {
  const parsed = parseJsonObject(stdout);
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
    const openClawResult = openClawResultFromJson(agent, processResult.stdout);
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
      finish({
        code,
        signal,
        timedOut,
        stdout,
        stderr,
        durationMs: Date.now() - started,
      });
    });
    if (spec.stdin) {
      child.stdin.end(spec.stdin);
    } else {
      child.stdin.end();
    }
  });
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

export async function executeWakeConnector(
  config: SupervisorConfig,
  agent: SupervisorAgentConfig,
  input: WakeConnectorInput,
  runDir: string
): Promise<WakeConnectorResult> {
  await fs.mkdir(runDir, { recursive: true });
  await fs.chmod(runDir, 0o700).catch(() => undefined);

  const connectorInput: WakeConnectorInput = {
    ...input,
    agentKind: agent.kind,
    liveChat: hermesLiveChatEnabled(agent),
    liveChatIdleTimeoutMs: hermesLiveChatIdleTimeoutMs(agent),
    liveChatMaxSessionMs: hermesLiveChatMaxSessionMs(agent),
    startupTimeoutMs: hermesStartupTimeoutMs(agent),
  };
  const hermesSession = agent.kind === 'hermes' && !agent.command?.trim()
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
  });
  if (busyResult) {
    await fs.writeFile(stdoutPath, '', 'utf8');
    await fs.writeFile(stderrPath, '', 'utf8');
    await fs.writeFile(resultPath, stringifyJsonSafe(busyResult), 'utf8');
    return busyResult;
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
        connectorEnv(config, agent, connectorInput, { inputPath, contextJson, payloadJson }),
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
            connectorEnv(config, agent, connectorInput, { inputPath, contextJson, payloadJson }),
            connectorRunTimeoutMs(agent)
          );
        }
      }
    }
    result = normalizeConnectorResult(agent, processResult);
    if (hermesSession && processResult) {
      const sessionId = await recordHermesSession(connectorInput, hermesSession, processResult);
      result = {
        ...result,
        metadata: {
          connectorMetadata: result.metadata,
          hermesSessionKey: hermesSession.key,
          hermesSessionId: sessionId ?? connectorInput.connectorSession?.hermesSessionId ?? null,
        },
      };
    }
  } catch (error) {
    result = {
      ok: false,
      handled: false,
      error: error instanceof Error ? error.message : String(error),
      metadata: { connector: agent.kind },
    };
  }

  await fs.writeFile(stdoutPath, processResult?.stdout ?? '', 'utf8');
  await fs.writeFile(stderrPath, processResult?.stderr ?? '', 'utf8');
  await fs.writeFile(resultPath, stringifyJsonSafe(result), 'utf8');

  return result;
}
