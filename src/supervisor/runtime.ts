import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AgentRealtimeClient, AgentTalkWakeClient } from '../agent-client';
import type * as ModuleTypes from '../module_bindings/types';
import { createWakeDispatchPayload } from '../wake';
import {
  ensureSupervisorDirs,
  expandHome,
  loadSupervisorConfigOrDefault,
  type SupervisorAgentConfig,
  type SupervisorConfig,
} from './config';
import { executeWakeConnector, type WakeConnectorResult } from './connectors';
import { stringifyJsonSafe, toJsonSafe } from './json';
import { loadAgentState, saveAgentState } from './state';

type RuntimeAgent = {
  config: SupervisorAgentConfig;
  realtime: AgentRealtimeClient;
  wakeClient: AgentTalkWakeClient;
  agentId: string;
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
  const registrationId = supervisorRegistrationId(profile.agentId);
  await realtime.heartbeat(agent.wake.statusText, 'agenttalk-supervisor');
  await realtime.registerWake({
    kind: 'local_daemon',
    agentId: profile.agentId,
    registrationId,
    enabled: agent.enabled,
    metadataJson: JSON.stringify({
      supervisor: true,
      agentName: agent.name,
      connectorKind: agent.kind,
    }),
  });
  await realtime.setWakePolicy({
    agentId: profile.agentId,
    wakeOnDirectMessage: config.defaultWakePolicy.wakeOnDirectMessage,
    wakeOnMention: config.defaultWakePolicy.wakeOnMention,
    wakeOnGroupMessage: config.defaultWakePolicy.wakeOnGroupMessage,
    acceptsNewConversations: config.defaultWakePolicy.acceptsNewConversations,
    coalesceWindowMs: BigInt(config.defaultWakePolicy.coalesceWindowMs),
    minWakeIntervalMs: BigInt(config.defaultWakePolicy.minWakeIntervalMs),
    maxWakesPerMinute: BigInt(config.defaultWakePolicy.maxWakesPerMinute),
    maxConcurrentWakeJobs: BigInt(agent.maxConcurrentWakeJobs),
    expectedWakeLatencyMs: BigInt(agent.wake.latencyMs),
    availabilityOverride: 'wakeable',
    statusText: agent.wake.statusText,
  });
  return registrationId;
}

async function prepareAgent(config: SupervisorConfig, agent: SupervisorAgentConfig) {
  const realtime = await connectAgent(config, agent);
  try {
    const profile = await ensureAgentAccount(realtime, agent);
    const registrationId = await configureWake(config, agent, realtime, profile);
    const runtime: RuntimeAgent = {
      config: agent,
      realtime,
      wakeClient: new AgentTalkWakeClient(realtime),
      agentId: profile.agentId,
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

    await runtime.realtime.markWakeDispatched(
      wake.wakeId,
      attemptId,
      JSON.stringify({ supervisor: true, agentName: agent.name })
    );
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
        stateDir: path.resolve(expandHome(agent.stateDir)),
        repoPath: agent.repoPath,
        wake: claimedWake,
        attemptId,
        contextMessages,
        payload,
      },
      runDir
    );

    if (result.ok && result.handled) {
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
        result: toJsonSafe(result),
      });
      return;
    }

    await failWake(config, runtime, wake.wakeId, attemptId, result);
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
  return {
    name: runtime.config.name,
    handle: runtime.config.handle,
    agentId: runtime.agentId,
    kind: runtime.config.kind,
    enabled: runtime.config.enabled,
    wakeable: true,
    availability: 'wakeable',
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
