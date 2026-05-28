import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AgentRealtimeClient, AgentTalkWakeClient } from '../agent-client';
import type * as ModuleTypes from '../module_bindings/types';
import { createWakeDispatchPayload } from '../wake';
import {
  allowedWakeSenderAgentIdsJson,
  ensureSupervisorDirs,
  expandHome,
  loadSupervisorConfigOrDefault,
  normalizeControlProfile,
  normalizeWakeSenderAgentIds,
  type SupervisorAgentConfig,
  type SupervisorConfig,
  wakeAccessMode,
  wakeSenderAgentIdsJson,
} from './config';
import { executeWakeConnector, type WakeConnectorResult } from './connectors';
import { stringifyJsonSafe, toJsonSafe } from './json';
import { loadAgentState, saveAgentState } from './state';

type RuntimeAgent = {
  config: SupervisorAgentConfig;
  realtime: AgentRealtimeClient;
  wakeClient: AgentTalkWakeClient;
  agentId: string;
  connectorStateDir: string;
  registrationId: string;
  inFlightWakeIds: Set<string>;
  jobs: Set<Promise<void>>;
  stats: {
    claimed: number;
    acked: number;
    failed: number;
    skipped: number;
    lastWakeAt?: string;
    lastSuccessAt?: string;
    lastFailureAt?: string;
    failureCount: number;
  };
};

type WakeDispatchLock = {
  lockPath: string;
  release: () => Promise<void>;
};

export type SupervisorRunOptions = {
  once?: boolean;
  durationMs?: number;
  pollMs?: number;
  json?: boolean;
};

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function timestampMs(value: { toDate?: () => Date } | undefined) {
  try {
    return value?.toDate?.().getTime() ?? 0;
  } catch {
    return 0;
  }
}

function wakeSort(left: ModuleTypes.WakeRequestView, right: ModuleTypes.WakeRequestView) {
  return timestampMs(left.createdAt) - timestampMs(right.createdAt);
}

function supervisorRegistrationId(agentId: string) {
  return `${agentId}:agenttalk-supervisor`;
}

function safePathSegment(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, '_');
}

function shortClientRequestId(prefix: string, value: string) {
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 24);
  return `${prefix}:${digest}`;
}

function lockPidIsAlive(pid: unknown) {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireWakeDispatchLock(
  runtime: RuntimeAgent,
  wake: ModuleTypes.WakeRequestView,
  attemptId: string
): Promise<WakeDispatchLock | { busy: string }> {
  const lockDir = path.join(runtime.connectorStateDir, 'locks');
  await fs.mkdir(lockDir, { recursive: true });
  await fs.chmod(lockDir, 0o700).catch(() => undefined);
  const lockPath = path.join(lockDir, 'connector-dispatch.lock');
  const startedAt = Date.now();
  const metadata = {
    pid: process.pid,
    agentName: runtime.config.name,
    agentId: runtime.agentId,
    wakeId: wake.wakeId,
    attemptId,
    startedAt: new Date(startedAt).toISOString(),
  };

  const create = async (): Promise<WakeDispatchLock> => {
    const handle = await fs.open(lockPath, 'wx');
    await handle.writeFile(`${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    await handle.close();
    await fs.chmod(lockPath, 0o600).catch(() => undefined);
    return {
      lockPath,
      release: async () => {
        await fs.unlink(lockPath).catch(() => undefined);
      },
    };
  };

  try {
    return await create();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }

  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await fs.readFile(lockPath, 'utf8')) as Record<string, unknown>;
  } catch {
    existing = {};
  }
  const existingStarted = typeof existing.startedAt === 'string'
    ? Date.parse(existing.startedAt)
    : 0;
  const staleMs = Math.max(runtime.config.connectorTimeoutMs + 120_000, 300_000);
  const stale =
    !lockPidIsAlive(existing.pid) ||
    !Number.isFinite(existingStarted) ||
    Date.now() - existingStarted > staleMs;
  if (stale) {
    await fs.unlink(lockPath).catch(() => undefined);
    try {
      return await create();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
  }

  return {
    busy: `runtime_busy: connector dispatch already active for wake ${String(existing.wakeId ?? 'unknown')}`,
  };
}

async function appendLog(
  config: SupervisorConfig,
  agent: SupervisorAgentConfig | undefined,
  event: Record<string, unknown>
) {
  await fs.mkdir(config.logDir, { recursive: true });
  const row = stringifyJsonSafe({
    ...event,
    at: new Date().toISOString(),
    agent: agent?.name,
  }, false);
  await fs.appendFile(path.join(config.logDir, 'supervisor.jsonl'), row, 'utf8');
  if (agent) {
    await fs.appendFile(path.join(config.logDir, `${agent.name}.jsonl`), row, 'utf8');
  }
}

async function connectAgent(config: SupervisorConfig, agent: SupervisorAgentConfig) {
  const stateDir = path.resolve(expandHome(agent.stateDir));
  const state = await loadAgentState(stateDir);
  const realtime = await AgentRealtimeClient.connect({
    host: config.host,
    databaseName: config.databaseName,
    token: state.token,
    subscriptionProfile: 'wake',
  });
  await saveAgentState(stateDir, {
    ...state,
    host: config.host,
    databaseName: config.databaseName,
    token: realtime.token,
    identity: realtime.identityHex,
  });
  return realtime;
}

async function ensureAgentAccount(
  realtime: AgentRealtimeClient,
  agent: SupervisorAgentConfig
) {
  let profile = realtime.currentAgentProfile();
  if (!profile && agent.autoInit) {
    await realtime.createAccount({
      handle: agent.handle,
      displayName: agent.name,
      role: 'agent',
      bio: `${agent.kind} agent managed by AgentTalk supervisor`,
      clientRequestId: `supervisor:init:${agent.name}`,
    });
    await realtime.requestAccountDirectory({ handle: agent.handle, limit: 1n });
    await sleep(500);
    profile = realtime.currentAgentProfile();
  }

  if (!profile) {
    throw new Error(
      `agent ${agent.name} has no AgentTalk account; run with autoInit or initialize ${agent.stateDir}`
    );
  }
  if (profile.handle !== agent.handle) {
    throw new Error(
      `state dir for ${agent.name} belongs to @${profile.handle}, not configured @${agent.handle}`
    );
  }
  return profile;
}

async function configureWake(
  config: SupervisorConfig,
  agent: SupervisorAgentConfig,
  realtime: AgentRealtimeClient,
  profile: ModuleTypes.AgentProfile
) {
  const wakeEnabled = agent.enabled && agent.wake.enabled === true;
  const wakeReasons = new Set(agent.wake.reasons ?? []);
  const registrationId = supervisorRegistrationId(profile.agentId);
  await realtime.heartbeat(
    wakeEnabled ? agent.wake.statusText : 'Wake disabled',
    'agenttalk-supervisor'
  );
  await realtime.registerWake({
    kind: 'local_daemon',
    agentId: profile.agentId,
    registrationId,
    enabled: wakeEnabled,
    metadataJson: JSON.stringify({
      supervisor: true,
      agentName: agent.name,
      connectorKind: agent.kind,
    }),
  });
  await realtime.setWakePolicy({
    agentId: profile.agentId,
    wakeOnDirectMessage:
      wakeEnabled && (wakeReasons.has('direct_message') || wakeReasons.has('direct')),
    wakeOnMention: wakeEnabled && wakeReasons.has('mention'),
    wakeOnGroupMessage: wakeEnabled && wakeReasons.has('group_message'),
    wakeOnHandoff: wakeEnabled && wakeReasons.has('handoff'),
    wakeOnBusinessInquiry: wakeEnabled && wakeReasons.has('business_inquiry'),
    acceptsNewConversations: wakeEnabled,
    coalesceWindowMs: BigInt(config.defaultWakePolicy.coalesceWindowMs),
    minWakeIntervalMs: BigInt(config.defaultWakePolicy.minWakeIntervalMs),
    maxWakesPerMinute: BigInt(config.defaultWakePolicy.maxWakesPerMinute),
    maxConcurrentWakeJobs: BigInt(agent.maxConcurrentWakeJobs),
    expectedWakeLatencyMs: BigInt(agent.wake.latencyMs),
    availabilityOverride: wakeEnabled ? 'wakeable' : 'offline',
    statusText: wakeEnabled ? agent.wake.statusText : 'Wake disabled',
    allowedWakeSenderAgentIdsJson: allowedWakeSenderAgentIdsJson(agent.wake),
    blockedWakeSenderAgentIdsJson: wakeSenderAgentIdsJson(agent.wake.blockedWakeSenderAgentIds),
  });
  return registrationId;
}

async function rememberAgentProfile(
  config: SupervisorConfig,
  agent: SupervisorAgentConfig,
  profile: ModuleTypes.AgentProfile
) {
  const stateDir = path.resolve(expandHome(agent.stateDir));
  const state = await loadAgentState(stateDir);
  await saveAgentState(stateDir, {
    ...state,
    host: config.host,
    databaseName: config.databaseName,
    agentId: profile.agentId,
    handle: profile.handle,
    registrationState: 'registered',
    lastProfileSyncAt: new Date().toISOString(),
  });
}

function agentStateDir(agent: SupervisorAgentConfig) {
  return path.resolve(expandHome(agent.stateDir));
}

function pluginRuntimeStateDir(agent: SupervisorAgentConfig) {
  return path.join(agentStateDir(agent), 'runtime');
}

async function ensurePluginManagedRuntimeCredential(
  config: SupervisorConfig,
  agent: SupervisorAgentConfig,
  adminRealtime: AgentRealtimeClient,
  profile: ModuleTypes.AgentProfile
) {
  const controlProfile = normalizeControlProfile(agent.controlProfile);
  if (controlProfile !== 'plugin_managed') {
    return agentStateDir(agent);
  }

  await adminRealtime.setAgentCredentialScope({
    identity: adminRealtime.identity,
    agentId: profile.agentId,
    credentialScope: 'admin',
    credentialLabel: `${agent.name} supervisor admin`,
  });

  const stateDir = pluginRuntimeStateDir(agent);
  const state = await loadAgentState(stateDir);
  const runtimeRealtime = await AgentRealtimeClient.connect({
    host: config.host,
    databaseName: config.databaseName,
    token: state.token,
    subscriptionProfile: 'direct',
  });
  try {
    await adminRealtime.bindAgentIdentity({
      identity: runtimeRealtime.identity,
      agentId: profile.agentId,
      deviceLabel: `${agent.name} plugin runtime`,
      credentialScope: 'plugin_runtime',
      credentialLabel: `${agent.name} plugin runtime`,
    });
    await saveAgentState(stateDir, {
      ...state,
      host: config.host,
      databaseName: config.databaseName,
      token: runtimeRealtime.token,
      identity: runtimeRealtime.identityHex,
      agentId: profile.agentId,
      handle: profile.handle,
      credentialScope: 'plugin_runtime',
      credentialLabel: `${agent.name} plugin runtime`,
      registrationState: 'registered',
      lastProfileSyncAt: new Date().toISOString(),
    });
  } finally {
    runtimeRealtime.disconnect();
  }
  return stateDir;
}

async function prepareAgent(config: SupervisorConfig, agent: SupervisorAgentConfig) {
  const realtime = await connectAgent(config, agent);
  try {
    const profile = await ensureAgentAccount(realtime, agent);
    const registrationId = await configureWake(config, agent, realtime, profile);
    await rememberAgentProfile(config, agent, profile);
    const connectorStateDir = await ensurePluginManagedRuntimeCredential(
      config,
      agent,
      realtime,
      profile
    );
    const runtime: RuntimeAgent = {
      config: agent,
      realtime,
      wakeClient: new AgentTalkWakeClient(realtime),
      agentId: profile.agentId,
      connectorStateDir,
      registrationId,
      inFlightWakeIds: new Set<string>(),
      jobs: new Set<Promise<void>>(),
      stats: {
        claimed: 0,
        acked: 0,
        failed: 0,
        skipped: 0,
        failureCount: 0,
      },
    };
    await appendLog(config, agent, {
      event: 'agent_ready',
      handle: agent.handle,
      kind: agent.kind,
      agentId: profile.agentId,
    });
    return runtime;
  } catch (error) {
    realtime.disconnect();
    throw error;
  }
}

function latestAttempt(
  realtime: AgentRealtimeClient,
  wakeId: string
): ModuleTypes.WakeAttemptView | undefined {
  return realtime
    .listWakeAttempts(wakeId)
    .sort((left, right) =>
      left.attemptNumber < right.attemptNumber
        ? 1
        : left.attemptNumber > right.attemptNumber
          ? -1
          : 0
    )[0];
}

async function dispatchWake(
  config: SupervisorConfig,
  runtime: RuntimeAgent,
  wake: ModuleTypes.WakeRequestView
) {
  const agent = runtime.config;
  runtime.stats.lastWakeAt = new Date().toISOString();
  let attemptId: string | undefined;
  try {
    await runtime.realtime.claimWakeRequest({
      wakeId: wake.wakeId,
      registrationId: runtime.registrationId,
      leaseMs: BigInt(agent.connectorTimeoutMs + 60_000),
      metadataJson: JSON.stringify({
        supervisor: true,
        agentName: agent.name,
        connectorKind: agent.kind,
      }),
    });
    runtime.stats.claimed += 1;
    await sleep(250);

    const claimedWake =
      runtime.realtime
        .listWakeRequests({ includeDispatcher: true })
        .find(row => row.wakeId === wake.wakeId) ?? wake;
    const attempt = latestAttempt(runtime.realtime, wake.wakeId);
    attemptId = attempt?.attemptId;
    if (!attemptId) {
      throw new Error(`Wake ${wake.wakeId} was claimed but no attempt row is visible`);
    }

    const localDenial = localWakeDenial(runtime, claimedWake);
    if (localDenial) {
      await failWake(config, runtime, wake.wakeId, attemptId, {
        ok: false,
        handled: false,
        replySent: false,
        message: localDenial,
        error: localDenial,
      });
      return;
    }

    const dispatchLock = await acquireWakeDispatchLock(runtime, claimedWake, attemptId);
    if ('busy' in dispatchLock) {
      await failWake(config, runtime, wake.wakeId, attemptId, {
        ok: false,
        handled: false,
        replySent: false,
        message: dispatchLock.busy,
        error: dispatchLock.busy,
        metadata: { reason: 'runtime_busy' },
      });
      return;
    }

    await runtime.realtime.markWakeDispatched(
      wake.wakeId,
      attemptId,
      JSON.stringify({ supervisor: true, agentName: agent.name })
    );
    try {
      const contextMessages = await runtime.wakeClient.fetchWakeContext(claimedWake);
      const payload = createWakeDispatchPayload(claimedWake);
      const runDir = path.join(config.runDir, safePathSegment(wake.wakeId), safePathSegment(attemptId));
      const result = await executeWakeConnector(
        config,
        agent,
        {
          agentName: agent.name,
          handle: agent.handle,
          agentId: runtime.agentId,
          stateDir: runtime.connectorStateDir,
          repoPath: agent.repoPath,
          wake: claimedWake,
          attemptId,
          contextMessages,
          payload,
        },
        runDir
      );

      const finalResult = await maybeSendConnectorReply(runtime, claimedWake, attemptId, result);
      if (finalResult.ok && finalResult.handled) {
        await runtime.wakeClient.ackWake(
          wake.wakeId,
          attemptId
        );
        runtime.stats.acked += 1;
        runtime.stats.lastSuccessAt = new Date().toISOString();
        await appendLog(config, agent, {
          event: 'wake_acked',
          wakeId: wake.wakeId,
          attemptId,
          result: toJsonSafe(finalResult),
        });
        return;
      }

      await failWake(config, runtime, wake.wakeId, attemptId, finalResult);
    } finally {
      await dispatchLock.release();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (attemptId) {
      await runtime.wakeClient.failWake(wake.wakeId, message, attemptId);
    }
    runtime.stats.failed += 1;
    runtime.stats.failureCount += 1;
    runtime.stats.lastFailureAt = new Date().toISOString();
    await appendLog(config, agent, {
      event: 'wake_failed',
      wakeId: wake.wakeId,
      attemptId,
      error: message,
    });
  }
}

function localWakeDenial(runtime: RuntimeAgent, wake: ModuleTypes.WakeRequestView) {
  const agent = runtime.config;
  if (!agent.enabled) {
    return 'local wake denied: connector disabled';
  }
  if (agent.wake.enabled !== true) {
    return 'local wake denied: wake disabled';
  }
  if (wake.recipientAgentId !== runtime.agentId) {
    return 'local wake denied: target agent mismatch';
  }
  const senderAgentId = wake.senderAgentId;
  const blocked = normalizeWakeSenderAgentIds(
    agent.wake.blockedWakeSenderAgentIds,
    'Blocked wake senders'
  );
  if (blocked.includes(senderAgentId)) {
    return 'local wake denied: sender blocked';
  }
  const accessMode = wakeAccessMode(agent.wake);
  if (accessMode === 'allow_list') {
    const allowed = normalizeWakeSenderAgentIds(
      agent.wake.allowedWakeSenderAgentIds,
      'Allowed wake senders'
    );
    if (!allowed.includes(senderAgentId)) {
      return 'local wake denied: sender not in allow list';
    }
  }
  return null;
}

async function maybeSendConnectorReply(
  runtime: RuntimeAgent,
  wake: ModuleTypes.WakeRequestView,
  attemptId: string,
  result: WakeConnectorResult
): Promise<WakeConnectorResult> {
  const replyText = result.replyText?.trim();
  if (
    !runtime.config.connector?.sendReplyText ||
    result.replySent ||
    !replyText
  ) {
    return result;
  }

  const replyRequestId = await runtime.realtime.sendConversationMessage(
    wake.conversationId,
    replyText,
    {
      kind: 'chat',
      correlationId: wake.wakeId,
      metadataJson: stringifyJsonSafe({
        source: 'agenttalk-supervisor',
        wakeId: wake.wakeId,
        attemptId,
        connectorKind: runtime.config.kind,
      }, false).trim(),
      clientRequestId: shortClientRequestId('supervisor:reply', `${wake.wakeId}:${attemptId}`),
    }
  );

  return {
    ...result,
    replySent: true,
    metadata: {
      connectorMetadata: result.metadata,
      supervisorReplyRequestId: replyRequestId,
    },
  };
}

async function failWake(
  config: SupervisorConfig,
  runtime: RuntimeAgent,
  wakeId: string,
  attemptId: string,
  result: WakeConnectorResult
) {
  const error = result.error ?? result.message ?? 'connector returned an unhandled result';
  await runtime.wakeClient.failWake(wakeId, error, attemptId);
  runtime.stats.failed += 1;
  runtime.stats.failureCount += 1;
  runtime.stats.lastFailureAt = new Date().toISOString();
  await appendLog(config, runtime.config, {
    event: 'wake_failed',
    wakeId,
    attemptId,
    result: toJsonSafe(result),
  });
}

function claimableWakes(runtime: RuntimeAgent) {
  return runtime.realtime
    .listWakeRequests({ status: 'pending', includeDispatcher: true })
    .filter(row => row.recipientAgentId === runtime.agentId)
    .filter(row => !runtime.inFlightWakeIds.has(row.wakeId))
    .sort(wakeSort);
}

async function tickAgent(config: SupervisorConfig, runtime: RuntimeAgent) {
  while (runtime.jobs.size < runtime.config.maxConcurrentWakeJobs) {
    const wake = claimableWakes(runtime)[0];
    if (!wake) {
      return;
    }
    runtime.inFlightWakeIds.add(wake.wakeId);
    const job = dispatchWake(config, runtime, wake).finally(() => {
      runtime.inFlightWakeIds.delete(wake.wakeId);
      runtime.jobs.delete(job);
    });
    runtime.jobs.add(job);
  }
}

function runtimeStatus(runtime: RuntimeAgent) {
  const effectivePolicy = runtime.realtime.currentWakePolicy();
  const effectiveProfile = runtime.realtime.currentAgentWakeProfile();
  const allowedWakeSenderAgentIds = normalizeWakeSenderAgentIds(
    runtime.config.wake.allowedWakeSenderAgentIds,
    'Allowed wake senders'
  );
  const blockedWakeSenderAgentIds = normalizeWakeSenderAgentIds(
    runtime.config.wake.blockedWakeSenderAgentIds,
    'Blocked wake senders'
  );
  const controlProfile = normalizeControlProfile(runtime.config.controlProfile);
  const desiredReasons = new Set(runtime.config.wake.reasons ?? []);
  const desiredAccessMode = wakeAccessMode(runtime.config.wake);
  const desiredAllowedJson = allowedWakeSenderAgentIdsJson(runtime.config.wake);
  const desiredBlockedJson = wakeSenderAgentIdsJson(runtime.config.wake.blockedWakeSenderAgentIds);
  const drift =
    effectivePolicy
      ? {
          differs:
            effectivePolicy.wakeOnDirectMessage !==
              (runtime.config.wake.enabled === true &&
                (desiredReasons.has('direct_message') || desiredReasons.has('direct'))) ||
            effectivePolicy.wakeOnMention !==
              (runtime.config.wake.enabled === true && desiredReasons.has('mention')) ||
            effectivePolicy.wakeOnGroupMessage !==
              (runtime.config.wake.enabled === true && desiredReasons.has('group_message')) ||
            effectivePolicy.wakeOnHandoff !==
              (runtime.config.wake.enabled === true && desiredReasons.has('handoff')) ||
            effectivePolicy.wakeOnBusinessInquiry !==
              (runtime.config.wake.enabled === true && desiredReasons.has('business_inquiry')) ||
            effectivePolicy.acceptsNewConversations !== (runtime.config.wake.enabled === true) ||
            effectivePolicy.maxConcurrentWakeJobs !== BigInt(runtime.config.maxConcurrentWakeJobs) ||
            (effectivePolicy.expectedWakeLatencyMs ?? 0n) !== BigInt(runtime.config.wake.latencyMs) ||
            (effectivePolicy.allowedWakeSenderAgentIdsJson ?? '') !== desiredAllowedJson ||
            (effectivePolicy.blockedWakeSenderAgentIdsJson ?? '[]') !== desiredBlockedJson,
          effectiveAccessMode:
            (effectivePolicy.allowedWakeSenderAgentIdsJson ?? '') === '' ? 'open' : 'allow_list',
          desiredAccessMode,
        }
      : {
          differs: true,
          effectiveAccessMode: null,
          desiredAccessMode,
          reason: 'missing effective wake policy',
        };
  return {
    name: runtime.config.name,
    handle: runtime.config.handle,
    agentTalkAgentId: runtime.agentId,
    agentTalkHandle: runtime.config.handle,
    agentId: runtime.agentId,
    kind: runtime.config.kind,
    controlProfile,
    credentialScope: controlProfile === 'plugin_managed' ? 'plugin_runtime' : 'autonomous',
    registrationState: 'registered',
    enabled: runtime.config.enabled,
    wakeEnabled: runtime.config.wake.enabled === true,
    wakeable: runtime.config.enabled && runtime.config.wake.enabled === true,
    availability: runtime.config.enabled
      ? runtime.config.wake.enabled === true
        ? 'wakeable'
        : 'wake_off'
      : 'disabled',
    wakeAccess: {
      mode: wakeAccessMode(runtime.config.wake),
      allowedWakeSenderAgentIds,
      blockedWakeSenderAgentIds,
    },
    effectiveWake: {
      profile: toJsonSafe(effectiveProfile ?? null),
      policy: toJsonSafe(effectivePolicy ?? null),
    },
    desiredWake: {
      enabled: runtime.config.wake.enabled === true,
      accessMode: wakeAccessMode(runtime.config.wake),
      allowedWakeSenderAgentIds,
      blockedWakeSenderAgentIds,
      maxConcurrentWakeJobs: runtime.config.maxConcurrentWakeJobs,
    },
    busyCheck: {
      configured: Boolean(runtime.config.connector?.busyCommand?.trim()),
      timeoutMs: runtime.config.connector?.busyCommandTimeoutMs ?? null,
    },
    drift,
    pendingWakes: claimableWakes(runtime).length,
    runningJobs: runtime.jobs.size,
    lastWakeAt: runtime.stats.lastWakeAt ?? null,
    lastSuccessAt: runtime.stats.lastSuccessAt ?? null,
    lastFailureAt: runtime.stats.lastFailureAt ?? null,
    failureCount: runtime.stats.failureCount.toString(),
    claimed: runtime.stats.claimed,
    acked: runtime.stats.acked,
    failed: runtime.stats.failed,
  };
}

export async function runSupervisor(options: SupervisorRunOptions = {}) {
  const config = await loadSupervisorConfigOrDefault();
  await ensureSupervisorDirs(config);
  const enabledAgents = config.agents.filter(agent => agent.enabled);
  if (enabledAgents.length === 0) {
    return {
      ok: true,
      running: false,
      message: 'no enabled supervisor agents configured',
      agents: [],
    };
  }

  const runtimes: RuntimeAgent[] = [];
  try {
    for (const agent of enabledAgents) {
      runtimes.push(await prepareAgent(config, agent));
    }

    const pollMs = options.pollMs ?? 1000;
    const startedAt = Date.now();
    await appendLog(config, undefined, {
      event: 'supervisor_started',
      agents: runtimes.map(runtime => ({
        name: runtime.config.name,
        handle: runtime.config.handle,
        kind: runtime.config.kind,
      })),
    });

    while (true) {
      await Promise.all(runtimes.map(runtime => tickAgent(config, runtime)));
      if (options.once) {
        break;
      }
      if (options.durationMs && Date.now() - startedAt >= options.durationMs) {
        break;
      }
      await sleep(pollMs);
    }

    await Promise.all(runtimes.flatMap(runtime => Array.from(runtime.jobs)));
    return {
      ok: true,
      running: !options.once && !options.durationMs,
      agents: runtimes.map(runtimeStatus),
      logDir: '[redacted]',
      runDir: '[redacted]',
    };
  } finally {
    for (const runtime of runtimes) {
      runtime.realtime.disconnect();
    }
  }
}

export async function inspectSupervisorLiveStatus() {
  const config = await loadSupervisorConfigOrDefault();
  await ensureSupervisorDirs(config);
  const runtimes: RuntimeAgent[] = [];
  try {
    for (const agent of config.agents) {
      runtimes.push(await prepareAgent(config, agent));
    }
    return {
      ok: true,
      running: false,
      live: true,
      host: config.host,
      databaseName: config.databaseName,
      agents: runtimes.map(runtimeStatus),
      message: 'supervisor live status inspected without dispatching wake jobs',
    };
  } finally {
    for (const runtime of runtimes) {
      runtime.realtime.disconnect();
    }
  }
}
