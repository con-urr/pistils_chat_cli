import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  defaultAgentStateDir,
  defaultSupervisorConfig,
  ensureSupervisorDirs,
  expandHome,
  loadSupervisorConfig,
  loadSupervisorConfigOrDefault,
  normalizeAgentName,
  normalizeHandle,
  normalizeKind,
  redactConfig,
  saveSupervisorConfig,
  supervisorConfigPath,
  type SupervisorAgentConfig,
  type SupervisorConfig,
} from './config';
import { executeWakeConnector } from './connectors';
import { stringifyJsonSafe } from './json';
import { runSupervisor } from './runtime';

export type SupervisorFlags = Record<string, string | boolean>;

function writeStdout(line: string) {
  process.stdout.write(`${line}\n`);
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

function runCommand(command: string, args: string[]) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
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

function agentStatus(agent: SupervisorAgentConfig) {
  return {
    name: agent.name,
    handle: agent.handle,
    agentId: null,
    kind: agent.kind,
    enabled: agent.enabled,
    wakeable: agent.enabled,
    availability: agent.enabled ? 'configured' : 'disabled',
    pendingWakes: 0,
    runningJobs: 0,
    lastWakeAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    failureCount: '0',
    connectorTimeoutMs: agent.connectorTimeoutMs,
    maxConcurrentWakeJobs: agent.maxConcurrentWakeJobs,
  };
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
  const connector =
    openclawAgentId && kind === 'openclaw'
      ? { openclawAgentId, sendReplyText: sendReplyText || undefined }
      : sendReplyText
        ? { sendReplyText }
        : undefined;
  const agent: SupervisorAgentConfig = {
    name,
    handle,
    kind,
    stateDir,
    repoPath: getStringFlag(flags, ['repo', 'repo-path', 'repoPath'])
      ? path.resolve(expandHome(getStringFlag(flags, ['repo', 'repo-path', 'repoPath'])!))
      : undefined,
    command: getStringFlag(flags, ['command']),
    connector,
    enabled: !getBooleanFlag(flags, ['disabled']),
    autoInit: !getBooleanFlag(flags, ['no-auto-init']),
    maxConcurrentWakeJobs,
    connectorTimeoutMs: timeoutMs,
    wake: {
      latencyMs: getIntFlag(flags, ['latency-ms', 'latencyMs'], 1000),
      statusText: getStringFlag(flags, ['status-text', 'statusText']) ?? `${name} ready`,
      reasons: ['direct_message', 'mention'],
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
  const config = await loadSupervisorConfigOrDefault();
  const payload = {
    running: false,
    configPath: '[redacted]',
    host: config.host,
    databaseName: config.databaseName,
    agents: config.agents.map(agentStatus),
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
  commandOk(flags, {
    config: redactConfig(config),
    checks: [
      { name: 'config_load', ok: true },
      { name: 'directory_create', ok: true },
      { name: 'agent_count', ok: config.agents.length >= 0, count: config.agents.length },
    ],
    message: 'agenttalk supervisor doctor passed local config checks',
  });
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
  agenttalk supervisor add-agent --kind noop --name support --handle support-agent [--send-reply-text] [--json]
  agenttalk supervisor remove-agent <name> [--json]
  agenttalk supervisor list [--json]
  agenttalk supervisor status [--json]
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
