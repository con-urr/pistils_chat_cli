import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  defaultAgentStateDir,
  defaultSupervisorConfig,
  ensureSupervisorDirs,
  expandHome,
  clearOpenWakeApprovalPassphrase,
  loadSupervisorConfig,
  loadSupervisorConfigOrDefault,
  normalizeAgentName,
  normalizeControlProfile,
  normalizeHandle,
  normalizeKind,
  normalizeWakeAccessMode,
  openWakeApprovalStatus,
  normalizeWakeSenderAgentIds,
  OPEN_WAKE_WARNING,
  redactConfig,
  requireOpenWakeLocalApproval,
  saveSupervisorConfig,
  setOpenWakeApprovalPassphrase,
  supervisorConfigPath,
  type AgentConnectorKind,
  type SupervisorAgentConfig,
  type SupervisorConfig,
  wakeAccessMode,
} from './config';
import { executeWakeConnector } from './connectors';
import { hermesStatusHasInferenceCredentials } from './hermes';
import { stringifyJsonSafe } from './json';
import { inspectSupervisorLiveStatus, runSupervisor } from './runtime';
import {
  createWakeChangeRequest,
  listWakeChangeRequests,
  resolveWakeChangeRequest,
  type WakeChangeRequestPatch,
  type WakeChangeRequestStatus,
} from './requests';
import { loadAgentState } from './state';

export type SupervisorFlags = Record<string, string | boolean>;
type SupervisorDoctorCheck = {
  name: string;
  ok: boolean;
  detail: string;
  agent?: string;
  kind?: AgentConnectorKind;
  count?: number;
};

function writeStdout(line: string) {
  process.stdout.write(`${line}\n`);
}

function writeStderr(line: string) {
  process.stderr.write(`${line}\n`);
}

function writeJson(value: unknown) {
  writeStdout(JSON.stringify(value, null, 2));
}

function getStringFlag(flags: SupervisorFlags, keys: string[]) {
  for (const key of keys) {
    const value = flags[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  return undefined;
}

function getBooleanFlag(flags: SupervisorFlags, keys: string[]) {
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

function getOptionalBooleanFlag(flags: SupervisorFlags, keys: string[]) {
  for (const key of keys) {
    const value = flags[key];
    if (value === true) {
      return true;
    }
    if (typeof value === 'string') {
      const normalized = value.toLowerCase();
      if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
        return true;
      }
      if (normalized === 'false' || normalized === '0' || normalized === 'no') {
        return false;
      }
      throw new Error(`${key} must be true or false`);
    }
  }
  return undefined;
}

function getIntFlag(flags: SupervisorFlags, keys: string[], defaultValue: number) {
  const raw = getStringFlag(flags, keys);
  if (!raw) {
    return defaultValue;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${keys[0]} must be a non-negative integer`);
  }
  return parsed;
}

function getWakeSenderAgentIdsFlag(
  flags: SupervisorFlags,
  keys: string[],
  clearKeys: string[],
  field: string
) {
  if (getBooleanFlag(flags, clearKeys)) {
    return [] as string[];
  }
  const raw = getStringFlag(flags, keys);
  return raw === undefined ? undefined : normalizeWakeSenderAgentIds(raw, field);
}

function getWakeAccessModeFlag(flags: SupervisorFlags) {
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

function hasOpenWakeConfirmation(flags: SupervisorFlags) {
  return getBooleanFlag(flags, [
    'i-understand-open-wake-risk',
    'confirm-open-wake',
    'yes-open-wake',
    'openWakeRiskAccepted',
  ]);
}

function getOpenWakeApprovalPassphrase(flags: SupervisorFlags) {
  return (
    getStringFlag(flags, [
      'open-wake-approval-passphrase',
      'approval-passphrase',
      'openWakeApprovalPassphrase',
    ]) ?? process.env.AGENTTALK_OPEN_WAKE_APPROVAL_PASSPHRASE
  );
}

function requireOpenWakeConfirmation(flags: SupervisorFlags, config?: SupervisorConfig) {
  if (!hasOpenWakeConfirmation(flags)) {
    throw new Error(
      `${OPEN_WAKE_WARNING}\nRe-run with --i-understand-open-wake-risk to confirm open wake mode.`
    );
  }
  writeStderr(`[warn] ${OPEN_WAKE_WARNING}`);
  requireOpenWakeLocalApproval(config, getOpenWakeApprovalPassphrase(flags));
}

function applyWakeAccessFlags(
  agent: SupervisorAgentConfig,
  flags: SupervisorFlags,
  config?: SupervisorConfig
) {
  const mode = getWakeAccessModeFlag(flags);
  if (mode === 'open') {
    requireOpenWakeConfirmation(flags, config);
    agent.wake.accessMode = 'open';
  } else if (mode === 'allow_list') {
    agent.wake.accessMode = 'allow_list';
  }

  const allowed = getWakeSenderAgentIdsFlag(
    flags,
    [
      'allow-senders',
      'allowed-senders',
      'allowed-wake-senders',
      'allow-wake-from',
      'allowedWakeSenderAgentIds',
    ],
    ['clear-allow-senders', 'clear-allowed-senders', 'clearAllowedWakeSenderAgentIds'],
    'Allowed wake senders'
  );
  const blocked = getWakeSenderAgentIdsFlag(
    flags,
    [
      'block-senders',
      'blocked-senders',
      'blocked-wake-senders',
      'block-wake-from',
      'blockedWakeSenderAgentIds',
    ],
    ['clear-block-senders', 'clear-blocked-senders', 'clearBlockedWakeSenderAgentIds'],
    'Blocked wake senders'
  );

  if (allowed !== undefined) {
    agent.wake.allowedWakeSenderAgentIds = allowed;
    agent.wake.accessMode = 'allow_list';
  }
  if (blocked !== undefined) {
    agent.wake.blockedWakeSenderAgentIds = blocked;
  }
}

function wakeChangePatchFromFlags(flags: SupervisorFlags): WakeChangeRequestPatch {
  const patch: WakeChangeRequestPatch = {};
  const wakeEnabled = getOptionalBooleanFlag(flags, ['wake-enabled', 'wakeEnabled', 'wake']);
  if (wakeEnabled !== undefined) {
    patch.wakeEnabled = wakeEnabled;
  }
  const mode = getWakeAccessModeFlag(flags);
  if (mode !== undefined) {
    patch.wakeAccessMode = mode;
  }
  const allowed = getWakeSenderAgentIdsFlag(
    flags,
    [
      'allow-senders',
      'allowed-senders',
      'allowed-wake-senders',
      'allow-wake-from',
      'allowedWakeSenderAgentIds',
    ],
    ['clear-allow-senders', 'clear-allowed-senders', 'clearAllowedWakeSenderAgentIds'],
    'Allowed wake senders'
  );
  const blocked = getWakeSenderAgentIdsFlag(
    flags,
    [
      'block-senders',
      'blocked-senders',
      'blocked-wake-senders',
      'block-wake-from',
      'blockedWakeSenderAgentIds',
    ],
    ['clear-block-senders', 'clear-blocked-senders', 'clearBlockedWakeSenderAgentIds'],
    'Blocked wake senders'
  );
  if (allowed !== undefined) {
    patch.allowedWakeSenderAgentIds = allowed;
    if (!patch.wakeAccessMode) {
      patch.wakeAccessMode = 'allow_list';
    }
  }
  if (blocked !== undefined) {
    patch.blockedWakeSenderAgentIds = blocked;
  }
  return patch;
}

function applyWakeChangePatch(
  agent: SupervisorAgentConfig,
  patch: WakeChangeRequestPatch,
  flags: SupervisorFlags,
  config?: SupervisorConfig
) {
  if (patch.wakeEnabled !== undefined) {
    agent.wake.enabled = patch.wakeEnabled;
    if (patch.wakeEnabled) {
      agent.wake.accessMode = 'allow_list';
    }
  }
  if (patch.wakeAccessMode === 'open') {
    requireOpenWakeConfirmation(flags, config);
    agent.wake.accessMode = 'open';
  } else if (patch.wakeAccessMode === 'allow_list') {
    agent.wake.accessMode = 'allow_list';
  }
  if (patch.allowedWakeSenderAgentIds !== undefined) {
    agent.wake.allowedWakeSenderAgentIds = patch.allowedWakeSenderAgentIds;
    if (agent.wake.accessMode !== 'open') {
      agent.wake.accessMode = 'allow_list';
    }
  }
  if (patch.blockedWakeSenderAgentIds !== undefined) {
    agent.wake.blockedWakeSenderAgentIds = patch.blockedWakeSenderAgentIds;
  }
}

function commandOk(flags: SupervisorFlags, payload: Record<string, unknown>) {
  if (getBooleanFlag(flags, ['json'])) {
    writeJson({ ok: true, ...payload });
    return;
  }
  if (typeof payload.message === 'string') {
    writeStdout(payload.message);
    return;
  }
  writeJson({ ok: true, ...payload });
}

function requireAgent(config: SupervisorConfig, name: string) {
  const normalized = normalizeAgentName(name);
  const agent = config.agents.find(row => row.name === normalized);
  if (!agent) {
    throw new Error(`Unknown supervisor agent '${name}'`);
  }
  return agent;
}

function supervisorEntrypoint() {
  return path.resolve(__dirname, '..', 'agenttalk-supervisor.js');
}

function serviceName(flags: SupervisorFlags) {
  return getStringFlag(flags, ['name', 'service-name', 'serviceName']) ?? 'agenttalk-supervisor';
}

function xmlEscape(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function quotePowerShell(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function systemdQuote(value: string) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function runCommand(command: string, args: string[], cwd?: string) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
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
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(' ')} exited ${code}; ${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function exists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
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
      const candidate = path.join(
        dir,
        process.platform === 'win32' ? `${command}${ext.toLowerCase()}` : command
      );
      if (await exists(candidate)) {
        return true;
      }
    }
  }
  return false;
}

function agentStatus(agent: SupervisorAgentConfig) {
  const wakeEnabled = agent.enabled && agent.wake.enabled === true;
  const allowedWakeSenderAgentIds = normalizeWakeSenderAgentIds(
    agent.wake.allowedWakeSenderAgentIds,
    'Allowed wake senders'
  );
  const blockedWakeSenderAgentIds = normalizeWakeSenderAgentIds(
    agent.wake.blockedWakeSenderAgentIds,
    'Blocked wake senders'
  );
  return {
    name: agent.name,
    handle: agent.handle,
    agentTalkAgentId: null,
    agentTalkHandle: null,
    agentId: null,
    kind: agent.kind,
    controlProfile: normalizeControlProfile(agent.controlProfile),
    credentialScope: normalizeControlProfile(agent.controlProfile) === 'plugin_managed'
      ? 'plugin_runtime'
      : 'autonomous',
    registrationState: 'unknown',
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
    busyCheck: {
      configured: Boolean(agent.connector?.busyCommand?.trim()),
      timeoutMs: agent.connector?.busyCommandTimeoutMs ?? null,
    },
    wakeAccess: {
      mode: wakeAccessMode(agent.wake),
      allowedWakeSenderAgentIds,
      blockedWakeSenderAgentIds,
    },
    desiredWake: {
      enabled: agent.wake.enabled === true,
      accessMode: wakeAccessMode(agent.wake),
      allowedWakeSenderAgentIds,
      blockedWakeSenderAgentIds,
      maxConcurrentWakeJobs: agent.maxConcurrentWakeJobs,
      latencyMs: agent.wake.latencyMs,
    },
    effectiveWake: null,
    drift: null,
  };
}

async function agentStatusWithState(agent: SupervisorAgentConfig) {
  const status = agentStatus(agent);
  const stateDir = path.resolve(expandHome(agent.stateDir));
  const state = await loadAgentState(stateDir);
  const agentTalkAgentId = state.agentId ?? null;
  const agentTalkHandle = state.handle ?? null;
  return {
    ...status,
    agentTalkAgentId,
    agentTalkHandle,
    agentId: agentTalkAgentId,
    registrationState: state.registrationState ?? (agentTalkAgentId ? 'registered' : 'not_registered'),
    lastProfileSyncAt: state.lastProfileSyncAt ?? null,
  };
}

function doctorCheck(input: SupervisorDoctorCheck): SupervisorDoctorCheck {
  return input;
}

async function checkRepoPath(agent: SupervisorAgentConfig, marker: string) {
  if (!agent.repoPath) {
    return doctorCheck({
      name: 'agent:repo',
      ok: false,
      agent: agent.name,
      kind: agent.kind,
      detail: `${agent.kind} connector requires repoPath`,
    });
  }
  const ok = await exists(path.join(agent.repoPath, marker));
  return doctorCheck({
    name: 'agent:repo',
    ok,
    agent: agent.name,
    kind: agent.kind,
    detail: ok ? `${marker} found` : `${marker} was not found`,
  });
}

async function checkOpenClaw(agent: SupervisorAgentConfig): Promise<SupervisorDoctorCheck[]> {
  if (agent.command?.trim()) {
    return [
      doctorCheck({
        name: 'agent:custom_command',
        ok: true,
        agent: agent.name,
        kind: agent.kind,
        detail: 'custom command configured; doctor does not execute it',
      }),
    ];
  }
  const repoCheck = await checkRepoPath(agent, 'openclaw.mjs');
  if (!repoCheck.ok || !agent.repoPath) {
    return [repoCheck];
  }
  try {
    const result = await runCommand(
      process.execPath,
      [path.join(agent.repoPath, 'openclaw.mjs'), 'agents', 'list', '--json'],
      agent.repoPath
    );
    const parsed = JSON.parse(result.stdout) as Array<{ id?: unknown; isDefault?: unknown }>;
    const configuredId = process.env.OPENCLAW_AGENT_ID ?? agent.connector?.openclawAgentId;
    const hasConfiguredId =
      typeof configuredId === 'string' && parsed.some(row => row.id === configuredId);
    const hasAnyId = parsed.some(row => typeof row.id === 'string' && row.id.trim());
    return [
      repoCheck,
      doctorCheck({
        name: 'agent:openclaw_agents',
        ok: hasAnyId,
        agent: agent.name,
        kind: agent.kind,
        count: parsed.length,
        detail: hasAnyId ? `read ${parsed.length} OpenClaw agent(s)` : 'no OpenClaw agents returned',
      }),
      doctorCheck({
        name: 'agent:openclaw_agent_id',
        ok: Boolean(configuredId ? hasConfiguredId : hasAnyId),
        agent: agent.name,
        kind: agent.kind,
        detail: configuredId
          ? hasConfiguredId
            ? 'configured OpenClaw agent id is available'
            : 'configured OpenClaw agent id was not found'
          : hasAnyId
            ? 'no stored OpenClaw agent id; default discovery can choose an agent'
            : 'no OpenClaw agent id available',
      }),
    ];
  } catch (error) {
    return [
      repoCheck,
      doctorCheck({
        name: 'agent:openclaw_agents',
        ok: false,
        agent: agent.name,
        kind: agent.kind,
        detail: error instanceof Error ? error.message : String(error),
      }),
    ];
  }
}

async function checkHermes(agent: SupervisorAgentConfig): Promise<SupervisorDoctorCheck[]> {
  if (agent.command?.trim()) {
    return [
      doctorCheck({
        name: 'agent:custom_command',
        ok: true,
        agent: agent.name,
        kind: agent.kind,
        detail: 'custom command configured; doctor does not execute it',
      }),
    ];
  }
  const repoCheck = await checkRepoPath(agent, 'hermes');
  if (!repoCheck.ok || !agent.repoPath) {
    return [repoCheck];
  }
  const python = process.platform === 'win32'
    ? path.join(agent.repoPath, 'venv', 'Scripts', 'python.exe')
    : path.join(agent.repoPath, 'venv', 'bin', 'python');
  const pythonOk = await exists(python);
  const checks = [
    repoCheck,
    doctorCheck({
      name: 'agent:hermes_python',
      ok: pythonOk,
      agent: agent.name,
      kind: agent.kind,
      detail: pythonOk ? 'Hermes virtualenv python found' : 'Hermes virtualenv python was not found',
    }),
  ];
  if (!pythonOk) {
    return checks;
  }
  try {
    const result = await runCommand(python, [path.join(agent.repoPath, 'hermes'), 'status'], agent.repoPath);
    const hasCredentials = hermesStatusHasInferenceCredentials(result.stdout);
    return [
      ...checks,
      doctorCheck({
        name: 'agent:hermes_credentials',
        ok: hasCredentials,
        agent: agent.name,
        kind: agent.kind,
        detail: hasCredentials
          ? 'Hermes has non-interactive model/provider credentials'
          : 'Hermes has no configured model/provider credentials for non-interactive wake runs',
      }),
    ];
  } catch (error) {
    return [
      ...checks,
      doctorCheck({
        name: 'agent:hermes_status',
        ok: false,
        agent: agent.name,
        kind: agent.kind,
        detail: error instanceof Error ? error.message : String(error),
      }),
    ];
  }
}

async function checkCodex(agent: SupervisorAgentConfig): Promise<SupervisorDoctorCheck[]> {
  if (agent.command?.trim()) {
    return [
      doctorCheck({
        name: 'agent:custom_command',
        ok: true,
        agent: agent.name,
        kind: agent.kind,
        detail: 'custom command configured; doctor does not execute it',
      }),
    ];
  }
  const codexOk = await findOnPath('codex');
  const checks = [
    doctorCheck({
      name: 'agent:codex_cli',
      ok: codexOk,
      agent: agent.name,
      kind: agent.kind,
      detail: codexOk ? 'codex executable found on PATH' : 'codex executable was not found on PATH',
    }),
  ];
  if (agent.repoPath) {
    const repoOk = await exists(agent.repoPath);
    checks.push(
      doctorCheck({
        name: 'agent:repo',
        ok: repoOk,
        agent: agent.name,
        kind: agent.kind,
        detail: repoOk ? 'Codex workdir exists' : 'Codex workdir was not found',
      })
    );
  }
  return checks;
}

async function checkAgentDoctor(agent: SupervisorAgentConfig): Promise<SupervisorDoctorCheck[]> {
  const checks: SupervisorDoctorCheck[] = [
    doctorCheck({
      name: 'agent:enabled',
      ok: true,
      agent: agent.name,
      kind: agent.kind,
      detail: agent.enabled ? 'agent enabled' : 'agent disabled',
    }),
    doctorCheck({
      name: 'agent:state_dir',
      ok: await exists(agent.stateDir),
      agent: agent.name,
      kind: agent.kind,
      detail: 'state dir check complete',
    }),
    doctorCheck({
      name: 'agent:limits',
      ok: agent.maxConcurrentWakeJobs > 0 && agent.connectorTimeoutMs > 0,
      agent: agent.name,
      kind: agent.kind,
      detail: 'wake concurrency and connector timeout are positive',
    }),
  ];

  if (!agent.enabled) {
    return checks;
  }
  if (agent.kind === 'noop') {
    return [
      ...checks,
      doctorCheck({
        name: 'agent:connector',
        ok: true,
        agent: agent.name,
        kind: agent.kind,
        detail: 'noop connector ready',
      }),
    ];
  }
  if (agent.kind === 'shell') {
    return [
      ...checks,
      doctorCheck({
        name: 'agent:custom_command',
        ok: Boolean(agent.command?.trim()),
        agent: agent.name,
        kind: agent.kind,
        detail: agent.command?.trim()
          ? 'shell command configured; doctor does not execute it'
          : 'shell connector requires command',
      }),
    ];
  }
  if (agent.kind === 'openclaw') {
    return [...checks, ...(await checkOpenClaw(agent))];
  }
  if (agent.kind === 'hermes') {
    return [...checks, ...(await checkHermes(agent))];
  }
  if (agent.kind === 'codex') {
    return [...checks, ...(await checkCodex(agent))];
  }
  return [
    ...checks,
    doctorCheck({
      name: 'agent:connector',
      ok: false,
      agent: agent.name,
      kind: agent.kind,
      detail: `unsupported connector kind ${agent.kind}`,
    }),
  ];
}

async function commandInit(flags: SupervisorFlags) {
  if (getBooleanFlag(flags, ['wizard'])) {
    const { runSetupCommand } = await import('../setup');
    await runSetupCommand({ ...flags, agents: true });
    return;
  }

  const force = getBooleanFlag(flags, ['force']);
  const configPath = supervisorConfigPath();
  if (!force) {
    try {
      await fs.access(configPath);
      commandOk(flags, {
        created: false,
        configPath: '[redacted]',
        message: 'agenttalk supervisor config already exists',
      });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
  const config = defaultSupervisorConfig();
  await saveSupervisorConfig(config);
  commandOk(flags, {
    created: true,
    config: redactConfig(config),
    configPath: '[redacted]',
    message: 'agenttalk supervisor config initialized',
  });
}

async function commandAddAgent(flags: SupervisorFlags) {
  const name = normalizeAgentName(getStringFlag(flags, ['name']) ?? '');
  const handle = normalizeHandle(getStringFlag(flags, ['handle']) ?? name);
  const kind = normalizeKind(getStringFlag(flags, ['kind']) ?? 'noop');
  const config = await loadSupervisorConfigOrDefault();
  const force = getBooleanFlag(flags, ['force']);
  const existingIndex = config.agents.findIndex(agent => agent.name === name);
  if (existingIndex >= 0 && !force) {
    throw new Error(`Agent '${name}' already exists. Use --force to replace it.`);
  }

  const stateDir = path.resolve(
    expandHome(getStringFlag(flags, ['state-dir', 'stateDir']) ?? defaultAgentStateDir(name))
  );
  const timeoutMs = getIntFlag(flags, ['timeout-ms', 'connectorTimeoutMs'], 300_000);
  const maxConcurrentWakeJobs = getIntFlag(flags, ['max-concurrent', 'maxConcurrentWakeJobs'], 1);
  const openclawAgentId = getStringFlag(flags, ['openclaw-agent-id', 'openclawAgentId']);
  const sendReplyText = getBooleanFlag(flags, ['send-reply-text', 'sendReplyText']);
  const busyCommand = getStringFlag(flags, ['busy-command', 'busyCommand']);
  const busyCommandTimeoutMs = getIntFlag(
    flags,
    ['busy-command-timeout-ms', 'busyCommandTimeoutMs'],
    5_000
  );
  const controlProfile = normalizeControlProfile(
    getStringFlag(flags, ['control-profile', 'controlProfile', 'profile-mode', 'profileMode'])
  );
  const accessMode = getWakeAccessModeFlag(flags) ?? 'allow_list';
  if (accessMode === 'open') {
    requireOpenWakeConfirmation(flags, config);
  }
  const connector: SupervisorAgentConfig['connector'] = {};
  if (openclawAgentId && kind === 'openclaw') {
    connector.openclawAgentId = openclawAgentId;
  }
  if (sendReplyText) {
    connector.sendReplyText = true;
  }
  if (busyCommand?.trim()) {
    connector.busyCommand = busyCommand;
    connector.busyCommandTimeoutMs = busyCommandTimeoutMs;
  }
  const agent: SupervisorAgentConfig = {
    name,
    handle,
    kind,
    controlProfile,
    stateDir,
    repoPath: getStringFlag(flags, ['repo', 'repo-path', 'repoPath'])
      ? path.resolve(expandHome(getStringFlag(flags, ['repo', 'repo-path', 'repoPath'])!))
      : undefined,
    command: getStringFlag(flags, ['command']),
    connector: Object.keys(connector).length ? connector : undefined,
    enabled: !getBooleanFlag(flags, ['disabled']),
    autoInit: !getBooleanFlag(flags, ['no-auto-init']),
    maxConcurrentWakeJobs,
    connectorTimeoutMs: timeoutMs,
    wake: {
      enabled: getBooleanFlag(flags, ['wake-enabled', 'wakeEnabled']),
      accessMode,
      latencyMs: getIntFlag(flags, ['latency-ms', 'latencyMs'], 1000),
      statusText: getStringFlag(flags, ['status-text', 'statusText']) ?? `${name} ready`,
      reasons: ['direct_message', 'mention'],
      allowedWakeSenderAgentIds: getWakeSenderAgentIdsFlag(
        flags,
        [
          'allow-senders',
          'allowed-senders',
          'allowed-wake-senders',
          'allow-wake-from',
          'allowedWakeSenderAgentIds',
        ],
        ['clear-allow-senders', 'clear-allowed-senders', 'clearAllowedWakeSenderAgentIds'],
        'Allowed wake senders'
      ) ?? [],
      blockedWakeSenderAgentIds: getWakeSenderAgentIdsFlag(
        flags,
        [
          'block-senders',
          'blocked-senders',
          'blocked-wake-senders',
          'block-wake-from',
          'blockedWakeSenderAgentIds',
        ],
        ['clear-block-senders', 'clear-blocked-senders', 'clearBlockedWakeSenderAgentIds'],
        'Blocked wake senders'
      ) ?? [],
    },
  };

  if (existingIndex >= 0) {
    config.agents[existingIndex] = agent;
  } else {
    config.agents.push(agent);
  }
  await saveSupervisorConfig(config);
  await fs.mkdir(stateDir, { recursive: true });
  await fs.chmod(stateDir, 0o700).catch(() => undefined);
  commandOk(flags, {
    added: existingIndex < 0,
    replaced: existingIndex >= 0,
    agent: redactConfig({ ...config, agents: [agent] }).agents[0],
    message: `configured supervisor agent ${name} (@${handle})`,
  });
}

async function commandRemoveAgent(positionals: string[], flags: SupervisorFlags) {
  const name = normalizeAgentName(getStringFlag(flags, ['name']) ?? positionals[1] ?? '');
  const config = await loadSupervisorConfig();
  const before = config.agents.length;
  config.agents = config.agents.filter(agent => agent.name !== name);
  if (config.agents.length === before) {
    throw new Error(`Unknown supervisor agent '${name}'`);
  }
  await saveSupervisorConfig(config);
  commandOk(flags, {
    removed: name,
    message: `removed supervisor agent ${name}`,
  });
}

async function commandSetAgentEnabled(positionals: string[], flags: SupervisorFlags, enabled: boolean) {
  const name = normalizeAgentName(getStringFlag(flags, ['name']) ?? positionals[1] ?? '');
  const config = await loadSupervisorConfig();
  const agent = requireAgent(config, name);
  agent.enabled = enabled;
  if (!enabled) {
    agent.wake.enabled = false;
  }
  await saveSupervisorConfig(config);
  commandOk(flags, {
    agent: agentStatus(agent),
    message: `${enabled ? 'enabled' : 'disabled'} supervisor agent ${name}`,
  });
}

async function commandSetWakeEnabled(positionals: string[], flags: SupervisorFlags, enabled: boolean) {
  const name = normalizeAgentName(getStringFlag(flags, ['name']) ?? positionals[1] ?? '');
  const config = await loadSupervisorConfig();
  const agent = requireAgent(config, name);
  agent.wake.enabled = enabled;
  if (enabled) {
    const requestedMode = getWakeAccessModeFlag(flags);
    if (!requestedMode) {
      agent.wake.accessMode = 'allow_list';
    }
    config.defaultWakePolicy = {
      ...config.defaultWakePolicy,
      wakeOnDirectMessage: getOptionalBooleanFlag(flags, ['direct']) ?? true,
      wakeOnMention: getOptionalBooleanFlag(flags, ['mention']) ?? true,
      wakeOnGroupMessage: getOptionalBooleanFlag(flags, ['group']) ?? false,
      acceptsNewConversations: getOptionalBooleanFlag(flags, ['new-conversations', 'acceptsNewConversations']) ?? true,
    };
  }
  applyWakeAccessFlags(agent, flags, config);
  await saveSupervisorConfig(config);
  commandOk(flags, {
    agent: agentStatus(agent),
    defaultWakePolicy: config.defaultWakePolicy,
    message: `${enabled ? 'enabled' : 'disabled'} wake for supervisor agent ${name}`,
  });
}

async function commandSetWakeAccess(positionals: string[], flags: SupervisorFlags) {
  const name = normalizeAgentName(getStringFlag(flags, ['name']) ?? positionals[1] ?? '');
  const config = await loadSupervisorConfig();
  const agent = requireAgent(config, name);
  applyWakeAccessFlags(agent, flags, config);
  await saveSupervisorConfig(config);
  commandOk(flags, {
    agent: agentStatus(agent),
    message: `updated wake access for supervisor agent ${name}`,
  });
}

async function commandRequestWakeChange(positionals: string[], flags: SupervisorFlags) {
  const name = normalizeAgentName(getStringFlag(flags, ['name']) ?? positionals[1] ?? '');
  const request = await createWakeChangeRequest({
    agentName: name,
    requestedBy: getStringFlag(flags, ['requested-by', 'requestedBy']) ?? 'agent-runtime',
    reason: getStringFlag(flags, ['reason']),
    desired: wakeChangePatchFromFlags(flags),
  });
  commandOk(flags, {
    request,
    message: `recorded wake change request ${request.id} for supervisor agent ${name}`,
  });
}

async function commandWakeChangeRequests(flags: SupervisorFlags) {
  const rawStatus = getStringFlag(flags, ['status']) ?? 'pending';
  const normalizedStatus = rawStatus === 'all'
    ? 'all'
    : rawStatus === 'pending' || rawStatus === 'approved' || rawStatus === 'denied'
      ? rawStatus
      : undefined;
  if (!normalizedStatus) {
    throw new Error('status must be pending, approved, denied, or all');
  }
  const requests = await listWakeChangeRequests({
    agentName: getStringFlag(flags, ['agent', 'name']),
    status: normalizedStatus as WakeChangeRequestStatus | 'all',
  });
  if (getBooleanFlag(flags, ['json'])) {
    writeJson({ ok: true, requests });
    return;
  }
  if (requests.length === 0) {
    writeStdout('No wake change requests.');
    return;
  }
  for (const request of requests) {
    writeStdout(`${request.status} ${request.id} ${request.agentName} ${JSON.stringify(request.desired)}`);
  }
}

async function commandApproveWakeChangeRequest(positionals: string[], flags: SupervisorFlags) {
  const id = getStringFlag(flags, ['id']) ?? positionals[1] ?? '';
  if (!id) {
    throw new Error('approve-request requires a request id');
  }
  const requests = await listWakeChangeRequests({ status: 'pending' });
  const pending = requests.find(request => request.id === id);
  if (!pending) {
    throw new Error(`Unknown pending wake change request '${id}'`);
  }
  const config = await loadSupervisorConfig();
  const agent = requireAgent(config, pending.agentName);
  applyWakeChangePatch(agent, pending.desired, flags, config);
  await saveSupervisorConfig(config);
  const request = await resolveWakeChangeRequest({
    id,
    status: 'approved',
    resolvedBy: getStringFlag(flags, ['resolved-by', 'resolvedBy']) ?? 'supervisor-admin',
    resolutionNote: getStringFlag(flags, ['note']),
  });
  commandOk(flags, {
    request,
    agent: agentStatus(agent),
    message: `approved wake change request ${id}`,
  });
}

async function commandDenyWakeChangeRequest(positionals: string[], flags: SupervisorFlags) {
  const id = getStringFlag(flags, ['id']) ?? positionals[1] ?? '';
  if (!id) {
    throw new Error('deny-request requires a request id');
  }
  const request = await resolveWakeChangeRequest({
    id,
    status: 'denied',
    resolvedBy: getStringFlag(flags, ['resolved-by', 'resolvedBy']) ?? 'supervisor-admin',
    resolutionNote: getStringFlag(flags, ['note']),
  });
  commandOk(flags, {
    request,
    message: `denied wake change request ${id}`,
  });
}

async function commandOpenWakeApproval(positionals: string[], flags: SupervisorFlags) {
  const action = getStringFlag(flags, ['action']) ?? positionals[1] ?? 'status';
  const config = await loadSupervisorConfigOrDefault();
  if (action === 'status') {
    const status = openWakeApprovalStatus(config);
    commandOk(flags, {
      openWakeApproval: status,
      message: `open wake approval mode: ${status.mode}`,
    });
    return;
  }
  if (action === 'set-passphrase' || action === 'set-password' || action === 'set') {
    const passphrase =
      getStringFlag(flags, ['passphrase', 'password']) ?? getOpenWakeApprovalPassphrase(flags);
    if (!passphrase) {
      throw new Error('set-passphrase requires --passphrase or AGENTTALK_OPEN_WAKE_APPROVAL_PASSPHRASE');
    }
    setOpenWakeApprovalPassphrase(config, passphrase);
    await saveSupervisorConfig(config);
    commandOk(flags, {
      openWakeApproval: openWakeApprovalStatus(config),
      message: 'open wake approval passphrase configured',
    });
    return;
  }
  if (action === 'clear' || action === 'off' || action === 'disable') {
    clearOpenWakeApprovalPassphrase(config);
    await saveSupervisorConfig(config);
    commandOk(flags, {
      openWakeApproval: openWakeApprovalStatus(config),
      message: 'open wake approval passphrase cleared',
    });
    return;
  }
  throw new Error('open-wake-approval action must be status, set-passphrase, or clear');
}

async function commandList(flags: SupervisorFlags) {
  const config = await loadSupervisorConfigOrDefault();
  const agents = config.agents.map(agent => redactConfig({ ...config, agents: [agent] }).agents[0]);
  if (getBooleanFlag(flags, ['json'])) {
    writeJson({ ok: true, agents });
    return;
  }
  if (agents.length === 0) {
    writeStdout('No supervisor agents configured.');
    return;
  }
  for (const agent of agents) {
    writeStdout(`${agent.enabled ? 'enabled ' : 'disabled'} @${agent.handle} ${agent.kind} ${agent.name}`);
  }
}

async function commandStatus(flags: SupervisorFlags) {
  if (getBooleanFlag(flags, ['live'])) {
    const live = await inspectSupervisorLiveStatus();
    if (getBooleanFlag(flags, ['json'])) {
      writeJson(live);
      return;
    }
    writeStdout(`supervisor live status inspected: ${live.agents.length} agent(s)`);
    return;
  }
  const config = await loadSupervisorConfigOrDefault();
  const agents = await Promise.all(config.agents.map(agentStatusWithState));
  const payload = {
    running: false,
    configPath: '[redacted]',
    host: config.host,
    databaseName: config.databaseName,
    agents,
  };
  if (getBooleanFlag(flags, ['json'])) {
    writeJson({ ok: true, ...payload });
    return;
  }
  writeStdout(`supervisor configured: ${payload.agents.length} agent(s), running=false`);
}

async function commandDoctor(flags: SupervisorFlags) {
  const config = await loadSupervisorConfigOrDefault();
  await ensureSupervisorDirs(config);
  const checks: SupervisorDoctorCheck[] = [
    { name: 'config_load', ok: true, detail: 'supervisor config loaded' },
    { name: 'directory_create', ok: true, detail: 'supervisor log/run directories are writable' },
    {
      name: 'agent_count',
      ok: config.agents.length >= 0,
      count: config.agents.length,
      detail: `${config.agents.length} agent(s) configured`,
    },
  ];
  for (const agent of config.agents) {
    checks.push(...(await checkAgentDoctor(agent)));
  }
  const ok = checks.every(check => check.ok);
  const payload = {
    ok,
    config: redactConfig(config),
    checks,
    message: ok
      ? 'agenttalk supervisor doctor passed local config checks'
      : 'agenttalk supervisor doctor found local config issues',
  };
  if (getBooleanFlag(flags, ['json'])) {
    writeJson(payload);
  } else {
    writeStdout(`doctor: ${ok ? 'ok' : 'failed'}`);
    for (const check of checks) {
      const prefix = check.ok ? 'ok' : 'fail';
      const agent = check.agent ? ` ${check.agent}` : '';
      writeStdout(`${prefix} ${check.name}${agent}: ${check.detail}`);
    }
  }
  if (!ok) {
    process.exitCode = 1;
  }
}

async function commandTestWake(positionals: string[], flags: SupervisorFlags) {
  const config = await loadSupervisorConfig();
  const agent = requireAgent(config, getStringFlag(flags, ['name']) ?? positionals[1] ?? '');
  const wakeId = `test-${Date.now().toString(36)}`;
  const attemptId = `${wakeId}-attempt-1`;
  const runDir = path.join(config.runDir, wakeId, attemptId);
  await fs.mkdir(runDir, { recursive: true });
  await fs.chmod(runDir, 0o700).catch(() => undefined);
  const input = {
    agentName: agent.name,
    handle: agent.handle,
    agentId: null,
    stateDir: '[redacted]',
    wake: {
      wakeId,
      conversationId: '0',
      minSequence: '0',
      maxSequence: '0',
      reason: 'manual_test',
    },
    attemptId,
    contextMessages: [],
    payload: {
      type: 'agenttalk.wake' as const,
      version: '1' as const,
      wakeId,
      recipientAgentId: 'test-agent-id',
      conversationId: '0',
      minSequence: '0',
      maxSequence: '0',
      reason: 'manual_test',
      issuedAt: new Date().toISOString(),
      nonce: wakeId,
    },
  };
  const now = new Date();
  const result = await executeWakeConnector(
    config,
    agent,
    {
      agentName: agent.name,
      handle: agent.handle,
      agentId: 'test-agent-id',
      stateDir: agent.stateDir,
      repoPath: agent.repoPath,
      wake: {
        wakeId,
        wakeKey: wakeId,
        recipientAgentId: 'test-agent-id',
        recipientIdentity: undefined,
        senderAgentId: 'test-sender-agent-id',
        conversationId: 0n,
        minSequence: 0n,
        maxSequence: 0n,
        reason: 'manual_test',
        status: 'pending',
        priority: 'normal',
        attemptCount: 0n,
        nextAttemptAt: { toDate: () => now } as never,
        leaseUntil: undefined,
        createdAt: { toDate: () => now } as never,
        updatedAt: { toDate: () => now } as never,
        expiresAt: { toDate: () => new Date(now.getTime() + 600_000) } as never,
        suppressedReason: undefined,
        metadataJson: undefined,
      },
      attemptId,
      contextMessages: [],
      payload: input.payload,
    },
    runDir
  );
  await fs.writeFile(path.join(runDir, 'input.json'), stringifyJsonSafe(input), 'utf8');
  if (!result.ok || !result.handled) {
    throw new Error(result.error ?? result.message ?? `${agent.kind} connector did not handle test wake`);
  }
  commandOk(flags, {
    wakeId,
    attemptId,
    agent: agentStatus(agent),
    result,
    runDir: '[redacted]',
    message: `${agent.kind} wake test passed for ${agent.name}`,
  });
}

function launchAgentPlist(label: string, config: SupervisorConfig) {
  const envEntries = [
    ['AGENTTALK_SUPERVISOR_CONFIG', supervisorConfigPath()],
    ['AGENTTALK_SUPERVISOR_HOME', path.dirname(supervisorConfigPath())],
  ];
  const environmentXml = envEntries
    .map(([key, value]) => `<key>${xmlEscape(key)}</key><string>${xmlEscape(value)}</string>`)
    .join('\n    ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(process.execPath)}</string>
    <string>${xmlEscape(supervisorEntrypoint())}</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    ${environmentXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(config.logDir, 'service.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(config.logDir, 'service.err.log'))}</string>
</dict>
</plist>
`;
}

function systemdUnit(config: SupervisorConfig) {
  const envLines = [
    `Environment=${systemdQuote(`AGENTTALK_SUPERVISOR_CONFIG=${supervisorConfigPath()}`)}`,
    `Environment=${systemdQuote(`AGENTTALK_SUPERVISOR_HOME=${path.dirname(supervisorConfigPath())}`)}`,
  ].join('\n');
  return `[Unit]
Description=AgentTalk Supervisor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${systemdQuote(process.execPath)} ${systemdQuote(supervisorEntrypoint())} run
Restart=always
RestartSec=5
${envLines}

[Install]
WantedBy=default.target
`;
}

function windowsServiceScript(config: SupervisorConfig) {
  return `$env:AGENTTALK_SUPERVISOR_CONFIG = ${quotePowerShell(supervisorConfigPath())}
$env:AGENTTALK_SUPERVISOR_HOME = ${quotePowerShell(path.dirname(supervisorConfigPath()))}
& ${quotePowerShell(process.execPath)} ${quotePowerShell(supervisorEntrypoint())} run
exit $LASTEXITCODE
`;
}

async function commandInstallService(flags: SupervisorFlags) {
  const config = await loadSupervisorConfigOrDefault();
  await ensureSupervisorDirs(config);
  const dryRun = getBooleanFlag(flags, ['dry-run', 'dryRun']);
  const noStart = getBooleanFlag(flags, ['no-start', 'noStart']);
  const name = serviceName(flags);
  const actions: string[] = [];
  let servicePath: string;
  let installed = false;
  let started = false;
  let platform = process.platform;

  if (platform === 'darwin') {
    const label = name.includes('.') ? name : `com.${name}`;
    servicePath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    if (!dryRun) {
      await fs.mkdir(path.dirname(servicePath), { recursive: true });
      await fs.writeFile(servicePath, launchAgentPlist(label, config), 'utf8');
      installed = true;
      actions.push('wrote launch agent plist');
      if (!noStart) {
        const uid = os.userInfo().uid;
        await runCommand('launchctl', ['bootout', `gui/${uid}`, servicePath]).catch(() => undefined);
        await runCommand('launchctl', ['bootstrap', `gui/${uid}`, servicePath]);
        await runCommand('launchctl', ['enable', `gui/${uid}/${label}`]).catch(() => undefined);
        started = true;
        actions.push('loaded launch agent');
      }
    }
  } else if (platform === 'linux') {
    servicePath = path.join(os.homedir(), '.config', 'systemd', 'user', `${name}.service`);
    if (!dryRun) {
      await fs.mkdir(path.dirname(servicePath), { recursive: true });
      await fs.writeFile(servicePath, systemdUnit(config), 'utf8');
      installed = true;
      actions.push('wrote systemd user service');
      await runCommand('systemctl', ['--user', 'daemon-reload']);
      if (!noStart) {
        await runCommand('systemctl', ['--user', 'enable', '--now', `${name}.service`]);
        started = true;
        actions.push('enabled systemd user service');
      }
    }
  } else if (platform === 'win32') {
    platform = 'win32';
    servicePath = path.join(path.dirname(supervisorConfigPath()), `${name}.ps1`);
    if (!dryRun) {
      await fs.writeFile(servicePath, windowsServiceScript(config), 'utf8');
      installed = true;
      actions.push('wrote Windows start script');
    }
  } else {
    throw new Error(`Unsupported service platform: ${platform}`);
  }

  commandOk(flags, {
    platform,
    installed,
    started,
    dryRun,
    servicePath: '[redacted]',
    actions,
    message: dryRun
      ? `service install dry run for ${platform}`
      : `service install prepared for ${platform}${started ? ' and started' : ''}`,
  });
}

async function commandUninstallService(flags: SupervisorFlags) {
  const name = serviceName(flags);
  const dryRun = getBooleanFlag(flags, ['dry-run', 'dryRun']);
  const actions: string[] = [];
  let servicePath: string;
  let removed = false;
  let platform = process.platform;

  if (platform === 'darwin') {
    const label = name.includes('.') ? name : `com.${name}`;
    servicePath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    if (!dryRun) {
      const uid = os.userInfo().uid;
      await runCommand('launchctl', ['bootout', `gui/${uid}`, servicePath]).catch(() => undefined);
      await fs.rm(servicePath, { force: true });
      removed = true;
      actions.push('unloaded and removed launch agent plist');
    }
  } else if (platform === 'linux') {
    servicePath = path.join(os.homedir(), '.config', 'systemd', 'user', `${name}.service`);
    if (!dryRun) {
      await runCommand('systemctl', ['--user', 'disable', '--now', `${name}.service`]).catch(() => undefined);
      await fs.rm(servicePath, { force: true });
      await runCommand('systemctl', ['--user', 'daemon-reload']).catch(() => undefined);
      removed = true;
      actions.push('disabled and removed systemd user service');
    }
  } else if (platform === 'win32') {
    platform = 'win32';
    servicePath = path.join(path.dirname(supervisorConfigPath()), `${name}.ps1`);
    if (!dryRun) {
      await fs.rm(servicePath, { force: true });
      removed = true;
      actions.push('removed Windows start script');
    }
  } else {
    throw new Error(`Unsupported service platform: ${platform}`);
  }

  commandOk(flags, {
    platform,
    removed,
    dryRun,
    servicePath: '[redacted]',
    actions,
    message: dryRun ? `service uninstall dry run for ${platform}` : `service removed for ${platform}`,
  });
}

async function readLastLines(filePath: string, tail: number) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    return tail > 0 ? lines.slice(-tail) : lines;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function commandLogs(positionals: string[], flags: SupervisorFlags) {
  const config = await loadSupervisorConfigOrDefault();
  const agentName = getStringFlag(flags, ['agent']) ?? positionals[1];
  if (agentName) {
    requireAgent(config, agentName);
  }
  const tail = getIntFlag(flags, ['tail'], 100);
  const fileName = agentName ? `${normalizeAgentName(agentName)}.jsonl` : 'supervisor.jsonl';
  const lines = await readLastLines(path.join(config.logDir, fileName), tail);
  if (getBooleanFlag(flags, ['json'])) {
    writeJson({
      ok: true,
      agent: agentName ? normalizeAgentName(agentName) : null,
      tail,
      logPath: '[redacted]',
      lines,
      events: lines.map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line };
        }
      }),
    });
    return;
  }
  for (const line of lines) {
    writeStdout(line);
  }
}

async function commandRunLike(subcommand: string, flags: SupervisorFlags) {
  const durationMs = getIntFlag(flags, ['duration-ms', 'durationMs'], 0);
  const result = await runSupervisor({
    once: getBooleanFlag(flags, ['once']),
    durationMs: durationMs > 0 ? durationMs : undefined,
    pollMs: getIntFlag(flags, ['poll-ms', 'pollMs'], 1000),
    json: getBooleanFlag(flags, ['json']),
  });
  if (getBooleanFlag(flags, ['json'])) {
    writeJson({ mode: subcommand, ...result });
    return;
  }
  if (result.running) {
    writeStdout(`supervisor running with ${result.agents.length} agent(s)`);
    return;
  }
  writeStdout(result.message ?? `supervisor ${subcommand} completed`);
}

function printHelp() {
  writeStdout(`AgentTalk supervisor

Usage:
  agenttalk supervisor init [--force] [--json]
  agenttalk supervisor init --wizard [--dry-run] [--json]
  agenttalk supervisor add-agent --kind noop --name support --handle support-agent [--wake-access allow-list|open] [--allow-senders agent-id[,agent-id]] [--block-senders agent-id[,agent-id]] [--send-reply-text] [--json]
  agenttalk supervisor remove-agent <name> [--json]
  agenttalk supervisor enable-agent <name> [--json]
  agenttalk supervisor disable-agent <name> [--json]
  agenttalk supervisor wake-on <name> [--direct true|false] [--mention true|false] [--wake-access allow-list|open] [--allow-senders agent-id[,agent-id]] [--block-senders agent-id[,agent-id]] [--json]
  agenttalk supervisor wake-off <name> [--json]
  agenttalk supervisor wake-access <name> [--wake-access allow-list|open] [--i-understand-open-wake-risk] [--open-wake-approval-passphrase text] [--allow-senders agent-id[,agent-id]|--clear-allow-senders] [--block-senders agent-id[,agent-id]|--clear-block-senders] [--json]
  agenttalk supervisor request-wake-change <name> [--wake-enabled true|false] [--wake-access allow-list|open] [--allow-senders agent-id[,agent-id]] [--block-senders agent-id[,agent-id]] [--reason text] [--json]
  agenttalk supervisor requests [--agent name] [--status pending|approved|denied|all] [--json]
  agenttalk supervisor approve-request <id> [--i-understand-open-wake-risk] [--open-wake-approval-passphrase text] [--json]
  agenttalk supervisor deny-request <id> [--note text] [--json]
  agenttalk supervisor open-wake-approval status|set-passphrase|clear [--passphrase text] [--json]
  agenttalk supervisor list [--json]
  agenttalk supervisor status [--live] [--json]
  agenttalk supervisor doctor [--json]
  agenttalk supervisor test-wake <name> [--json]
  agenttalk supervisor run [--once] [--duration-ms 30000] [--json]
  agenttalk supervisor install-service [--no-start] [--dry-run] [--json]
  agenttalk supervisor uninstall-service [--dry-run] [--json]
  agenttalk supervisor logs [--agent support] [--tail 100] [--json]

The run command configures enabled agents as non-presence supervisor clients, claims pending wakes, dispatches connectors, and ack/fails wake attempts.`);
}

export async function runSupervisorCommand(positionals: string[], flags: SupervisorFlags) {
  const subcommand = positionals[0] ?? 'help';
  if (subcommand === 'help' || subcommand === '--help') {
    printHelp();
    return;
  }
  if (subcommand === 'init') {
    await commandInit(flags);
    return;
  }
  if (subcommand === 'add-agent') {
    await commandAddAgent(flags);
    return;
  }
  if (subcommand === 'remove-agent' || subcommand === 'remove') {
    await commandRemoveAgent(positionals, flags);
    return;
  }
  if (subcommand === 'enable-agent' || subcommand === 'agent-on') {
    await commandSetAgentEnabled(positionals, flags, true);
    return;
  }
  if (subcommand === 'disable-agent' || subcommand === 'agent-off') {
    await commandSetAgentEnabled(positionals, flags, false);
    return;
  }
  if (subcommand === 'wake-on' || subcommand === 'enable-wake') {
    await commandSetWakeEnabled(positionals, flags, true);
    return;
  }
  if (subcommand === 'wake-off' || subcommand === 'disable-wake') {
    await commandSetWakeEnabled(positionals, flags, false);
    return;
  }
  if (subcommand === 'wake-access' || subcommand === 'wake-policy') {
    await commandSetWakeAccess(positionals, flags);
    return;
  }
  if (subcommand === 'request-wake-change' || subcommand === 'wake-request') {
    await commandRequestWakeChange(positionals, flags);
    return;
  }
  if (subcommand === 'requests' || subcommand === 'wake-requests') {
    await commandWakeChangeRequests(flags);
    return;
  }
  if (subcommand === 'approve-request' || subcommand === 'approve-wake-request') {
    await commandApproveWakeChangeRequest(positionals, flags);
    return;
  }
  if (subcommand === 'deny-request' || subcommand === 'deny-wake-request') {
    await commandDenyWakeChangeRequest(positionals, flags);
    return;
  }
  if (subcommand === 'open-wake-approval' || subcommand === 'open-wake-gate') {
    await commandOpenWakeApproval(positionals, flags);
    return;
  }
  if (subcommand === 'list') {
    await commandList(flags);
    return;
  }
  if (subcommand === 'status') {
    await commandStatus(flags);
    return;
  }
  if (subcommand === 'doctor') {
    await commandDoctor(flags);
    return;
  }
  if (subcommand === 'test-wake') {
    await commandTestWake(positionals, flags);
    return;
  }
  if (subcommand === 'run' || subcommand === 'start') {
    await commandRunLike(subcommand, flags);
    return;
  }
  if (subcommand === 'install-service') {
    await commandInstallService(flags);
    return;
  }
  if (subcommand === 'uninstall-service') {
    await commandUninstallService(flags);
    return;
  }
  if (subcommand === 'logs' || subcommand === 'events') {
    await commandLogs(positionals, flags);
    return;
  }
  throw new Error(`Unknown supervisor command: ${subcommand}`);
}

export function parseSupervisorArgs(argv: string[]) {
  const flags: SupervisorFlags = {};
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const equals = token.indexOf('=');
    if (equals > 2) {
      flags[token.slice(2, equals)] = token.slice(equals + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    index += 1;
  }
  return { flags, positionals };
}
