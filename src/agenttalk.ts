#!/usr/bin/env node
import './node-compat';
import { existsSync, readFileSync, realpathSync, writeSync, promises as fs } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { Identity, setGlobalLogLevel } from 'spacetimedb';
import {
  AgentRealtimeClient,
  type AccountType,
  type AgentRole,
  type AgentSubscriptionProfile,
  type RichMessageInput,
  type RoomOptions,
} from './agent-client';
import type * as ModuleTypes from './module_bindings/types';
import {
  normalizeControlProfile,
  normalizeWakeAccessMode,
  normalizeWakeSenderAgentIds,
  OPEN_WAKE_WARNING,
} from './supervisor/config';
import {
  checkForPackageUpdate,
  formatPackageUpdateNotice,
  maybeNotifyPackageUpdate,
} from './update-check';

type Flags = Record<string, string | boolean>;

type AgenttalkState = {
  host?: string;
  databaseName?: string;
  token?: string;
  ipcSecret?: string;
};

const DEFAULT_HOST = 'https://maincloud.spacetimedb.com';
const DEFAULT_DB = 'crimsonconfidentialgibbon';
const STATE_DIR = process.env.AGENTTALK_STATE_DIR
  ? path.resolve(process.env.AGENTTALK_STATE_DIR)
  : path.join(os.homedir(), '.agenttalk');
const STATE_PATH = path.join(STATE_DIR, 'state.json');
const STATE_LOCK_DIR = path.join(STATE_DIR, '.state.lock');
const DAEMON_PID_PATH = path.join(STATE_DIR, 'agenttalkd.pid');
const DIRECTORY_SYNC_DELAY_MS = 250;

let QUIET = false;
let STRICT_OUTPUT = false;

const CLI_JSON_SCHEMA_VERSION = 'agenttalk.cli.v1';

type CliJsonWarning = {
  code: string;
  message: string;
  severity: 'info' | 'warning';
  field?: string;
};

function writeStdout(line: string) {
  writeSync(1, line + '\n');
}

function writeJson(payload: unknown, pretty = true) {
  writeSync(1, JSON.stringify(payload, null, pretty ? 2 : undefined) + '\n');
}

function normalizeCliWarnings(...sets: Array<unknown>): CliJsonWarning[] {
  const warnings: CliJsonWarning[] = [];
  const seen = new Set<string>();
  for (const set of sets) {
    if (!Array.isArray(set)) {
      continue;
    }
    for (const item of set) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const row = item as Partial<CliJsonWarning>;
      if (typeof row.code !== 'string' || typeof row.message !== 'string') {
        continue;
      }
      const severity = row.severity === 'warning' ? 'warning' : 'info';
      const warning: CliJsonWarning = {
        code: row.code,
        message: row.message,
        severity,
        ...(typeof row.field === 'string' && row.field ? { field: row.field } : {}),
      };
      const key = `${warning.code}:${warning.field ?? ''}:${warning.message}`;
      if (!seen.has(key)) {
        warnings.push(warning);
        seen.add(key);
      }
    }
  }
  return warnings;
}

function stableCliJson(
  command: string,
  payload: Record<string, unknown>,
  warnings: CliJsonWarning[] = []
) {
  return {
    schemaVersion: CLI_JSON_SCHEMA_VERSION,
    command,
    ...payload,
    warnings: normalizeCliWarnings(payload.warnings, warnings),
  };
}

function writeCommandJson(
  command: string,
  payload: Record<string, unknown>,
  warnings: CliJsonWarning[] = []
) {
  writeJson(stableCliJson(command, payload, warnings));
}

function writeStderr(line: string) {
  writeSync(2, line + '\n');
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
  const line = args
    .map(arg => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
    .join(' ');
  return line.replace(/%c/g, '').trim();
}

function configureRuntime(command: string, flags: Flags) {
  const agentMode = getBooleanFlag(flags, ['agent']);
  QUIET = getBooleanFlag(flags, ['quiet']) || agentMode;
  STRICT_OUTPUT =
    getBooleanFlag(flags, ['json', 'jsonl', 'agent']) ||
    ((command === 'run' || command === 'serve') && getBooleanFlag(flags, ['jsonl']));

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

function getBigIntFlag(flags: Flags, keys: string[]): bigint | undefined {
  const raw = getStringFlag(flags, keys);
  if (!raw) {
    return undefined;
  }

  return parseRequiredBigInt(raw, keys[0]);
}

function getDurationFlagMs(flags: Flags, keys: string[], defaultValueMs: number) {
  let raw: string | undefined;
  for (const key of keys) {
    const value = flags[key];
    if (value === true) {
      return defaultValueMs;
    }
    if (typeof value === 'string') {
      raw = value;
      break;
    }
  }

  if (!raw) {
    return defaultValueMs;
  }

  const match = raw.trim().match(/^(\d+)(ms|s|m)?$/i);
  if (!match) {
    throw new Error(`${keys[0]} must be a duration like 500ms, 30s, or 2m`);
  }

  const value = Number(match[1]);
  const unit = (match[2] ?? 'ms').toLowerCase();
  if (unit === 'm') {
    return value * 60_000;
  }
  if (unit === 's') {
    return value * 1000;
  }
  return value;
}

async function loadState(): Promise<AgenttalkState> {
  try {
    const raw = await fs.readFile(STATE_PATH, 'utf8');
    return JSON.parse(raw) as AgenttalkState;
  } catch {
    return {};
  }
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

async function saveState(state: AgenttalkState): Promise<void> {
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

function daemonPipePath() {
  if (process.env.AGENTTALK_DAEMON_PIPE) {
    return process.env.AGENTTALK_DAEMON_PIPE;
  }
  const state = loadStateSync();
  const host = process.env.SPACETIMEDB_HOST ?? state.host ?? DEFAULT_HOST;
  const databaseName = process.env.SPACETIMEDB_DB_NAME ?? state.databaseName ?? DEFAULT_DB;
  const key = createHash('sha256')
    .update(JSON.stringify({ stateDir: STATE_DIR, host, databaseName }))
    .digest('hex')
    .slice(0, 16);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\agenttalkd-${key}`;
  }
  return path.join(os.tmpdir(), `agenttalkd-${key}.sock`);
}

function sendDaemonCommand(payload: Record<string, unknown>, timeoutMs = 3000) {
  return new Promise<any>((resolve, reject) => {
    const socket = net.createConnection(daemonPipePath());
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Timed out connecting to agenttalkd'));
    }, timeoutMs);
    let buffer = '';

    socket.on('connect', () => {
      const state = loadStateSync();
      socket.write(
        JSON.stringify({
          ...payload,
          ipcSecret: state.ipcSecret,
        }) + '\n'
      );
    });
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) {
        return;
      }
      clearTimeout(timer);
      const line = buffer.slice(0, newline);
      socket.end();
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(error);
      }
    });
    socket.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      if (!buffer) {
        reject(new Error('agenttalkd closed without a response'));
      }
    });
  });
}

async function pingDaemon(timeoutMs = 750) {
  try {
    const response = await sendDaemonCommand({ id: 'ping', cmd: 'ping' }, timeoutMs);
    return response?.ok === true ? response : undefined;
  } catch {
    return undefined;
  }
}

function agenttalkdEntrypoint() {
  const argvFile = path.resolve(process.argv[1] ?? 'agenttalk.js');
  const currentFile = existsSync(argvFile) ? realpathSync(argvFile) : argvFile;
  const dir = path.dirname(currentFile);
  const isTypeScript = currentFile.endsWith('.ts');
  if (isTypeScript) {
    const tsxCli = [
      path.resolve(dir, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      path.resolve(dir, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      path.resolve(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    ].find(candidate => existsSync(candidate));

    if (tsxCli) {
      return {
        command: process.execPath,
        args: [tsxCli, path.join(dir, 'agenttalkd.ts'), '--ipc-only'],
      };
    }
  }

  return {
    command: isTypeScript ? (process.platform === 'win32' ? 'npx.cmd' : 'npx') : process.execPath,
    args: isTypeScript
      ? ['tsx', path.join(dir, 'agenttalkd.ts'), '--ipc-only']
      : [path.join(dir, 'agenttalkd.js'), '--ipc-only'],
  };
}

function quotePowerShellString(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function powerShellArray(values: string[]) {
  return `@(${values.map(quotePowerShellString).join(',')})`;
}

function spawnDaemonEntrypoint(entrypoint: { command: string; args: string[] }) {
  if (process.platform === 'win32') {
    const command = [
      'Start-Process',
      '-FilePath',
      quotePowerShellString(entrypoint.command),
      '-ArgumentList',
      powerShellArray(entrypoint.args),
      '-WindowStyle',
      'Hidden',
    ].join(' ');
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', command],
      {
        stdio: 'ignore',
        env: process.env,
        windowsHide: true,
      }
    );
    child.unref();
    return;
  }

  const child = spawn(entrypoint.command, entrypoint.args, {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
}

async function startDaemonProcess() {
  const existing = await pingDaemon();
  if (existing) {
    return { started: false, response: existing };
  }

  const entrypoint = agenttalkdEntrypoint();
  spawnDaemonEntrypoint(entrypoint);

  const readyTimeoutMs = 20_000;
  const pollMs = 250;
  const startedAt = Date.now();
  while (Date.now() - startedAt < readyTimeoutMs) {
    await sleep(pollMs);
    const response = await pingDaemon();
    if (response) {
      return { started: true, response };
    }
  }

  throw new Error(`agenttalkd did not become ready within ${Math.ceil(readyTimeoutMs / 1000)}s`);
}

async function acquireStateLock(timeoutMs = 15000) {
  const started = Date.now();

  while (true) {
    try {
      await fs.mkdir(STATE_DIR, { recursive: true });
      await fs.mkdir(STATE_LOCK_DIR);
      await fs.writeFile(
        path.join(STATE_LOCK_DIR, 'owner.json'),
        JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }) + '\n',
        'utf8'
      );
      return async () => {
        await fs.rm(STATE_LOCK_DIR, { recursive: true, force: true });
      };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== 'EEXIST') {
        throw error;
      }

      try {
        const stat = await fs.stat(STATE_LOCK_DIR);
        if (Date.now() - stat.mtimeMs > 120000) {
          await fs.rm(STATE_LOCK_DIR, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }

      if (Date.now() - started > timeoutMs) {
        throw new Error(`Timed out waiting for state lock at ${STATE_LOCK_DIR}`);
      }

      await sleep(100);
    }
  }
}

function wantsJson(flags: Flags) {
  return getBooleanFlag(flags, ['json', 'agent']);
}

function printHelp() {
  writeStdout(`agenttalk: tiny realtime SpaceTimeDB agent client

Usage:
  agenttalk init --handle <handle> [--name <display>] [--role agent|human] [--bio text] [--json]
  agenttalk find <query-or-handle> [--json]
  agenttalk chat <handle-or-identity> --message <text> [--kind chat|task|handoff|tool_result|approval_request|status|system] [--emit-event] [--json]
  agenttalk reply <conversation-id> --message <text> [--kind chat|task|handoff|tool_result|approval_request|status|system] [--json]
  agenttalk group start --with <handle-or-identity,...> [--title text] [--message text] [--json]
  agenttalk inbox [--wait 30s] [--max 5] [--min 1] [--json|--jsonl]
  agenttalk listen --conversation <id> [--after <sequence>] [--max 1] [--min 1] [--follow] [--timeout 60s] [--json|--jsonl]
  agenttalk wait --conversation <id> [--after <sequence>] [--max 1] [--min 1] [--follow] [--timeout 60s] [--json|--jsonl]
  agenttalk listen --thread <id> [--max 5] [--timeout 60s] [--json|--jsonl]
  agenttalk transcript --conversation <id> [--limit 50] [--after <sequence>|--before <sequence>] [--json]
  agenttalk transcript --thread <id> [--limit 50] [--after-id <id>|--before-id <id>] [--json]
  agenttalk account create --handle <handle> [--name <display>] [--role agent|human] [--bio text]
  agenttalk account bootstrap-operator
  agenttalk account type <handle> --type free|group|pro|operator [--group-chat true|false]
  agenttalk account entitlements [--json]
  agenttalk account search [--query text] [--handle handle] [--role agent|human] [--online true|false] [--json]
  agenttalk signup --name <name> [--role agent|human] [--bio text]
  agenttalk whoami
  agenttalk daemon start|status|stop|doctor|run
  agenttalk channels [--json]
  agenttalk doctor [--json]
  agenttalk smoke [--json] [--name <name>] [--channel <channel>]
  agenttalk create-channel --name <name> --topic <topic> [--visibility public|private] [--join-policy open|password|invite] [--password text]
  agenttalk room start --name <name> --with <handle-or-identity,...> [--message text] [--visibility public|private] [--join-policy open|password|invite] [--password text]
  agenttalk room info <channel-id-or-name> [--json]
  agenttalk room members <channel-id-or-name> [--json]
  agenttalk room remove <channel-id-or-name> <handle-or-identity> [--reason text]
  agenttalk room config <channel-id-or-name> [--visibility public|private] [--join-policy open|password|invite] [--password text]
  agenttalk room role <channel-id-or-name> <handle-or-identity> --role owner|mod|member
  agenttalk room kick <channel-id-or-name> <handle-or-identity> [--reason text]
  agenttalk join <channel-id-or-name> [--password text]
  agenttalk leave <channel-id-or-name>
  agenttalk threads [<channel-id-or-name>] [--json]
  agenttalk create-thread <channel-id-or-name> --title <title> --message <text>
  agenttalk send <thread-id> --message <text> [--kind chat|task|handoff|tool_result|approval_request|status|system]
  agenttalk conversation start <handle-or-identity> [--title text] [--message text] [--json]
  agenttalk conversation group --title <title> --members <handle-or-identity,...> [--message text] [--json]
  agenttalk conversation add <conversation-id> <handle-or-identity> [--role mod|member]
  agenttalk conversation send <conversation-id> --message <text> [--kind chat|task|handoff|tool_result|approval_request|status|system]
  agenttalk conversation list [--json]
  agenttalk conversation messages <conversation-id> [--limit 50] [--after <sequence>|--before <sequence>] [--json]
  agenttalk task create <channel-id-or-name> --title <title> --description <text> [--priority low|normal|high|urgent] [--assign handle-or-identity]
  agenttalk task claim <task-id>
  agenttalk task status <task-id> --status open|claimed|in_progress|blocked|done|cancelled
  agenttalk task list [channel-id-or-name] [--json]
  agenttalk handoff create <channel-id-or-name> --summary <text> [--to handle-or-identity] [--context-json json]
  agenttalk handoff accept <handoff-id>
  agenttalk handoff list [channel-id-or-name] [--json]
  agenttalk event emit --kind typing|heartbeat|mention|joined_thread|joined_conversation|status [--channel <channel>] [--thread-id <id>] [--conversation-id <id>] [--target handle-or-identity] [--text text]
  agenttalk watch <thread-id> [--jsonl]
  agenttalk wake status [--private] [--json]
  agenttalk wake on [--latency-ms <n>] [--status-text text] [--wake-access allow-list|open] [--json]
  agenttalk wake off [--json]
  agenttalk wake register [--kind local_daemon|webhook|cloud_runner|mcp_session|push_gateway|noop] [--endpoint-ref ref] [--secret-hash hash] [--json]
  agenttalk wake policy [--direct true|false] [--mention true|false] [--group true|false] [--handoff true|false] [--business true|false] [--wake-access allow-list|open] [--allow-senders agent-id[,agent-id]] [--block-senders agent-id[,agent-id]] [--availability online|wakeable|sleeping|offline|unavailable] [--json]
  agenttalk wake requests [--status pending|leased|dispatched|acked|failed|suppressed|expired] [--conversation <id>] [--json]
  agenttalk wake listen [--timeout 30s] [--follow] [--context] [--exec "<command>"] [--no-auto-ack] [--json|--jsonl]
  agenttalk wake claim [wake-id] [--lease-ms <n>] [--json]
  agenttalk wake ack <wake-id> [--attempt-id <id>] [--json]
  agenttalk wake fail <wake-id> --error <text> [--retry-after-ms <n>] [--json]
  agenttalk setup --agents [--dry-run] [--json]
  agenttalk hermes preflight [--strict] [--repo <hermes-repo>]
  agenttalk hermes codex-oauth --confirm [--timeout-seconds 600] [--repo <hermes-repo>]
  agenttalk mcp [serve|stdio] [--transport stdio]
  agenttalk mcp config [--client codex|claude|cursor|all] [--dev] [--url https://<service>/mcp --bearer-token-env-var AGENTTALK_MCP_TOKEN] [--json]
  agenttalk mcp install-codex [--name agenttalk] [--dev] [--url https://<service>/mcp --bearer-token-env-var AGENTTALK_MCP_TOKEN] [--dry-run] [--json]
  agenttalk supervisor init|add-agent|list|status|doctor|test-wake [--json]
  agenttalk update check [--force] [--json]
  agenttalk repair-access
  agenttalk run --jsonl
  agenttalk serve --jsonl
  agenttalkd

Open beta supported daemon-first commands:
  init, whoami, doctor, daemon start/status/stop/doctor
  find, chat, reply, group start, inbox, listen/wait --conversation, transcript --conversation
  conversation list/start/group/add/send/messages, wake status/on/off/register/policy/listen/claim/ack/fail, setup, hermes, mcp, supervisor

Experimental/dev surfaces:
  room/thread/task/handoff/event/watch/serve and account operator tools are available but are not the primary open-beta hot path.
  MCP, archive storage, billing, Redis edge guard, and Postgres cold storage are planned adapters, not implemented core dependencies.

Global flags:
  --host <url>       default: ${DEFAULT_HOST}
  --db <name>        default: ${DEFAULT_DB}
  --token <token>    override saved token
  --show-token       include raw token in signup/whoami output
  --quiet            suppress non-data informational output
  --agent            agent-friendly mode: quiet + JSON output
  --direct           disabled; use SpaceTimeDB CLI/admin tooling for direct DB debugging
  --no-daemon        disabled; agenttalk commands always use agenttalkd
  --daemon           compatibility flag; daemon routing is already the default
  --retries <n>      connect retry attempts on transient failures (default: 2)
  --retry-base-ms <n> base backoff milliseconds (default: 300)
  --connect-timeout-ms <n> connection timeout milliseconds (default: 15000)
  --subscription-profile <directory|identity|direct|direct-lite|daemon-direct|account-admin|wake|rooms|ops|all>
                     override the command's optimized realtime subscription set
  --no-update-check  suppress passive npm update checks for this invocation

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

function normalizeAccountRef(ref: string): string {
  return ref.startsWith('@') ? ref.slice(1).trim().toLowerCase() : ref.trim().toLowerCase();
}

function maybeAccountHandle(ref: string) {
  const normalized = normalizeAccountRef(ref);
  return /^[a-z0-9][a-z0-9_-]{2,39}$/.test(normalized) ? normalized : undefined;
}

function directoryLimitFromFlags(flags: Flags, defaultValue = 20) {
  return BigInt(Math.min(getIntFlag(flags, ['limit'], defaultValue), 50));
}

function directoryLimitFromValue(value: unknown, defaultValue = 20) {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : defaultValue;
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    return BigInt(defaultValue);
  }

  return BigInt(Math.min(parsed, 50));
}

function assertChoice<T extends string>(
  value: string | undefined,
  field: string,
  allowed: readonly T[],
  defaultValue?: T
): T {
  if (!value) {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new Error(`${field} is required`);
  }

  if ((allowed as readonly string[]).includes(value)) {
    return value as T;
  }

  throw new Error(`${field} must be one of: ${allowed.join(', ')}`);
}

function parseOptionalBoolean(raw: string | undefined, field: string) {
  if (raw === undefined) {
    return undefined;
  }

  const normalized = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'online'].includes(normalized)) {
    return true;
  }
  if (['false', '0', 'no', 'offline'].includes(normalized)) {
    return false;
  }

  throw new Error(`${field} must be true or false`);
}

function getOptionalBooleanFlag(flags: Flags, keys: string[]) {
  for (const key of keys) {
    const value = flags[key];
    if (value === true) {
      return true;
    }
    if (typeof value === 'string') {
      return parseOptionalBoolean(value, key);
    }
  }
  return undefined;
}

function parseRoomOptions(flags: Flags): RoomOptions {
  const visibilityRaw = getStringFlag(flags, ['visibility']);
  const joinPolicyRaw = getStringFlag(flags, ['join-policy', 'joinPolicy']);

  return {
    visibility: visibilityRaw
      ? assertChoice(visibilityRaw, 'visibility', ['public', 'private'] as const)
      : undefined,
    joinPolicy: joinPolicyRaw
      ? assertChoice(joinPolicyRaw, 'join-policy', ['open', 'password', 'invite'] as const)
      : undefined,
    password: getStringFlag(flags, ['password']),
  };
}

function parseRichMessageInput(flags: Flags): RichMessageInput {
  const kindRaw = getStringFlag(flags, ['kind']);
  const replyToRaw = getStringFlag(flags, ['reply-to', 'replyToMessageId']);
  return {
    kind: kindRaw
      ? assertChoice(kindRaw, 'kind', [
          'chat',
          'task',
          'handoff',
          'tool_result',
          'approval_request',
          'status',
          'system',
        ] as const)
      : undefined,
    replyToMessageId: replyToRaw
      ? parseRequiredBigInt(replyToRaw, 'reply-to')
      : undefined,
    correlationId: getStringFlag(flags, ['correlation-id', 'correlationId']),
    metadataJson: getStringFlag(flags, ['metadata-json', 'metadataJson']),
    artifactUrl: getStringFlag(flags, ['artifact-url', 'artifactUrl']),
    artifactMimeType: getStringFlag(flags, ['artifact-mime', 'artifactMimeType']),
    clientRequestId: getStringFlag(flags, ['client-request-id', 'clientRequestId']),
  };
}

function directCliRequested(flags: Flags) {
  return getBooleanFlag(flags, ['direct', 'no-daemon']);
}

function allowDirectCli(flags: Flags) {
  if (directCliRequested(flags)) {
    throw new Error(
      'Direct SpaceTimeDB CLI mode is not available through agenttalk. Use the SpaceTimeDB CLI or backend admin tooling for direct database debugging.'
    );
  }

  return false;
}

function assertDirectCliAllowed(flags: Flags) {
  allowDirectCli(flags);

  throw new Error(
    'This command is not yet daemon-routed. The agenttalk CLI requires the agenttalkd gateway and will not open a direct SpaceTimeDB connection; use the SpaceTimeDB CLI/admin tooling for direct database debugging.'
  );
}

function makeLocalRequestId(action: string) {
  return `agenttalk:${action}:${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2)}`;
}

function receiptActionForDaemonCommand(command: string) {
  if (command === 'open_direct') {
    return 'open_direct_conversation';
  }
  if (command === 'send_conversation') {
    return 'send_conversation_message';
  }
  if (command === 'send_direct') {
    return 'send_direct_message';
  }
  return undefined;
}

async function ensureDaemonRunning(_flags: Flags) {
  const existing = await pingDaemon();
  if (existing) {
    return { response: existing, started: false };
  }

  if (!QUIET && !STRICT_OUTPUT) {
    writeStderr('[info] agenttalkd not running; starting...');
  }

  const started = await startDaemonProcess();
  return started;
}

async function sendRequiredDaemonCommand(
  flags: Flags,
  payload: Record<string, unknown>,
  timeoutMs = 5000,
  returnErrors = false
) {
  if (allowDirectCli(flags)) {
    return undefined;
  }

  const daemonStatus = await ensureDaemonRunning(flags);

  const command = String(payload.cmd ?? payload.command ?? 'command');
  const requestPayload = { ...payload };
  requestPayload.id = makeLocalRequestId(String(payload.id ?? command));
  const receiptAction = receiptActionForDaemonCommand(command);
  if (
    receiptAction &&
    typeof requestPayload.clientRequestId !== 'string' &&
    typeof requestPayload.client_request_id !== 'string'
  ) {
    requestPayload.clientRequestId = makeLocalRequestId(receiptAction);
  }

  const response = await sendDaemonCommand(requestPayload, timeoutMs);
  if (!response?.ok && !returnErrors) {
    throw new Error(response?.error ?? 'agenttalkd returned an error');
  }
  return response ? { ...response, daemonStarted: daemonStatus.started === true } : response;
}

function daemonTransportPayload<T extends Record<string, unknown>>(
  payload: T,
  daemonResponse?: { daemonStarted?: boolean } | null
) {
  return {
    ok: true,
    transport: 'daemon',
    daemon: true,
    ...(daemonResponse ? { daemonStarted: daemonResponse.daemonStarted === true } : {}),
    ...payload,
  };
}

async function executableOnPath(command: string) {
  const pathValue = process.env.PATH ?? '';
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
      : [''];
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    for (const ext of exts) {
      const candidate = path.join(
        dir,
        process.platform === 'win32' ? `${command}${ext.toLowerCase()}` : command
      );
      if (existsSync(candidate)) {
        return true;
      }
    }
  }
  return false;
}

function runToolCommand(command: string, args: string[]) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', code => {
      resolve({ stdout, stderr, code });
    });
  });
}

function flagsToArgs(flags: Flags) {
  const args: string[] = [];
  for (const [key, value] of Object.entries(flags)) {
    if (value === true) {
      args.push(`--${key}`);
    } else if (typeof value === 'string') {
      args.push(`--${key}`, value);
    }
  }
  return args;
}

function packagedScriptPath(fileName: string) {
  return path.resolve(__dirname, '..', 'scripts', fileName);
}

async function runPackagedNodeScript(fileName: string, args: string[]) {
  const scriptPath = packagedScriptPath(fileName);
  if (!existsSync(scriptPath)) {
    throw new Error(`Packaged helper script was not found: ${fileName}`);
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      stdio: 'inherit',
      windowsHide: false,
      env: process.env,
    });
    child.on('error', reject);
    child.on('close', code => {
      process.exitCode = code ?? 1;
      resolve();
    });
  });
}

function blockedDirectTransportPayload<T extends Record<string, unknown>>(payload: T) {
  return {
    transport: 'direct-disabled',
    daemon: false,
    ...payload,
  };
}

function parseAccountRefs(raw: string | undefined, extraRefs: string[] = []) {
  return [
    ...(raw ? raw.split(',') : []),
    ...extraRefs,
  ]
    .map(ref => ref.trim())
    .filter(Boolean);
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

function identityHex(identity?: Identity | null) {
  return identity ? identity.toHexString() : null;
}

function toAccountDto(account: ModuleTypes.Account) {
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

function toAccountEntitlementDto(entitlement: ModuleTypes.AccountEntitlement) {
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

function toRoomConfigDto(config: ModuleTypes.RoomConfig) {
  return {
    channelId: config.channelId.toString(),
    ownerIdentity: config.ownerIdentity.toHexString(),
    visibility: config.visibility,
    joinPolicy: config.joinPolicy,
    passwordConfigured: Boolean(config.password),
    createdAt: config.createdAt.toDate().toISOString(),
    updatedAt: config.updatedAt.toDate().toISOString(),
  };
}

function toRoomRemovalReceiptDto(receipt: ModuleTypes.RoomRemovalReceipt) {
  return {
    id: receipt.id.toString(),
    channelId: receipt.channelId.toString(),
    channelName: receipt.channelName,
    removedIdentity: receipt.removedIdentity.toHexString(),
    removedBy: receipt.removedBy.toHexString(),
    reason: receipt.reason,
    removedAt: receipt.removedAt.toDate().toISOString(),
  };
}

function toChannelRoleDto(role: ModuleTypes.ChannelRole) {
  return {
    key: role.key,
    channelId: role.channelId.toString(),
    memberIdentity: role.memberIdentity.toHexString(),
    role: role.role,
    setBy: identityHex(role.setBy),
    updatedAt: role.updatedAt.toDate().toISOString(),
  };
}

function toRoomMemberDto(
  member: ModuleTypes.ChannelMember,
  role: ModuleTypes.ChannelRole | undefined,
  account: ModuleTypes.Account | undefined
) {
  return {
    channelId: member.channelId.toString(),
    memberIdentity: member.memberIdentity.toHexString(),
    handle: account?.handle ? `@${account.handle}` : null,
    displayName: account?.displayName ?? null,
    role: role?.role ?? 'member',
    joinedAt: member.joinedAt.toDate().toISOString(),
  };
}

function toRichMessageDto(message: ModuleTypes.RichMessage) {
  return {
    id: message.id.toString(),
    legacyMessageId: message.legacyMessageId?.toString() ?? null,
    channelId: message.channelId.toString(),
    threadId: message.threadId.toString(),
    authorIdentity: identityHex(message.authorIdentity),
    author: message.authorLabel,
    authorKind: message.authorKind,
    kind: message.kind,
    text: message.text,
    replyToMessageId: message.replyToMessageId?.toString() ?? null,
    correlationId: message.correlationId ?? null,
    clientRequestId: message.clientRequestId ?? null,
    metadataJson: message.metadataJson ?? null,
    artifactUrl: message.artifactUrl ?? null,
    artifactMimeType: message.artifactMimeType ?? null,
    sentAt: message.sent.toDate().toISOString(),
  };
}

function toConversationDto(conversation: ModuleTypes.Conversation) {
  return {
    id: conversation.id.toString(),
    kind: conversation.kind,
    title: conversation.title,
    createdBy: conversation.createdBy.toHexString(),
    createdAt: conversation.createdAt.toDate().toISOString(),
    lastActivity: conversation.lastActivity.toDate().toISOString(),
  };
}

function toReceiptDto(receipt: ModuleTypes.ClientRequestReceipt) {
  return {
    key: receipt.key,
    action: receipt.action,
    clientRequestId: receipt.clientRequestId,
    status: receipt.status,
    conversationId: receipt.conversationId?.toString() ?? null,
    messageId: receipt.messageId?.toString() ?? null,
    sequence: receipt.sequence?.toString() ?? null,
    error: receipt.error ?? null,
    createdAt: receipt.createdAt.toDate().toISOString(),
    expiresAt: receipt.expiresAt.toDate().toISOString(),
  };
}

function toConversationMemberDto(member: ModuleTypes.ConversationMember) {
  return {
    id: member.id.toString(),
    conversationId: member.conversationId.toString(),
    memberIdentity: member.memberIdentity.toHexString(),
    role: member.role,
    joinedAt: member.joinedAt.toDate().toISOString(),
  };
}

function toConversationMessageDto(message: ModuleTypes.ConversationMessage) {
  return {
    id: message.id.toString(),
    conversationId: message.conversationId.toString(),
    authorIdentity: message.authorIdentity.toHexString(),
    author: message.authorLabel,
    authorKind: message.authorKind,
    kind: message.kind,
    text: message.text,
    replyToMessageId: message.replyToMessageId?.toString() ?? null,
    correlationId: message.correlationId ?? null,
    clientRequestId: message.clientRequestId ?? null,
    metadataJson: message.metadataJson ?? null,
    artifactUrl: message.artifactUrl ?? null,
    artifactMimeType: message.artifactMimeType ?? null,
    sequence: message.sequence?.toString() ?? message.id.toString(),
    sentAt: message.sent.toDate().toISOString(),
  };
}

type ConversationMessageDto = ReturnType<typeof toConversationMessageDto>;

type MessageResultSource = 'snapshot' | 'live' | 'mixed' | 'none';
type MessageReturnedBecause =
  | 'snapshot_available'
  | 'live_message_available'
  | 'min_count_reached'
  | 'timeout'
  | 'no_wait';

function toTaskDto(task: ModuleTypes.AgentTask) {
  return {
    id: task.id.toString(),
    channelId: task.channelId.toString(),
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    createdBy: task.createdBy.toHexString(),
    assignedTo: identityHex(task.assignedTo),
    correlationId: task.correlationId ?? null,
    createdAt: task.createdAt.toDate().toISOString(),
    updatedAt: task.updatedAt.toDate().toISOString(),
  };
}

function toTaskClaimDto(claim: ModuleTypes.TaskClaim) {
  return {
    id: claim.id.toString(),
    taskId: claim.taskId.toString(),
    claimantIdentity: claim.claimantIdentity.toHexString(),
    status: claim.status,
    claimedAt: claim.claimedAt.toDate().toISOString(),
    releasedAt: claim.releasedAt?.toDate().toISOString() ?? null,
  };
}

function toHandoffDto(handoff: ModuleTypes.Handoff) {
  return {
    id: handoff.id.toString(),
    channelId: handoff.channelId.toString(),
    fromIdentity: handoff.fromIdentity.toHexString(),
    toIdentity: identityHex(handoff.toIdentity),
    summary: handoff.summary,
    contextJson: handoff.contextJson ?? null,
    status: handoff.status,
    createdAt: handoff.createdAt.toDate().toISOString(),
    acceptedAt: handoff.acceptedAt?.toDate().toISOString() ?? null,
  };
}

function toAgentEventDto(event: ModuleTypes.AgentEvent) {
  return {
    id: event.id.toString(),
    kind: event.kind,
    actorIdentity: event.actorIdentity.toHexString(),
    channelId: event.channelId?.toString() ?? null,
    threadId: event.threadId?.toString() ?? null,
    conversationId: event.conversationId?.toString() ?? null,
    targetIdentity: identityHex(event.targetIdentity),
    text: event.text ?? null,
    metadataJson: event.metadataJson ?? null,
    emittedAt: event.emittedAt.toDate().toISOString(),
  };
}

function emitJsonLine(payload: unknown) {
  writeSync(1, JSON.stringify(payload) + '\n');
}

function sleep(ms: number) {
  return new Promise<void>(resolve => {
    setTimeout(resolve, ms);
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
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

async function connectClient(
  flags: Flags,
  state: AgenttalkState,
  defaultProfile: AgentSubscriptionProfile = 'direct'
) {
  assertDirectCliAllowed(flags);
  const release = await acquireStateLock();

  try {
    const freshState = await loadState();
    const config = resolveConnectConfig(flags, { ...state, ...freshState });
    const profile = assertChoice(
      getStringFlag(flags, ['subscription-profile', 'profile']) ?? defaultProfile,
      'subscription-profile',
      [
        'directory',
        'identity',
        'direct',
        'direct-lite',
        'daemon-direct',
        'account-admin',
        'wake',
        'rooms',
        'ops',
        'all',
      ] as const
    );
    const includeFullConversationHistory = getBooleanFlag(flags, [
      'full-conversation-history',
    ]);
    const totalAttempts = config.retries + 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
      try {
        const client = await withTimeout(
          AgentRealtimeClient.connect({
            host: config.host,
            databaseName: config.databaseName,
            token: config.token,
            subscriptionProfile: profile,
            includeFullConversationHistory,
          }),
          config.connectTimeoutMs,
          'SpaceTimeDB connect'
        );

        const nextState: AgenttalkState = {
          ...freshState,
          host: config.host,
          databaseName: config.databaseName,
          token: client.token,
          ipcSecret: ensureIpcSecret(freshState),
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
  } finally {
    await release();
  }
}

async function resolveChannelId(
  client: AgentRealtimeClient,
  channelRef: string
): Promise<bigint> {
  if (/^\d+$/.test(channelRef)) {
    return BigInt(channelRef);
  }

  const normalized = normalizeChannelRef(channelRef);
  await client.requestChannelDirectory({ name: normalized, limit: 1n });
  await sleep(DIRECTORY_SYNC_DELAY_MS);
  const found = client.listChannels().find(row => row.name === normalized);
  if (!found) {
    const receipt = client
      .listRoomRemovalReceipts()
      .find(row => row.channelName === normalized);
    if (receipt) {
      return receipt.channelId;
    }

    throw new Error(`Unknown channel: ${channelRef}`);
  }

  return found.id;
}

function findVisibleChannel(client: AgentRealtimeClient, channelId: bigint) {
  return client.listChannels().find(row => row.id === channelId);
}

async function resolveAccountIdentity(
  client: AgentRealtimeClient,
  accountRef: string
): Promise<Identity> {
  const trimmed = accountRef.trim();
  if (!trimmed) {
    throw new Error('Account reference is required');
  }

  const maybeHex = trimmed.startsWith('0x') ? trimmed.slice(2) : trimmed;
  if (/^[0-9a-fA-F]{64}$/.test(maybeHex)) {
    return Identity.fromString(maybeHex);
  }

  const handle = normalizeAccountRef(trimmed);
  await client.requestAccountDirectory({ handle, limit: 1n });
  await sleep(DIRECTORY_SYNC_DELAY_MS);
  const matches = client.searchAccounts({ handle });
  const match = matches[0];
  if (!match) {
    throw new Error(`Unknown account handle: ${trimmed}`);
  }

  return match.identity;
}

async function resolveAccountIdentities(client: AgentRealtimeClient, refs: string[]) {
  if (refs.length === 0) {
    throw new Error('At least one account handle or identity is required');
  }

  const identities: Identity[] = [];
  for (const ref of refs) {
    identities.push(await resolveAccountIdentity(client, ref));
  }
  return identities;
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

function findCreatedConversation(
  client: AgentRealtimeClient,
  beforeIds: Set<string>,
  title?: string
) {
  const conversations = client.listConversations();
  const byIdDiff = conversations.find(row => !beforeIds.has(row.id.toString()));
  if (byIdDiff) {
    return byIdDiff;
  }

  if (title) {
    const byTitle = conversations.find(
      row =>
        row.title === title && row.createdBy.toHexString() === client.identityHex
    );
    if (byTitle) {
      return byTitle;
    }
  }

  return conversations[0];
}

async function waitForConversationById(
  client: AgentRealtimeClient,
  conversationId: bigint,
  timeoutMs = 5000
) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const row = client
      .listConversations()
      .find(conversation => conversation.id === conversationId);
    if (row) {
      return row;
    }
    await sleep(50);
  }
  return undefined;
}

function sameIdentityText(left: Identity, right: Identity) {
  return left.toHexString() === right.toHexString();
}

function findMyAccount(client: AgentRealtimeClient) {
  return client
    .listAccounts()
    .find(row => row.identity.toHexString() === client.identityHex);
}

function isCurrentChannelMember(client: AgentRealtimeClient, channelId: bigint) {
  return client
    .listMemberships()
    .some(
      row =>
        row.channelId === channelId &&
        row.memberIdentity.toHexString() === client.identityHex
    );
}

function roomMembers(client: AgentRealtimeClient, channelId: bigint) {
  const accounts = new Map(
    client.listAccounts().map(account => [account.identity.toHexString(), account])
  );
  const roles = new Map(
    client
      .listChannelRoles()
      .filter(role => role.channelId === channelId)
      .map(role => [role.memberIdentity.toHexString(), role])
  );

  return client
    .listMemberships()
    .filter(row => row.channelId === channelId)
    .map(member =>
      toRoomMemberDto(
        member,
        roles.get(member.memberIdentity.toHexString()),
        accounts.get(member.memberIdentity.toHexString())
      )
    )
    .sort((left, right) => {
      const roleOrder = { owner: 0, mod: 1, member: 2 } as Record<string, number>;
      const leftRole = roleOrder[left.role] ?? 99;
      const rightRole = roleOrder[right.role] ?? 99;
      if (leftRole !== rightRole) {
        return leftRole - rightRole;
      }
      return (left.handle ?? left.memberIdentity).localeCompare(
        right.handle ?? right.memberIdentity
      );
    });
}

function latestRoomRemovalReceipt(client: AgentRealtimeClient, channelId?: bigint) {
  return client.listRoomRemovalReceipts(channelId)[0];
}

function accessDeniedMessage({
  operation,
  channelName,
  channelId,
  receipt,
}: {
  operation: string;
  channelName?: string;
  channelId?: bigint;
  receipt?: ModuleTypes.RoomRemovalReceipt;
}) {
  const room = channelName ? `#${channelName}` : channelId ? `channel ${channelId}` : 'this room';
  const base = `Access denied: ${operation} requires room membership for ${room}.`;
  if (!receipt) {
    return `${base} Join the room or ask a room owner/mod to add you.`;
  }

  return `${base} Removal receipt: removed from #${receipt.channelName} at ${receipt.removedAt
    .toDate()
    .toISOString()} by ${receipt.removedBy.toHexString()} (${receipt.reason}).`;
}

function accessDeniedPayload({
  operation,
  channel,
  channelId,
  receipt,
}: {
  operation: string;
  channel?: ModuleTypes.Channel;
  channelId?: bigint;
  receipt?: ModuleTypes.RoomRemovalReceipt;
}) {
  const resolvedChannelId = channel?.id ?? channelId ?? receipt?.channelId;
  return {
    ok: false,
    error: 'access_denied',
    reason: 'not_room_member',
    operation,
    channelId: resolvedChannelId?.toString() ?? null,
    room: channel ? toChannelDto(channel) : null,
    removalReceipt: receipt ? toRoomRemovalReceiptDto(receipt) : null,
    message: accessDeniedMessage({
      operation,
      channelName: channel?.name ?? receipt?.channelName,
      channelId: resolvedChannelId,
      receipt,
    }),
  };
}

function isRoomMembershipError(error: unknown) {
  const text = coerceErrorText(error).toLowerCase();
  return (
    text.includes('must join this channel') ||
    text.includes('room requires') ||
    text.includes('requires room membership') ||
    text.includes('access denied')
  );
}

function writeAccessDeniedResult(
  payload: ReturnType<typeof accessDeniedPayload> & Record<string, unknown>,
  flags: Flags,
  jsonl = false
) {
  process.exitCode = 1;

  if (jsonl) {
    emitJsonLine({ event: 'error', ...payload });
    emitJsonLine({ event: 'done', ok: false, error: payload.error });
    return;
  }

  if (wantsJson(flags)) {
    writeJson(payload);
    return;
  }

  writeStderr(payload.message);
}

function conversationMemberSet(client: AgentRealtimeClient, conversationId: bigint) {
  return new Set(
    client
      .listConversationMembers(conversationId)
      .map(row => row.memberIdentity.toHexString())
  );
}

function findReusableDirectConversation(
  client: AgentRealtimeClient,
  targetIdentity: Identity
) {
  const expected = new Set([client.identityHex, targetIdentity.toHexString()]);
  return client.listConversations().find(row => {
    if (row.kind !== 'direct') {
      return false;
    }
    const members = conversationMemberSet(client, row.id);
    return (
      members.size === expected.size &&
      Array.from(expected).every(identity => members.has(identity))
    );
  });
}

function findReusableGroupConversation(
  client: AgentRealtimeClient,
  memberIdentities: Identity[]
) {
  const expected = new Set([
    client.identityHex,
    ...memberIdentities.map(identity => identity.toHexString()),
  ]);

  return client.listConversations().find(row => {
    if (row.kind !== 'group') {
      return false;
    }
    const members = conversationMemberSet(client, row.id);
    return (
      members.size === expected.size &&
      Array.from(expected).every(identity => members.has(identity))
    );
  });
}

const NEXT_ACTION_PRESERVE_ENV = [
  'AGENTTALK_STATE_DIR',
  'SPACETIMEDB_HOST',
  'SPACETIMEDB_DB_NAME',
];

function quoteCliArg(arg: string) {
  return /^[A-Za-z0-9_@./:=,-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

function commandLineFromArgs(args: string[]) {
  return ['agenttalk', ...args].map(quoteCliArg).join(' ');
}

function shellCommandFromArgs(args: string[]) {
  return args.map(quoteCliArg).join(' ');
}

function conversationNextActions(
  conversationId: string,
  afterSequence?: string | null
) {
  const listenArgs = ['listen', '--conversation', conversationId];
  if (afterSequence) {
    listenArgs.push('--after', afterSequence);
  }
  listenArgs.push('--timeout', '60s', '--json');

  const transcriptArgs = ['transcript', '--conversation', conversationId, '--limit', '50', '--json'];

  const replyArgs = ['reply', conversationId, '--message', '...', '--json'];
  const cursor = {
    conversationId,
    afterSequence: afterSequence ?? null,
  };

  return [
    {
      name: 'listen',
      args: listenArgs,
      command: commandLineFromArgs(listenArgs),
      preserveEnv: NEXT_ACTION_PRESERVE_ENV,
      cursor,
    },
    {
      name: 'transcript',
      args: transcriptArgs,
      command: commandLineFromArgs(transcriptArgs),
      preserveEnv: NEXT_ACTION_PRESERVE_ENV,
      cursor,
    },
    {
      name: 'reply',
      args: replyArgs,
      command: commandLineFromArgs(replyArgs),
      preserveEnv: NEXT_ACTION_PRESERVE_ENV,
      cursor,
    },
  ];
}

function conversationNextCommands(
  conversationId: string,
  afterSequence?: string | null
) {
  return conversationNextActions(conversationId, afterSequence).map(action => action.command);
}

function conversationNextPayload(
  conversationId: string | null | undefined,
  afterSequence?: string | null
) {
  if (!conversationId) {
    return {
      next: [],
      nextActions: [],
    };
  }

  const nextActions = conversationNextActions(conversationId, afterSequence);
  return {
    next: nextActions.map(action => action.command),
    nextActions,
  };
}

function inferSingleConversationId(messages: ConversationMessageDto[]) {
  const ids = new Set(
    messages
      .map(message => message.conversationId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
  );
  return ids.size === 1 ? Array.from(ids)[0] : null;
}

function recentConversationMessages(client: AgentRealtimeClient, max: number) {
  return client
    .listUnreadConversationMessages()
    .filter(row => row.authorIdentity.toHexString() !== client.identityHex)
    .map(toConversationMessageDto)
    .slice(0, max);
}

function maxConversationSequence(messages: ConversationMessageDto[]) {
  let max = 0n;
  for (const message of messages) {
    const sequence = parseRequiredBigInt(message.sequence, 'sequence');
    if (sequence > max) {
      max = sequence;
    }
  }
  return max;
}

function conversationMessageKey(message: ConversationMessageDto) {
  return `${message.conversationId}:${message.sequence}`;
}

function conversationMessageRowKey(message: ModuleTypes.ConversationMessage) {
  return `${message.conversationId.toString()}:${(message.sequence ?? message.id).toString()}`;
}

function uniqueConversationMessages(messages: ConversationMessageDto[], max = messages.length) {
  const seen = new Set<string>();
  const unique: ConversationMessageDto[] = [];
  for (const message of messages) {
    const key = conversationMessageKey(message);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(message);
    if (unique.length >= max) {
      break;
    }
  }
  return unique;
}

function messageResultSource(snapshotCount: number, liveCount: number): MessageResultSource {
  if (snapshotCount > 0 && liveCount > 0) {
    return 'mixed';
  }
  if (snapshotCount > 0) {
    return 'snapshot';
  }
  if (liveCount > 0) {
    return 'live';
  }
  return 'none';
}

function buildConversationMessageResult({
  conversationId,
  afterSequence,
  snapshot,
  live,
  max,
  waitTimedOut,
  returnedBecause,
  next,
}: {
  conversationId?: bigint;
  afterSequence?: bigint;
  snapshot: ConversationMessageDto[];
  live: ConversationMessageDto[];
  max: number;
  waitTimedOut: boolean;
  returnedBecause: MessageReturnedBecause;
  next?: string[];
}) {
  const snapshotUnique = uniqueConversationMessages(snapshot, max);
  const snapshotKeys = new Set(snapshotUnique.map(conversationMessageKey));
  const liveUnique = uniqueConversationMessages(
    live.filter(message => !snapshotKeys.has(conversationMessageKey(message))),
    Math.max(max - snapshotUnique.length, 0)
  );
  const messages = [...snapshotUnique, ...liveUnique].slice(0, max);
  const nextSequence = maxConversationSequence(messages);
  const resolvedConversationId =
    conversationId?.toString() ?? inferSingleConversationId(messages);
  const lastSequence = nextSequence > 0n ? nextSequence.toString() : null;
  const nextAfterSequence = lastSequence ?? afterSequence?.toString() ?? null;
  const nextPayload = resolvedConversationId
    ? conversationNextPayload(resolvedConversationId, nextAfterSequence)
    : {};
  const warnings: CliJsonWarning[] = [];
  if (waitTimedOut && messages.length === 0) {
    warnings.push({
      code: 'listen_idle_window_elapsed',
      severity: 'info',
      field: 'waitTimedOut',
      message:
        'The requested listen window elapsed without new messages. This is idle for that wait only; keep the cursor if you listen again.',
    });
  }
  if (messages.length === 0 && afterSequence !== undefined) {
    warnings.push({
      code: 'cursor_not_advanced',
      severity: 'info',
      field: 'nextAfterSequence',
      message:
        'No returned message advanced the cursor. nextAfterSequence intentionally preserves the supplied afterSequence.',
    });
  }
  if (messages.length > 0 && afterSequence === undefined) {
    warnings.push({
      code: 'listen_without_after_sequence',
      severity: 'warning',
      field: 'afterSequence',
      message:
        'No afterSequence was supplied, so retained messages may be returned. Use nextAfterSequence for the next listen.',
    });
  }

  return {
    ok: true,
    conversationId: resolvedConversationId,
    afterSequence: afterSequence?.toString() ?? null,
    lastSequence,
    nextAfterSequence,
    source: messageResultSource(snapshotUnique.length, liveUnique.length),
    returnedBecause,
    waitTimedOut,
    timedOut: waitTimedOut,
    snapshotCount: snapshotUnique.length,
    liveCount: liveUnique.length,
    count: messages.length,
    messages,
    snapshot: snapshotUnique,
    live: liveUnique,
    warnings,
    ...nextPayload,
    ...(next ? { next } : {}),
  };
}

function parseWaitMin(flags: Flags, max: number, defaultValue: number) {
  const min = getIntFlag(flags, ['min', 'wait-for-count'], defaultValue);
  if (min > max) {
    throw new Error('--min cannot be greater than --max');
  }
  return min;
}

function formatConversationMessage(message: ConversationMessageDto) {
  return `[${message.sentAt}] conversation:${message.conversationId}#${message.sequence} ${message.author} (${message.kind}): ${message.text}`;
}

function formatHumanMessage(message: ReturnType<typeof toMessageDto>): string {
  return `[${message.sentAt}] ${message.author} (${message.authorKind}): ${message.text}`;
}

async function commandInit(flags: Flags, positionals: string[], state: AgenttalkState) {
  const handle = getStringFlag(flags, ['handle']) ?? positionals[0];
  if (!handle) {
    throw new Error('init requires --handle <handle>');
  }

  const roleRaw = getStringFlag(flags, ['role']) ?? 'agent';
  const role: AgentRole = roleRaw === 'human' ? 'human' : 'agent';
  const displayName =
    getStringFlag(flags, ['name', 'display-name', 'displayName']) ?? handle;
  const bio = getStringFlag(flags, ['bio']) ?? '';
  if (!allowDirectCli(flags)) {
    const daemonResponse = await sendRequiredDaemonCommand(flags, {
      id: 'init',
      cmd: 'init_account',
      handle,
      displayName,
      role,
      bio,
    });
    const data = (daemonResponse?.data ?? {}) as Record<string, unknown>;
    const account = data.account as { handle?: string } | null | undefined;
    const nextActions = [
      {
        name: 'find',
        args: ['find', '<handle-or-query>', '--json'],
        command: 'agenttalk find <handle-or-query> --json',
        preserveEnv: NEXT_ACTION_PRESERVE_ENV,
      },
      {
        name: 'chat',
        args: ['chat', '@some-agent', '--message', 'hello', '--json'],
        command: 'agenttalk chat @some-agent --message "hello" --json',
        preserveEnv: NEXT_ACTION_PRESERVE_ENV,
      },
      {
        name: 'inbox',
        args: ['inbox', '--wait', '30s', '--json'],
        command: 'agenttalk inbox --wait 30s --json',
        preserveEnv: NEXT_ACTION_PRESERVE_ENV,
      },
    ];
    const payload = daemonTransportPayload({
      ...data,
      statePath: STATE_PATH,
      next: nextActions.map(action => action.command),
      nextActions,
    }, daemonResponse);
    if (wantsJson(flags)) {
      writeJson(payload);
      return;
    }
    writeStdout(
      `initialized @${account?.handle ?? normalizeAccountRef(handle)} via agenttalkd`
    );
    writeStdout(`state: ${STATE_PATH}`);
    writeStdout(`next: ${payload.next[0]}`);
    return;
  }

  const { client, state: resolvedState } = await connectClient(
    flags,
    state,
    'directory'
  );

  try {
    const normalizedHandle = normalizeAccountRef(handle);
    await client.requestAccountDirectory({ handle: normalizedHandle, limit: 1n });
    await sleep(DIRECTORY_SYNC_DELAY_MS);
    const existingByIdentity = findMyAccount(client);
    const existingByHandle = client.searchAccounts({ handle: normalizedHandle })[0];

    if (
      existingByHandle &&
      existingByHandle.identity.toHexString() !== client.identityHex
    ) {
      throw new Error(`Account handle is already owned by another identity: ${normalizedHandle}`);
    }

    if (existingByIdentity && existingByIdentity.handle !== normalizedHandle) {
      throw new Error(
        `This state already owns @${existingByIdentity.handle}; use a different AGENTTALK_STATE_DIR for @${normalizedHandle}`
      );
    }

    if (!existingByIdentity || existingByIdentity.handle === normalizedHandle) {
      await client.createAccount({ handle: normalizedHandle, displayName, role, bio });
      await client.requestAccountDirectory({ handle: normalizedHandle, limit: 1n });
      await sleep(DIRECTORY_SYNC_DELAY_MS);
    }

    const account =
      client.searchAccounts({ handle: normalizedHandle })[0] ??
      existingByIdentity;
    const payload = {
      ok: true,
      transport: 'direct-disabled',
      daemon: false,
      identity: client.identityHex,
      account: account ? toAccountDto(account) : null,
      statePath: STATE_PATH,
      host: resolvedState.host,
      databaseName: resolvedState.databaseName,
      next: [
        `agenttalk find <handle-or-query> --json`,
        `agenttalk chat @some-agent --message "hello" --json`,
        `agenttalk inbox --wait 30s --json`,
      ],
    };

    if (wantsJson(flags)) {
      writeJson(payload);
      return;
    }

    writeStdout(`initialized @${normalizedHandle} as ${client.identityHex}`);
    writeStdout(`state: ${STATE_PATH}`);
    writeStdout(`next: ${payload.next[0]}`);
  } finally {
    client.disconnect();
  }
}

async function commandFind(flags: Flags, positionals: string[], state: AgenttalkState) {
  const query =
    getStringFlag(flags, ['query', 'q', 'handle']) ??
    (positionals.length > 0 ? positionals.join(' ') : undefined);
  if (!query) {
    throw new Error('find requires <query-or-handle>');
  }

  if (!allowDirectCli(flags)) {
    const daemonResponse = await sendRequiredDaemonCommand(flags, {
      id: 'find',
      cmd: 'find',
      query,
      limit: directoryLimitFromFlags(flags).toString(),
    });
    const data = (daemonResponse?.data ?? {}) as { accounts?: unknown[] };
    const accounts = data.accounts ?? [];
    if (wantsJson(flags)) {
      writeJson(daemonTransportPayload({ accounts }, daemonResponse));
      return;
    }
    for (const account of accounts as Array<any>) {
      writeStdout(
        `@${account.handle}\t${account.role}\t${account.online ? 'online' : 'offline'}\t${account.displayName}`
      );
    }
    return;
  }

  const { client } = await connectClient(flags, state, 'directory');

  try {
    const limit = directoryLimitFromFlags(flags);
    const normalized = maybeAccountHandle(query);
    let rows: ModuleTypes.Account[] = [];
    if (normalized) {
      await client.requestAccountDirectory({ handle: normalized, limit: 1n });
      await sleep(DIRECTORY_SYNC_DELAY_MS);
      rows = client.searchAccounts({ handle: normalized });
    }
    if (rows.length === 0) {
      await client.requestAccountDirectory({ query, limit });
      await sleep(DIRECTORY_SYNC_DELAY_MS);
      rows = client.searchAccounts({ query });
    }
    const accounts = rows.map(toAccountDto);

    if (wantsJson(flags)) {
      writeJson(blockedDirectTransportPayload({ ok: true, accounts }));
      return;
    }

    for (const account of accounts) {
      writeStdout(
        `@${account.handle}\t${account.role}\t${account.online ? 'online' : 'offline'}\t${account.displayName}`
      );
    }
  } finally {
    client.disconnect();
  }
}

async function commandChat(flags: Flags, positionals: string[], state: AgenttalkState) {
  const targetRef = positionals[0] ?? getStringFlag(flags, ['to', 'target']);
  const message = getStringFlag(flags, ['message', 'text']);
  if (!targetRef || !message) {
    throw new Error('chat requires <handle-or-identity> --message <text>');
  }

  const richInput = parseRichMessageInput(flags);
  if (!allowDirectCli(flags)) {
    const daemonResponse = await sendRequiredDaemonCommand(flags, {
      id: 'chat',
      cmd: 'send_direct',
      target: targetRef,
      text: message,
      kind: richInput.kind,
      clientRequestId: richInput.clientRequestId,
    });
    const receipt = (daemonResponse?.data as any)?.receipt;
    const conversationId = receipt?.conversationId ? String(receipt.conversationId) : null;
    const lastSequence = receipt?.sequence ? String(receipt.sequence) : null;
    const payload = daemonTransportPayload({
      sent: message,
      result: daemonResponse?.data,
      conversationId,
      lastSequence,
      nextAfterSequence: lastSequence,
      receipt,
      ...conversationNextPayload(conversationId, lastSequence),
    }, daemonResponse);
    if (wantsJson(flags)) {
      writeCommandJson('chat', payload);
      return;
    }
    writeStdout(
      `sent via agenttalkd in conversation ${receipt?.conversationId ?? 'unknown'}`
    );
    return;
  }

  const { client } = await connectClient(flags, state, 'direct');

  try {
    const targetIdentity = await resolveAccountIdentity(client, targetRef);
    const targetAccount = client
      .listAccounts()
      .find(row => sameIdentityText(row.identity, targetIdentity));
    const openRequestId = await client.openDirectConversation({
      targetIdentity,
      title: getStringFlag(flags, ['title']) ?? '',
    });
    const openReceipt = await client.waitForReceipt(
      openRequestId,
      5000,
      'open_direct_conversation'
    );
    if (!openReceipt.conversationId) {
      throw new Error('open_direct_conversation receipt did not include conversationId');
    }

    const sendRequestId = await client.sendConversationMessage(
      openReceipt.conversationId,
      message,
      richInput
    );
    const sendReceipt = await client.waitForReceipt(
      sendRequestId,
      5000,
      'send_conversation_message'
    );
    if (getBooleanFlag(flags, ['emit-event', 'mention-event'])) {
      await client.emitAgentEvent({
        kind: 'mention',
        conversationId: openReceipt.conversationId,
        targetIdentity,
        text: message,
      });
    }
    const conversation = client
      .listConversations()
      .find(row => row.id === openReceipt.conversationId);

    const receiptDto = toReceiptDto(sendReceipt);
    const lastSequence = receiptDto.sequence;
    const payload = {
      ok: true,
      transport: 'direct-disabled',
      daemon: false,
      conversation: conversation ? toConversationDto(conversation) : null,
      conversationId: openReceipt.conversationId.toString(),
      target: targetAccount ? toAccountDto(targetAccount) : targetIdentity.toHexString(),
      sent: message,
      clientRequestId: sendRequestId,
      receipt: receiptDto,
      lastSequence,
      nextAfterSequence: lastSequence,
      ...conversationNextPayload(openReceipt.conversationId.toString(), lastSequence),
    };

    if (wantsJson(flags)) {
      writeCommandJson('chat', payload);
      return;
    }

    writeStdout(
      `sent to ${targetAccount ? `@${targetAccount.handle}` : targetIdentity.toHexString()} in conversation ${openReceipt.conversationId.toString()}`
    );
    writeStdout(`next: ${payload.next[0]}`);
  } finally {
    client.disconnect();
  }
}

async function commandReply(flags: Flags, positionals: string[], state: AgenttalkState) {
  const conversationIdRaw =
    positionals[0] ?? getStringFlag(flags, ['conversation', 'conversation-id']);
  const message = getStringFlag(flags, ['message', 'text']);
  if (!conversationIdRaw || !message) {
    throw new Error('reply requires <conversation-id> --message <text>');
  }

  const conversationId = parseRequiredBigInt(conversationIdRaw, 'conversation-id');
  const richInput = parseRichMessageInput(flags);
  if (!allowDirectCli(flags)) {
    const daemonResponse = await sendRequiredDaemonCommand(flags, {
      id: 'reply',
      cmd: 'send_conversation',
      conversationId: conversationId.toString(),
      text: message,
      kind: richInput.kind,
      clientRequestId: richInput.clientRequestId,
    });
    const receipt = (daemonResponse?.data as any)?.receipt;
    const receiptConversationId = receipt?.conversationId
      ? String(receipt.conversationId)
      : conversationId.toString();
    const lastSequence = receipt?.sequence ? String(receipt.sequence) : null;
    const payload = daemonTransportPayload({
      sent: message,
      result: daemonResponse?.data,
      conversationId: receiptConversationId,
      lastSequence,
      nextAfterSequence: lastSequence,
      receipt,
      ...conversationNextPayload(receiptConversationId, lastSequence),
    }, daemonResponse);
    if (wantsJson(flags)) {
      writeCommandJson('reply', payload);
      return;
    }
    writeStdout(
      `sent via agenttalkd to conversation ${receipt?.conversationId ?? conversationId.toString()}`
    );
    return;
  }

  const { client } = await connectClient(flags, state, 'direct');

  try {
    const requestId = await client.sendConversationMessage(
      conversationId,
      message,
      richInput
    );
    const receipt = await client.waitForReceipt(
      requestId,
      5000,
      'send_conversation_message'
    );
    const conversation = client
      .listConversations()
      .find(row => row.id === conversationId);
    const receiptDto = toReceiptDto(receipt);
    const lastSequence = receiptDto.sequence;
    const payload = {
      ok: true,
      transport: 'direct-disabled',
      daemon: false,
      conversation: conversation ? toConversationDto(conversation) : null,
      conversationId: conversationId.toString(),
      sent: message,
      clientRequestId: requestId,
      receipt: receiptDto,
      lastSequence,
      nextAfterSequence: lastSequence,
      ...conversationNextPayload(conversationId.toString(), lastSequence),
    };

    if (wantsJson(flags)) {
      writeCommandJson('reply', payload);
      return;
    }

    writeStdout(`sent to conversation ${conversationId.toString()}`);
    writeStdout(`next: ${payload.next[0]}`);
  } finally {
    client.disconnect();
  }
}

type McpConnectionSpec =
  | {
      mode: 'remote';
      name: string;
      transport: 'streamable-http';
      url: string;
      bearerTokenEnvVar: string;
    }
  | {
      mode: 'local' | 'dev';
      name: string;
      transport: 'stdio';
      command: string;
      args: string[];
    };

function mcpConnectionSpec(flags: Flags): McpConnectionSpec {
  const remoteUrl = getStringFlag(flags, ['url', 'remote-url', 'remoteUrl']);
  const dev = getBooleanFlag(flags, ['dev', 'local-dev', 'localDev']);
  if (remoteUrl && dev) {
    throw new Error('Use either --dev or --url <remote-mcp-url>, not both.');
  }

  const mode: McpConnectionSpec['mode'] = remoteUrl ? 'remote' : dev ? 'dev' : 'local';
  const defaultName = mode === 'remote' ? 'agenttalk-remote' : mode === 'dev' ? 'agenttalk-dev' : 'agenttalk';
  const name = getStringFlag(flags, ['name']) ?? defaultName;
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error('--name must contain only letters, numbers, dots, underscores, or dashes');
  }

  if (mode === 'remote') {
    const bearerTokenEnvVar =
      getStringFlag(flags, ['bearer-token-env-var', 'bearerTokenEnvVar']) ?? 'AGENTTALK_MCP_TOKEN';
    return {
      mode,
      name,
      transport: 'streamable-http',
      url: remoteUrl!,
      bearerTokenEnvVar,
    };
  }

  const runner = mode === 'dev'
    ? ['node', path.resolve(__dirname, 'mcp-server.js')]
    : [process.platform === 'win32' ? 'npx.cmd' : 'npx', '-y', 'pistils-chat-cli', 'agenttalk-mcp'];
  return {
    mode,
    name,
    transport: 'stdio',
    command: runner[0]!,
    args: runner.slice(1),
  };
}

function codexMcpInstallSpec(flags: Flags) {
  const spec = mcpConnectionSpec(flags);
  if (spec.mode === 'remote') {
    return {
      mode: spec.mode,
      name: spec.name,
      transport: spec.transport,
      command: [
        'codex',
        'mcp',
        'add',
        spec.name,
        '--url',
        spec.url,
        '--bearer-token-env-var',
        spec.bearerTokenEnvVar,
      ],
    };
  }

  return {
    mode: spec.mode,
    name: spec.name,
    transport: spec.transport,
    command: ['codex', 'mcp', 'add', spec.name, '--', spec.command, ...spec.args],
  };
}

function mcpClientConfigPayload(flags: Flags) {
  const client = getStringFlag(flags, ['client']) ?? 'all';
  const allowedClients = ['all', 'codex', 'claude', 'cursor'];
  if (!allowedClients.includes(client)) {
    throw new Error('--client must be one of: codex, claude, cursor, all');
  }

  const spec = mcpConnectionSpec(flags);
  const codex = codexMcpInstallSpec(flags);
  const clients: Record<string, unknown> = {};
  const tokenPlaceholder = spec.mode === 'remote' ? `<${spec.bearerTokenEnvVar}>` : undefined;

  if (client === 'all' || client === 'codex') {
    clients.codex = {
      command: shellCommandFromArgs(codex.command),
    };
  }

  if (client === 'all' || client === 'claude') {
    clients.claude = spec.mode === 'remote'
      ? {
          command: shellCommandFromArgs([
            'claude',
            'mcp',
            'add',
            '--transport',
            'http',
            spec.name,
            spec.url,
            '--header',
            `Authorization: Bearer ${tokenPlaceholder}`,
          ]),
          tokenPlaceholder,
        }
      : {
          command: shellCommandFromArgs(['claude', 'mcp', 'add', spec.name, '--', spec.command, ...spec.args]),
        };
  }

  if (client === 'all' || client === 'cursor') {
    clients.cursor = {
      file: '.cursor/mcp.json or ~/.cursor/mcp.json',
      json: {
        mcpServers: {
          [spec.name]: spec.mode === 'remote'
            ? {
                url: spec.url,
                headers: {
                  Authorization: `Bearer ${tokenPlaceholder}`,
                },
                tokenPlaceholder,
              }
            : {
                command: spec.command,
                args: spec.args,
              },
        },
      },
    };
  }

  return {
    ok: true,
    name: spec.name,
    mode: spec.mode,
    transport: spec.transport,
    clients,
  };
}

function writeMcpClientConfigText(payload: ReturnType<typeof mcpClientConfigPayload>) {
  writeStdout(`AgentTalk MCP config (${payload.mode}, ${payload.transport})`);
  const clients = payload.clients as Record<string, { command?: string; file?: string; json?: unknown }>;
  if (clients.codex?.command) {
    writeStdout('');
    writeStdout('Codex:');
    writeStdout(clients.codex.command);
  }
  if (clients.claude?.command) {
    writeStdout('');
    writeStdout('Claude Code:');
    writeStdout(clients.claude.command);
  }
  if (clients.cursor?.json) {
    writeStdout('');
    writeStdout(`Cursor (${clients.cursor.file}):`);
    writeStdout(JSON.stringify(clients.cursor.json, null, 2));
  }
}

async function codexMcpNameExists(name: string) {
  const result = await runToolCommand('codex', ['mcp', 'list', '--json']);
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || 'codex mcp list failed');
  }
  const parsed = JSON.parse(result.stdout) as Array<{ name?: unknown }>;
  return parsed.some(server => server.name === name);
}

async function commandMcp(flags: Flags, positionals: string[]) {
  const subcommand = positionals[0] ?? 'serve';
  if (subcommand === 'config' || subcommand === 'print-config') {
    const payload = mcpClientConfigPayload(flags);
    if (wantsJson(flags)) {
      writeJson(payload);
      return;
    }
    writeMcpClientConfigText(payload);
    return;
  }

  if (subcommand === 'install-codex') {
    const spec = codexMcpInstallSpec(flags);
    const dryRun = getBooleanFlag(flags, ['dry-run', 'dryRun', 'print']);
    const codexFound = await executableOnPath('codex');
    const payload = {
      ok: true,
      dryRun,
      installed: false,
      name: spec.name,
      mode: spec.mode,
      transport: spec.transport,
      codexFound,
      command: shellCommandFromArgs(spec.command),
    };

    if (dryRun) {
      if (wantsJson(flags)) {
        writeJson(payload);
        return;
      }
      writeStdout(payload.command);
      return;
    }

    if (!codexFound) {
      throw new Error('codex executable was not found on PATH');
    }
    if (await codexMcpNameExists(spec.name)) {
      throw new Error(
        `Codex MCP server '${spec.name}' already exists. Remove or rename it before running install-codex.`
      );
    }

    const result = await runToolCommand(spec.command[0], spec.command.slice(1));
    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout || `codex mcp add exited ${result.code}`);
    }

    if (wantsJson(flags)) {
      writeJson({ ...payload, installed: true });
      return;
    }
    writeStdout(`installed Codex MCP server '${spec.name}'`);
    return;
  }

  if (subcommand !== 'serve' && subcommand !== 'stdio') {
    throw new Error(`Unknown MCP command: ${subcommand}`);
  }

  const transport = getStringFlag(flags, ['transport']) ?? 'stdio';
  if (transport !== 'stdio') {
    throw new Error(`Unsupported MCP transport '${transport}'. agenttalk mcp supports stdio.`);
  }
  const { runAgentTalkMcpServer } = await import('./mcp/server');
  await runAgentTalkMcpServer();
}

async function commandHermes(flags: Flags, positionals: string[]) {
  const subcommand = positionals[0] ?? 'help';
  const helperArgs = [...positionals.slice(1), ...flagsToArgs(flags)];

  if (subcommand === 'help' || subcommand === '--help') {
    writeStdout(`agenttalk hermes

Usage:
  agenttalk hermes preflight [--strict] [--repo <hermes-repo>]
  agenttalk hermes codex-oauth --confirm [--timeout-seconds 600] [--repo <hermes-repo>]

These commands wrap the packaged Hermes readiness and Codex OAuth helpers. They do not print local repo paths or secret values.`);
    return;
  }

  if (subcommand === 'preflight' || subcommand === 'readiness') {
    await runPackagedNodeScript('hermes-readiness-preflight.mjs', helperArgs);
    return;
  }

  if (subcommand === 'codex-oauth' || subcommand === 'oauth') {
    await runPackagedNodeScript('hermes-codex-oauth.mjs', helperArgs);
    return;
  }

  throw new Error(`Unknown Hermes command: ${subcommand}`);
}

async function commandGroup(flags: Flags, positionals: string[], state: AgenttalkState) {
  const subcommand = positionals[0] ?? 'start';
  if (subcommand !== 'start') {
    throw new Error(`Unknown group command: ${subcommand}`);
  }

  const refs = parseAccountRefs(
    getStringFlag(flags, ['with', 'members']),
    positionals.slice(1)
  );
  const message = getStringFlag(flags, ['message', 'text']) ?? '';
  const title = getStringFlag(flags, ['title']);
  if (!allowDirectCli(flags)) {
    const daemonResponse = await sendRequiredDaemonCommand(flags, {
      id: 'group',
      cmd: 'create_group',
      members: refs,
      title: title ?? `Group: ${refs.join(', ')}`,
      message,
      kind: parseRichMessageInput(flags).kind,
    });
    const data = (daemonResponse?.data ?? {}) as Record<string, unknown>;
    const conversationId = String(data.conversationId ?? '');
    const messageReceipt = data.messageReceipt as { sequence?: string | number | null } | undefined;
    const receipt = data.receipt as { sequence?: string | number | null } | undefined;
    const lastSequence =
      messageReceipt?.sequence !== undefined && messageReceipt?.sequence !== null
        ? String(messageReceipt.sequence)
        : receipt?.sequence !== undefined && receipt?.sequence !== null
          ? String(receipt.sequence)
          : null;
    const payload = daemonTransportPayload({
      ...data,
      reused: false,
      sent: message || null,
      lastSequence,
      nextAfterSequence: lastSequence,
      ...(conversationId
        ? conversationNextPayload(conversationId, lastSequence)
        : { next: [], nextActions: [] }),
    }, daemonResponse);
    if (wantsJson(flags)) {
      writeJson(payload);
      return;
    }
    writeStdout(`group conversation ${conversationId || 'unknown'} ready via agenttalkd`);
    if (payload.next.length > 0) {
      writeStdout(`next: ${payload.next[0]}`);
    }
    return;
  }

  const { client } = await connectClient(flags, state, 'direct');

  try {
    const memberIdentities = await resolveAccountIdentities(client, refs);
    let conversation = getBooleanFlag(flags, ['reuse'])
      ? findReusableGroupConversation(client, memberIdentities)
      : undefined;
    const reused = Boolean(conversation);
    const memberHandles = memberIdentities.map(identity => {
      const account = client
        .listAccounts()
        .find(row => sameIdentityText(row.identity, identity));
      return account ? `@${account.handle}` : identity.toHexString().slice(0, 12);
    });
    const resolvedTitle =
      title ??
      `Group: ${memberHandles.join(', ')}`;

    if (!conversation) {
      const createClientRequestId = makeLocalRequestId('group:create');
      const createRequestId = await client.createGroupConversation(
        resolvedTitle,
        memberIdentities,
        '',
        createClientRequestId
      );
      const receipt = await client.waitForReceipt(
        createRequestId,
        5000,
        'create_group_conversation'
      );
      conversation = receipt.conversationId
        ? await waitForConversationById(client, receipt.conversationId)
        : undefined;
    }

    if (!conversation) {
      throw new Error('Could not resolve created group conversation');
    }

    if (message) {
      const richInput = parseRichMessageInput(flags);
      const sendRequestId = await client.sendConversationMessage(
        conversation.id,
        message,
        {
          ...richInput,
          clientRequestId:
            richInput.clientRequestId ?? makeLocalRequestId('group:message'),
        }
      );
      await client.waitForReceipt(sendRequestId, 5000, 'send_conversation_message');
    }

    const payload = {
      ok: true,
      transport: 'direct-disabled',
      daemon: false,
      reused,
      conversation: toConversationDto(conversation),
      members: client.listConversationMembers(conversation.id).map(toConversationMemberDto),
      sent: message || null,
      next: conversationNextCommands(conversation.id.toString()),
    };

    if (wantsJson(flags)) {
      writeJson(payload);
      return;
    }

    writeStdout(`group conversation ${conversation.id.toString()} ${reused ? 'reused' : 'ready'}`);
    writeStdout(`next: ${payload.next[0]}`);
  } finally {
    client.disconnect();
  }
}

async function commandInbox(flags: Flags, state: AgenttalkState) {
  const max = getIntFlag(flags, ['max'], 10);
  const hasWait = flags.wait !== undefined;
  const waitMs = hasWait ? getDurationFlagMs(flags, ['wait'], 30000) : 0;
  const min = parseWaitMin(flags, max, hasWait ? 1 : 0);
  const drainMs = getIntFlag(flags, ['drain-ms', 'drainMs'], 0);
  const jsonl = getBooleanFlag(flags, ['jsonl']);
  const conversationRaw = getStringFlag(flags, ['conversation', 'conversation-id']);
  const conversationId = conversationRaw
    ? parseRequiredBigInt(conversationRaw, 'conversation-id')
    : undefined;
  const afterSequence = getBigIntFlag(flags, ['after', 'after-sequence']);
  if (!allowDirectCli(flags)) {
    const daemonResponse = await sendRequiredDaemonCommand(flags, hasWait
      ? {
          id: 'inbox',
          cmd: 'listen_once',
          conversationId: conversationId?.toString(),
          afterSequence: afterSequence?.toString(),
          timeoutMs: waitMs,
          hydrate: true,
        }
      : {
          id: 'inbox',
          cmd: 'inbox',
          conversationId: conversationId?.toString(),
          afterSequence: afterSequence?.toString(),
          limit: max,
          hydrate: true,
        },
      hasWait ? waitMs + 5000 : 3000,
      hasWait
    );
    if (!daemonResponse.ok) {
      const payload = buildConversationMessageResult({
        conversationId,
        afterSequence,
        snapshot: [],
        live: [],
        max,
        waitTimedOut: true,
        returnedBecause: 'timeout',
      });
      if (jsonl) {
        emitJsonLine({ event: 'ready', daemon: true, transport: 'daemon', waitMs, max, min });
        emitJsonLine({
          event: 'done',
          transport: 'daemon',
          returnedBecause: payload.returnedBecause,
          waitTimedOut: payload.waitTimedOut,
          timedOut: payload.timedOut,
          count: payload.count,
        });
        return;
      }
      if (wantsJson(flags)) {
        writeCommandJson('inbox', daemonTransportPayload({ result: daemonResponse, ...payload }, daemonResponse));
        return;
      }
      writeStdout(`timed out after ${waitMs}ms`);
      return;
    }
    const daemonMessage = (daemonResponse.data as { message?: ConversationMessageDto | null })?.message ?? null;
    const daemonItems = ((daemonResponse.data as any)?.items ?? []) as Array<{
      delivery?: Record<string, unknown> | null;
      message?: ConversationMessageDto | null;
    }>;
    const itemMessages = daemonItems.map(item => item.message).filter(Boolean) as ConversationMessageDto[];
    const hydratedItems = daemonItems.filter(item => item.message);
    const deliveries = hydratedItems
      .map(item => item.delivery)
      .filter(Boolean) as Array<Record<string, unknown>>;
    const deliveryCount =
      daemonItems.length ||
      ((daemonResponse.data as any)?.deliveries ?? []).length ||
      (daemonMessage ? 1 : 0);
    const hydratedDeliveryCount = hydratedItems.length || (daemonMessage ? 1 : 0);
    const daemonMessages = daemonMessage ? [daemonMessage] : [];
    const daemonPayloadBase = hasWait
      ? buildConversationMessageResult({
          conversationId,
          afterSequence,
          snapshot: [],
          live: daemonMessages,
          max,
          waitTimedOut: false,
          returnedBecause: daemonMessages.length > 0 ? 'live_message_available' : 'no_wait',
        })
      : buildConversationMessageResult({
          conversationId,
          afterSequence,
          snapshot: itemMessages,
          live: [],
          max,
          waitTimedOut: false,
          returnedBecause: 'no_wait',
        });
    const payload: any = {
      ...daemonPayloadBase,
      deliveries,
      deliveryCount,
      hydratedDeliveryCount,
      unhydratedDeliveryCount: Math.max(deliveryCount - hydratedDeliveryCount, 0),
    };
    if (jsonl) {
      emitJsonLine({ event: 'ready', daemon: true, transport: 'daemon', waitMs, max });
      emitJsonLine({
        event: 'inbox',
        transport: 'daemon',
        messages: payload.messages,
        deliveries: payload.deliveries,
        deliveryCount: payload.deliveryCount,
        hydratedDeliveryCount: payload.hydratedDeliveryCount,
        unhydratedDeliveryCount: payload.unhydratedDeliveryCount,
      });
      emitJsonLine({
        event: 'done',
        transport: 'daemon',
        returnedBecause: payload.returnedBecause ?? 'no_wait',
        waitTimedOut: false,
        timedOut: false,
        count: payload.count ?? 1,
      });
      return;
    }
    if (wantsJson(flags)) {
      writeCommandJson('inbox', daemonTransportPayload(payload, daemonResponse));
      return;
    }
    writeStdout(JSON.stringify(daemonResponse.data));
    return;
  }

  const { client } = await connectClient(flags, state, 'direct');

  try {
    if (jsonl) {
      emitJsonLine({
        event: 'ready',
        transport: 'direct-disabled',
        daemon: false,
        identity: client.identityHex,
        waitMs,
        max,
        min,
      });
    }

    const recent = recentConversationMessages(client, max);
    if (!hasWait) {
      const readThrough = maxConversationSequence(recent);
      if (readThrough > 0n) {
        for (const conversationId of new Set(recent.map(message => message.conversationId))) {
          const conversationMax = maxConversationSequence(
            recent.filter(message => message.conversationId === conversationId)
          );
          await client.markConversationRead(BigInt(conversationId), conversationMax);
        }
      }

      if (jsonl) {
        for (const message of recent) {
          emitJsonLine({ event: 'message', message });
        }
        emitJsonLine({ event: 'done', timedOut: false, count: recent.length });
      } else if (wantsJson(flags)) {
        writeCommandJson('inbox', blockedDirectTransportPayload(buildConversationMessageResult({
            snapshot: recent,
            live: [],
            max,
            waitTimedOut: false,
            returnedBecause: 'no_wait',
          })));
      } else {
        for (const message of recent) {
          writeStdout(formatConversationMessage(message));
        }
      }
      return;
    }

    if (recent.length > 0) {
      const readThrough = maxConversationSequence(recent);
      if (readThrough > 0n) {
        for (const conversationId of new Set(recent.map(message => message.conversationId))) {
          const conversationMax = maxConversationSequence(
            recent.filter(message => message.conversationId === conversationId)
          );
          await client.markConversationRead(BigInt(conversationId), conversationMax);
        }
      }

      const payload = buildConversationMessageResult({
        snapshot: recent,
        live: [],
        max,
        waitTimedOut: false,
        returnedBecause: 'snapshot_available',
        next: [`agenttalk inbox --wait 30s --json`],
      });

      if (jsonl) {
        for (const message of payload.messages) {
          emitJsonLine({ event: 'message', source: 'snapshot', message });
        }
        emitJsonLine({
          event: 'done',
          returnedBecause: payload.returnedBecause,
          waitTimedOut: payload.waitTimedOut,
          timedOut: payload.timedOut,
          count: payload.count,
        });
        return;
      }

      if (wantsJson(flags)) {
        writeCommandJson('inbox', blockedDirectTransportPayload(payload));
        return;
      }

      for (const message of payload.messages) {
        writeStdout(formatConversationMessage(message));
      }
      return;
    }

    const waited = await waitForConversationMessages({
      client,
      max,
      min,
      timeoutMs: waitMs,
      drainMs,
    });
    const messages = waited.messages.map(toConversationMessageDto);
    for (const conversationId of new Set(messages.map(message => message.conversationId))) {
      const conversationMax = maxConversationSequence(
        messages.filter(message => message.conversationId === conversationId)
      );
      if (conversationMax > 0n) {
        await client.markConversationRead(BigInt(conversationId), conversationMax);
      }
    }

    if (jsonl) {
      for (const message of messages) {
        emitJsonLine({ event: 'message', source: 'live', message });
      }
      const payload = buildConversationMessageResult({
        snapshot: [],
        live: messages,
        max,
        waitTimedOut: waited.timedOut,
        returnedBecause:
          messages.length >= min
            ? 'min_count_reached'
            : waited.timedOut
              ? 'timeout'
              : 'live_message_available',
        next: [`agenttalk inbox --wait 30s --json`],
      });
      emitJsonLine({
        event: 'done',
        returnedBecause: payload.returnedBecause,
        waitTimedOut: payload.waitTimedOut,
        timedOut: payload.timedOut,
        count: payload.count,
      });
      return;
    }

    const payload = buildConversationMessageResult({
      snapshot: [],
      live: messages,
      max,
      waitTimedOut: waited.timedOut,
      returnedBecause:
        messages.length >= min
          ? 'min_count_reached'
          : waited.timedOut
            ? 'timeout'
            : 'live_message_available',
      next: [`agenttalk inbox --wait 30s --json`],
    });

    if (wantsJson(flags)) {
      writeCommandJson('inbox', blockedDirectTransportPayload(payload));
      return;
    }

    for (const message of payload.messages) {
      writeStdout(formatConversationMessage(message));
    }
    if (payload.waitTimedOut && payload.messages.length === 0) {
      writeStdout(`timed out after ${waitMs}ms`);
    }
  } finally {
    client.disconnect();
  }
}

async function commandListen(
  flags: Flags,
  positionals: string[],
  state: AgenttalkState,
  commandName = 'listen'
) {
  const conversationRaw =
    getStringFlag(flags, ['conversation', 'conversation-id']) ??
    (positionals[0] === 'conversation' ? positionals[1] : undefined);
  const threadRaw =
    getStringFlag(flags, ['thread', 'thread-id']) ??
    (positionals[0] === 'thread' ? positionals[1] : undefined);

  if (!conversationRaw && !threadRaw) {
    throw new Error('listen requires --conversation <id> or --thread <id>');
  }

  const max = getIntFlag(flags, ['max'], 1);
  const snapshotMax = getIntFlag(flags, ['snapshot'], 10);
  const timeoutMs = getDurationFlagMs(flags, ['timeout'], 30000);
  const min = parseWaitMin(flags, max, 1);
  const follow = getBooleanFlag(flags, ['follow']);
  const drainMs = getIntFlag(flags, ['drain-ms', 'drainMs'], 0);
  const jsonl = getBooleanFlag(flags, ['jsonl']);
  if (conversationRaw) {
    const conversationId = parseRequiredBigInt(conversationRaw, 'conversation-id');
    const afterSequence = getBigIntFlag(flags, ['after', 'after-sequence']);
    if (!allowDirectCli(flags)) {
      const daemonResponse = await sendRequiredDaemonCommand(flags, {
        id: 'listen',
        cmd: 'listen_once',
        conversationId: conversationId.toString(),
        afterSequence: afterSequence?.toString(),
        timeoutMs,
        max,
        hydrate: true,
      }, timeoutMs + 5000, true);
      if (!daemonResponse.ok) {
        const payload = {
          result: daemonResponse,
          ...buildConversationMessageResult({
            conversationId,
            afterSequence,
            snapshot: [],
            live: [],
            max,
            waitTimedOut: true,
            returnedBecause: 'timeout',
          }),
        };
        if (jsonl) {
          emitJsonLine({
            event: 'ready',
            kind: 'conversation',
            daemon: true,
            transport: 'daemon',
            conversationId: conversationId.toString(),
            timeoutMs,
            max,
            min,
          });
          emitJsonLine({
            event: 'done',
            transport: 'daemon',
            returnedBecause: payload.returnedBecause,
            waitTimedOut: payload.waitTimedOut,
            timedOut: payload.timedOut,
            count: payload.count,
          });
          return;
        }
        if (wantsJson(flags)) {
          writeCommandJson(commandName, daemonTransportPayload(payload, daemonResponse));
          return;
        }
        writeStdout(`timed out after ${timeoutMs}ms`);
        return;
      }
      const daemonData = daemonResponse.data as {
        message?: ConversationMessageDto | null;
        messages?: ConversationMessageDto[];
      };
      const daemonMessages = Array.isArray(daemonData?.messages)
        ? daemonData.messages
        : daemonData?.message
          ? [daemonData.message]
          : [];
      const payload = {
        result: daemonResponse.data,
        ...buildConversationMessageResult({
          conversationId,
          afterSequence,
          snapshot: [],
          live: daemonMessages,
          max,
          waitTimedOut: false,
          returnedBecause: daemonMessages.length > 0 ? 'live_message_available' : 'no_wait',
        }),
      };
      if (jsonl) {
        emitJsonLine({
          event: 'ready',
          kind: 'conversation',
          daemon: true,
          transport: 'daemon',
          conversationId: conversationId.toString(),
          timeoutMs,
          max,
          min,
        });
        emitJsonLine({ event: 'delivery', transport: 'daemon', data: daemonResponse.data });
        emitJsonLine({
          event: 'done',
          transport: 'daemon',
          returnedBecause: payload.returnedBecause,
          waitTimedOut: payload.waitTimedOut,
          timedOut: payload.timedOut,
          count: payload.count,
        });
        return;
      }
      if (wantsJson(flags)) {
        writeCommandJson(commandName, daemonTransportPayload(payload, daemonResponse));
        return;
      }
      writeStdout(JSON.stringify(daemonResponse.data));
      return;
    }
  }

  const { client } = await connectClient(
    flags,
    state,
    conversationRaw ? 'direct' : 'rooms'
  );

  try {
    if (conversationRaw) {
      const conversationId = parseRequiredBigInt(conversationRaw, 'conversation-id');
      const afterSequence =
        getBigIntFlag(flags, ['after', 'after-sequence']) ??
        client.conversationReadSequence(conversationId);
      const requestLimit = BigInt(Math.max(max, min, snapshotMax, 1));
      await client.requestConversationMessages({
        conversationId,
        afterSequence,
        limit: requestLimit,
      });
      await sleep(250);
      const snapshot = client
        .listRequestedConversationMessages(conversationId)
        .filter(row => (row.sequence ?? row.id) > afterSequence)
        .map(toConversationMessageDto)
        .slice(0, Math.min(max, snapshotMax));
      const snapshotReadThrough = maxConversationSequence(snapshot);
      if (snapshotReadThrough > 0n) {
        await client.markConversationRead(conversationId, snapshotReadThrough);
        await client.requestConversationMessages({
          conversationId,
          afterSequence: snapshotReadThrough,
          limit: BigInt(Math.max(max, 1)),
        });
        await sleep(100);
      }

      if (jsonl) {
        emitJsonLine({
          event: 'ready',
          kind: 'conversation',
          transport: 'direct-disabled',
          daemon: false,
          conversationId: conversationId.toString(),
          afterSequence: afterSequence.toString(),
          timeoutMs,
          max,
          min,
          follow,
        });
        for (const message of snapshot) {
          emitJsonLine({ event: 'snapshot', message });
        }
      }

      if (snapshot.length > 0 && !follow) {
        const payload = buildConversationMessageResult({
          conversationId,
          afterSequence,
          snapshot,
          live: [],
          max,
          waitTimedOut: false,
          returnedBecause: 'snapshot_available',
        });

        if (jsonl) {
          emitJsonLine({
            event: 'done',
            transport: 'direct-disabled',
            daemon: false,
            returnedBecause: payload.returnedBecause,
            waitTimedOut: payload.waitTimedOut,
            timedOut: payload.timedOut,
            count: payload.count,
          });
        } else if (wantsJson(flags)) {
          writeCommandJson(commandName, blockedDirectTransportPayload(payload));
        } else {
          for (const message of payload.messages) {
            writeStdout(formatConversationMessage(message));
          }
        }
        return;
      }

      if (follow && snapshot.length >= min) {
        const payload = buildConversationMessageResult({
          conversationId,
          afterSequence,
          snapshot,
          live: [],
          max,
          waitTimedOut: false,
          returnedBecause: 'snapshot_available',
        });

        if (jsonl) {
          emitJsonLine({
            event: 'done',
            transport: 'direct-disabled',
            daemon: false,
            returnedBecause: payload.returnedBecause,
            waitTimedOut: payload.waitTimedOut,
            timedOut: payload.timedOut,
            count: payload.count,
          });
        } else if (wantsJson(flags)) {
          writeCommandJson(commandName, blockedDirectTransportPayload(payload));
        } else {
          for (const message of payload.messages) {
            writeStdout(formatConversationMessage(message));
          }
        }
        return;
      }

      const snapshotKeys = new Set(snapshot.map(conversationMessageKey));
      const waited = await waitForConversationMessages({
        client,
        conversationId,
        max: Math.max(max - snapshot.length, 0),
        min: Math.max(min - snapshot.length, 1),
        afterSequence,
        timeoutMs,
        includeOwn: true,
        drainMs,
        ignoreKeys: snapshotKeys,
      });
      const messages = waited.messages.map(toConversationMessageDto);
      const payload = buildConversationMessageResult({
        conversationId,
        afterSequence,
        snapshot,
        live: messages,
        max,
        waitTimedOut: waited.timedOut,
        returnedBecause:
          snapshot.length + messages.length >= min
            ? messages.length > 0
              ? 'min_count_reached'
              : 'snapshot_available'
            : waited.timedOut
              ? 'timeout'
              : 'live_message_available',
      });
      const readThrough = maxConversationSequence(payload.messages);
      if (readThrough > 0n) {
        await client.markConversationRead(conversationId, readThrough);
      }

      if (jsonl) {
        for (const message of payload.live) {
          emitJsonLine({ event: 'message', source: 'live', message });
        }
        emitJsonLine({
          event: 'done',
          transport: 'direct-disabled',
          daemon: false,
          returnedBecause: payload.returnedBecause,
          waitTimedOut: payload.waitTimedOut,
          timedOut: payload.timedOut,
          count: payload.count,
        });
      } else if (wantsJson(flags)) {
        writeCommandJson(commandName, blockedDirectTransportPayload(payload));
      } else {
        for (const message of payload.messages) {
          writeStdout(formatConversationMessage(message));
        }
        if (payload.waitTimedOut && payload.messages.length === 0) {
          writeStdout(`timed out after ${timeoutMs}ms`);
        }
      }
      return;
    }

    const threadId = parseRequiredBigInt(threadRaw!, 'thread-id');
    try {
      await client.watchThread(threadId);
    } catch (error) {
      if (!isRoomMembershipError(error)) {
        throw error;
      }

      const receipt = latestRoomRemovalReceipt(client);
      const payload = {
        ...accessDeniedPayload({
          operation: 'listen',
          receipt,
        }),
        threadId: threadId.toString(),
        reducerError: coerceErrorText(error),
      };
      writeAccessDeniedResult(payload, flags, jsonl);
      return;
    }
    const snapshot = client.listMessages(threadId).map(toMessageDto).slice(-snapshotMax);

    if (jsonl) {
      emitJsonLine({
        event: 'ready',
        kind: 'thread',
        transport: 'direct-disabled',
        daemon: false,
        threadId: threadId.toString(),
        timeoutMs,
        max,
      });
      for (const message of snapshot) {
        emitJsonLine({ event: 'snapshot', message });
      }
    }

    const waited = await waitForThreadMessages({
      client,
      threadId,
      max,
      timeoutMs,
      includeOwn: true,
    });
    const messages = waited.messages.map(toMessageDto);

    if (jsonl) {
      for (const message of messages) {
        emitJsonLine({ event: 'message', message });
      }
      emitJsonLine({ event: 'done', timedOut: waited.timedOut, count: messages.length });
    } else if (wantsJson(flags)) {
      writeCommandJson(commandName, blockedDirectTransportPayload({ ok: true, snapshot, messages, timedOut: waited.timedOut }));
    } else {
      for (const message of snapshot) {
        writeStdout(`snapshot ${formatHumanMessage(message)}`);
      }
      for (const message of messages) {
        writeStdout(formatHumanMessage(message));
      }
      if (waited.timedOut) {
        writeStdout(`timed out after ${timeoutMs}ms`);
      }
    }
  } finally {
    client.disconnect();
  }
}

async function commandTranscript(
  flags: Flags,
  positionals: string[],
  state: AgenttalkState
) {
  const conversationRaw =
    getStringFlag(flags, ['conversation', 'conversation-id']) ??
    (positionals[0] === 'conversation' ? positionals[1] : undefined);
  const threadRaw =
    getStringFlag(flags, ['thread', 'thread-id']) ??
    (positionals[0] === 'thread' ? positionals[1] : undefined) ??
    (positionals.length === 1 && /^\d+$/.test(positionals[0]) ? positionals[0] : undefined);

  if (!conversationRaw && !threadRaw) {
    throw new Error('transcript requires --conversation <id> or --thread <id>');
  }

  const limit = Math.min(getIntFlag(flags, ['limit'], 50), 100);
  const afterSequence = getBigIntFlag(flags, ['after', 'after-sequence']);
  const beforeSequence = getBigIntFlag(flags, ['before', 'before-sequence']);
  if (afterSequence && beforeSequence) {
    throw new Error('transcript accepts --after or --before, not both');
  }

  if (conversationRaw) {
    const conversationId = parseRequiredBigInt(conversationRaw, 'conversation-id');
    if (!allowDirectCli(flags)) {
      const requestedAfterSequence = afterSequence ?? (beforeSequence ? undefined : 0n);
      const daemonResponse = await sendRequiredDaemonCommand(flags, {
        id: 'history',
        cmd: 'history',
        conversationId: conversationId.toString(),
        afterSequence: requestedAfterSequence?.toString(),
        beforeSequence: beforeSequence?.toString(),
        limit,
      });
      const messages = ((daemonResponse?.data as any)?.messages ?? []) as Array<any>;
      const previousBeforeSequence = messages[0]?.sequence ?? null;
      const lastSequence =
        messages[messages.length - 1]?.sequence ?? requestedAfterSequence?.toString() ?? null;
      const payload = daemonTransportPayload({
        conversationId: conversationId.toString(),
        messages,
        page: {
          limit,
          count: messages.length,
          afterSequence: requestedAfterSequence?.toString() ?? null,
          beforeSequence: beforeSequence?.toString() ?? null,
          previousBeforeSequence,
          lastSequence,
          nextAfterSequence: lastSequence,
        },
        lastSequence,
        nextAfterSequence: lastSequence,
        ...conversationNextPayload(conversationId.toString(), lastSequence),
        hotRetentionHours: 12,
      }, daemonResponse);
      if (wantsJson(flags)) {
        writeCommandJson('transcript', payload);
        return;
      }
      for (const message of messages) {
        writeStdout(
          `[${message.conversationId}#${message.sequence}] ${message.authorLabel}: ${message.text}`
        );
      }
      writeStdout('note: conversation transcript is limited to hot retained messages (~12h).');
      return;
    }
  }

  const { client } = await connectClient(
    flags,
    state,
    conversationRaw ? 'direct' : 'rooms'
  );

  try {
    if (conversationRaw) {
      const conversationId = parseRequiredBigInt(conversationRaw, 'conversation-id');
      const conversation = client
        .listConversations()
        .find(row => row.id === conversationId);
      await client.requestConversationMessages({
        conversationId,
        afterSequence,
        beforeSequence,
        limit: BigInt(limit),
      });
      await sleep(250);
      const messages = client
        .listRequestedConversationMessages(conversationId)
        .map(toConversationMessageDto);
      const firstSequence = messages[0]?.sequence ?? null;
      const lastSequence = messages[messages.length - 1]?.sequence ?? null;
      const nextAfterSequence = lastSequence ?? afterSequence?.toString() ?? null;
      const payload = {
        ok: true,
        conversationId: conversationId.toString(),
        conversation: conversation ? toConversationDto(conversation) : null,
        messages,
        page: {
          limit,
          count: messages.length,
          afterSequence: afterSequence?.toString() ?? null,
          beforeSequence: beforeSequence?.toString() ?? null,
          previousBeforeSequence: firstSequence,
          lastSequence,
          nextAfterSequence,
        },
        lastSequence,
        nextAfterSequence,
        ...conversationNextPayload(conversationId.toString(), nextAfterSequence),
      };

      if (wantsJson(flags)) {
        writeCommandJson('transcript', blockedDirectTransportPayload(payload));
        return;
      }

      writeStdout(
        `conversation ${conversationId.toString()}${conversation ? `: ${conversation.title}` : ''} (limit ${limit})`
      );
      for (const message of messages) {
        writeStdout(formatConversationMessage(message));
      }
      return;
    }

    const threadId = parseRequiredBigInt(threadRaw!, 'thread-id');
    try {
      await client.watchThread(threadId);
    } catch (error) {
      if (!isRoomMembershipError(error)) {
        throw error;
      }

      const receipt = latestRoomRemovalReceipt(client);
      const payload = {
        ...accessDeniedPayload({
          operation: 'transcript',
          receipt,
        }),
        threadId: threadId.toString(),
        reducerError: coerceErrorText(error),
      };
      writeAccessDeniedResult(payload, flags);
      return;
    }
    const thread = client.listThreads().find(row => row.id === threadId);
    const afterId = getBigIntFlag(flags, ['after-id']);
    const beforeId = getBigIntFlag(flags, ['before-id']);
    if (afterId && beforeId) {
      throw new Error('thread transcript accepts --after-id or --before-id, not both');
    }
    const threadRows = client
      .listMessages(threadId)
      .filter(row => (afterId ? row.id > afterId : true))
      .filter(row => (beforeId ? row.id < beforeId : true));
    const pagedThreadRows = beforeId
      ? threadRows.slice(-limit)
      : threadRows.slice(0, limit);
    const messages = pagedThreadRows.map(toMessageDto);
    const richRows = client
      .listRichMessages(threadId)
      .filter(row => {
        const sourceId = row.legacyMessageId ?? row.id;
        if (afterId && sourceId <= afterId) {
          return false;
        }
        if (beforeId && sourceId >= beforeId) {
          return false;
        }
        return true;
      });
    const richMessages = (beforeId ? richRows.slice(-limit) : richRows.slice(0, limit)).map(
      toRichMessageDto
    );
    const payload = {
      ok: true,
      thread: thread ? toThreadDto(thread) : null,
      messages,
      richMessages,
      page: {
        limit,
        count: messages.length,
        afterId: afterId?.toString() ?? null,
        beforeId: beforeId?.toString() ?? null,
        previousBeforeId: messages[0]?.id ?? null,
        nextAfterId: messages[messages.length - 1]?.id ?? null,
      },
    };

    if (wantsJson(flags)) {
      writeJson(payload);
      return;
    }

    writeStdout(`thread ${threadId.toString()}${thread ? `: ${thread.title}` : ''}`);
    for (const message of messages) {
      writeStdout(formatHumanMessage(message));
    }
  } finally {
    client.disconnect();
  }
}

async function commandAccount(
  flags: Flags,
  positionals: string[],
  state: AgenttalkState
) {
  const subcommand = positionals[0] ?? 'search';
  if (!allowDirectCli(flags)) {
    if (subcommand === 'create') {
      const handle = getStringFlag(flags, ['handle']) ?? positionals[1];
      if (!handle) {
        throw new Error('account create requires --handle <handle>');
      }
      const roleRaw = getStringFlag(flags, ['role']) ?? 'agent';
      const role: AgentRole = roleRaw === 'human' ? 'human' : 'agent';
      const displayName =
        getStringFlag(flags, ['name', 'display-name', 'displayName']) ?? handle;
      const bio = getStringFlag(flags, ['bio']) ?? '';
      const daemonResponse = await sendRequiredDaemonCommand(flags, {
        id: 'account:create',
        cmd: 'create_account',
        handle,
        displayName,
        role,
        bio,
      });
      writeJson(daemonTransportPayload((daemonResponse?.data ?? {}) as Record<string, unknown>));
      return;
    }

    if (subcommand === 'bootstrap-operator') {
      const daemonResponse = await sendRequiredDaemonCommand(flags, {
        id: 'account:bootstrap-operator',
        cmd: 'bootstrap_operator_account',
      });
      writeJson(daemonTransportPayload((daemonResponse?.data ?? {}) as Record<string, unknown>));
      return;
    }

    if (subcommand === 'type' || subcommand === 'entitle') {
      const handle = getStringFlag(flags, ['handle']) ?? positionals[1];
      const typeRaw = getStringFlag(flags, ['type', 'account-type']) ?? positionals[2];
      if (!handle || !typeRaw) {
        throw new Error('account type requires <handle> --type free|group|pro|operator');
      }
      const accountType: AccountType = assertChoice(
        typeRaw,
        'type',
        ['free', 'group', 'pro', 'operator'] as const
      );
      const explicitGroup = parseOptionalBoolean(
        getStringFlag(flags, ['group-chat', 'groupChatAllowed']),
        'group-chat'
      );
      const groupChatAllowed =
        explicitGroup ??
        (accountType === 'group' || accountType === 'pro' || accountType === 'operator');
      const daemonResponse = await sendRequiredDaemonCommand(flags, {
        id: 'account:type',
        cmd: 'set_account_type',
        handle,
        accountType,
        groupChatAllowed,
      });
      writeJson(daemonTransportPayload((daemonResponse?.data ?? {}) as Record<string, unknown>));
      return;
    }

    if (subcommand === 'entitlements') {
      const daemonResponse = await sendRequiredDaemonCommand(flags, {
        id: 'account:entitlements',
        cmd: 'account_entitlements',
      });
      writeJson(daemonTransportPayload((daemonResponse?.data ?? {}) as Record<string, unknown>));
      return;
    }

    if (subcommand === 'search' || subcommand === 'list') {
      const outputJson = wantsJson(flags);
      const roleRaw = getStringFlag(flags, ['role']);
      const role = roleRaw
        ? assertChoice(roleRaw, 'role', ['agent', 'human'] as const)
        : undefined;
      const online = parseOptionalBoolean(getStringFlag(flags, ['online']), 'online');
      const query =
        getStringFlag(flags, ['query', 'q']) ??
        (positionals.length > 1 ? positionals.slice(1).join(' ') : undefined);
      const handle = getStringFlag(flags, ['handle']);
      const daemonResponse = await sendRequiredDaemonCommand(flags, {
        id: 'account:search',
        cmd: 'account_search',
        query,
        handle,
        role,
        online,
        limit: directoryLimitFromFlags(flags).toString(),
      });
      const data = (daemonResponse?.data ?? {}) as { accounts?: unknown[] };
      const accounts = data.accounts ?? [];
      if (outputJson) {
        writeJson(daemonTransportPayload({ accounts }));
        return;
      }
      for (const account of accounts as Array<any>) {
        writeStdout(
          `@${account.handle}\t${account.role}\t${account.online ? 'online' : 'offline'}\t${account.displayName}\t${account.identity}`
        );
      }
      return;
    }

    throw new Error(`Unknown account command: ${subcommand}`);
  }

  const profile: AgentSubscriptionProfile =
    subcommand === 'create' ||
    subcommand === 'bootstrap-operator' ||
    subcommand === 'type' ||
    subcommand === 'entitle' ||
    subcommand === 'entitlements'
      ? 'account-admin'
      : 'directory';
  const { client } = await connectClient(flags, state, profile);

  try {
    if (subcommand === 'create') {
      const handle = getStringFlag(flags, ['handle']) ?? positionals[1];
      if (!handle) {
        throw new Error('account create requires --handle <handle>');
      }

      const roleRaw = getStringFlag(flags, ['role']) ?? 'agent';
      const role: AgentRole = roleRaw === 'human' ? 'human' : 'agent';
      const displayName =
        getStringFlag(flags, ['name', 'display-name', 'displayName']) ?? handle;
      const bio = getStringFlag(flags, ['bio']) ?? '';

      await client.createAccount({ handle, displayName, role, bio });
      await client.requestAccountDirectory({
        handle: normalizeAccountRef(handle),
        limit: 1n,
      });
      await sleep(DIRECTORY_SYNC_DELAY_MS);

      const created = client.searchAccounts({ handle: normalizeAccountRef(handle) })[0];
      const entitlement = client.currentAccountEntitlement();
      writeJson({
        ok: true,
        transport: 'direct-disabled',
        daemon: false,
        identity: client.identityHex,
        account: created
          ? toAccountDto(created)
          : {
              handle: normalizeAccountRef(handle),
              identity: client.identityHex,
              displayName,
              role,
              bio,
            },
        entitlement: entitlement ? toAccountEntitlementDto(entitlement) : null,
      });
      return;
    }

    if (subcommand === 'bootstrap-operator') {
      await client.bootstrapOperatorAccount();
      await sleep(250);
      writeJson({
        ok: true,
        transport: 'direct-disabled',
        daemon: false,
        identity: client.identityHex,
        entitlement: client.currentAccountEntitlement()
          ? toAccountEntitlementDto(client.currentAccountEntitlement()!)
          : null,
      });
      return;
    }

    if (subcommand === 'type' || subcommand === 'entitle') {
      const handle = getStringFlag(flags, ['handle']) ?? positionals[1];
      const typeRaw = getStringFlag(flags, ['type', 'account-type']) ?? positionals[2];
      if (!handle || !typeRaw) {
        throw new Error('account type requires <handle> --type free|group|pro|operator');
      }

      const accountType: AccountType = assertChoice(
        typeRaw,
        'type',
        ['free', 'group', 'pro', 'operator'] as const
      );
      const explicitGroup = parseOptionalBoolean(
        getStringFlag(flags, ['group-chat', 'groupChatAllowed']),
        'group-chat'
      );
      const groupChatAllowed =
        explicitGroup ??
        (accountType === 'group' || accountType === 'pro' || accountType === 'operator');

      await client.setAccountType({
        handle: normalizeAccountRef(handle),
        accountType,
        groupChatAllowed,
      });
      await sleep(250);
      const entitlement = client
        .listAccountEntitlements()
        .find(row => row.handle === normalizeAccountRef(handle));
      writeJson({
        ok: true,
        transport: 'direct-disabled',
        daemon: false,
        entitlement: entitlement ? toAccountEntitlementDto(entitlement) : null,
      });
      return;
    }

    if (subcommand === 'entitlements') {
      writeJson(
        blockedDirectTransportPayload({
          ok: true,
          entitlements: client.listAccountEntitlements().map(toAccountEntitlementDto),
        })
      );
      return;
    }

    if (subcommand === 'search' || subcommand === 'list') {
      const outputJson = wantsJson(flags);
      const roleRaw = getStringFlag(flags, ['role']);
      const role = roleRaw
        ? assertChoice(roleRaw, 'role', ['agent', 'human'] as const)
        : undefined;
      const online = parseOptionalBoolean(getStringFlag(flags, ['online']), 'online');
      const query =
        getStringFlag(flags, ['query', 'q']) ??
        (positionals.length > 1 ? positionals.slice(1).join(' ') : undefined);
      const handle = getStringFlag(flags, ['handle']);
      await client.requestAccountDirectory({
        query,
        handle: handle ? normalizeAccountRef(handle) : undefined,
        role,
        online,
        limit: directoryLimitFromFlags(flags),
      });
      await sleep(DIRECTORY_SYNC_DELAY_MS);
      const accounts = client
        .searchAccounts({
          query,
          handle,
          role,
          online,
        })
        .map(toAccountDto);

      if (outputJson) {
        writeJson(blockedDirectTransportPayload({ ok: true, accounts }));
        return;
      }

      for (const account of accounts) {
        writeStdout(
          `@${account.handle}\t${account.role}\t${account.online ? 'online' : 'offline'}\t${account.displayName}\t${account.identity}`
        );
      }
      return;
    }

    throw new Error(`Unknown account command: ${subcommand}`);
  } finally {
    client.disconnect();
  }
}

async function commandRoom(flags: Flags, positionals: string[], state: AgenttalkState) {
  const subcommand = positionals[0] ?? 'list';
  const { client } = await connectClient(flags, state, 'rooms');

  try {
    if (subcommand === 'list') {
      await client.requestChannelDirectory({
        query: getStringFlag(flags, ['query', 'q']),
        limit: directoryLimitFromFlags(flags),
      });
      await sleep(DIRECTORY_SYNC_DELAY_MS);
      const channels = new Map(
        client.listChannels().map(channel => [channel.id.toString(), channel])
      );
      const rooms = client.listRoomConfigs().map(room => ({
        ...toRoomConfigDto(room),
        room: channels.get(room.channelId.toString())
          ? toChannelDto(channels.get(room.channelId.toString())!)
          : null,
        currentMember: isCurrentChannelMember(client, room.channelId),
      }));
      if (wantsJson(flags)) {
        writeJson(rooms);
        return;
      }
      for (const room of rooms) {
        writeStdout(
          `${room.channelId}\t#${room.room?.name ?? room.channelId}\t${room.visibility}\t${room.joinPolicy}\tmember:${room.currentMember ? 'yes' : 'no'}\tpassword:${room.passwordConfigured ? 'yes' : 'no'}`
        );
      }
      return;
    }

    if (subcommand === 'start') {
      const nameFromFlag = getStringFlag(flags, ['name']);
      const name = nameFromFlag ?? positionals[1];
      if (!name) {
        throw new Error('room start requires --name <name> --with <handle-or-identity,...>');
      }

      const memberRefs = parseAccountRefs(
        getStringFlag(flags, ['with', 'members']),
        positionals.slice(nameFromFlag ? 1 : 2)
      );
      if (memberRefs.length === 0) {
        throw new Error('room start requires --with <handle-or-identity,...>');
      }

      const normalizedName = normalizeChannelRef(name).trim().toLowerCase();
      const roomOptions = parseRoomOptions(flags);
      if (roomOptions.joinPolicy === 'password' && !roomOptions.password) {
        throw new Error('room start with --join-policy password requires --password');
      }

      const topic =
        getStringFlag(flags, ['topic']) ??
        `Agent collaboration room started by ${client.identityHex.slice(0, 12)}`;
      const memberIdentities = await resolveAccountIdentities(client, memberRefs);
      const beforeThreadIds = new Set(
        client.listThreads().map(row => row.id.toString())
      );

      await client.requestChannelDirectory({ name: normalizedName, limit: 1n });
      await sleep(DIRECTORY_SYNC_DELAY_MS);
      let channel = client.listChannels().find(row => row.name === normalizedName);
      let reused = Boolean(channel);
      if (!channel) {
        await client.createRoom(normalizedName, topic, roomOptions);
        await client.requestChannelDirectory({ name: normalizedName, limit: 1n });
        await sleep(DIRECTORY_SYNC_DELAY_MS);
        channel = client.listChannels().find(row => row.name === normalizedName);
        reused = false;
      }

      if (!channel) {
        throw new Error(`Room was created but is not visible yet: ${normalizedName}`);
      }

      for (const memberIdentity of memberIdentities) {
        if (memberIdentity.toHexString() !== client.identityHex) {
          await client.setRoomRole(channel.id, memberIdentity, 'member');
        }
      }
      await sleep(250);

      const openingMessage = getStringFlag(flags, ['message']);
      let createdThread: ModuleTypes.Thread | undefined;
      if (openingMessage) {
        const title = getStringFlag(flags, ['title']) ?? `Start #${channel.name}`;
        await client.createThread(channel.id, title, openingMessage);
        await sleep(250);
        createdThread = findCreatedThread(client, channel.id, title, beforeThreadIds);
      }

      const room = client
        .listRoomConfigs()
        .find(row => row.channelId === channel!.id);
      const payload = {
        ok: true,
        reused,
        room: toChannelDto(channel),
        config: room ? toRoomConfigDto(room) : null,
        members: roomMembers(client, channel.id),
        thread: createdThread ? toThreadDto(createdThread) : null,
        next: [
          `agenttalk room info ${channel.name} --json`,
          `agenttalk room members ${channel.name} --json`,
          `agenttalk threads ${channel.name} --json`,
        ],
      };

      if (wantsJson(flags)) {
        writeJson(payload);
        return;
      }

      writeStdout(`${reused ? 'using existing' : 'started'} room #${channel.name} (${channel.id.toString()})`);
      writeStdout(`members: ${payload.members.map(member => member.handle ?? member.memberIdentity).join(', ')}`);
      if (createdThread) {
        writeStdout(`thread: ${createdThread.id.toString()} ${createdThread.title}`);
      }
      return;
    }

    const channelRef = positionals[1];
    if (!channelRef) {
      throw new Error(`room ${subcommand} requires <channel-id-or-name>`);
    }

    const channelId = await resolveChannelId(client, channelRef);
    const channel = findVisibleChannel(client, channelId);

    if (subcommand === 'info') {
      const config = client
        .listRoomConfigs()
        .find(row => row.channelId === channelId);
      const currentMember = isCurrentChannelMember(client, channelId);
      const currentRole = client
        .listChannelRoles()
        .find(
          row =>
            row.channelId === channelId &&
            row.memberIdentity.toHexString() === client.identityHex
        );
      const receipt = latestRoomRemovalReceipt(client, channelId);
      const payload = {
        ok: true,
        room: channel ? toChannelDto(channel) : { id: channelId.toString() },
        config: config ? toRoomConfigDto(config) : null,
        access: {
          member: currentMember,
          role: currentRole?.role ?? null,
          denied: !currentMember,
          message: currentMember
            ? null
            : accessDeniedMessage({
                operation: 'room info',
                channelName: channel?.name ?? receipt?.channelName,
                channelId,
                receipt,
              }),
          removalReceipt: receipt ? toRoomRemovalReceiptDto(receipt) : null,
        },
        members: currentMember ? roomMembers(client, channelId) : [],
      };

      if (wantsJson(flags)) {
        writeJson(payload);
        return;
      }

      writeStdout(`room ${payload.room.id}${channel ? ` #${channel.name}` : ''}`);
      if (config) {
        writeStdout(
          `visibility:${config.visibility} join:${config.joinPolicy} password:${config.password ? 'yes' : 'no'}`
        );
      }
      writeStdout(`member:${currentMember ? 'yes' : 'no'} role:${currentRole?.role ?? 'none'}`);
      if (!currentMember) {
        writeStdout(payload.access.message!);
      }
      return;
    }

    if (subcommand === 'members') {
      if (!isCurrentChannelMember(client, channelId)) {
        const payload = accessDeniedPayload({
          operation: 'room members',
          channel,
          channelId,
          receipt: latestRoomRemovalReceipt(client, channelId),
        });
        process.exitCode = 1;
        if (wantsJson(flags)) {
          writeJson(payload);
        } else {
          writeStderr(payload.message);
        }
        return;
      }

      const members = roomMembers(client, channelId);
      if (wantsJson(flags)) {
        writeJson({
          ok: true,
          room: channel ? toChannelDto(channel) : { id: channelId.toString() },
          members,
        });
        return;
      }

      for (const member of members) {
        writeStdout(
          `${member.role}\t${member.handle ?? member.memberIdentity}\t${member.displayName ?? ''}\tjoined:${member.joinedAt}`
        );
      }
      return;
    }

    if (subcommand === 'config') {
      const existing = client
        .listRoomConfigs()
        .find(row => row.channelId === channelId);
      const options = parseRoomOptions(flags);
      const visibility =
        options.visibility ??
        assertChoice(existing?.visibility, 'visibility', ['public', 'private'] as const, 'public');
      const joinPolicy =
        options.joinPolicy ??
        assertChoice(
          existing?.joinPolicy,
          'join-policy',
          ['open', 'password', 'invite'] as const,
          'open'
        );
      const password = options.password ?? '';

      if (joinPolicy === 'password' && !password) {
        throw new Error('room config with --join-policy password requires --password');
      }

      await client.setRoomConfig(channelId, {
        visibility,
        joinPolicy,
        password,
      });
      await sleep(250);

      const updated = client
        .listRoomConfigs()
        .find(row => row.channelId === channelId);
      writeJson({
        ok: true,
        room: updated
          ? toRoomConfigDto(updated)
          : { channelId: channelId.toString(), visibility, joinPolicy },
      });
      return;
    }

    if (subcommand === 'role') {
      const accountRef = positionals[2];
      const roleRaw = getStringFlag(flags, ['role']) ?? positionals[3];
      if (!accountRef || !roleRaw) {
        throw new Error('room role requires <handle-or-identity> --role owner|mod|member');
      }

      const role = assertChoice(roleRaw, 'role', ['owner', 'mod', 'member'] as const);
      const memberIdentity = await resolveAccountIdentity(client, accountRef);
      await client.setRoomRole(channelId, memberIdentity, role);
      await sleep(250);

      writeJson({
        ok: true,
        channelId: channelId.toString(),
        memberIdentity: memberIdentity.toHexString(),
        role,
      });
      return;
    }

    if (subcommand === 'kick' || subcommand === 'remove') {
      const accountRef = positionals[2];
      if (!accountRef) {
        throw new Error(`room ${subcommand} requires <handle-or-identity>`);
      }

      const memberIdentity = await resolveAccountIdentity(client, accountRef);
      const reason =
        getStringFlag(flags, ['reason']) ??
        `removed by ${client.identityHex.slice(0, 12)}`;
      await client.kickFromRoom(channelId, memberIdentity, reason);
      await sleep(250);
      const receipt = client
        .listRoomRemovalReceipts(channelId)
        .find(row => row.removedIdentity.toHexString() === memberIdentity.toHexString());
      writeJson({
        ok: true,
        action: 'remove',
        channelId: channelId.toString(),
        memberIdentity: memberIdentity.toHexString(),
        reason,
        removalReceipt: receipt ? toRoomRemovalReceiptDto(receipt) : null,
      });
      return;
    }

    throw new Error(`Unknown room command: ${subcommand}`);
  } finally {
    client.disconnect();
  }
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

  const { client, state: resolvedState } = await connectClient(flags, state, 'identity');

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
  if (!allowDirectCli(flags)) {
    const daemonResponse = await sendRequiredDaemonCommand(flags, {
      id: 'whoami',
      cmd: 'whoami',
    });
    const payload = daemonTransportPayload({
      ...((daemonResponse?.data ?? {}) as Record<string, unknown>),
      token: null,
      tokenRedacted: true,
      tokenStoredAt: STATE_PATH,
      messageStore: 'ephemeral-hot-realtime',
    });
    writeJson(payload);
    return;
  }

  const { client } = await connectClient(flags, state, 'identity');

  try {
    const me = client
      .listUsers()
      .find(row => row.identity.toHexString() === client.identityHex);

    writeJson({
      transport: 'direct-disabled',
      daemon: false,
      identity: client.identityHex,
      token: showToken ? client.token : null,
      tokenRedacted: !showToken,
      tokenStoredAt: STATE_PATH,
      hotRetentionHours: 12,
      messageStore: 'ephemeral-hot-realtime',
      archiveConfigured: false,
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
  const outputJson = wantsJson(flags);
  const { client } = await connectClient(flags, state, 'rooms');

  try {
    const query = getStringFlag(flags, ['query', 'q']);
    await client.requestChannelDirectory({
      query,
      name: getStringFlag(flags, ['name']),
      limit: directoryLimitFromFlags(flags),
    });
    await sleep(DIRECTORY_SYNC_DELAY_MS);
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
  const roomOptions = parseRoomOptions(flags);

  if (!name) {
    throw new Error('create-channel requires --name <name>');
  }

  if (roomOptions.joinPolicy === 'password' && !roomOptions.password) {
    throw new Error('create-channel with --join-policy password requires --password');
  }

  const { client } = await connectClient(flags, state, 'rooms');

  try {
    if (roomOptions.visibility || roomOptions.joinPolicy || roomOptions.password) {
      await client.createRoom(name, topic, roomOptions);
    } else {
      await client.createChannel(name, topic);
    }
    await sleep(250);
    await client.requestChannelDirectory({
      name: normalizeChannelRef(name).trim().toLowerCase(),
      limit: 1n,
    });
    await sleep(DIRECTORY_SYNC_DELAY_MS);
    const normalizedName = normalizeChannelRef(name).trim().toLowerCase();
    const created = client.listChannels().find(row => row.name === normalizedName);
    const room = created
      ? client.listRoomConfigs().find(row => row.channelId === created.id)
      : undefined;

    writeJson({
      ok: true,
      channel: created ? toChannelDto(created) : { id: null, name, topic },
      room: room ? toRoomConfigDto(room) : null,
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

  const { client } = await connectClient(flags, state, 'rooms');

  try {
    const channelId = await resolveChannelId(client, channelRef);

    if (command === 'join') {
      await client.joinChannel(channelId, getStringFlag(flags, ['password']));
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
  const outputJson = wantsJson(flags);
  const channelRef = positionals[0];

  const { client } = await connectClient(flags, state, 'rooms');

  try {
    const channelId = channelRef ? await resolveChannelId(client, channelRef) : undefined;
    if (channelId && !isCurrentChannelMember(client, channelId)) {
      const channel = findVisibleChannel(client, channelId);
      const payload = accessDeniedPayload({
        operation: 'threads',
        channel,
        channelId,
        receipt: latestRoomRemovalReceipt(client, channelId),
      });
      writeAccessDeniedResult(payload, flags);
      return;
    }

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

  const { client } = await connectClient(flags, state, 'rooms');

  try {
    const channelId = await resolveChannelId(client, channelRef);
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
  const { client } = await connectClient(flags, state, 'rooms');

  try {
    await client.watchThread(threadId);
    await client.sendThreadMessage(threadId, message, parseRichMessageInput(flags));
    writeJson({
      ok: true,
      threadId: threadId.toString(),
      text: message,
    });
  } finally {
    client.disconnect();
  }
}

async function commandConversation(
  flags: Flags,
  positionals: string[],
  state: AgenttalkState
) {
  const subcommand = positionals[0] ?? 'list';
  if (!allowDirectCli(flags)) {
    if (subcommand === 'list') {
      const daemonResponse = await sendRequiredDaemonCommand(flags, {
        id: 'conversation:list',
        cmd: 'conversation_list',
      });
      const conversations = ((daemonResponse?.data as any)?.conversations ?? []) as Array<any>;
      if (wantsJson(flags)) {
        writeCommandJson('conversation.list', daemonTransportPayload({ conversations }, daemonResponse));
        return;
      }
      for (const conversation of conversations) {
        writeStdout(
          `${conversation.id}\t${conversation.kind}\tmembers:${conversation.memberCount}\t${conversation.title}\tlast:${conversation.lastActivity}`
        );
      }
      return;
    }

    if (subcommand === 'start') {
      const targetRef = positionals[1] ?? getStringFlag(flags, ['to', 'target']);
      if (!targetRef) {
        throw new Error('conversation start requires <handle-or-identity>');
      }
      const daemonResponse = await sendRequiredDaemonCommand(flags, {
        id: 'conversation:start',
        cmd: 'create_direct',
        target: targetRef,
        title: getStringFlag(flags, ['title']) ?? '',
        message: getStringFlag(flags, ['message']) ?? '',
      });
      const data = (daemonResponse?.data ?? {}) as Record<string, unknown>;
      const conversationId = data.conversationId ? String(data.conversationId) : null;
      const receipt = data.receipt as { sequence?: string | number | null } | undefined;
      const messageReceipt = data.messageReceipt as { sequence?: string | number | null } | undefined;
      const lastSequence =
        messageReceipt?.sequence !== undefined && messageReceipt?.sequence !== null
          ? String(messageReceipt.sequence)
          : receipt?.sequence !== undefined && receipt?.sequence !== null
            ? String(receipt.sequence)
            : null;
      writeCommandJson('conversation.start', daemonTransportPayload({
        ...data,
        lastSequence,
        nextAfterSequence: lastSequence,
        ...conversationNextPayload(conversationId, lastSequence),
      }, daemonResponse));
      return;
    }

    if (subcommand === 'group') {
      const title = getStringFlag(flags, ['title']);
      if (!title) {
        throw new Error('conversation group requires --title <title>');
      }
      const refs = parseAccountRefs(
        getStringFlag(flags, ['members']),
        positionals.slice(1)
      );
      const daemonResponse = await sendRequiredDaemonCommand(flags, {
        id: 'conversation:group',
        cmd: 'create_group',
        title,
        members: refs,
        message: getStringFlag(flags, ['message']) ?? '',
        kind: parseRichMessageInput(flags).kind,
      });
      const data = (daemonResponse?.data ?? {}) as Record<string, unknown>;
      const conversationId = data.conversationId ? String(data.conversationId) : null;
      const receipt = data.receipt as { sequence?: string | number | null } | undefined;
      const messageReceipt = data.messageReceipt as { sequence?: string | number | null } | undefined;
      const lastSequence =
        messageReceipt?.sequence !== undefined && messageReceipt?.sequence !== null
          ? String(messageReceipt.sequence)
          : receipt?.sequence !== undefined && receipt?.sequence !== null
            ? String(receipt.sequence)
            : null;
      writeCommandJson('conversation.group', daemonTransportPayload({
        ...data,
        lastSequence,
        nextAfterSequence: lastSequence,
        ...conversationNextPayload(conversationId, lastSequence),
      }, daemonResponse));
      return;
    }

    if (subcommand === 'add') {
      const conversationIdRaw = positionals[1];
      const accountRef = positionals[2];
      if (!conversationIdRaw || !accountRef) {
        throw new Error('conversation add requires <conversation-id> <handle-or-identity>');
      }
      const daemonResponse = await sendRequiredDaemonCommand(flags, {
        id: 'conversation:add',
        cmd: 'add_conversation_member',
        conversationId: conversationIdRaw,
        member: accountRef,
        role: getStringFlag(flags, ['role']) ?? 'member',
      });
      writeCommandJson(
        'conversation.add',
        daemonTransportPayload((daemonResponse?.data ?? {}) as Record<string, unknown>, daemonResponse)
      );
      return;
    }

    if (subcommand === 'send') {
      const conversationIdRaw = positionals[1];
      const message = getStringFlag(flags, ['message']);
      if (!conversationIdRaw || !message) {
        throw new Error('conversation send requires <conversation-id> --message <text>');
      }
      const richInput = parseRichMessageInput(flags);
      const daemonResponse = await sendRequiredDaemonCommand(flags, {
        id: 'conversation:send',
        cmd: 'send_conversation',
        conversationId: conversationIdRaw,
        text: message,
        kind: richInput.kind,
        clientRequestId: richInput.clientRequestId,
      });
      const receipt = (daemonResponse?.data as any)?.receipt ?? null;
      const lastSequence = receipt?.sequence ? String(receipt.sequence) : null;
      writeCommandJson('conversation.send', daemonTransportPayload({
        conversationId: conversationIdRaw,
        text: message,
        result: daemonResponse?.data,
        receipt,
        lastSequence,
        nextAfterSequence: lastSequence,
        ...conversationNextPayload(conversationIdRaw, lastSequence),
      }, daemonResponse));
      return;
    }

    if (subcommand === 'messages') {
      const conversationIdRaw = positionals[1];
      if (!conversationIdRaw) {
        throw new Error('conversation messages requires <conversation-id>');
      }
      const limit = Math.min(getIntFlag(flags, ['limit'], 50), 100);
      const requestedAfterSequence = getBigIntFlag(flags, ['after', 'after-sequence']);
      const beforeSequence = getBigIntFlag(flags, ['before', 'before-sequence']);
      if (requestedAfterSequence && beforeSequence) {
        throw new Error('conversation messages accepts --after or --before, not both');
      }
      const effectiveAfterSequence = requestedAfterSequence ?? (beforeSequence ? undefined : 0n);
      const daemonResponse = await sendRequiredDaemonCommand(flags, {
        id: 'conversation:messages',
        cmd: 'history',
        conversationId: conversationIdRaw,
        afterSequence: effectiveAfterSequence?.toString(),
        beforeSequence: beforeSequence?.toString(),
        limit,
      });
      const messages = ((daemonResponse?.data as any)?.messages ?? []) as Array<any>;
      const lastSequence =
        messages[messages.length - 1]?.sequence ?? effectiveAfterSequence?.toString() ?? null;
      const payload = daemonTransportPayload({
        conversationId: conversationIdRaw,
        messages,
        page: {
          limit,
          count: messages.length,
          afterSequence: effectiveAfterSequence?.toString() ?? null,
          beforeSequence: beforeSequence?.toString() ?? null,
          previousBeforeSequence: messages[0]?.sequence ?? null,
          lastSequence,
          nextAfterSequence: lastSequence,
        },
        lastSequence,
        nextAfterSequence: lastSequence,
        ...conversationNextPayload(conversationIdRaw, lastSequence),
      }, daemonResponse);
      if (wantsJson(flags)) {
        writeCommandJson('conversation.messages', payload);
        return;
      }
      for (const message of messages) {
        writeStdout(
          `[${message.sentAt ?? message.sent}] ${message.author ?? message.authorLabel} (${message.kind}): ${message.text}`
        );
      }
      return;
    }

    throw new Error(
      `conversation ${subcommand} is not yet daemon-routed. The agenttalk CLI requires the agenttalkd gateway and will not open a direct SpaceTimeDB connection.`
    );
  }

  const { client } = await connectClient(flags, state, 'direct');

  try {
    if (subcommand === 'list') {
      const conversations = client.listConversations().map(row => ({
        ...toConversationDto(row),
        memberCount: client.listConversationMembers(row.id).length,
      }));

      if (wantsJson(flags)) {
        writeCommandJson('conversation.list', blockedDirectTransportPayload({ ok: true, conversations }));
        return;
      }

      for (const conversation of conversations) {
        writeStdout(
          `${conversation.id}\t${conversation.kind}\tmembers:${conversation.memberCount}\t${conversation.title}\tlast:${conversation.lastActivity}`
        );
      }
      return;
    }

    if (subcommand === 'start') {
      const targetRef = positionals[1] ?? getStringFlag(flags, ['to', 'target']);
      if (!targetRef) {
        throw new Error('conversation start requires <handle-or-identity>');
      }

      const beforeIds = new Set(
        client.listConversations().map(row => row.id.toString())
      );
      const title = getStringFlag(flags, ['title']) ?? '';
      const openingMessage = getStringFlag(flags, ['message']) ?? '';
      const targetIdentity = await resolveAccountIdentity(client, targetRef);

      await client.createDirectConversation(targetIdentity, title, openingMessage);
      await sleep(250);

      const created = findCreatedConversation(client, beforeIds, title || undefined);
      writeCommandJson('conversation.start', blockedDirectTransportPayload({
        ok: true,
        conversation: created ? toConversationDto(created) : null,
        members: created
          ? client.listConversationMembers(created.id).map(toConversationMemberDto)
          : [],
      }));
      return;
    }

    if (subcommand === 'group') {
      const title = getStringFlag(flags, ['title']);
      if (!title) {
        throw new Error('conversation group requires --title <title>');
      }

      const refs = parseAccountRefs(
        getStringFlag(flags, ['members']),
        positionals.slice(1)
      );
      const memberIdentities = await resolveAccountIdentities(client, refs);
      const message = getStringFlag(flags, ['message']) ?? '';
      const createRequestId = await client.createGroupConversation(
        title,
        memberIdentities,
        '',
        makeLocalRequestId('conversation:group:create')
      );
      const receipt = await client.waitForReceipt(
        createRequestId,
        5000,
        'create_group_conversation'
      );
      const created = receipt.conversationId
        ? await waitForConversationById(client, receipt.conversationId)
        : undefined;
      const sendReceipt =
        created && message
          ? await client.waitForReceipt(
              await client.sendConversationMessage(created.id, message, {
                ...parseRichMessageInput(flags),
                clientRequestId: makeLocalRequestId('conversation:group:message'),
              }),
              5000,
              'send_conversation_message'
            )
          : undefined;
      writeCommandJson('conversation.group', blockedDirectTransportPayload({
        ok: true,
        conversation: created ? toConversationDto(created) : null,
        members: created
          ? client.listConversationMembers(created.id).map(toConversationMemberDto)
          : [],
        receipt: toReceiptDto(receipt),
        messageReceipt: sendReceipt ? toReceiptDto(sendReceipt) : null,
      }));
      return;
    }

    if (subcommand === 'add') {
      const conversationIdRaw = positionals[1];
      const accountRef = positionals[2];
      if (!conversationIdRaw || !accountRef) {
        throw new Error('conversation add requires <conversation-id> <handle-or-identity>');
      }

      const conversationId = parseRequiredBigInt(conversationIdRaw, 'conversation-id');
      const role = assertChoice(
        getStringFlag(flags, ['role']) ?? 'member',
        'role',
        ['mod', 'member'] as const
      );
      const memberIdentity = await resolveAccountIdentity(client, accountRef);

      await client.addConversationMember(conversationId, memberIdentity, role);
      await sleep(250);

      writeCommandJson('conversation.add', blockedDirectTransportPayload({
        ok: true,
        conversationId: conversationId.toString(),
        memberIdentity: memberIdentity.toHexString(),
        role,
        members: client
          .listConversationMembers(conversationId)
          .map(toConversationMemberDto),
      }));
      return;
    }

    if (subcommand === 'send') {
      const conversationIdRaw = positionals[1];
      const message = getStringFlag(flags, ['message']);
      if (!conversationIdRaw || !message) {
        throw new Error('conversation send requires <conversation-id> --message <text>');
      }

      const conversationId = parseRequiredBigInt(conversationIdRaw, 'conversation-id');
      const requestId = await client.sendConversationMessage(
        conversationId,
        message,
        parseRichMessageInput(flags)
      );
      const receipt = await client.waitForReceipt(
        requestId,
        5000,
        'send_conversation_message'
      );

      const receiptDto = toReceiptDto(receipt);
      const lastSequence = receiptDto.sequence;
      writeCommandJson('conversation.send', blockedDirectTransportPayload({
        ok: true,
        conversationId: conversationId.toString(),
        text: message,
        receipt: receiptDto,
        lastSequence,
        nextAfterSequence: lastSequence,
        ...conversationNextPayload(conversationId.toString(), lastSequence),
      }));
      return;
    }

    if (subcommand === 'messages') {
      const conversationIdRaw = positionals[1];
      if (!conversationIdRaw) {
        throw new Error('conversation messages requires <conversation-id>');
      }

      const conversationId = parseRequiredBigInt(conversationIdRaw, 'conversation-id');
      const limit = Math.min(getIntFlag(flags, ['limit'], 50), 100);
      const requestedAfterSequence = getBigIntFlag(flags, ['after', 'after-sequence']);
      const beforeSequence = getBigIntFlag(flags, ['before', 'before-sequence']);
      if (requestedAfterSequence && beforeSequence) {
        throw new Error('conversation messages accepts --after or --before, not both');
      }
      const afterSequence = beforeSequence
        ? undefined
        : requestedAfterSequence ?? client.conversationReadSequence(conversationId);
      await client.requestConversationMessages({
        conversationId,
        afterSequence,
        beforeSequence,
        limit: BigInt(limit),
      });
      await sleep(250);
      const messages = client
        .listRequestedConversationMessages(conversationId)
        .map(toConversationMessageDto);
      const readThrough = beforeSequence ? 0n : maxConversationSequence(messages);
      if (readThrough > 0n) {
        await client.markConversationRead(conversationId, readThrough);
      }

      if (wantsJson(flags)) {
        const lastSequence = messages[messages.length - 1]?.sequence ?? afterSequence?.toString() ?? null;
        writeCommandJson('conversation.messages', blockedDirectTransportPayload({
          ok: true,
          conversationId: conversationId.toString(),
          messages,
          page: {
            limit,
            count: messages.length,
            afterSequence: afterSequence?.toString() ?? null,
            beforeSequence: beforeSequence?.toString() ?? null,
            previousBeforeSequence: messages[0]?.sequence ?? null,
            lastSequence,
            nextAfterSequence: lastSequence,
          },
          lastSequence,
          nextAfterSequence: lastSequence,
          ...conversationNextPayload(conversationId.toString(), lastSequence),
        }));
        return;
      }

      for (const message of messages) {
        writeStdout(
          `[${message.sentAt}] ${message.author} (${message.kind}): ${message.text}`
        );
      }
      return;
    }

    if (subcommand === 'leave') {
      const conversationIdRaw = positionals[1];
      if (!conversationIdRaw) {
        throw new Error('conversation leave requires <conversation-id>');
      }

      const conversationId = parseRequiredBigInt(conversationIdRaw, 'conversation-id');
      await client.leaveConversation(conversationId);
      writeCommandJson(
        'conversation.leave',
        blockedDirectTransportPayload({ ok: true, conversationId: conversationId.toString() })
      );
      return;
    }

    throw new Error(`Unknown conversation command: ${subcommand}`);
  } finally {
    client.disconnect();
  }
}

async function commandTask(flags: Flags, positionals: string[], state: AgenttalkState) {
  const subcommand = positionals[0] ?? 'list';
  const { client } = await connectClient(flags, state, 'ops');

  try {
    if (subcommand === 'create') {
      const channelRef = positionals[1];
      const title = getStringFlag(flags, ['title']);
      const description = getStringFlag(flags, ['description', 'message']);
      if (!channelRef || !title || !description) {
        throw new Error(
          'task create requires <channel-id-or-name> --title <title> --description <text>'
        );
      }

      const channelId = await resolveChannelId(client, channelRef);
      const priority = assertChoice(
        getStringFlag(flags, ['priority']) ?? 'normal',
        'priority',
        ['low', 'normal', 'high', 'urgent'] as const
      );
      const assignedToRef = getStringFlag(flags, ['assign', 'assigned-to']);
      const assignedTo = assignedToRef
        ? await resolveAccountIdentity(client, assignedToRef)
        : undefined;
      await client.createTask(
        channelId,
        title,
        description,
        priority,
        assignedTo,
        getStringFlag(flags, ['correlation-id', 'correlationId'])
      );
      await sleep(250);

      const created = client
        .listTasks(channelId)
        .find(row => row.title === title && row.createdBy.toHexString() === client.identityHex);
      writeJson({
        ok: true,
        task: created
          ? toTaskDto(created)
          : { channelId: channelId.toString(), title, description, priority },
      });
      return;
    }

    if (subcommand === 'claim') {
      const taskIdRaw = positionals[1];
      if (!taskIdRaw) {
        throw new Error('task claim requires <task-id>');
      }

      const taskId = parseRequiredBigInt(taskIdRaw, 'task-id');
      await client.claimTask(taskId);
      await sleep(250);
      writeJson({
        ok: true,
        taskId: taskId.toString(),
        task: client.listTasks().find(row => row.id === taskId)
          ? toTaskDto(client.listTasks().find(row => row.id === taskId)!)
          : null,
        claims: client.listTaskClaims(taskId).map(toTaskClaimDto),
      });
      return;
    }

    if (subcommand === 'status') {
      const taskIdRaw = positionals[1];
      const statusRaw = getStringFlag(flags, ['status']) ?? positionals[2];
      if (!taskIdRaw || !statusRaw) {
        throw new Error('task status requires <task-id> --status <status>');
      }

      const status = assertChoice(
        statusRaw,
        'status',
        ['open', 'claimed', 'in_progress', 'blocked', 'done', 'cancelled'] as const
      );
      const taskId = parseRequiredBigInt(taskIdRaw, 'task-id');
      await client.updateTaskStatus(taskId, status);
      await sleep(250);
      const updated = client.listTasks().find(row => row.id === taskId);
      writeJson({
        ok: true,
        taskId: taskId.toString(),
        status,
        task: updated ? toTaskDto(updated) : null,
      });
      return;
    }

    if (subcommand === 'list') {
      const channelRef = positionals[1];
      const channelId = channelRef ? await resolveChannelId(client, channelRef) : undefined;
      const tasks = client.listTasks(channelId).map(task => ({
        ...toTaskDto(task),
        claims: client.listTaskClaims(task.id).map(toTaskClaimDto),
      }));

      if (wantsJson(flags)) {
        writeJson(tasks);
        return;
      }

      for (const task of tasks) {
        writeStdout(
          `${task.id}\tchannel:${task.channelId}\t${task.status}\t${task.priority}\t${task.title}`
        );
      }
      return;
    }

    throw new Error(`Unknown task command: ${subcommand}`);
  } finally {
    client.disconnect();
  }
}

async function commandHandoff(
  flags: Flags,
  positionals: string[],
  state: AgenttalkState
) {
  const subcommand = positionals[0] ?? 'list';
  const { client } = await connectClient(flags, state, 'ops');

  try {
    if (subcommand === 'create') {
      const channelRef = positionals[1];
      const summary = getStringFlag(flags, ['summary', 'message']);
      if (!channelRef || !summary) {
        throw new Error('handoff create requires <channel-id-or-name> --summary <text>');
      }

      const channelId = await resolveChannelId(client, channelRef);
      const toRef = getStringFlag(flags, ['to']);
      await client.createHandoff(
        channelId,
        summary,
        toRef ? await resolveAccountIdentity(client, toRef) : undefined,
        getStringFlag(flags, ['context-json', 'contextJson'])
      );
      await sleep(250);
      const created = client
        .listHandoffs(channelId)
        .find(row => row.summary === summary && row.fromIdentity.toHexString() === client.identityHex);
      writeJson({
        ok: true,
        handoff: created
          ? toHandoffDto(created)
          : { channelId: channelId.toString(), summary },
      });
      return;
    }

    if (subcommand === 'accept') {
      const handoffIdRaw = positionals[1];
      if (!handoffIdRaw) {
        throw new Error('handoff accept requires <handoff-id>');
      }

      const handoffId = parseRequiredBigInt(handoffIdRaw, 'handoff-id');
      await client.acceptHandoff(handoffId);
      await sleep(250);
      const updated = client.listHandoffs().find(row => row.id === handoffId);
      writeJson({
        ok: true,
        handoffId: handoffId.toString(),
        handoff: updated ? toHandoffDto(updated) : null,
      });
      return;
    }

    if (subcommand === 'list') {
      const channelRef = positionals[1];
      const channelId = channelRef ? await resolveChannelId(client, channelRef) : undefined;
      const handoffs = client.listHandoffs(channelId).map(toHandoffDto);

      if (wantsJson(flags)) {
        writeJson(handoffs);
        return;
      }

      for (const handoff of handoffs) {
        writeStdout(
          `${handoff.id}\tchannel:${handoff.channelId}\t${handoff.status}\t${handoff.summary}`
        );
      }
      return;
    }

    throw new Error(`Unknown handoff command: ${subcommand}`);
  } finally {
    client.disconnect();
  }
}

async function commandEvent(flags: Flags, positionals: string[], state: AgenttalkState) {
  const subcommand = positionals[0] ?? 'emit';
  if (subcommand !== 'emit') {
    throw new Error(`Unknown event command: ${subcommand}`);
  }

  const kind = assertChoice(
    getStringFlag(flags, ['kind']) ?? positionals[1],
    'kind',
    ['typing', 'heartbeat', 'mention', 'joined_thread', 'joined_conversation', 'status'] as const
  );

  const { client } = await connectClient(flags, state, 'ops');

  try {
    const channelRef = getStringFlag(flags, ['channel']);
    const channelId = channelRef ? await resolveChannelId(client, channelRef) : undefined;
    const threadRaw = getStringFlag(flags, ['thread-id', 'threadId']);
    const conversationRaw = getStringFlag(flags, ['conversation-id', 'conversationId']);
    const targetRef = getStringFlag(flags, ['target', 'to']);

    await client.emitAgentEvent({
      kind,
      channelId,
      threadId: threadRaw ? parseRequiredBigInt(threadRaw, 'thread-id') : undefined,
      conversationId: conversationRaw
        ? parseRequiredBigInt(conversationRaw, 'conversation-id')
        : undefined,
      targetIdentity: targetRef ? await resolveAccountIdentity(client, targetRef) : undefined,
      text: getStringFlag(flags, ['text', 'message']),
      metadataJson: getStringFlag(flags, ['metadata-json', 'metadataJson']),
    });

    writeJson({
      ok: true,
      kind,
      channelId: channelId?.toString() ?? null,
      threadId: threadRaw ?? null,
      conversationId: conversationRaw ?? null,
    });
  } finally {
    client.disconnect();
  }
}

async function commandDoctor(flags: Flags, state: AgenttalkState) {
  const outputJson = wantsJson(flags);
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

  if (!allowDirectCli(flags)) {
    const daemonStatus = await ensureDaemonRunning(flags);
    const whoami = await sendDaemonCommand({ id: 'doctor:whoami', cmd: 'whoami' });
    const stats = await sendDaemonCommand({ id: 'doctor:stats', cmd: 'stats' });
    const data = (whoami.data ?? {}) as Record<string, unknown>;
    identity = typeof data.identity === 'string' ? data.identity : null;
    checks.push({
      name: 'daemon',
      ok: daemonStatus.response?.ok === true,
      detail: `agenttalkd running at ${daemonPipePath()}`,
    });
    checks.push({
      name: 'connect',
      ok: whoami.ok === true,
      detail: identity
        ? `daemon connected to ${config.databaseName} as ${identity.slice(0, 12)}...`
        : 'daemon connected',
    });
    checks.push({
      name: 'identity:account',
      ok: whoami.ok === true,
      detail: data.account
        ? `account @${(data.account as any).handle}`
        : data.needsInit
          ? 'daemon running; account initialization needed'
          : 'no account row visible',
    });
    const result = daemonTransportPayload({
      host: config.host,
      databaseName: config.databaseName,
      tokenProvided: Boolean(config.token),
      identity,
      whoami: data,
      daemonStatus: daemonStatus.response,
      daemonStarted: daemonStatus.started,
      stats: stats.data ?? stats,
      hotRetentionHours: data.hotRetentionHours ?? 12,
      messageStore: 'ephemeral-hot-realtime',
      archiveConfigured: data.archiveConfigured ?? false,
      checks,
    });
    if (outputJson) {
      writeJson(result);
    } else {
      writeStdout(`doctor: ${result.ok ? 'ok' : 'failed'}`);
      writeStdout('hot retention: 12 hours; archiveConfigured=false');
      for (const check of checks) {
        writeStdout(`${check.ok ? 'ok' : 'fail'} ${check.name}: ${check.detail}`);
      }
    }
    if (!checks.every(check => check.ok)) {
      process.exitCode = 1;
    }
    return;
  }

  try {
    const connected = await connectClient(flags, state, 'ops');
    client = connected.client;
    const currentClient = client;
    identity = currentClient.identityHex;
    checks.push({
      name: 'connect',
      ok: true,
      detail: `connected to ${connected.state.databaseName} as ${identity.slice(0, 12)}...`,
    });

    await currentClient.requestChannelDirectory({ limit: 20n });
    await sleep(DIRECTORY_SYNC_DELAY_MS);
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
    transport: 'direct-disabled',
    daemon: false,
    host: config.host,
    databaseName: config.databaseName,
    tokenProvided: Boolean(config.token),
    identity,
    channelCount,
    hotRetentionHours: 12,
    messageStore: 'ephemeral-hot-realtime',
    archiveConfigured: false,
    checks,
  };

  if (outputJson) {
    writeJson(result);
  } else {
    writeStdout(`doctor: ${result.ok ? 'ok' : 'failed'}`);
    writeStdout('hot retention: 12 hours; archiveConfigured=false');
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

async function waitForConversationMessages({
  client,
  conversationId,
  max,
  min = max,
  afterSequence,
  timeoutMs,
  includeOwn = false,
  drainMs = 0,
  ignoreKeys,
}: {
  client: AgentRealtimeClient;
  conversationId?: bigint;
  max: number;
  min?: number;
  afterSequence?: bigint;
  timeoutMs: number;
  includeOwn?: boolean;
  drainMs?: number;
  ignoreKeys?: Set<string>;
}) {
  const messages: ModuleTypes.ConversationMessage[] = [];
  const seen = new Set<string>(ignoreKeys);

  if (timeoutMs <= 0 || max <= 0 || min <= 0) {
    return { messages, timedOut: false };
  }

  return new Promise<{ messages: ModuleTypes.ConversationMessage[]; timedOut: boolean }>(
    resolve => {
      let detach: () => void = () => {};
      let drainTimer: NodeJS.Timeout | undefined;
      const finish = (timedOut: boolean) => {
        clearTimeout(timer);
        if (drainTimer) {
          clearTimeout(drainTimer);
        }
        detach();
        resolve({ messages, timedOut });
      };

      const timer = setTimeout(() => finish(true), timeoutMs);
      const listen = conversationId
        ? client.onConversationMessageInsert.bind(client)
        : client.onUnreadConversationMessageInsert.bind(client);
      detach = listen(row => {
        if (conversationId && row.conversationId !== conversationId) {
          return;
        }
        if (!includeOwn && row.authorIdentity.toHexString() === client.identityHex) {
          return;
        }
        if (afterSequence && (row.sequence ?? row.id) <= afterSequence) {
          return;
        }

        const key = conversationMessageRowKey(row);
        if (seen.has(key)) {
          return;
        }
        seen.add(key);
        messages.push(row);
        if (messages.length >= max) {
          finish(false);
          return;
        }
        if (messages.length >= min && !drainTimer) {
          if (drainMs <= 0) {
            finish(false);
            return;
          }
          drainTimer = setTimeout(() => finish(false), drainMs);
        }
      });
    }
  );
}

async function waitForThreadMessages({
  client,
  threadId,
  max,
  timeoutMs,
  includeOwn = false,
}: {
  client: AgentRealtimeClient;
  threadId: bigint;
  max: number;
  timeoutMs: number;
  includeOwn?: boolean;
}) {
  const messages: ModuleTypes.Message[] = [];

  if (timeoutMs <= 0 || max <= 0) {
    return { messages, timedOut: false };
  }

  return new Promise<{ messages: ModuleTypes.Message[]; timedOut: boolean }>(
    resolve => {
      let detach: () => void = () => {};
      const finish = (timedOut: boolean) => {
        clearTimeout(timer);
        detach();
        resolve({ messages, timedOut });
      };

      const timer = setTimeout(() => finish(true), timeoutMs);
      detach = client.onMessageInsert(row => {
        if (row.threadId !== threadId) {
          return;
        }
        if (
          !includeOwn &&
          row.authorIdentity &&
          row.authorIdentity.toHexString() === client.identityHex
        ) {
          return;
        }

        messages.push(row);
        if (messages.length >= max) {
          finish(false);
        }
      });
    }
  );
}

async function commandSmoke(flags: Flags, state: AgenttalkState) {
  const outputJson = wantsJson(flags);
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

  const { client } = await connectClient(flags, state, 'ops');

  try {
    await client.signUp({ name: smokeName, role: 'agent', bio: 'agenttalk smoke test' });
    steps.push({ name: 'signup', ok: true, detail: `signed up as ${smokeName}` });

    await client.requestChannelDirectory({ name: channelName, limit: 1n });
    await sleep(DIRECTORY_SYNC_DELAY_MS);
    let channel = client.listChannels().find(row => row.name === channelName);
    if (!channel) {
      await client.createChannel(channelName, 'Created by agenttalk smoke');
      await client.requestChannelDirectory({ name: channelName, limit: 1n });
      await sleep(DIRECTORY_SYNC_DELAY_MS);
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

  const { client, state: resolvedState } = await connectClient(
    flags,
    state,
    'rooms'
  );
  await client.watchThread(threadId);

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

async function resolveCommandChannelId(
  client: AgentRealtimeClient,
  payload: Record<string, unknown>
): Promise<bigint> {
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

function wakeData(response: any): Record<string, any> {
  return ((response?.data ?? {}) as Record<string, any>) ?? {};
}

function formatWakeRequest(wake: any) {
  const range =
    wake?.minSequence && wake?.maxSequence
      ? `${wake.minSequence}-${wake.maxSequence}`
      : 'unknown';
  return [
    wake?.wakeId ?? 'unknown',
    wake?.status ?? 'unknown',
    wake?.reason ?? 'unknown',
    `conversation=${wake?.conversationId ?? 'unknown'}`,
    `seq=${range}`,
    `attempts=${wake?.attemptCount ?? '0'}`,
  ].join('\t');
}

function latestWakeAttempt(data: Record<string, any>) {
  const attempts = Array.isArray(data.attempts) ? data.attempts : [];
  return attempts
    .filter(attempt => attempt?.attemptId)
    .sort((left, right) => {
      const leftNumber = BigInt(String(left.attemptNumber ?? '0'));
      const rightNumber = BigInt(String(right.attemptNumber ?? '0'));
      return leftNumber < rightNumber ? 1 : leftNumber > rightNumber ? -1 : 0;
    })[0];
}

function wakeExecEnvironment(data: Record<string, any>, flags: Flags) {
  const wake = (data.wake ?? {}) as Record<string, any>;
  const attempt = latestWakeAttempt(data) ?? {};
  const state = loadStateSync();
  const conversationId = String(wake.conversationId ?? '');
  const minSequence = String(wake.minSequence ?? '');
  const maxSequence = String(wake.maxSequence ?? '');
  const reason = String(wake.reason ?? '');
  const payload = {
    wake,
    attempts: Array.isArray(data.attempts) ? data.attempts : [],
    context: Array.isArray(data.context) ? data.context : [],
  };
  return {
    AGENTTALK_WAKE_ID: String(wake.wakeId ?? ''),
    AGENTTALK_WAKE_ATTEMPT_ID: String(attempt.attemptId ?? ''),
    AGENTTALK_WAKE_CONVERSATION_ID: conversationId,
    AGENTTALK_WAKE_MIN_SEQUENCE: minSequence,
    AGENTTALK_WAKE_MAX_SEQUENCE: maxSequence,
    AGENTTALK_WAKE_REASON: reason,
    AGENTTALK_CONVERSATION_ID: conversationId,
    AGENTTALK_MIN_SEQUENCE: minSequence,
    AGENTTALK_MAX_SEQUENCE: maxSequence,
    AGENTTALK_REASON: reason,
    AGENTTALK_WAKE_PRIORITY: String(wake.priority ?? ''),
    AGENTTALK_WAKE_STATUS: String(wake.status ?? ''),
    AGENTTALK_WAKE_SENDER_AGENT_ID: String(wake.senderAgentId ?? ''),
    AGENTTALK_WAKE_RECIPIENT_AGENT_ID: String(wake.recipientAgentId ?? ''),
    AGENTTALK_STATE_DIR: STATE_DIR,
    AGENTTALK_HOST: getStringFlag(flags, ['host']) ?? state.host ?? DEFAULT_HOST,
    AGENTTALK_DB: getStringFlag(flags, ['db']) ?? state.databaseName ?? DEFAULT_DB,
    AGENTTALK_WAKE_PAYLOAD_JSON: JSON.stringify(payload),
    AGENTTALK_WAKE_CONTEXT_JSON: JSON.stringify(payload.context),
  };
}

type WakeExecResult = {
  command: string;
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  stdout?: string;
  stderr?: string;
  error?: string;
};

function appendLimited(current: string, chunk: Buffer, limit = 16384) {
  const next = current + chunk.toString();
  return next.length > limit ? next.slice(next.length - limit) : next;
}

function runWakeExecCommand(
  command: string,
  data: Record<string, any>,
  flags: Flags,
  routeStdoutToStderr: boolean
): Promise<WakeExecResult> {
  const started = Date.now();
  const env = {
    ...process.env,
    ...wakeExecEnvironment(data, flags),
  };
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (result: Omit<WakeExecResult, 'command' | 'durationMs'>) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        command,
        durationMs: Date.now() - started,
        stdout: stdout || undefined,
        stderr: stderr || undefined,
        ...result,
      });
    };

    const child = spawn(command, {
      shell: true,
      windowsHide: true,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', chunk => {
      stdout = appendLimited(stdout, chunk);
      writeSync(routeStdoutToStderr ? 2 : 1, chunk);
    });
    child.stderr?.on('data', chunk => {
      stderr = appendLimited(stderr, chunk);
      writeSync(2, chunk);
    });
    child.on('error', error => {
      settle({
        ok: false,
        exitCode: null,
        signal: null,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    child.on('close', (exitCode, signal) => {
      settle({
        ok: exitCode === 0,
        exitCode,
        signal,
      });
    });
  });
}

function wakeExecFailureMessage(result: WakeExecResult) {
  if (result.error) {
    return result.error;
  }
  if (result.signal) {
    return `wake exec terminated by ${result.signal}`;
  }
  return `wake exec exited with code ${result.exitCode ?? 'unknown'}`;
}

async function completeWakeExec(
  flags: Flags,
  data: Record<string, any>,
  result: WakeExecResult
) {
  const wakeId = data.wake?.wakeId;
  if (!wakeId) {
    throw new Error('wake listen --exec could not find wakeId to ack/fail');
  }
  const attemptId = latestWakeAttempt(data)?.attemptId;
  if (result.ok) {
    await sendRequiredDaemonCommand(flags, {
      id: 'wake:exec:ack',
      cmd: 'ack_wake',
      wakeId,
      attemptId,
    });
    return { action: 'ack', ok: true, wakeId, attemptId };
  }

  await sendRequiredDaemonCommand(flags, {
    id: 'wake:exec:fail',
    cmd: 'fail_wake',
    wakeId,
    attemptId,
    error: wakeExecFailureMessage(result),
  });
  return { action: 'fail', ok: true, wakeId, attemptId };
}

function printWakeStatus(data: Record<string, any>) {
  const profile = data.profile;
  if (profile) {
    writeStdout(
      `wake profile: ${profile.agentId} ${profile.wakeable ? 'wakeable' : 'not-wakeable'} availability=${profile.availability} latency=${profile.expectedWakeLatencyMs ?? 'unknown'}ms`
    );
    if (profile.statusText) {
      writeStdout(`status: ${profile.statusText}`);
    }
  } else {
    writeStdout('wake profile: unavailable; create an agent account first');
  }

  const registrations = Array.isArray(data.registrations) ? data.registrations : [];
  writeStdout(`registrations: ${registrations.length}`);
  for (const registration of registrations) {
    const endpoint = registration.endpointRef
      ? ` endpoint=${registration.endpointRef}`
      : registration.endpointRefRedacted
        ? ' endpoint=<redacted>'
        : '';
    writeStdout(
      `  ${registration.registrationId} ${registration.kind} ${registration.enabled ? 'enabled' : 'disabled'}${endpoint}`
    );
  }

  const policy = data.policy;
  if (policy) {
    writeStdout(
      `policy: direct=${policy.wakeOnDirectMessage} mention=${policy.wakeOnMention} group=${policy.wakeOnGroupMessage} handoff=${policy.wakeOnHandoff} business=${policy.wakeOnBusinessInquiry} acceptsNew=${policy.acceptsNewConversations}`
    );
  }

  const requests = Array.isArray(data.requests) ? data.requests : [];
  writeStdout(`wake requests: ${requests.length}`);
}

function wakeSenderAgentIdsJsonFlag(flags: Flags, keys: string[], field: string) {
  const raw = getStringFlag(flags, keys);
  return raw === undefined ? undefined : JSON.stringify(normalizeWakeSenderAgentIds(raw, field));
}

function getWakeAccessModeFlag(flags: Flags) {
  const raw = getStringFlag(flags, [
    'wake-access',
    'wake-access-mode',
    'access-mode',
    'wakeAccess',
    'wakeAccessMode',
  ]);
  if (raw !== undefined) {
    return normalizeWakeAccessMode(raw);
  }
  if (getBooleanFlag(flags, ['open-wake', 'openWake'])) {
    return 'open' as const;
  }
  if (getBooleanFlag(flags, ['allow-list-wake', 'allowlist-wake', 'allowListWake'])) {
    return 'allow_list' as const;
  }
  return undefined;
}

function hasOpenWakeConfirmation(flags: Flags) {
  return getBooleanFlag(flags, [
    'i-understand-open-wake-risk',
    'confirm-open-wake',
    'yes-open-wake',
    'openWakeRiskAccepted',
  ]);
}

function requireOpenWakeConfirmation(flags: Flags) {
  if (!hasOpenWakeConfirmation(flags)) {
    throw new Error(
      `${OPEN_WAKE_WARNING}\nRe-run with --i-understand-open-wake-risk to confirm open wake mode.`
    );
  }
  writeStderr(`[warn] ${OPEN_WAKE_WARNING}`);
}

function currentRuntimeControlProfile() {
  const raw = process.env.AGENTTALK_CONTROL_PROFILE ?? process.env.AGENTTALK_PROFILE;
  return raw ? normalizeControlProfile(raw) : undefined;
}

function requireWakeAdminAllowed(action: string) {
  if (currentRuntimeControlProfile() === 'plugin_managed') {
    throw new Error(
      `${action} denied: plugin-managed AgentTalk runtimes cannot mutate wake/admin state directly. Use the host plugin GUI or supervisor admin surface.`
    );
  }
}

function allowedWakeSenderJsonFromFlags(flags: Flags, options: { defaultAllowList?: boolean } = {}) {
  const requestedMode = getWakeAccessModeFlag(flags);
  const rawJson = getStringFlag(flags, ['allowed-senders-json', 'allowedWakeSenderAgentIdsJson']);
  const listJson = wakeSenderAgentIdsJsonFlag(
    flags,
    ['allow-senders', 'allowed-senders', 'allowed-wake-senders', 'allow-wake-from'],
    'Allowed wake senders'
  );

  if (requestedMode === 'open') {
    requireOpenWakeConfirmation(flags);
    return '';
  }
  if (requestedMode === 'allow_list') {
    return rawJson && rawJson.trim() ? rawJson : listJson ?? '[]';
  }
  if (rawJson !== undefined && !rawJson.trim()) {
    requireOpenWakeConfirmation(flags);
    return '';
  }
  return rawJson ?? listJson ?? (options.defaultAllowList ? '[]' : undefined);
}

function wakePolicyPayloadFromFlags(flags: Flags, options: { defaultAllowList?: boolean } = {}) {
  return {
    wakeOnDirectMessage: getOptionalBooleanFlag(flags, ['direct', 'wake-on-direct']),
    wakeOnMention: getOptionalBooleanFlag(flags, ['mention', 'wake-on-mention']),
    wakeOnGroupMessage: getOptionalBooleanFlag(flags, ['group', 'wake-on-group']),
    wakeOnHandoff: getOptionalBooleanFlag(flags, ['handoff', 'wake-on-handoff']),
    wakeOnBusinessInquiry: getOptionalBooleanFlag(flags, ['business', 'wake-on-business']),
    acceptsNewConversations: getOptionalBooleanFlag(flags, [
      'accepts-new',
      'accepts-new-conversations',
    ]),
    minWakeIntervalMs: getBigIntFlag(flags, ['min-interval-ms', 'minWakeIntervalMs'])?.toString(),
    coalesceWindowMs: getBigIntFlag(flags, ['coalesce-ms', 'coalesceWindowMs'])?.toString(),
    maxWakesPerMinute: getBigIntFlag(flags, ['max-per-minute', 'maxWakesPerMinute'])?.toString(),
    maxConcurrentWakeJobs: getBigIntFlag(flags, [
      'max-concurrent',
      'maxConcurrentWakeJobs',
    ])?.toString(),
    expectedWakeLatencyMs: getBigIntFlag(flags, [
      'latency-ms',
      'expected-latency-ms',
      'expectedWakeLatencyMs',
    ])?.toString(),
    availabilityOverride: getStringFlag(flags, ['availability', 'availabilityOverride']),
    statusText: getStringFlag(flags, ['status-text', 'statusText']),
    allowedWakeSenderAgentIdsJson: allowedWakeSenderJsonFromFlags(flags, options),
    blockedWakeSenderAgentIdsJson:
      getStringFlag(flags, ['blocked-senders-json', 'blockedWakeSenderAgentIdsJson']) ??
      wakeSenderAgentIdsJsonFlag(
        flags,
        ['block-senders', 'blocked-senders', 'blocked-wake-senders', 'block-wake-from'],
        'Blocked wake senders'
      ),
  };
}

async function commandWake(flags: Flags, positionals: string[]) {
  const subcommand = positionals[0] ?? 'status';
  const outputJson = wantsJson(flags);
  const outputJsonl = getBooleanFlag(flags, ['jsonl']);

  if (subcommand === 'status' || subcommand === 'list') {
    const response = await sendRequiredDaemonCommand(flags, {
      id: 'wake:status',
      cmd: 'wake_status',
      showPrivate: getBooleanFlag(flags, ['private', 'show-private']),
      status: getStringFlag(flags, ['status']),
      conversationId: getStringFlag(flags, ['conversation', 'conversation-id']),
      wakeId: getStringFlag(flags, ['wake-id', 'wakeId']) ?? positionals[1],
    });
    const data = wakeData(response);
    if (outputJson) {
      writeJson(daemonTransportPayload(data, response));
      return;
    }
    printWakeStatus(data);
    return;
  }

  if (subcommand === 'on' || subcommand === 'enable') {
    requireWakeAdminAllowed('wake:on');
    const policyFlags = wakePolicyPayloadFromFlags(flags, { defaultAllowList: true });
    await sendRequiredDaemonCommand(flags, {
      id: 'wake:register-local',
      cmd: 'register_wake',
      kind: getStringFlag(flags, ['kind']) ?? 'local_daemon',
      endpointRef: getStringFlag(flags, ['endpoint-ref', 'endpointRef']) ?? `ipc:${daemonPipePath()}`,
      enabled: true,
      metadataJson:
        getStringFlag(flags, ['metadata-json', 'metadataJson']) ??
        JSON.stringify({ source: 'agenttalk-cli', stateDir: STATE_DIR }),
    });
    const response = await sendRequiredDaemonCommand(flags, {
      id: 'wake:on',
      cmd: 'set_wake_policy',
      ...policyFlags,
      wakeOnDirectMessage: policyFlags.wakeOnDirectMessage ?? true,
      wakeOnMention: policyFlags.wakeOnMention ?? true,
      wakeOnGroupMessage: policyFlags.wakeOnGroupMessage ?? false,
      wakeOnHandoff: policyFlags.wakeOnHandoff ?? false,
      wakeOnBusinessInquiry: policyFlags.wakeOnBusinessInquiry ?? false,
      acceptsNewConversations: policyFlags.acceptsNewConversations ?? true,
      availabilityOverride: policyFlags.availabilityOverride ?? 'wakeable',
    });
    const data = wakeData(response);
    if (outputJson) {
      writeJson(daemonTransportPayload(data, response));
      return;
    }
    printWakeStatus(data);
    return;
  }

  if (subcommand === 'off' || subcommand === 'disable') {
    requireWakeAdminAllowed('wake:off');
    const response = await sendRequiredDaemonCommand(flags, {
      id: 'wake:off',
      cmd: 'set_wake_policy',
      wakeOnDirectMessage: false,
      wakeOnMention: false,
      wakeOnGroupMessage: false,
      wakeOnHandoff: false,
      wakeOnBusinessInquiry: false,
      acceptsNewConversations: false,
      availabilityOverride: getStringFlag(flags, ['availability']) ?? 'offline',
      statusText: getStringFlag(flags, ['status-text', 'statusText']) ?? 'Wake disabled',
    });
    const data = wakeData(response);
    if (outputJson) {
      writeJson(daemonTransportPayload(data, response));
      return;
    }
    printWakeStatus(data);
    return;
  }

  if (subcommand === 'register') {
    requireWakeAdminAllowed('wake:register');
    const kind = assertChoice(
      getStringFlag(flags, ['kind']) ?? positionals[1] ?? 'local_daemon',
      'kind',
      ['webhook', 'local_daemon', 'cloud_runner', 'mcp_session', 'push_gateway', 'noop'] as const
    );
    const response = await sendRequiredDaemonCommand(flags, {
      id: 'wake:register',
      cmd: 'register_wake',
      kind,
      endpointRef: getStringFlag(flags, ['endpoint-ref', 'endpointRef']),
      secretHash: getStringFlag(flags, ['secret-hash', 'secretHash']),
      enabled: getOptionalBooleanFlag(flags, ['enabled']) ?? true,
      metadataJson: getStringFlag(flags, ['metadata-json', 'metadataJson']),
      registrationId: getStringFlag(flags, ['registration-id', 'registrationId']),
    });
    const data = wakeData(response);
    if (outputJson) {
      writeJson(daemonTransportPayload(data, response));
      return;
    }
    printWakeStatus(data);
    return;
  }

  if (subcommand === 'unregister' || subcommand === 'disable-registration') {
    requireWakeAdminAllowed('wake:disable-registration');
    const response = await sendRequiredDaemonCommand(flags, {
      id: 'wake:disable-registration',
      cmd: 'disable_wake_registration',
      registrationId:
        getStringFlag(flags, ['registration-id', 'registrationId']) ?? positionals[1],
      kind: getStringFlag(flags, ['kind']),
    });
    const data = wakeData(response);
    if (outputJson) {
      writeJson(daemonTransportPayload(data, response));
      return;
    }
    printWakeStatus(data);
    return;
  }

  if (subcommand === 'policy') {
    const payload = wakePolicyPayloadFromFlags(flags);
    const hasSetting = Object.values(payload).some(value => value !== undefined);
    if (!hasSetting) {
      await commandWake(flags, ['status']);
      return;
    }
    requireWakeAdminAllowed('wake:policy');
    const response = await sendRequiredDaemonCommand(flags, {
      id: 'wake:policy',
      cmd: 'set_wake_policy',
      ...payload,
    });
    const data = wakeData(response);
    if (outputJson) {
      writeJson(daemonTransportPayload(data, response));
      return;
    }
    printWakeStatus(data);
    return;
  }

  if (subcommand === 'reset-policy') {
    requireWakeAdminAllowed('wake:reset-policy');
    const response = await sendRequiredDaemonCommand(flags, {
      id: 'wake:reset-policy',
      cmd: 'reset_wake_policy',
    });
    const data = wakeData(response);
    if (outputJson) {
      writeJson(daemonTransportPayload(data, response));
      return;
    }
    printWakeStatus(data);
    return;
  }

  if (subcommand === 'requests' || subcommand === 'queue') {
    const response = await sendRequiredDaemonCommand(flags, {
      id: 'wake:requests',
      cmd: 'wake_status',
      status: getStringFlag(flags, ['status']),
      conversationId: getStringFlag(flags, ['conversation', 'conversation-id']),
      wakeId: getStringFlag(flags, ['wake-id', 'wakeId']) ?? positionals[1],
      dispatcher: true,
    });
    const data = wakeData(response);
    if (outputJson) {
      writeJson(daemonTransportPayload(data, response));
      return;
    }
    for (const wake of (data.requests ?? []) as any[]) {
      writeStdout(formatWakeRequest(wake));
    }
    return;
  }

  if (subcommand === 'attempts') {
    const response = await sendRequiredDaemonCommand(flags, {
      id: 'wake:attempts',
      cmd: 'wake_status',
      wakeId: getStringFlag(flags, ['wake-id', 'wakeId']) ?? positionals[1],
      dispatcher: true,
    });
    const data = wakeData(response);
    if (outputJson) {
      writeJson(daemonTransportPayload(data, response));
      return;
    }
    for (const attempt of (data.attempts ?? []) as any[]) {
      writeStdout(
        `${attempt.attemptId}\t${attempt.wakeId}\t${attempt.status}\tattempt=${attempt.attemptNumber}\tleaseUntil=${attempt.leaseUntil}`
      );
    }
    return;
  }

  if (subcommand === 'claim') {
    const response = await sendRequiredDaemonCommand(flags, {
      id: 'wake:claim',
      cmd: 'claim_wake',
      wakeId: getStringFlag(flags, ['wake-id', 'wakeId']) ?? positionals[1],
      leaseMs: getBigIntFlag(flags, ['lease-ms', 'leaseMs'])?.toString(),
      registrationId: getStringFlag(flags, ['registration-id', 'registrationId']),
      metadataJson: getStringFlag(flags, ['metadata-json', 'metadataJson']),
    });
    const data = wakeData(response);
    if (outputJson) {
      writeJson(daemonTransportPayload(data, response));
      return;
    }
    for (const wake of (data.requests ?? []) as any[]) {
      writeStdout(formatWakeRequest(wake));
    }
    return;
  }

  if (subcommand === 'listen') {
    const follow = getBooleanFlag(flags, ['follow']);
    const timeoutMs = getDurationFlagMs(flags, ['timeout', 'wait'], 30000);
    const streamJson = outputJsonl || follow || getBooleanFlag(flags, ['agent']);
    const execCommand = getStringFlag(flags, ['exec', 'command']);
    if (flags.exec === true || flags.command === true) {
      throw new Error('wake listen --exec requires a command string');
    }
    do {
      const response = await sendRequiredDaemonCommand(
        flags,
        {
          id: 'wake:listen',
          cmd: 'wait_wake',
          timeoutMs,
          status: getStringFlag(flags, ['status']) ?? 'pending',
          conversationId: getStringFlag(flags, ['conversation', 'conversation-id']),
          claim: !getBooleanFlag(flags, ['no-claim']),
          context: getBooleanFlag(flags, ['context', 'hydrate']),
          leaseMs: getBigIntFlag(flags, ['lease-ms', 'leaseMs'])?.toString(),
          registrationId: getStringFlag(flags, ['registration-id', 'registrationId']),
          metadataJson: getStringFlag(flags, ['metadata-json', 'metadataJson']),
        },
        timeoutMs + 5000,
        true
      );

      if (!response?.ok) {
        const event = { event: 'timeout', ok: false, error: response?.error ?? 'timeout' };
        if (streamJson) {
          emitJsonLine(event);
        } else if (outputJson) {
          writeJson(event);
        } else {
          writeStdout(`wake listen timeout: ${event.error}`);
        }
        if (!follow) {
          return;
        }
        continue;
      }

      const data = wakeData(response);
      let execResult: WakeExecResult | undefined;
      let execCompletion: { action: string; ok: boolean; [key: string]: unknown } | undefined;
      if (!streamJson && !outputJson) {
        writeStdout(formatWakeRequest(data.wake));
        for (const message of (data.context ?? []) as any[]) {
          writeStdout(
            `[${message.conversationId}#${message.sequence}] ${message.author}: ${message.text}`
          );
        }
      }
      if (execCommand) {
        execResult = await runWakeExecCommand(execCommand, data, flags, streamJson || outputJson);
        if (getBooleanFlag(flags, ['no-auto-ack', 'noAutoAck', 'manual-ack'])) {
          execCompletion = {
            action: 'none',
            ok: true,
            reason: 'no-auto-ack',
          };
        } else {
          execCompletion = await completeWakeExec(flags, data, execResult);
        }
        if (!streamJson && !outputJson) {
          writeStdout(
            `wake exec ${execResult.ok ? 'succeeded' : 'failed'}; completion=${execCompletion.action}`
          );
        }
        if (!execResult.ok && !follow) {
          process.exitCode = 1;
        }
      }
      const eventData = execResult
        ? { ...data, exec: execResult, completion: execCompletion }
        : data;
      if (streamJson) {
        emitJsonLine({ event: 'wake', ok: true, ...eventData });
      } else if (outputJson) {
        writeJson(daemonTransportPayload(eventData, response));
      }
    } while (follow);
    return;
  }

  if (subcommand === 'dispatch' || subcommand === 'dispatched') {
    const wakeId = getStringFlag(flags, ['wake-id', 'wakeId']) ?? positionals[1];
    if (!wakeId) {
      throw new Error('wake dispatch requires <wake-id>');
    }
    const response = await sendRequiredDaemonCommand(flags, {
      id: 'wake:dispatch',
      cmd: 'mark_wake_dispatched',
      wakeId,
      attemptId: getStringFlag(flags, ['attempt-id', 'attemptId']),
      metadataJson: getStringFlag(flags, ['metadata-json', 'metadataJson']),
    });
    const data = wakeData(response);
    if (outputJson) {
      writeJson(daemonTransportPayload(data, response));
      return;
    }
    for (const wake of (data.requests ?? []) as any[]) {
      writeStdout(formatWakeRequest(wake));
    }
    return;
  }

  if (subcommand === 'ack') {
    const wakeId = getStringFlag(flags, ['wake-id', 'wakeId']) ?? positionals[1];
    if (!wakeId) {
      throw new Error('wake ack requires <wake-id>');
    }
    const response = await sendRequiredDaemonCommand(flags, {
      id: 'wake:ack',
      cmd: 'ack_wake',
      wakeId,
      attemptId: getStringFlag(flags, ['attempt-id', 'attemptId']),
      metadataJson: getStringFlag(flags, ['metadata-json', 'metadataJson']),
    });
    const data = wakeData(response);
    if (outputJson) {
      writeJson(daemonTransportPayload(data, response));
      return;
    }
    for (const wake of (data.requests ?? []) as any[]) {
      writeStdout(formatWakeRequest(wake));
    }
    return;
  }

  if (subcommand === 'fail') {
    const wakeId = getStringFlag(flags, ['wake-id', 'wakeId']) ?? positionals[1];
    const error = getStringFlag(flags, ['error']) ?? positionals[2];
    if (!wakeId || !error) {
      throw new Error('wake fail requires <wake-id> --error <text>');
    }
    const response = await sendRequiredDaemonCommand(flags, {
      id: 'wake:fail',
      cmd: 'fail_wake',
      wakeId,
      error,
      attemptId: getStringFlag(flags, ['attempt-id', 'attemptId']),
      retryAfterMs: getBigIntFlag(flags, ['retry-after-ms', 'retryAfterMs'])?.toString(),
      metadataJson: getStringFlag(flags, ['metadata-json', 'metadataJson']),
    });
    const data = wakeData(response);
    if (outputJson) {
      writeJson(daemonTransportPayload(data, response));
      return;
    }
    for (const wake of (data.requests ?? []) as any[]) {
      writeStdout(formatWakeRequest(wake));
    }
    return;
  }

  if (subcommand === 'expire') {
    const response = await sendRequiredDaemonCommand(flags, {
      id: 'wake:expire',
      cmd: 'expire_wake_requests',
      limit: getBigIntFlag(flags, ['limit'])?.toString(),
    });
    const data = wakeData(response);
    if (outputJson) {
      writeJson(daemonTransportPayload(data, response));
      return;
    }
    printWakeStatus(data);
    return;
  }

  throw new Error(`Unknown wake command: ${subcommand}`);
}

async function commandRepairAccess(flags: Flags, state: AgenttalkState) {
  const outputJson = wantsJson(flags);
  const { client } = await connectClient(flags, state, 'rooms');

  try {
    await client.repairAccessState();
    await client.requestChannelDirectory({ limit: 20n });
    await sleep(DIRECTORY_SYNC_DELAY_MS);
    const result = {
      ok: true,
      identity: client.identityHex,
      channels: client.listChannels().map(toChannelDto),
    };

    if (outputJson) {
      writeJson(result);
    } else {
      writeStdout(`repair-access: ok (${result.channels.length} visible channels)`);
    }
  } finally {
    client.disconnect();
  }
}

async function commandDaemon(flags: Flags, positionals: string[]) {
  const subcommand = positionals[0] ?? 'status';

  if (subcommand === 'run') {
    const { runAgenttalkd } = await import('./agenttalkd');
    await runAgenttalkd({ stdio: true, ipc: true });
    return;
  }

  if (subcommand === 'start') {
    const result = await startDaemonProcess();
    const payload = {
      ok: true,
      started: result.started,
      endpoint: daemonPipePath(),
      response: result.response,
    };
    if (wantsJson(flags)) {
      writeJson(payload);
      return;
    }
    writeStdout(
      result.started
        ? `agenttalkd started at ${payload.endpoint}`
        : `agenttalkd already running at ${payload.endpoint}`
    );
    return;
  }

  if (subcommand === 'status') {
    const ping = await pingDaemon(1000);
    if (!ping) {
      const payload = { ok: false, running: false, endpoint: daemonPipePath() };
      if (wantsJson(flags)) {
        writeJson(payload);
        return;
      }
      writeStdout(`agenttalkd not running at ${payload.endpoint}`);
      return;
    }
    const stats = await sendDaemonCommand({ id: 'stats', cmd: 'stats' });
    const payload = {
      ok: true,
      running: true,
      endpoint: daemonPipePath(),
      ping,
      stats,
    };
    if (wantsJson(flags)) {
      writeJson(payload);
      return;
    }
    writeStdout(`agenttalkd running at ${payload.endpoint}`);
    writeStdout(`stats: ${JSON.stringify(stats.data ?? stats)}`);
    return;
  }

  if (subcommand === 'stop') {
    const response = await sendDaemonCommand({ id: 'shutdown', cmd: 'shutdown' });
    try {
      await fs.rm(DAEMON_PID_PATH, { force: true });
    } catch {
      // pid cleanup is best effort
    }
    if (wantsJson(flags)) {
      writeJson({ ok: true, response });
      return;
    }
    writeStdout(
      response.ok
        ? 'agenttalkd shutdown requested'
        : `agenttalkd stop failed: ${response.error}`
    );
    return;
  }

  if (subcommand === 'doctor') {
    const ping = await pingDaemon(1000);
    if (!ping) {
      const payload = {
        ok: false,
        running: false,
        endpoint: daemonPipePath(),
        hotRetentionHours: 12,
        archiveConfigured: false,
      };
      if (wantsJson(flags)) {
        writeJson(payload);
        return;
      }
      writeStdout(`agenttalkd not running at ${payload.endpoint}`);
      writeStdout('hot retention: 12 hours; archiveConfigured=false');
      return;
    }
    const whoami = await sendDaemonCommand({ id: 'whoami', cmd: 'whoami' });
    const stats = await sendDaemonCommand({ id: 'stats', cmd: 'stats' });
    const payload = {
      ok: true,
      running: true,
      endpoint: daemonPipePath(),
      whoami: whoami.data ?? whoami,
      stats: stats.data ?? stats,
      hotRetentionHours: 12,
      archiveConfigured: false,
    };
    if (wantsJson(flags)) {
      writeJson(payload);
      return;
    }
    writeStdout(`agenttalkd running at ${payload.endpoint}`);
    writeStdout(`identity: ${(payload.whoami as any).identity ?? 'unknown'}`);
    writeStdout('hot retention: 12 hours; archiveConfigured=false');
    return;
  }

  throw new Error(`Unknown daemon command: ${subcommand}`);
}

async function commandRunJsonl(flags: Flags, state: AgenttalkState) {
  if (!allowDirectCli(flags)) {
    const { runAgenttalkd } = await import('./agenttalkd');
    await runAgenttalkd({ stdio: true, ipc: true });
    return;
  }

  const { client, state: resolvedState } = await connectClient(flags, state, 'ops');

  const subscribedThreads = new Set<string>();

  const send = (
    event: 'ready' | 'ok' | 'error' | 'message' | 'snapshot',
    data: Record<string, unknown>,
    id?: string | number
  ) => {
    emitJsonLine({
      ...(id !== undefined ? { id } : {}),
      event,
      transport: 'direct-disabled',
      daemon: false,
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
      'init',
      'find',
      'chat',
      'reply',
      'inbox',
      'transcript',
      'create_account',
      'bootstrap_operator_account',
      'set_account_type',
      'list_account_entitlements',
      'search_accounts',
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
      'list_conversations',
      'create_direct_conversation',
      'create_group_conversation',
      'add_conversation_member',
      'list_conversation_messages',
      'mark_conversation_read',
      'send_conversation',
      'subscribe_conversation',
      'unsubscribe_conversation',
      'list_tasks',
      'create_task',
      'claim_task',
      'update_task_status',
      'list_handoffs',
      'create_handoff',
      'accept_handoff',
      'emit_event',
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

  const subscribedConversations = new Set<string>();
  const detachConversation = client.onConversationMessageInsert(row => {
    const conversationId = row.conversationId.toString();
    if (!subscribedConversations.has(conversationId)) {
      return;
    }

    send('message', {
      conversationMessage: toConversationMessageDto(row),
    });
    void client.markConversationRead(row.conversationId, row.sequence ?? row.id);
  });

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  const cleanup = () => {
    detach();
    detachConversation();
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

        if (command === 'init') {
          const handle = String(payload.handle ?? '').trim();
          if (!handle) {
            throw new Error('init requires handle');
          }

          const role = payload.role === 'human' ? 'human' : 'agent';
          const displayName = String(payload.display_name ?? payload.displayName ?? handle);
          const bio = String(payload.bio ?? '');
          const normalizedHandle = normalizeAccountRef(handle);
          await client.requestAccountDirectory({ handle: normalizedHandle, limit: 1n });
          await sleep(DIRECTORY_SYNC_DELAY_MS);
          const existingByHandle = client.searchAccounts({ handle: normalizedHandle })[0];
          if (
            existingByHandle &&
            existingByHandle.identity.toHexString() !== client.identityHex
          ) {
            throw new Error(`Account handle is already owned: ${normalizedHandle}`);
          }

          await client.createAccount({ handle: normalizedHandle, displayName, role, bio });
          await client.requestAccountDirectory({ handle: normalizedHandle, limit: 1n });
          await sleep(DIRECTORY_SYNC_DELAY_MS);
          send(
            'ok',
            {
              account:
                client.searchAccounts({ handle: normalizedHandle })[0]
                  ? toAccountDto(client.searchAccounts({ handle: normalizedHandle })[0])
                  : null,
              next: [
                `agenttalk chat @some-agent --message "hello" --json`,
                `agenttalk inbox --wait 30s --json`,
              ],
            },
            id
          );
          return;
        }

        if (command === 'find') {
          const query = String(payload.query ?? payload.handle ?? '').trim();
          if (!query) {
            throw new Error('find requires query or handle');
          }
          const normalized = maybeAccountHandle(query);
          let rows: ModuleTypes.Account[] = [];
          if (normalized) {
            await client.requestAccountDirectory({ handle: normalized, limit: 1n });
            await sleep(DIRECTORY_SYNC_DELAY_MS);
            rows = client.searchAccounts({ handle: normalized });
          }
          if (rows.length === 0) {
            await client.requestAccountDirectory({
              query,
              limit: directoryLimitFromValue(payload.limit),
            });
            await sleep(DIRECTORY_SYNC_DELAY_MS);
            rows = client.searchAccounts({ query });
          }
          send(
            'ok',
            {
              accounts: rows.map(toAccountDto),
            },
            id
          );
          return;
        }

        if (command === 'chat') {
          const target = String(payload.target ?? payload.to ?? '').trim();
          const text = String(payload.text ?? payload.message ?? '').trim();
          if (!target || !text) {
            throw new Error('chat requires target and text');
          }

          const targetIdentity = await resolveAccountIdentity(client, target);
          let conversation = payload.new
            ? undefined
            : findReusableDirectConversation(client, targetIdentity);
          const reused = Boolean(conversation);
          if (!conversation) {
            const beforeIds = new Set(
              client.listConversations().map(row => row.id.toString())
            );
            await client.createDirectConversation(
              targetIdentity,
              typeof payload.title === 'string' ? payload.title : '',
              ''
            );
            await sleep(250);
            conversation = findCreatedConversation(client, beforeIds);
          }
          if (!conversation) {
            throw new Error('Could not resolve conversation');
          }

          await client.sendConversationMessage(conversation.id, text, {
            kind:
              typeof payload.kind === 'string'
                ? assertChoice(payload.kind, 'kind', [
                    'chat',
                    'task',
                    'handoff',
                    'tool_result',
                    'approval_request',
                    'status',
                    'system',
                  ] as const)
                : undefined,
            metadataJson:
              typeof payload.metadata_json === 'string' ? payload.metadata_json : undefined,
            correlationId:
              typeof payload.correlation_id === 'string' ? payload.correlation_id : undefined,
          });
          if (payload.emit_event === true || payload.mention_event === true) {
            await client.emitAgentEvent({
              kind: 'mention',
              conversationId: conversation.id,
              targetIdentity,
              text,
            });
          }
          send(
            'ok',
            {
              reused,
              conversation: toConversationDto(conversation),
              next: conversationNextCommands(conversation.id.toString()),
            },
            id
          );
          return;
        }

        if (command === 'reply') {
          const conversationIdRaw = payload.conversation_id ?? payload.conversationId;
          const text = String(payload.text ?? payload.message ?? '').trim();
          if (conversationIdRaw === undefined || !text) {
            throw new Error('reply requires conversation_id and text');
          }

          const conversationId = parseRequiredBigInt(
            String(conversationIdRaw),
            'conversation_id'
          );
          const requestId = await client.sendConversationMessage(conversationId, text, {
            kind:
              typeof payload.kind === 'string'
                ? assertChoice(payload.kind, 'kind', [
                    'chat',
                    'task',
                    'handoff',
                    'tool_result',
                    'approval_request',
                    'status',
                    'system',
                  ] as const)
                : undefined,
          });
          send(
            'ok',
            {
              conversationId: conversationId.toString(),
              next: conversationNextCommands(conversationId.toString()),
            },
            id
          );
          return;
        }

        if (command === 'inbox') {
          const max =
            Number.isInteger(payload.max) && Number(payload.max) > 0
              ? Number(payload.max)
              : 10;
          const messages = recentConversationMessages(client, max);
          for (const conversationId of new Set(messages.map(message => message.conversationId))) {
            const conversationMax = maxConversationSequence(
              messages.filter(message => message.conversationId === conversationId)
            );
            if (conversationMax > 0n) {
              await client.markConversationRead(BigInt(conversationId), conversationMax);
            }
          }
          send('ok', { messages }, id);
          return;
        }

        if (command === 'transcript') {
          const conversationIdRaw = payload.conversation_id ?? payload.conversationId;
          const threadIdRaw = payload.thread_id ?? payload.threadId;
          const limit =
            Number.isInteger(payload.limit) && Number(payload.limit) > 0
              ? Math.min(Number(payload.limit), 100)
              : 50;
          if (conversationIdRaw !== undefined) {
            const conversationId = parseRequiredBigInt(
              String(conversationIdRaw),
              'conversation_id'
            );
            const afterSequence =
              payload.after_sequence !== undefined || payload.after !== undefined
                ? parseRequiredBigInt(
                    String(payload.after_sequence ?? payload.after),
                    'after_sequence'
                  )
                : undefined;
            const beforeSequence =
              payload.before_sequence !== undefined || payload.before !== undefined
                ? parseRequiredBigInt(
                    String(payload.before_sequence ?? payload.before),
                    'before_sequence'
                  )
                : undefined;
            if (afterSequence && beforeSequence) {
              throw new Error('transcript accepts after_sequence or before_sequence, not both');
            }
            const conversation = client
              .listConversations()
              .find(row => row.id === conversationId);
            await client.requestConversationMessages({
              conversationId,
              afterSequence,
              beforeSequence,
              limit: BigInt(limit),
            });
            await sleep(250);
            const messages = client
              .listRequestedConversationMessages(conversationId)
              .map(toConversationMessageDto);
            send(
              'ok',
              {
                conversation: conversation ? toConversationDto(conversation) : null,
                messages,
                page: {
                  limit,
                  count: messages.length,
                  afterSequence: afterSequence?.toString() ?? null,
                  beforeSequence: beforeSequence?.toString() ?? null,
                  previousBeforeSequence: messages[0]?.sequence ?? null,
                  nextAfterSequence: messages[messages.length - 1]?.sequence ?? null,
                },
              },
              id
            );
            return;
          }
          if (threadIdRaw !== undefined) {
            const threadId = parseRequiredBigInt(String(threadIdRaw), 'thread_id');
            await client.watchThread(threadId);
            const afterId =
              payload.after_id !== undefined
                ? parseRequiredBigInt(String(payload.after_id), 'after_id')
                : undefined;
            const beforeId =
              payload.before_id !== undefined
                ? parseRequiredBigInt(String(payload.before_id), 'before_id')
                : undefined;
            if (afterId && beforeId) {
              throw new Error('thread transcript accepts after_id or before_id, not both');
            }
            const messages = client
              .listMessages(threadId)
              .filter(row => (afterId ? row.id > afterId : true))
              .filter(row => (beforeId ? row.id < beforeId : true));
            const pageRows = beforeId ? messages.slice(-limit) : messages.slice(0, limit);
            const page = pageRows.map(toMessageDto);
            send(
              'ok',
              {
                threadId: threadId.toString(),
                messages: page,
                page: {
                  limit,
                  count: page.length,
                  afterId: afterId?.toString() ?? null,
                  beforeId: beforeId?.toString() ?? null,
                  previousBeforeId: page[0]?.id ?? null,
                  nextAfterId: page[page.length - 1]?.id ?? null,
                },
              },
              id
            );
            return;
          }
          throw new Error('transcript requires conversation_id or thread_id');
        }

        if (command === 'create_account') {
          const handle = String(payload.handle ?? '').trim();
          if (!handle) {
            throw new Error('create_account requires handle');
          }

          const role = payload.role === 'human' ? 'human' : 'agent';
          const displayName = String(payload.display_name ?? payload.displayName ?? handle);
          const bio = String(payload.bio ?? '');
          await client.createAccount({ handle, displayName, role, bio });
          const normalizedHandle = normalizeAccountRef(handle);
          await client.requestAccountDirectory({ handle: normalizedHandle, limit: 1n });
          await sleep(DIRECTORY_SYNC_DELAY_MS);

          send(
            'ok',
            {
              account:
                client.searchAccounts({ handle: normalizedHandle })[0]
                  ? toAccountDto(
                      client.searchAccounts({ handle: normalizedHandle })[0]
                    )
                  : null,
            },
            id
          );
          return;
        }

        if (command === 'bootstrap_operator_account') {
          await client.bootstrapOperatorAccount();
          await sleep(250);
          send(
            'ok',
            {
              entitlement: client.currentAccountEntitlement()
                ? toAccountEntitlementDto(client.currentAccountEntitlement()!)
                : null,
            },
            id
          );
          return;
        }

        if (command === 'set_account_type') {
          const handle = String(payload.handle ?? '').trim();
          const typeRaw = String(payload.account_type ?? payload.accountType ?? payload.type ?? '').trim();
          if (!handle || !typeRaw) {
            throw new Error('set_account_type requires handle and account_type');
          }
          const accountType: AccountType = assertChoice(
            typeRaw,
            'account_type',
            ['free', 'group', 'pro', 'operator'] as const
          );
          const groupChatAllowed =
            typeof payload.group_chat_allowed === 'boolean'
              ? payload.group_chat_allowed
              : typeof payload.groupChatAllowed === 'boolean'
                ? payload.groupChatAllowed
                : accountType === 'group' || accountType === 'pro' || accountType === 'operator';
          await client.setAccountType({
            handle: normalizeAccountRef(handle),
            accountType,
            groupChatAllowed,
          });
          await sleep(250);
          send(
            'ok',
            {
              entitlement:
                client
                  .listAccountEntitlements()
                  .find(row => row.handle === normalizeAccountRef(handle))
                  ? toAccountEntitlementDto(
                      client
                        .listAccountEntitlements()
                        .find(row => row.handle === normalizeAccountRef(handle))!
                    )
                  : null,
            },
            id
          );
          return;
        }

        if (command === 'list_account_entitlements') {
          send(
            'ok',
            {
              entitlements: client.listAccountEntitlements().map(toAccountEntitlementDto),
            },
            id
          );
          return;
        }

        if (command === 'search_accounts') {
          const role =
            payload.role === 'agent' || payload.role === 'human'
              ? payload.role
              : undefined;
          const online =
            typeof payload.online === 'boolean' ? payload.online : undefined;
          const handle =
            typeof payload.handle === 'string'
              ? normalizeAccountRef(payload.handle)
              : undefined;
          await client.requestAccountDirectory({
            query: typeof payload.query === 'string' ? payload.query : undefined,
            handle,
            role,
            online,
            limit: directoryLimitFromValue(payload.limit),
          });
          await sleep(DIRECTORY_SYNC_DELAY_MS);
          send(
            'ok',
            {
              accounts: client
                .searchAccounts({
                  query: typeof payload.query === 'string' ? payload.query : undefined,
                  handle,
                  role,
                  online,
                })
                .map(toAccountDto),
            },
            id
          );
          return;
        }

        if (command === 'list_channels') {
          await client.requestChannelDirectory({
            query: typeof payload.query === 'string' ? payload.query : undefined,
            name:
              typeof payload.name === 'string'
                ? normalizeChannelRef(payload.name).trim().toLowerCase()
                : undefined,
            limit: directoryLimitFromValue(payload.limit),
          });
          await sleep(DIRECTORY_SYNC_DELAY_MS);
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

          const roomOptions: RoomOptions = {
            visibility:
              payload.visibility === 'public' || payload.visibility === 'private'
                ? payload.visibility
                : undefined,
            joinPolicy:
              payload.join_policy === 'open' ||
              payload.join_policy === 'password' ||
              payload.join_policy === 'invite'
                ? payload.join_policy
                : undefined,
            password:
              typeof payload.password === 'string' ? payload.password : undefined,
          };

          if (roomOptions.visibility || roomOptions.joinPolicy || roomOptions.password) {
            await client.createRoom(name, topic, roomOptions);
          } else {
            await client.createChannel(name, topic);
          }
          const normalizedName = normalizeChannelRef(name).trim().toLowerCase();
          await client.requestChannelDirectory({ name: normalizedName, limit: 1n });
          await sleep(DIRECTORY_SYNC_DELAY_MS);
          const created = client.listChannels().find(row => row.name === normalizedName);

          send(
            'ok',
            {
              channel: created ? toChannelDto(created) : { id: null, name, topic },
              room: created
                ? client.listRoomConfigs().find(row => row.channelId === created.id)
                  ? toRoomConfigDto(
                      client.listRoomConfigs().find(row => row.channelId === created.id)!
                    )
                  : null
                : null,
            },
            id
          );
          return;
        }

        if (command === 'join_channel') {
          const channelId = await resolveCommandChannelId(client, payload);
          await client.joinChannel(
            channelId,
            typeof payload.password === 'string' ? payload.password : undefined
          );
          send('ok', { channelId: channelId.toString() }, id);
          return;
        }

        if (command === 'leave_channel') {
          const channelId = await resolveCommandChannelId(client, payload);
          await client.leaveChannel(channelId);
          send('ok', { channelId: channelId.toString() }, id);
          return;
        }

        if (command === 'list_threads') {
          const channelId =
            payload.channel_id !== undefined || payload.channel !== undefined
              ? await resolveCommandChannelId(client, payload)
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
          const channelId = await resolveCommandChannelId(client, payload);
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
          await client.watchThread(threadId);

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
          await client.watchThread(threadId);
          await client.sendThreadMessage(threadId, text, {
            kind:
              typeof payload.kind === 'string'
                ? assertChoice(payload.kind, 'kind', [
                    'chat',
                    'task',
                    'handoff',
                    'tool_result',
                    'approval_request',
                    'status',
                    'system',
                  ] as const)
                : undefined,
            replyToMessageId:
              payload.reply_to_message_id !== undefined
                ? parseRequiredBigInt(String(payload.reply_to_message_id), 'reply_to_message_id')
                : undefined,
            correlationId:
              typeof payload.correlation_id === 'string' ? payload.correlation_id : undefined,
            metadataJson:
              typeof payload.metadata_json === 'string' ? payload.metadata_json : undefined,
            artifactUrl:
              typeof payload.artifact_url === 'string' ? payload.artifact_url : undefined,
            artifactMimeType:
              typeof payload.artifact_mime_type === 'string'
                ? payload.artifact_mime_type
                : undefined,
            clientRequestId:
              typeof payload.client_request_id === 'string'
                ? payload.client_request_id
                : undefined,
          });

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

          await client.watchThread(threadId);
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

          await client.unwatchThread(threadId);
          subscribedThreads.delete(threadIdText);
          send('ok', { threadId: threadIdText, subscribed: false }, id);
          return;
        }

        if (command === 'list_conversations') {
          send(
            'ok',
            {
              conversations: client.listConversations().map(toConversationDto),
            },
            id
          );
          return;
        }

        if (command === 'create_direct_conversation') {
          const target = String(payload.target ?? payload.to ?? '').trim();
          if (!target) {
            throw new Error('create_direct_conversation requires target');
          }

          const beforeIds = new Set(
            client.listConversations().map(row => row.id.toString())
          );
          const title = String(payload.title ?? '');
          await client.createDirectConversation(
            await resolveAccountIdentity(client, target),
            title,
            String(payload.opening_message ?? payload.message ?? '')
          );
          await sleep(250);
          const created = findCreatedConversation(client, beforeIds, title || undefined);
          send(
            'ok',
            {
              conversation: created ? toConversationDto(created) : null,
              members: created
                ? client.listConversationMembers(created.id).map(toConversationMemberDto)
                : [],
            },
            id
          );
          return;
        }

        if (command === 'create_group_conversation') {
          const title = String(payload.title ?? '').trim();
          if (!title) {
            throw new Error('create_group_conversation requires title');
          }

          const memberRefs = Array.isArray(payload.members)
            ? payload.members.map(String)
            : parseAccountRefs(
                typeof payload.members === 'string' ? payload.members : undefined
              );
          const openingMessage = String(payload.opening_message ?? payload.message ?? '');
          const createRequestId = await client.createGroupConversation(
            title,
            await resolveAccountIdentities(client, memberRefs),
            '',
            typeof payload.client_request_id === 'string'
              ? payload.client_request_id
              : typeof payload.clientRequestId === 'string'
                ? payload.clientRequestId
                : makeLocalRequestId('jsonl:group:create')
          );
          const receipt = await client.waitForReceipt(
            createRequestId,
            5000,
            'create_group_conversation'
          );
          const created = receipt.conversationId
            ? await waitForConversationById(client, receipt.conversationId)
            : undefined;
          const messageReceipt =
            created && openingMessage.trim()
              ? await client.waitForReceipt(
                  await client.sendConversationMessage(created.id, openingMessage, {
                    clientRequestId: makeLocalRequestId('jsonl:group:message'),
                  }),
                  5000,
                  'send_conversation_message'
                )
              : undefined;
          send(
            'ok',
            {
              conversation: created ? toConversationDto(created) : null,
              members: created
                ? client.listConversationMembers(created.id).map(toConversationMemberDto)
                : [],
              receipt: toReceiptDto(receipt),
              messageReceipt: messageReceipt ? toReceiptDto(messageReceipt) : null,
            },
            id
          );
          return;
        }

        if (command === 'add_conversation_member') {
          const conversationIdRaw = payload.conversation_id;
          const memberRef = String(payload.member ?? payload.account ?? '').trim();
          if (conversationIdRaw === undefined || !memberRef) {
            throw new Error('add_conversation_member requires conversation_id and member');
          }

          const conversationId = parseRequiredBigInt(
            String(conversationIdRaw),
            'conversation_id'
          );
          const role =
            payload.role === 'mod' || payload.role === 'member'
              ? payload.role
              : 'member';
          await client.addConversationMember(
            conversationId,
            await resolveAccountIdentity(client, memberRef),
            role
          );
          await sleep(250);
          send(
            'ok',
            {
              conversationId: conversationId.toString(),
              members: client
                .listConversationMembers(conversationId)
                .map(toConversationMemberDto),
            },
            id
          );
          return;
        }

        if (command === 'list_conversation_messages') {
          const conversationIdRaw = payload.conversation_id;
          if (conversationIdRaw === undefined) {
            throw new Error('list_conversation_messages requires conversation_id');
          }

          const conversationId = parseRequiredBigInt(
            String(conversationIdRaw),
            'conversation_id'
          );
          const limit =
            Number.isInteger(payload.limit) && Number(payload.limit) > 0
              ? Math.min(Number(payload.limit), 100)
              : 50;
          const requestedAfter =
            payload.after_sequence !== undefined || payload.after !== undefined
              ? parseRequiredBigInt(
                  String(payload.after_sequence ?? payload.after),
                  'after_sequence'
                )
              : undefined;
          const beforeSequence =
            payload.before_sequence !== undefined || payload.before !== undefined
              ? parseRequiredBigInt(
                  String(payload.before_sequence ?? payload.before),
                  'before_sequence'
                )
              : undefined;
          if (requestedAfter && beforeSequence) {
            throw new Error('list_conversation_messages accepts after_sequence or before_sequence, not both');
          }
          const afterSequence = beforeSequence
            ? undefined
            : requestedAfter ?? client.conversationReadSequence(conversationId);
          await client.requestConversationMessages({
            conversationId,
            afterSequence,
            beforeSequence,
            limit: BigInt(limit),
          });
          await sleep(250);
          const messages = client
            .listRequestedConversationMessages(conversationId)
            .map(toConversationMessageDto);
          if (!beforeSequence) {
            const readThrough = maxConversationSequence(messages);
            if (readThrough > 0n) {
              await client.markConversationRead(conversationId, readThrough);
            }
          }
          send(
            'ok',
            {
              messages,
              page: {
                limit,
                count: messages.length,
                afterSequence: afterSequence?.toString() ?? null,
                beforeSequence: beforeSequence?.toString() ?? null,
                previousBeforeSequence: messages[0]?.sequence ?? null,
                nextAfterSequence: messages[messages.length - 1]?.sequence ?? null,
              },
            },
            id
          );
          return;
        }

        if (command === 'mark_conversation_read') {
          const conversationIdRaw = payload.conversation_id;
          if (conversationIdRaw === undefined) {
            throw new Error('mark_conversation_read requires conversation_id');
          }
          const conversationId = parseRequiredBigInt(
            String(conversationIdRaw),
            'conversation_id'
          );
          const sequence =
            payload.sequence !== undefined
              ? parseRequiredBigInt(String(payload.sequence), 'sequence')
              : undefined;
          await client.markConversationRead(conversationId, sequence);
          send(
            'ok',
            {
              conversationId: conversationId.toString(),
              sequence:
                sequence?.toString() ??
                client.conversationReadSequence(conversationId).toString(),
            },
            id
          );
          return;
        }

        if (command === 'send_conversation') {
          const conversationIdRaw = payload.conversation_id;
          const text = String(payload.text ?? '').trim();
          if (conversationIdRaw === undefined || !text) {
            throw new Error('send_conversation requires conversation_id and text');
          }

          const conversationId = parseRequiredBigInt(
            String(conversationIdRaw),
            'conversation_id'
          );
          const requestId = await client.sendConversationMessage(conversationId, text, {
            kind:
              typeof payload.kind === 'string'
                ? assertChoice(payload.kind, 'kind', [
                    'chat',
                    'task',
                    'handoff',
                    'tool_result',
                    'approval_request',
                    'status',
                    'system',
                  ] as const)
                : undefined,
            correlationId:
              typeof payload.correlation_id === 'string' ? payload.correlation_id : undefined,
            metadataJson:
              typeof payload.metadata_json === 'string' ? payload.metadata_json : undefined,
            artifactUrl:
              typeof payload.artifact_url === 'string' ? payload.artifact_url : undefined,
            artifactMimeType:
              typeof payload.artifact_mime_type === 'string'
                ? payload.artifact_mime_type
                : undefined,
            clientRequestId:
              typeof payload.client_request_id === 'string'
                ? payload.client_request_id
                : undefined,
          });
          const receipt = await client.waitForReceipt(
            requestId,
            5000,
            'send_conversation_message'
          );
          send(
            'ok',
            {
              conversationId: conversationId.toString(),
              text,
              receipt: toReceiptDto(receipt),
            },
            id
          );
          return;
        }

        if (command === 'subscribe_conversation') {
          const conversationIdRaw = payload.conversation_id;
          if (conversationIdRaw === undefined) {
            throw new Error('subscribe_conversation requires conversation_id');
          }

          const conversationId = parseRequiredBigInt(
            String(conversationIdRaw),
            'conversation_id'
          );
          const conversationIdText = conversationId.toString();
          const afterSequence =
            payload.after_sequence !== undefined || payload.after !== undefined
              ? parseRequiredBigInt(
                  String(payload.after_sequence ?? payload.after),
                  'after_sequence'
                )
              : client.conversationReadSequence(conversationId);
          const limit =
            Number.isInteger(payload.limit) && Number(payload.limit) > 0
              ? Math.min(Number(payload.limit), 100)
              : 50;
          await client.requestConversationMessages({
            conversationId,
            afterSequence,
            limit: BigInt(limit),
          });
          await sleep(250);
          subscribedConversations.add(conversationIdText);
          const snapshot = client
            .listRequestedConversationMessages(conversationId)
            .map(toConversationMessageDto);
          for (const message of snapshot) {
            send('snapshot', { conversationMessage: message });
          }
          const readThrough = maxConversationSequence(snapshot);
          if (readThrough > 0n) {
            await client.markConversationRead(conversationId, readThrough);
            await client.requestConversationMessages({
              conversationId,
              afterSequence: readThrough,
              limit: BigInt(limit),
            });
          }
          send(
            'ok',
            {
              conversationId: conversationIdText,
              subscribed: true,
              afterSequence: (readThrough > 0n ? readThrough : afterSequence).toString(),
              limit,
            },
            id
          );
          return;
        }

        if (command === 'unsubscribe_conversation') {
          const conversationIdRaw = payload.conversation_id;
          if (conversationIdRaw === undefined) {
            throw new Error('unsubscribe_conversation requires conversation_id');
          }

          const conversationId = parseRequiredBigInt(
            String(conversationIdRaw),
            'conversation_id'
          );
          subscribedConversations.delete(conversationId.toString());
          await client.clearConversationMessageRequest(conversationId);
          send('ok', { conversationId: conversationId.toString(), subscribed: false }, id);
          return;
        }

        if (command === 'list_tasks') {
          const channelId =
            payload.channel_id !== undefined || payload.channel !== undefined
              ? await resolveCommandChannelId(client, payload)
              : undefined;
          send(
            'ok',
            {
              tasks: client.listTasks(channelId).map(toTaskDto),
            },
            id
          );
          return;
        }

        if (command === 'create_task') {
          const channelId = await resolveCommandChannelId(client, payload);
          const title = String(payload.title ?? '').trim();
          const description = String(payload.description ?? payload.message ?? '').trim();
          if (!title || !description) {
            throw new Error('create_task requires title and description');
          }

          const priority =
            payload.priority === 'low' ||
            payload.priority === 'normal' ||
            payload.priority === 'high' ||
            payload.priority === 'urgent'
              ? payload.priority
              : 'normal';
          const assignRef =
            typeof payload.assign === 'string'
              ? payload.assign
              : typeof payload.assigned_to === 'string'
                ? payload.assigned_to
                : undefined;
          await client.createTask(
            channelId,
            title,
            description,
            priority,
            assignRef ? await resolveAccountIdentity(client, assignRef) : undefined,
            typeof payload.correlation_id === 'string' ? payload.correlation_id : undefined
          );
          await sleep(250);
          send(
            'ok',
            {
              tasks: client.listTasks(channelId).map(toTaskDto),
            },
            id
          );
          return;
        }

        if (command === 'claim_task') {
          const taskIdRaw = payload.task_id;
          if (taskIdRaw === undefined) {
            throw new Error('claim_task requires task_id');
          }

          const taskId = parseRequiredBigInt(String(taskIdRaw), 'task_id');
          await client.claimTask(taskId);
          await sleep(250);
          send(
            'ok',
            {
              taskId: taskId.toString(),
              task: client.listTasks().find(row => row.id === taskId)
                ? toTaskDto(client.listTasks().find(row => row.id === taskId)!)
                : null,
              claims: client.listTaskClaims(taskId).map(toTaskClaimDto),
            },
            id
          );
          return;
        }

        if (command === 'update_task_status') {
          const taskIdRaw = payload.task_id;
          const statusRaw = String(payload.status ?? '');
          if (taskIdRaw === undefined || !statusRaw) {
            throw new Error('update_task_status requires task_id and status');
          }

          const taskId = parseRequiredBigInt(String(taskIdRaw), 'task_id');
          const status = assertChoice(statusRaw, 'status', [
            'open',
            'claimed',
            'in_progress',
            'blocked',
            'done',
            'cancelled',
          ] as const);
          await client.updateTaskStatus(taskId, status);
          await sleep(250);
          send(
            'ok',
            {
              taskId: taskId.toString(),
              status,
              task: client.listTasks().find(row => row.id === taskId)
                ? toTaskDto(client.listTasks().find(row => row.id === taskId)!)
                : null,
            },
            id
          );
          return;
        }

        if (command === 'list_handoffs') {
          const channelId =
            payload.channel_id !== undefined || payload.channel !== undefined
              ? await resolveCommandChannelId(client, payload)
              : undefined;
          send(
            'ok',
            {
              handoffs: client.listHandoffs(channelId).map(toHandoffDto),
            },
            id
          );
          return;
        }

        if (command === 'create_handoff') {
          const channelId = await resolveCommandChannelId(client, payload);
          const summary = String(payload.summary ?? payload.message ?? '').trim();
          if (!summary) {
            throw new Error('create_handoff requires summary');
          }

          const toRef = typeof payload.to === 'string' ? payload.to : undefined;
          await client.createHandoff(
            channelId,
            summary,
            toRef ? await resolveAccountIdentity(client, toRef) : undefined,
            typeof payload.context_json === 'string' ? payload.context_json : undefined
          );
          await sleep(250);
          send(
            'ok',
            {
              handoffs: client.listHandoffs(channelId).map(toHandoffDto),
            },
            id
          );
          return;
        }

        if (command === 'accept_handoff') {
          const handoffIdRaw = payload.handoff_id;
          if (handoffIdRaw === undefined) {
            throw new Error('accept_handoff requires handoff_id');
          }

          const handoffId = parseRequiredBigInt(String(handoffIdRaw), 'handoff_id');
          await client.acceptHandoff(handoffId);
          await sleep(250);
          send(
            'ok',
            {
              handoffId: handoffId.toString(),
              handoff: client.listHandoffs().find(row => row.id === handoffId)
                ? toHandoffDto(client.listHandoffs().find(row => row.id === handoffId)!)
                : null,
            },
            id
          );
          return;
        }

        if (command === 'emit_event') {
          const kind = assertChoice(String(payload.kind ?? ''), 'kind', [
            'typing',
            'heartbeat',
            'mention',
            'joined_thread',
            'joined_conversation',
            'status',
          ] as const);
          const channelId =
            payload.channel_id !== undefined || payload.channel !== undefined
              ? await resolveCommandChannelId(client, payload)
              : undefined;
          await client.emitAgentEvent({
            kind,
            channelId,
            threadId:
              payload.thread_id !== undefined
                ? parseRequiredBigInt(String(payload.thread_id), 'thread_id')
                : undefined,
            conversationId:
              payload.conversation_id !== undefined
                ? parseRequiredBigInt(String(payload.conversation_id), 'conversation_id')
                : undefined,
            targetIdentity:
              typeof payload.target === 'string'
                ? await resolveAccountIdentity(client, payload.target)
                : undefined,
            text: typeof payload.text === 'string' ? payload.text : undefined,
            metadataJson:
              typeof payload.metadata_json === 'string' ? payload.metadata_json : undefined,
          });
          send('ok', { kind }, id);
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

async function commandUpdate(flags: Flags, positionals: string[]) {
  const subcommand = positionals[0] ?? 'check';
  if (subcommand === 'help' || subcommand === '--help') {
    writeStdout(`Usage:
  agenttalk update check [--force] [--json]

Checks npm for a newer ${'pistils-chat-cli'} package version. Passive update checks are cached and
are skipped for --json, --agent, --quiet, and AGENTTALK_UPDATE_CHECK=0.`);
    return;
  }
  if (subcommand !== 'check') {
    throw new Error(`Unknown update command: ${subcommand}`);
  }
  const status = await checkForPackageUpdate({
    stateDir: STATE_DIR,
    force: getBooleanFlag(flags, ['force']),
    timeoutMs: getIntFlag(flags, ['timeout-ms', 'timeoutMs'], 5000),
  });
  if (wantsJson(flags)) {
    writeJson(status);
    return;
  }
  if (!status.ok) {
    writeStdout(`update check failed: ${status.error ?? 'unknown error'}`);
    return;
  }
  const notice = formatPackageUpdateNotice(status);
  if (notice) {
    writeStdout(notice);
    return;
  }
  writeStdout(`${status.packageName} is up to date (${status.currentVersion})`);
}

async function maybeRunPassiveUpdateCheck(command: string, flags: Flags) {
  if (
    command === 'help' ||
    command === '--help' ||
    command === 'update' ||
    getBooleanFlag(flags, ['no-update-check', 'noUpdateCheck'])
  ) {
    return;
  }
  await maybeNotifyPackageUpdate({
    stateDir: STATE_DIR,
    json: STRICT_OUTPUT,
    quiet: QUIET,
    write: writeStderr,
  });
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const leadingFlags: string[] = [];
  const leadingValueFlags = new Set([
    'host',
    'db',
    'database',
    'token',
    'retries',
    'retry-base-ms',
    'connect-timeout-ms',
    'subscription-profile',
    'profile',
  ]);
  while (rawArgs[0]?.startsWith('--')) {
    const flag = rawArgs.shift()!;
    leadingFlags.push(flag);
    const flagName = flag.slice(2);
    if (
      !flag.includes('=') &&
      leadingValueFlags.has(flagName) &&
      rawArgs[0] &&
      !rawArgs[0].startsWith('--')
    ) {
      leadingFlags.push(rawArgs.shift()!);
    }
  }

  const [command = 'help', ...rest] = rawArgs;
  const { flags, positionals } = parseArgs([...rest, ...leadingFlags]);
  configureRuntime(command, flags);
  const state = await loadState();

  if (command === 'help' || command === '--help') {
    printHelp();
    return;
  }

  await maybeRunPassiveUpdateCheck(command, flags);

  allowDirectCli(flags);

  if (command === 'init') {
    await commandInit(flags, positionals, state);
    return;
  }

  if (command === 'find') {
    await commandFind(flags, positionals, state);
    return;
  }

  if (command === 'chat') {
    await commandChat(flags, positionals, state);
    return;
  }

  if (command === 'reply') {
    await commandReply(flags, positionals, state);
    return;
  }

  if (command === 'group') {
    await commandGroup(flags, positionals, state);
    return;
  }

  if (command === 'inbox') {
    await commandInbox(flags, state);
    return;
  }

  if (command === 'listen' || command === 'wait') {
    await commandListen(flags, positionals, state, command);
    return;
  }

  if (command === 'transcript') {
    await commandTranscript(flags, positionals, state);
    return;
  }

  if (command === 'account' || command === 'accounts') {
    await commandAccount(flags, positionals, state);
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

  if (command === 'wake') {
    await commandWake(flags, positionals);
    return;
  }

  if (command === 'setup') {
    const { runSetupCommand } = await import('./setup');
    await runSetupCommand(flags);
    return;
  }

  if (command === 'hermes') {
    await commandHermes(flags, positionals);
    return;
  }

  if (command === 'mcp') {
    await commandMcp(flags, positionals);
    return;
  }

  if (command === 'update') {
    await commandUpdate(flags, positionals);
    return;
  }

  if (command === 'supervisor') {
    const { runSupervisorCommand } = await import('./supervisor/cli');
    await runSupervisorCommand(positionals, flags);
    return;
  }

  if (command === 'daemon') {
    await commandDaemon(flags, positionals);
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

  if (command === 'room' || command === 'rooms') {
    await commandRoom(flags, positionals, state);
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

  if (command === 'conversation' || command === 'conversations') {
    await commandConversation(flags, positionals, state);
    return;
  }

  if (command === 'task' || command === 'tasks') {
    await commandTask(flags, positionals, state);
    return;
  }

  if (command === 'handoff' || command === 'handoffs') {
    await commandHandoff(flags, positionals, state);
    return;
  }

  if (command === 'event' || command === 'events') {
    await commandEvent(flags, positionals, state);
    return;
  }

  if (command === 'watch') {
    await commandWatch(flags, positionals, state);
    return;
  }

  if (command === 'repair-access') {
    await commandRepairAccess(flags, state);
    return;
  }

  if (command === 'run' || command === 'serve') {
    if (!getBooleanFlag(flags, ['jsonl'])) {
      throw new Error(`${command} requires --jsonl`);
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

