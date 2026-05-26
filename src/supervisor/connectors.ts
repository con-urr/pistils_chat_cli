import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type * as ModuleTypes from '../module_bindings/types';
import type { WakeDispatchPayload } from '../wake';
import type { SupervisorAgentConfig, SupervisorConfig } from './config';
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

function truncateText(value: string, max = 4000) {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}\n[truncated ${value.length - max} chars]`;
}

function wakeText(input: WakeConnectorInput) {
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
- Decide whether you need to reply.
- If replying, use AgentTalk through the provided state dir or configured MCP/CLI.
- Do not reveal secrets or local paths.
- Return or print a structured connector result JSON when possible:
  {"ok":true,"handled":true,"replySent":false,"message":"..."}
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
  return {
    ...process.env,
    AGENTTALK_WAKE_ID: input.wake.wakeId,
    AGENTTALK_WAKE_ATTEMPT_ID: input.attemptId,
    AGENTTALK_AGENT_NAME: input.agentName,
    AGENTTALK_AGENT_HANDLE: input.handle,
    AGENTTALK_AGENT_ID: input.agentId ?? '',
    AGENTTALK_CONVERSATION_ID: input.wake.conversationId.toString(),
    AGENTTALK_MIN_SEQUENCE: input.wake.minSequence.toString(),
    AGENTTALK_MAX_SEQUENCE: input.wake.maxSequence.toString(),
    AGENTTALK_REASON: input.wake.reason,
    AGENTTALK_STATE_DIR: input.stateDir,
    AGENTTALK_HOST: config.host,
    AGENTTALK_DB: config.databaseName,
    AGENTTALK_WAKE_INPUT_JSON: paths.inputPath,
    AGENTTALK_WAKE_CONTEXT_JSON: paths.contextJson,
    AGENTTALK_WAKE_PAYLOAD_JSON: paths.payloadJson,
    OPENCLAW_AGENT_ID: openclawAgentId,
    OPENCLAW_TIMEOUT_SECONDS:
      process.env.OPENCLAW_TIMEOUT_SECONDS ??
      Math.max(1, Math.ceil(agent.connectorTimeoutMs / 1000)).toString(),
    HERMES_TIMEOUT_SECONDS:
      process.env.HERMES_TIMEOUT_SECONDS ??
      Math.max(1, Math.ceil(agent.connectorTimeoutMs / 1000)).toString(),
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
  return {
    command: python,
    args: [hermes, 'chat', '--query', wakeText(input), '--quiet', '--source', 'agenttalk'],
    cwd: agent.repoPath,
  };
}

function defaultCodexSpec(agent: SupervisorAgentConfig, input: WakeConnectorInput): ProcessSpec {
  const workdir = process.env.AGENTTALK_CODEX_WORKDIR ?? agent.repoPath ?? process.cwd();
  const sandbox = process.env.AGENTTALK_CODEX_SANDBOX ?? 'read-only';
  const command = process.platform === 'win32' ? 'codex.cmd' : 'codex';
  const args = ['exec', '-', '--json', '--sandbox', sandbox, '--cd', workdir];
  const outputSchema = process.env.AGENTTALK_CODEX_OUTPUT_SCHEMA;
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

function buildProcessSpec(agent: SupervisorAgentConfig, input: WakeConnectorInput): ProcessSpec | null {
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
    return defaultCodexSpec(agent, input);
  }
  throw new Error(`Unsupported connector kind: ${agent.kind}`);
}

function parseJsonObject(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  const candidates = [trimmed, ...trimmed.split(/\r?\n/).reverse()];
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

  const parsed = parseJsonObject(processResult.stdout);
  if (parsed && typeof parsed.ok === 'boolean' && typeof parsed.handled === 'boolean') {
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

export async function executeWakeConnector(
  config: SupervisorConfig,
  agent: SupervisorAgentConfig,
  input: WakeConnectorInput,
  runDir: string
): Promise<WakeConnectorResult> {
  await fs.mkdir(runDir, { recursive: true });
  await fs.chmod(runDir, 0o700).catch(() => undefined);

  const inputPath = path.join(runDir, 'input.json');
  const stdoutPath = path.join(runDir, 'stdout.log');
  const stderrPath = path.join(runDir, 'stderr.log');
  const resultPath = path.join(runDir, 'result.json');
  const contextJson = JSON.stringify(toJsonSafe(input.contextMessages));
  const payloadJson = JSON.stringify(toJsonSafe(input.payload));

  await fs.writeFile(inputPath, stringifyJsonSafe(input), 'utf8');

  let processResult: ProcessResult | undefined;
  let result: WakeConnectorResult;
  try {
    const spec = buildProcessSpec(agent, input);
    if (spec) {
      processResult = await runProcess(
        spec,
        connectorEnv(config, agent, input, { inputPath, contextJson, payloadJson }),
        agent.connectorTimeoutMs
      );
    }
    result = normalizeConnectorResult(agent, processResult);
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
