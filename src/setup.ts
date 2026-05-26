import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  defaultAgentStateDir,
  loadSupervisorConfigOrDefault,
  normalizeAgentName,
  normalizeHandle,
  saveSupervisorConfig,
  type AgentConnectorKind,
  type SupervisorAgentConfig,
  type SupervisorConfig,
} from './supervisor/config';

type SetupFlags = Record<string, string | boolean>;

type DetectedAgent = {
  name: string;
  handle: string;
  kind: AgentConnectorKind;
  repoPath?: string;
  ready: boolean;
  reason?: string;
};

function writeStdout(line: string) {
  process.stdout.write(`${line}\n`);
}

function writeJson(value: unknown) {
  writeStdout(JSON.stringify(value, null, 2));
}

function getStringFlag(flags: SetupFlags, keys: string[]) {
  for (const key of keys) {
    const value = flags[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  return undefined;
}

function getBooleanFlag(flags: SetupFlags, keys: string[]) {
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

function expandHome(input: string) {
  if (input === '~') {
    return os.homedir();
  }
  if (input.startsWith('~/') || input.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

async function exists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function documentsGitHub() {
  return path.join(os.homedir(), 'Documents', 'GitHub');
}

function repoCandidates(name: string, explicit?: string) {
  return [
    explicit,
    path.join(documentsGitHub(), name),
    path.join(os.homedir(), 'github', name),
    path.join(os.homedir(), 'GitHub', name),
  ].filter(Boolean) as string[];
}

async function firstExistingRepo(candidates: string[], marker: string) {
  for (const candidate of candidates) {
    const resolved = path.resolve(expandHome(candidate));
    if (await exists(path.join(resolved, marker))) {
      return resolved;
    }
  }
  return undefined;
}

async function findOnPath(command: string) {
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
      const candidate = path.join(dir, process.platform === 'win32' ? `${command}${ext.toLowerCase()}` : command);
      if (await exists(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

async function detectOpenClaw(flags: SetupFlags): Promise<DetectedAgent | undefined> {
  if (getBooleanFlag(flags, ['no-openclaw', 'skip-openclaw'])) {
    return undefined;
  }
  const repo = await firstExistingRepo(
    repoCandidates('openclaw', getStringFlag(flags, ['openclaw-repo', 'openclawRepo'])),
    'openclaw.mjs'
  );
  return {
    name: 'support',
    handle: 'support-agent',
    kind: 'openclaw',
    repoPath: repo,
    ready: Boolean(repo),
    reason: repo ? undefined : 'openclaw.mjs was not found',
  };
}

async function detectHermes(flags: SetupFlags): Promise<DetectedAgent | undefined> {
  if (getBooleanFlag(flags, ['no-hermes', 'skip-hermes'])) {
    return undefined;
  }
  const repo = await firstExistingRepo(
    repoCandidates('hermes-agent', getStringFlag(flags, ['hermes-repo', 'hermesRepo'])),
    'hermes'
  );
  const python = repo
    ? process.platform === 'win32'
      ? path.join(repo, 'venv', 'Scripts', 'python.exe')
      : path.join(repo, 'venv', 'bin', 'python')
    : undefined;
  const hasPython = python ? await exists(python) : false;
  return {
    name: 'research',
    handle: 'research-agent',
    kind: 'hermes',
    repoPath: repo,
    ready: Boolean(repo && hasPython),
    reason: repo ? (hasPython ? undefined : 'Hermes virtualenv python was not found') : 'hermes repo was not found',
  };
}

async function detectCodex(flags: SetupFlags): Promise<DetectedAgent | undefined> {
  if (getBooleanFlag(flags, ['no-codex', 'skip-codex'])) {
    return undefined;
  }
  const codex = await findOnPath(process.platform === 'win32' ? 'codex' : 'codex');
  const repoPath = path.resolve(expandHome(getStringFlag(flags, ['codex-workdir', 'codexWorkdir']) ?? process.cwd()));
  return {
    name: 'coder',
    handle: 'codex-agent',
    kind: 'codex',
    repoPath,
    ready: Boolean(codex),
    reason: codex ? undefined : 'codex executable was not found on PATH',
  };
}

function toSupervisorAgent(detected: DetectedAgent): SupervisorAgentConfig {
  return {
    name: normalizeAgentName(detected.name),
    handle: normalizeHandle(detected.handle),
    kind: detected.kind,
    stateDir: defaultAgentStateDir(detected.name),
    repoPath: detected.repoPath,
    enabled: true,
    autoInit: true,
    maxConcurrentWakeJobs: 1,
    connectorTimeoutMs: detected.kind === 'codex' ? 600_000 : 300_000,
    wake: {
      latencyMs: detected.kind === 'codex' ? 10_000 : detected.kind === 'hermes' ? 5_000 : 1_000,
      statusText: `${detected.name} agent available`,
      reasons: ['direct_message', 'mention'],
    },
  };
}

function applyDetectedAgents(
  config: SupervisorConfig,
  detected: DetectedAgent[],
  force: boolean
) {
  const configured: Array<{ agent: SupervisorAgentConfig; action: 'added' | 'replaced' | 'kept' }> = [];
  for (const item of detected.filter(agent => agent.ready)) {
    const next = toSupervisorAgent(item);
    const existingIndex = config.agents.findIndex(agent => agent.name === next.name);
    if (existingIndex >= 0 && !force) {
      configured.push({ agent: config.agents[existingIndex], action: 'kept' });
      continue;
    }
    if (existingIndex >= 0) {
      config.agents[existingIndex] = next;
      configured.push({ agent: next, action: 'replaced' });
    } else {
      config.agents.push(next);
      configured.push({ agent: next, action: 'added' });
    }
  }
  return configured;
}

function redactedAgent(agent: SupervisorAgentConfig) {
  return {
    ...agent,
    stateDir: '[redacted]',
    repoPath: agent.repoPath ? '[redacted]' : undefined,
  };
}

function redactedDetected(agent: DetectedAgent) {
  return {
    ...agent,
    repoPath: agent.repoPath ? '[redacted]' : undefined,
  };
}

export async function runSetupCommand(flags: SetupFlags) {
  const configureAgents = getBooleanFlag(flags, ['agents']) || !getBooleanFlag(flags, ['mcp-only']);
  if (!configureAgents) {
    throw new Error('Only agent setup is implemented. Use agenttalk setup --agents.');
  }

  const dryRun = getBooleanFlag(flags, ['dry-run', 'dryRun']);
  const force = getBooleanFlag(flags, ['force']);
  const detected = (
    await Promise.all([detectOpenClaw(flags), detectHermes(flags), detectCodex(flags)])
  ).filter(Boolean) as DetectedAgent[];
  const config = await loadSupervisorConfigOrDefault();
  const configured = applyDetectedAgents(config, detected, force);
  if (!dryRun) {
    await saveSupervisorConfig(config);
    await Promise.all(configured.map(({ agent }) => fs.mkdir(agent.stateDir, { recursive: true })));
  }

  const payload = {
    ok: true,
    dryRun,
    detected: detected.map(redactedDetected),
    configured: configured.map(item => ({
      action: item.action,
      agent: redactedAgent(item.agent),
    })),
    skipped: detected.filter(agent => !agent.ready).map(redactedDetected),
    nextActions: [
      {
        label: 'Run a one-minute supervisor check',
        command: 'agenttalk supervisor run --duration-ms 60000 --json',
      },
      {
        label: 'Install the user service',
        command: 'agenttalk supervisor install-service --json',
      },
      {
        label: 'Add local AgentTalk MCP to Codex',
        command: 'codex mcp add agenttalk -- npx -y pistils-chat-cli agenttalk-mcp',
      },
    ],
  };

  if (getBooleanFlag(flags, ['json'])) {
    writeJson(payload);
    return;
  }

  writeStdout(`Configured ${configured.length} wakeable agent(s)${dryRun ? ' (dry run)' : ''}:`);
  for (const item of configured) {
    writeStdout(`@${item.agent.handle} ${item.agent.kind} ${item.action}`);
  }
  for (const item of payload.skipped) {
    writeStdout(`Skipped ${item.kind}: ${item.reason}`);
  }
  writeStdout('Next: agenttalk supervisor run --duration-ms 60000 --json');
}
