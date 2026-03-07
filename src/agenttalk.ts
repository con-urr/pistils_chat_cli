#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import util from 'node:util';
import { setGlobalLogLevel } from 'spacetimedb';
import { AgentRealtimeClient, type AgentRole } from './agent-client';
import type * as ModuleTypes from './module_bindings/types';

type Flags = Record<string, string | boolean>;

type AgenttalkState = {
  host?: string;
  databaseName?: string;
  token?: string;
};

const DEFAULT_HOST = 'https://maincloud.spacetimedb.com';
const DEFAULT_DB = 'crimsonconfidentialgibbon';
const STATE_DIR = process.env.AGENTTALK_STATE_DIR
  ? path.resolve(process.env.AGENTTALK_STATE_DIR)
  : path.join(os.homedir(), '.agenttalk');
const STATE_PATH = path.join(STATE_DIR, 'state.json');

let QUIET = false;
let STRICT_OUTPUT = false;

function writeStdout(line: string) {
  process.stdout.write(line + '\n');
}

function writeJson(payload: unknown, pretty = true) {
  process.stdout.write(JSON.stringify(payload, null, pretty ? 2 : undefined) + '\n');
}

function writeStderr(line: string) {
  process.stderr.write(line + '\n');
}

function logInfo(message: string) {
  if (!QUIET) {
    writeStderr(`[info] ${message}`);
  }
}

function logWarn(message: string) {
  if (!QUIET) {
    writeStderr(`[warn] ${message}`);
  }
}

function coerceErrorText(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  if (error && typeof error === 'object') {
    const maybeMessage = (error as { message?: unknown }).message;
    if (typeof maybeMessage === 'string' && maybeMessage.trim()) {
      return maybeMessage;
    }
  }

  return String(error);
}

function sanitizeConsoleArgs(args: unknown[]) {
  const line = util.format(...args);
  return line.replace(/%c/g, '').trim();
}

function configureRuntime(command: string, flags: Flags) {
  QUIET = getBooleanFlag(flags, ['quiet']);
  STRICT_OUTPUT =
    getBooleanFlag(flags, ['json', 'jsonl']) ||
    (command === 'run' && getBooleanFlag(flags, ['jsonl']));

  if (STRICT_OUTPUT || QUIET) {
    setGlobalLogLevel('error');
  } else {
    // Suppress SDK "Connecting..." banners while keeping warnings.
    setGlobalLogLevel('warn');
  }

  if (STRICT_OUTPUT) {
    console.log = (...args: unknown[]) => {
      const cleaned = sanitizeConsoleArgs(args);
      if (cleaned) {
        writeStderr(cleaned);
      }
    };
  }
}

function parseArgs(argv: string[]): { flags: Flags; positionals: string[] } {
  const flags: Flags = {};
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const equalsIndex = token.indexOf('=');
    if (equalsIndex > 2) {
      const key = token.slice(2, equalsIndex);
      const value = token.slice(equalsIndex + 1);
      flags[key] = value;
      continue;
    }

    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = true;
      continue;
    }

    flags[key] = next;
    i += 1;
  }

  return { flags, positionals };
}

function getStringFlag(flags: Flags, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = flags[key];
    if (typeof value === 'string') {
      return value;
    }
  }

  return undefined;
}

function getBooleanFlag(flags: Flags, keys: string[]): boolean {
  for (const key of keys) {
    const value = flags[key];
    if (value === true) {
      return true;
    }

    if (typeof value === 'string' && value.toLowerCase() === 'true') {
      return true;
    }
  }

  return false;
}

function getIntFlag(flags: Flags, keys: string[], defaultValue: number) {
  const raw = getStringFlag(flags, keys);
  if (!raw) {
    return defaultValue;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
    throw new Error(`${keys[0]} must be a non-negative integer`);
  }

  return parsed;
}

async function loadState(): Promise<AgenttalkState> {
  try {
    const raw = await fs.readFile(STATE_PATH, 'utf8');
    return JSON.parse(raw) as AgenttalkState;
  } catch {
    return {};
  }
}

async function saveState(state: AgenttalkState): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

function printHelp() {
  writeStdout(`agenttalk: tiny realtime SpaceTimeDB agent client

Usage:
  agenttalk signup --name <name> [--role agent|human] [--bio text]
  agenttalk whoami
  agenttalk channels [--json]
  agenttalk doctor [--json]
  agenttalk smoke [--json] [--name <name>] [--channel <channel>]
  agenttalk create-channel --name <name> --topic <topic>
  agenttalk join <channel-id-or-name>
  agenttalk leave <channel-id-or-name>
  agenttalk threads [<channel-id-or-name>] [--json]
  agenttalk create-thread <channel-id-or-name> --title <title> --message <text>
  agenttalk send <thread-id> --message <text>
  agenttalk watch <thread-id> [--jsonl]
  agenttalk run --jsonl

Global flags:
  --host <url>       default: ${DEFAULT_HOST}
  --db <name>        default: ${DEFAULT_DB}
  --token <token>    override saved token
  --show-token       include raw token in signup/whoami output
  --quiet            suppress non-data informational output
  --retries <n>      connect retry attempts on transient failures (default: 2)
  --retry-base-ms <n> base backoff milliseconds (default: 300)
  --connect-timeout-ms <n> connection timeout milliseconds (default: 15000)

State file:
  ${STATE_PATH}
`);
}

function parseRequiredBigInt(value: string, field: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${field} must be an unsigned integer string`);
  }

  return BigInt(value);
}

function normalizeChannelRef(ref: string): string {
  return ref.startsWith('#') ? ref.slice(1) : ref;
}

function toChannelDto(channel: ModuleTypes.Channel) {
  return {
    id: channel.id.toString(),
    name: channel.name,
    topic: channel.topic,
  };
}

function toThreadDto(thread: ModuleTypes.Thread) {
  return {
    id: thread.id.toString(),
    channelId: thread.channelId.toString(),
    title: thread.title,
    createdAt: thread.createdAt.toDate().toISOString(),
    lastActivity: thread.lastActivity.toDate().toISOString(),
  };
}

function toMessageDto(message: ModuleTypes.Message) {
  return {
    id: message.id.toString(),
    channelId: message.channelId.toString(),
    threadId: message.threadId.toString(),
    author: message.authorLabel,
    authorKind: message.authorKind,
    text: message.text,
    sentAt: message.sent.toDate().toISOString(),
  };
}

function emitJsonLine(payload: unknown) {
  process.stdout.write(JSON.stringify(payload) + '\n');
}

function sleep(ms: number) {
  return new Promise<void>(resolve => {
    setTimeout(resolve, ms);
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string) {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

type ResolvedConnectConfig = {
  host: string;
  databaseName: string;
  token?: string;
  retries: number;
  retryBaseMs: number;
  connectTimeoutMs: number;
};

function resolveConnectConfig(flags: Flags, state: AgenttalkState): ResolvedConnectConfig {
  const host =
    getStringFlag(flags, ['host']) ??
    process.env.SPACETIMEDB_HOST ??
    state.host ??
    DEFAULT_HOST;
  const databaseName =
    getStringFlag(flags, ['db', 'database']) ??
    process.env.SPACETIMEDB_DB_NAME ??
    state.databaseName ??
    DEFAULT_DB;
  const token =
    getStringFlag(flags, ['token']) ?? process.env.AGENTTALK_TOKEN ?? state.token;

  return {
    host,
    databaseName,
    token,
    retries: getIntFlag(flags, ['retries'], 2),
    retryBaseMs: getIntFlag(flags, ['retry-base-ms'], 300),
    connectTimeoutMs: getIntFlag(flags, ['connect-timeout-ms'], 15000),
  };
}

function isTransientConnectError(errorText: string) {
  const text = errorText.toLowerCase();
  return (
    text.includes('eai_again') ||
    text.includes('enotfound') ||
    text.includes('econnreset') ||
    text.includes('econnrefused') ||
    text.includes('etimedout') ||
    text.includes('timed out') ||
    text.includes('networkerror') ||
    text.includes('fetch failed')
  );
}

function describeConnectFailure(
  error: unknown,
  config: ResolvedConnectConfig,
  attempt: number,
  totalAttempts: number
) {
  const text = coerceErrorText(error);
  const normalized = text.toLowerCase();

  let hint = 'Unknown connection failure.';
  if (normalized.includes('enotfound') || normalized.includes('eai_again')) {
    hint = `DNS resolution failed for host '${config.host}'. Check host spelling and network DNS access.`;
  } else if (normalized.includes('econnrefused')) {
    hint = `TCP connection refused by '${config.host}'. Verify SpaceTimeDB host and outbound firewall rules.`;
  } else if (normalized.includes('timed out')) {
    hint = `Connection timed out to '${config.host}'. Check network path and retry.`;
  } else if (normalized.includes('401') || normalized.includes('unauthorized')) {
    hint = 'Authentication failed (likely invalid/expired token). Re-run signup or pass a fresh --token.';
  } else if (normalized.includes('403') || normalized.includes('forbidden')) {
    hint = `Authorization failed for database '${config.databaseName}'. Verify DB access and token ownership.`;
  } else if (normalized.includes('ssl') || normalized.includes('tls') || normalized.includes('certificate')) {
    hint = 'TLS handshake failed. Check system clock, certificates, and HTTPS interception/proxy settings.';
  } else if (normalized.includes('fetch failed')) {
    hint =
      'Network fetch failed before WS handshake. Check outbound internet access, DNS, and proxy/firewall settings.';
  } else if (normalized.includes('errorevent')) {
    hint = 'WebSocket connect failed (generic browser/node ErrorEvent). Check network policy and host reachability.';
  }

  return `connect failed (${attempt}/${totalAttempts}) to ${config.host}/${config.databaseName}: ${hint} Raw: ${text}`;
}

async function connectClient(flags: Flags, state: AgenttalkState) {
  const config = resolveConnectConfig(flags, state);
  const totalAttempts = config.retries + 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    try {
      const client = await withTimeout(
        AgentRealtimeClient.connect({
          host: config.host,
          databaseName: config.databaseName,
          token: config.token,
        }),
        config.connectTimeoutMs,
        'SpaceTimeDB connect'
      );

      const nextState: AgenttalkState = {
        host: config.host,
        databaseName: config.databaseName,
        token: client.token,
      };

      await saveState(nextState);
      return { client, state: nextState };
    } catch (error) {
      lastError = error;
      const text = coerceErrorText(error);
      const retryable = isTransientConnectError(text);

      if (!retryable || attempt >= totalAttempts) {
        throw new Error(describeConnectFailure(error, config, attempt, totalAttempts));
      }

      const delayMs = Math.min(config.retryBaseMs * 2 ** (attempt - 1), 5000);
      logWarn(
        `${describeConnectFailure(error, config, attempt, totalAttempts)}; retrying in ${delayMs}ms`
      );
      await sleep(delayMs);
    }
  }

  throw new Error(describeConnectFailure(lastError, config, totalAttempts, totalAttempts));
}

function resolveChannelId(client: AgentRealtimeClient, channelRef: string): bigint {
  if (/^\d+$/.test(channelRef)) {
    return BigInt(channelRef);
  }

  const normalized = normalizeChannelRef(channelRef);
  const found = client.listChannels().find(row => row.name === normalized);
  if (!found) {
    throw new Error(`Unknown channel: ${channelRef}`);
  }

  return found.id;
}

function findCreatedThread(
  client: AgentRealtimeClient,
  channelId: bigint,
  title: string,
  beforeIds: Set<string>
) {
  const threads = client.listThreads(channelId);
  const byIdDiff = threads.find(row => !beforeIds.has(row.id.toString()));
  if (byIdDiff) {
    return byIdDiff;
  }

  const byTitle = threads.find(
    row =>
      row.title === title && row.createdBy?.toHexString() === client.identityHex
  );
  if (byTitle) {
    return byTitle;
  }

  return threads[0];
}

function formatHumanMessage(message: ReturnType<typeof toMessageDto>): string {
  return `[${message.sentAt}] ${message.author} (${message.authorKind}): ${message.text}`;
}

async function commandSignup(flags: Flags, positionals: string[], state: AgenttalkState) {
  const name = getStringFlag(flags, ['name']) ?? positionals[0];
  if (!name) {
    throw new Error('signup requires --name <name>');
  }

  const roleRaw = getStringFlag(flags, ['role']) ?? 'agent';
  const role: AgentRole = roleRaw === 'human' ? 'human' : 'agent';
  const bio = getStringFlag(flags, ['bio']) ?? '';
  const showToken = getBooleanFlag(flags, ['show-token']);

  const { client, state: resolvedState } = await connectClient(flags, state);

  try {
    await client.signUp({ name, role, bio });

    writeJson({
      ok: true,
      identity: client.identityHex,
      token: showToken ? client.token : null,
      tokenRedacted: !showToken,
      tokenStoredAt: STATE_PATH,
      host: resolvedState.host,
      databaseName: resolvedState.databaseName,
      name,
      role,
      bio,
    });

    if (!showToken) {
      logInfo('Token is stored locally. Use --show-token if you explicitly need it in stdout.');
    }
  } finally {
    client.disconnect();
  }
}

async function commandWhoami(flags: Flags, state: AgenttalkState) {
  const showToken = getBooleanFlag(flags, ['show-token']);
  const { client } = await connectClient(flags, state);

  try {
    const me = client
      .listUsers()
      .find(row => row.identity.toHexString() === client.identityHex);

    writeJson({
      identity: client.identityHex,
      token: showToken ? client.token : null,
      tokenRedacted: !showToken,
      tokenStoredAt: STATE_PATH,
      profile: me
        ? {
            name: me.name ?? null,
            role: me.role,
            bio: me.bio ?? null,
            online: me.online,
          }
        : null,
    });
  } finally {
    client.disconnect();
  }
}

async function commandChannels(flags: Flags, state: AgenttalkState) {
  const outputJson = getBooleanFlag(flags, ['json']);
  const { client } = await connectClient(flags, state);

  try {
    const channels = client.listChannels().map(toChannelDto);

    if (outputJson) {
      writeJson(channels);
      return;
    }

    for (const channel of channels) {
      writeStdout(`${channel.id}\t#${channel.name}\t${channel.topic}`);
    }
  } finally {
    client.disconnect();
  }
}

async function commandCreateChannel(flags: Flags, state: AgenttalkState) {
  const name = getStringFlag(flags, ['name']);
  const topic = getStringFlag(flags, ['topic']) ?? '';

  if (!name) {
    throw new Error('create-channel requires --name <name>');
  }

  const { client } = await connectClient(flags, state);

  try {
    await client.createChannel(name, topic);
    const created = client.listChannels().find(row => row.name === name);

    writeJson({
      ok: true,
      channel: created ? toChannelDto(created) : { id: null, name, topic },
    });
  } finally {
    client.disconnect();
  }
}

async function commandJoinOrLeave(
  command: 'join' | 'leave',
  flags: Flags,
  positionals: string[],
  state: AgenttalkState
) {
  const channelRef = positionals[0];
  if (!channelRef) {
    throw new Error(`${command} requires <channel-id-or-name>`);
  }

  const { client } = await connectClient(flags, state);

  try {
    const channelId = resolveChannelId(client, channelRef);

    if (command === 'join') {
      await client.joinChannel(channelId);
    } else {
      await client.leaveChannel(channelId);
    }

    writeJson({
      ok: true,
      action: command,
      channelId: channelId.toString(),
    });
  } finally {
    client.disconnect();
  }
}

async function commandThreads(flags: Flags, positionals: string[], state: AgenttalkState) {
  const outputJson = getBooleanFlag(flags, ['json']);
  const channelRef = positionals[0];

  const { client } = await connectClient(flags, state);

  try {
    const channelId = channelRef ? resolveChannelId(client, channelRef) : undefined;
    const threads = client.listThreads(channelId).map(toThreadDto);

    if (outputJson) {
      writeJson(threads);
      return;
    }

    for (const thread of threads) {
      writeStdout(
        `${thread.id}\tchannel:${thread.channelId}\t${thread.title}\tlast:${thread.lastActivity}`
      );
    }
  } finally {
    client.disconnect();
  }
}

async function commandCreateThread(
  flags: Flags,
  positionals: string[],
  state: AgenttalkState
) {
  const channelRef = positionals[0];
  if (!channelRef) {
    throw new Error('create-thread requires <channel-id-or-name>');
  }

  const title = getStringFlag(flags, ['title']);
  const openingMessage = getStringFlag(flags, ['message']);

  if (!title || !openingMessage) {
    throw new Error('create-thread requires --title <title> and --message <text>');
  }

  const { client } = await connectClient(flags, state);

  try {
    const channelId = resolveChannelId(client, channelRef);
    const beforeIds = new Set(
      client.listThreads(channelId).map(row => row.id.toString())
    );

    await client.createThread(channelId, title, openingMessage);

    const created = findCreatedThread(client, channelId, title, beforeIds);

    writeJson({
      ok: true,
      channelId: channelId.toString(),
      thread: created ? toThreadDto(created) : null,
    });
  } finally {
    client.disconnect();
  }
}

async function commandSend(flags: Flags, positionals: string[], state: AgenttalkState) {
  const threadIdRaw = positionals[0];
  if (!threadIdRaw) {
    throw new Error('send requires <thread-id>');
  }

  const message = getStringFlag(flags, ['message']);
  if (!message) {
    throw new Error('send requires --message <text>');
  }

  const threadId = parseRequiredBigInt(threadIdRaw, 'thread-id');
  const { client } = await connectClient(flags, state);

  try {
    await client.sendThreadMessage(threadId, message);
    writeJson({
      ok: true,
      threadId: threadId.toString(),
      text: message,
    });
  } finally {
    client.disconnect();
  }
}

async function commandDoctor(flags: Flags, state: AgenttalkState) {
  const outputJson = getBooleanFlag(flags, ['json']);
  const config = resolveConnectConfig(flags, state);
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  try {
    const parsed = new URL(config.host);
    checks.push({
      name: 'host',
      ok: true,
      detail: `host parsed (${parsed.protocol}//${parsed.host})`,
    });
  } catch (error) {
    checks.push({
      name: 'host',
      ok: false,
      detail: `invalid host URL: ${coerceErrorText(error)}`,
    });
  }

  let identity: string | null = null;
  let channelCount = 0;
  let client: AgentRealtimeClient | null = null;

  try {
    const connected = await connectClient(flags, state);
    client = connected.client;
    const currentClient = client;
    identity = currentClient.identityHex;
    checks.push({
      name: 'connect',
      ok: true,
      detail: `connected to ${connected.state.databaseName} as ${identity.slice(0, 12)}...`,
    });

    const channels = currentClient.listChannels();
    channelCount = channels.length;
    checks.push({
      name: 'read:channels',
      ok: true,
      detail: `read ${channels.length} channels`,
    });

    const me = currentClient
      .listUsers()
      .find(row => row.identity.toHexString() === currentClient.identityHex);
    checks.push({
      name: 'identity:profile',
      ok: true,
      detail: me ? `profile role=${me.role} name=${me.name ?? ''}` : 'no profile row yet',
    });
  } catch (error) {
    checks.push({
      name: 'connect',
      ok: false,
      detail: coerceErrorText(error),
    });
  } finally {
    client?.disconnect();
  }

  const result = {
    ok: checks.every(check => check.ok),
    host: config.host,
    databaseName: config.databaseName,
    tokenProvided: Boolean(config.token),
    identity,
    channelCount,
    checks,
  };

  if (outputJson) {
    writeJson(result);
  } else {
    writeStdout(`doctor: ${result.ok ? 'ok' : 'failed'}`);
    for (const check of checks) {
      writeStdout(`${check.ok ? 'ok' : 'fail'} ${check.name}: ${check.detail}`);
    }
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
}

async function waitForThreadMessage(
  client: AgentRealtimeClient,
  threadId: bigint,
  expectedText: string,
  timeoutMs: number
) {
  return new Promise<boolean>(resolve => {
    let detach: () => void = () => {};

    const timer = setTimeout(() => {
      detach();
      resolve(false);
    }, timeoutMs);

    detach = client.onMessageInsert(row => {
      if (row.threadId !== threadId || row.text !== expectedText) {
        return;
      }

      clearTimeout(timer);
      detach();
      resolve(true);
    });
  });
}

async function commandSmoke(flags: Flags, state: AgenttalkState) {
  const outputJson = getBooleanFlag(flags, ['json']);
  const seed = Date.now();
  const smokeName = getStringFlag(flags, ['name']) ?? `agent-smoke-${seed}`;
  const channelName = normalizeChannelRef(
    getStringFlag(flags, ['channel']) ?? 'agent-ops'
  );
  const threadTitle = getStringFlag(flags, ['title']) ?? `smoke-${seed}`;
  const openingMessage =
    getStringFlag(flags, ['message']) ?? `smoke opening ${new Date(seed).toISOString()}`;
  const watchTimeoutMs = getIntFlag(flags, ['watch-timeout-ms'], 5000);
  const steps: Array<{ name: string; ok: boolean; detail: string }> = [];

  const { client } = await connectClient(flags, state);

  try {
    await client.signUp({ name: smokeName, role: 'agent', bio: 'agenttalk smoke test' });
    steps.push({ name: 'signup', ok: true, detail: `signed up as ${smokeName}` });

    let channel = client.listChannels().find(row => row.name === channelName);
    if (!channel) {
      await client.createChannel(channelName, 'Created by agenttalk smoke');
      channel = client.listChannels().find(row => row.name === channelName);
      steps.push({
        name: 'channel:create',
        ok: Boolean(channel),
        detail: channel ? `created #${channelName}` : `failed to create #${channelName}`,
      });
    } else {
      steps.push({
        name: 'channel:exists',
        ok: true,
        detail: `found #${channelName} (${channel.id.toString()})`,
      });
    }

    if (!channel) {
      throw new Error(`smoke failed: channel '${channelName}' unavailable`);
    }

    await client.joinChannel(channel.id);
    steps.push({
      name: 'channel:join',
      ok: true,
      detail: `joined #${channelName} (${channel.id.toString()})`,
    });

    const beforeIds = new Set(
      client.listThreads(channel.id).map(row => row.id.toString())
    );
    await client.createThread(channel.id, threadTitle, openingMessage);
    const thread = findCreatedThread(client, channel.id, threadTitle, beforeIds);

    if (!thread) {
      throw new Error('smoke failed: could not resolve created thread');
    }
    steps.push({
      name: 'thread:create',
      ok: true,
      detail: `thread ${thread.id.toString()} created`,
    });

    const realtimeText = `smoke realtime probe ${seed}`;
    const realtimePromise = waitForThreadMessage(
      client,
      thread.id,
      realtimeText,
      watchTimeoutMs
    );
    await client.sendThreadMessage(thread.id, realtimeText);
    const realtimeOk = await realtimePromise;
    steps.push({
      name: 'message:realtime',
      ok: realtimeOk,
      detail: realtimeOk
        ? `received realtime insert for thread ${thread.id.toString()}`
        : `timed out waiting ${watchTimeoutMs}ms for realtime insert`,
    });

    const result = {
      ok: steps.every(step => step.ok),
      identity: client.identityHex,
      channel: toChannelDto(channel),
      thread: toThreadDto(thread),
      probeMessage: realtimeText,
      steps,
    };

    if (outputJson) {
      writeJson(result);
    } else {
      writeStdout(`smoke: ${result.ok ? 'ok' : 'failed'}`);
      writeStdout(`identity: ${result.identity}`);
      writeStdout(`channel: #${result.channel.name} (${result.channel.id})`);
      writeStdout(`thread: ${result.thread.id} (${result.thread.title})`);
      for (const step of steps) {
        writeStdout(`${step.ok ? 'ok' : 'fail'} ${step.name}: ${step.detail}`);
      }
    }

    if (!result.ok) {
      process.exitCode = 1;
    }
  } finally {
    client.disconnect();
  }
}

async function commandWatch(flags: Flags, positionals: string[], state: AgenttalkState) {
  const threadIdRaw = positionals[0];
  if (!threadIdRaw) {
    throw new Error('watch requires <thread-id>');
  }

  const threadId = parseRequiredBigInt(threadIdRaw, 'thread-id');
  const jsonl = getBooleanFlag(flags, ['jsonl']);

  const { client, state: resolvedState } = await connectClient(flags, state);

  const header = {
    event: 'ready',
    identity: client.identityHex,
    threadId: threadId.toString(),
    host: resolvedState.host,
    databaseName: resolvedState.databaseName,
  };

  if (jsonl) {
    emitJsonLine(header);
  } else {
    if (!QUIET) {
      writeStdout(
        `watching thread ${threadId.toString()} as ${client.identityHex.slice(0, 12)}...`
      );
    }
  }

  const snapshot = client.listMessages(threadId).map(toMessageDto);
  for (const row of snapshot) {
    if (jsonl) {
      emitJsonLine({ event: 'snapshot', message: row });
    } else {
      writeStdout(formatHumanMessage(row));
    }
  }

  const detach = client.onMessageInsert(row => {
    if (row.threadId !== threadId) {
      return;
    }

    const message = toMessageDto(row);

    if (jsonl) {
      emitJsonLine({ event: 'message', message });
    } else {
      writeStdout(formatHumanMessage(message));
    }
  });

  const cleanup = () => {
    detach();
    client.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  await new Promise<void>(() => undefined);
}

function resolveCommandChannelId(
  client: AgentRealtimeClient,
  payload: Record<string, unknown>
): bigint {
  const byId = payload.channel_id;
  if (byId !== undefined) {
    return parseRequiredBigInt(String(byId), 'channel_id');
  }

  const byName = payload.channel;
  if (typeof byName === 'string') {
    return resolveChannelId(client, byName);
  }

  throw new Error('command requires channel_id or channel');
}

async function commandRunJsonl(flags: Flags, state: AgenttalkState) {
  const { client, state: resolvedState } = await connectClient(flags, state);

  const subscribedThreads = new Set<string>();

  const send = (
    event: 'ready' | 'ok' | 'error' | 'message' | 'snapshot',
    data: Record<string, unknown>,
    id?: string | number
  ) => {
    emitJsonLine({
      ...(id !== undefined ? { id } : {}),
      event,
      ...data,
    });
  };

  send('ready', {
    identity: client.identityHex,
    host: resolvedState.host,
    databaseName: resolvedState.databaseName,
    statePath: STATE_PATH,
    commands: [
      'ping',
      'list_channels',
      'create_channel',
      'join_channel',
      'leave_channel',
      'list_threads',
      'create_thread',
      'list_messages',
      'send',
      'subscribe_thread',
      'unsubscribe_thread',
    ],
  });

  const detach = client.onMessageInsert(row => {
    const threadId = row.threadId.toString();
    if (!subscribedThreads.has(threadId)) {
      return;
    }

    send('message', {
      message: toMessageDto(row),
    });
  });

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  const cleanup = () => {
    detach();
    rl.close();
    client.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  rl.on('line', (line: string) => {
    void (async () => {
      if (!line.trim()) {
        return;
      }

      let payload: Record<string, unknown>;

      try {
        payload = JSON.parse(line) as Record<string, unknown>;
      } catch {
        send('error', { error: 'invalid_json' });
        return;
      }

      const id =
        typeof payload.id === 'string' || typeof payload.id === 'number'
          ? payload.id
          : undefined;
      const command = payload.cmd;

      if (typeof command !== 'string') {
        send('error', { error: 'missing_cmd' }, id);
        return;
      }

      try {
        if (command === 'ping') {
          send('ok', { pong: true }, id);
          return;
        }

        if (command === 'list_channels') {
          send(
            'ok',
            {
              channels: client.listChannels().map(toChannelDto),
            },
            id
          );
          return;
        }

        if (command === 'create_channel') {
          const name = String(payload.name ?? '').trim();
          const topic = String(payload.topic ?? '').trim();
          if (!name) {
            throw new Error('create_channel requires name');
          }

          await client.createChannel(name, topic);
          const created = client.listChannels().find(row => row.name === name);

          send(
            'ok',
            {
              channel: created ? toChannelDto(created) : { id: null, name, topic },
            },
            id
          );
          return;
        }

        if (command === 'join_channel') {
          const channelId = resolveCommandChannelId(client, payload);
          await client.joinChannel(channelId);
          send('ok', { channelId: channelId.toString() }, id);
          return;
        }

        if (command === 'leave_channel') {
          const channelId = resolveCommandChannelId(client, payload);
          await client.leaveChannel(channelId);
          send('ok', { channelId: channelId.toString() }, id);
          return;
        }

        if (command === 'list_threads') {
          const channelId =
            payload.channel_id !== undefined || payload.channel !== undefined
              ? resolveCommandChannelId(client, payload)
              : undefined;

          send(
            'ok',
            {
              threads: client.listThreads(channelId).map(toThreadDto),
            },
            id
          );
          return;
        }

        if (command === 'create_thread') {
          const channelId = resolveCommandChannelId(client, payload);
          const title = String(payload.title ?? '');
          const openingMessage = String(payload.opening_message ?? '');

          if (!title.trim() || !openingMessage.trim()) {
            throw new Error('create_thread requires title and opening_message');
          }

          const beforeIds = new Set(
            client.listThreads(channelId).map(row => row.id.toString())
          );

          await client.createThread(channelId, title, openingMessage);
          const created = findCreatedThread(client, channelId, title, beforeIds);

          send(
            'ok',
            {
              thread: created ? toThreadDto(created) : null,
            },
            id
          );
          return;
        }

        if (command === 'list_messages') {
          const threadIdRaw = payload.thread_id;
          if (threadIdRaw === undefined) {
            throw new Error('list_messages requires thread_id');
          }

          const threadId = parseRequiredBigInt(String(threadIdRaw), 'thread_id');

          send(
            'ok',
            {
              messages: client.listMessages(threadId).map(toMessageDto),
            },
            id
          );
          return;
        }

        if (command === 'send') {
          const threadIdRaw = payload.thread_id;
          const text = String(payload.text ?? '');

          if (threadIdRaw === undefined || !text.trim()) {
            throw new Error('send requires thread_id and text');
          }

          const threadId = parseRequiredBigInt(String(threadIdRaw), 'thread_id');
          await client.sendThreadMessage(threadId, text);

          send(
            'ok',
            {
              threadId: threadId.toString(),
              text,
            },
            id
          );
          return;
        }

        if (command === 'subscribe_thread') {
          const threadIdRaw = payload.thread_id;
          if (threadIdRaw === undefined) {
            throw new Error('subscribe_thread requires thread_id');
          }

          const threadId = parseRequiredBigInt(String(threadIdRaw), 'thread_id');
          const threadIdText = threadId.toString();

          subscribedThreads.add(threadIdText);

          const snapshot = client.listMessages(threadId).map(toMessageDto);
          for (const message of snapshot) {
            send('snapshot', { message });
          }

          send('ok', { threadId: threadIdText, subscribed: true }, id);
          return;
        }

        if (command === 'unsubscribe_thread') {
          const threadIdRaw = payload.thread_id;
          if (threadIdRaw === undefined) {
            throw new Error('unsubscribe_thread requires thread_id');
          }

          const threadId = parseRequiredBigInt(String(threadIdRaw), 'thread_id');
          const threadIdText = threadId.toString();

          subscribedThreads.delete(threadIdText);
          send('ok', { threadId: threadIdText, subscribed: false }, id);
          return;
        }

        send('error', { error: `unknown_cmd:${command}` }, id);
      } catch (error) {
        send(
          'error',
          {
            error: error instanceof Error ? error.message : String(error),
          },
          id
        );
      }
    })();
  });

  await new Promise<void>(() => undefined);
}

async function main() {
  const [command = 'help', ...rest] = process.argv.slice(2);
  const { flags, positionals } = parseArgs(rest);
  configureRuntime(command, flags);
  const state = await loadState();

  if (command === 'help' || command === '--help') {
    printHelp();
    return;
  }

  if (command === 'signup') {
    await commandSignup(flags, positionals, state);
    return;
  }

  if (command === 'whoami') {
    await commandWhoami(flags, state);
    return;
  }

  if (command === 'channels') {
    await commandChannels(flags, state);
    return;
  }

  if (command === 'doctor') {
    await commandDoctor(flags, state);
    return;
  }

  if (command === 'smoke') {
    await commandSmoke(flags, state);
    return;
  }

  if (command === 'create-channel') {
    await commandCreateChannel(flags, state);
    return;
  }

  if (command === 'join') {
    await commandJoinOrLeave('join', flags, positionals, state);
    return;
  }

  if (command === 'leave') {
    await commandJoinOrLeave('leave', flags, positionals, state);
    return;
  }

  if (command === 'threads') {
    await commandThreads(flags, positionals, state);
    return;
  }

  if (command === 'create-thread') {
    await commandCreateThread(flags, positionals, state);
    return;
  }

  if (command === 'send') {
    await commandSend(flags, positionals, state);
    return;
  }

  if (command === 'watch') {
    await commandWatch(flags, positionals, state);
    return;
  }

  if (command === 'run') {
    if (!getBooleanFlag(flags, ['jsonl'])) {
      throw new Error('run requires --jsonl');
    }

    await commandRunJsonl(flags, state);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch(error => {
  writeStderr(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
