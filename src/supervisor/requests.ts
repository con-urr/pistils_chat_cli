import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  normalizeAgentName,
  normalizeWakeAccessMode,
  normalizeWakeSenderAgentIds,
  OPEN_WAKE_WARNING,
  supervisorRoot,
  type WakeAccessMode,
} from './config';

export type WakeChangeRequestStatus = 'pending' | 'approved' | 'denied';

export type WakeChangeRequestPatch = {
  wakeEnabled?: boolean;
  wakeAccessMode?: WakeAccessMode;
  allowedWakeSenderAgentIds?: string[];
  blockedWakeSenderAgentIds?: string[];
};

export type WakeChangeRequest = {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: WakeChangeRequestStatus;
  agentName: string;
  requestedBy: string;
  reason?: string;
  desired: WakeChangeRequestPatch;
  warning?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolutionNote?: string;
};

type WakeChangeRequestStore = {
  version: 1;
  requests: WakeChangeRequest[];
};

export function wakeChangeRequestsPath() {
  return path.join(supervisorRoot(), 'wake-change-requests.json');
}

function requestId(agentName: string) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `wcr_${normalizeAgentName(agentName)}_${suffix}`;
}

function normalizePatch(input: WakeChangeRequestPatch): WakeChangeRequestPatch {
  const patch: WakeChangeRequestPatch = {};
  if (input.wakeEnabled !== undefined) {
    patch.wakeEnabled = input.wakeEnabled;
  }
  if (input.wakeAccessMode !== undefined) {
    patch.wakeAccessMode = normalizeWakeAccessMode(input.wakeAccessMode);
  }
  if (input.allowedWakeSenderAgentIds !== undefined) {
    patch.allowedWakeSenderAgentIds = normalizeWakeSenderAgentIds(
      input.allowedWakeSenderAgentIds,
      'Allowed wake senders'
    );
  }
  if (input.blockedWakeSenderAgentIds !== undefined) {
    patch.blockedWakeSenderAgentIds = normalizeWakeSenderAgentIds(
      input.blockedWakeSenderAgentIds,
      'Blocked wake senders'
    );
  }
  if (Object.keys(patch).length === 0) {
    throw new Error('wake change request must include at least one requested change');
  }
  return patch;
}

export async function loadWakeChangeRequests(): Promise<WakeChangeRequestStore> {
  try {
    const raw = await fs.readFile(wakeChangeRequestsPath(), 'utf8');
    const parsed = JSON.parse(raw) as WakeChangeRequestStore;
    if (parsed.version !== 1 || !Array.isArray(parsed.requests)) {
      throw new Error(`Unsupported wake change request store at ${wakeChangeRequestsPath()}`);
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, requests: [] };
    }
    throw error;
  }
}

export async function saveWakeChangeRequests(store: WakeChangeRequestStore) {
  const file = wakeChangeRequestsPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.chmod(path.dirname(file), 0o700).catch(() => undefined);
  await fs.writeFile(file, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  await fs.chmod(file, 0o600).catch(() => undefined);
}

export async function createWakeChangeRequest(input: {
  agentName: string;
  requestedBy?: string;
  reason?: string;
  desired: WakeChangeRequestPatch;
}) {
  const agentName = normalizeAgentName(input.agentName);
  const desired = normalizePatch(input.desired);
  const now = new Date().toISOString();
  const request: WakeChangeRequest = {
    id: requestId(agentName),
    createdAt: now,
    updatedAt: now,
    status: 'pending',
    agentName,
    requestedBy: input.requestedBy?.trim() || 'agent-runtime',
    reason: input.reason?.trim() || undefined,
    desired,
    warning: desired.wakeAccessMode === 'open' ? OPEN_WAKE_WARNING : undefined,
  };
  const store = await loadWakeChangeRequests();
  store.requests.push(request);
  await saveWakeChangeRequests(store);
  return request;
}

export async function listWakeChangeRequests(filter: {
  agentName?: string;
  status?: WakeChangeRequestStatus | 'all';
} = {}) {
  const store = await loadWakeChangeRequests();
  const agentName = filter.agentName ? normalizeAgentName(filter.agentName) : undefined;
  return store.requests
    .filter(request => (agentName ? request.agentName === agentName : true))
    .filter(request => (!filter.status || filter.status === 'all' ? true : request.status === filter.status))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function resolveWakeChangeRequest(input: {
  id: string;
  status: 'approved' | 'denied';
  resolvedBy?: string;
  resolutionNote?: string;
}) {
  const store = await loadWakeChangeRequests();
  const request = store.requests.find(row => row.id === input.id);
  if (!request) {
    throw new Error(`Unknown wake change request '${input.id}'`);
  }
  if (request.status !== 'pending') {
    throw new Error(`Wake change request '${input.id}' is already ${request.status}`);
  }
  const now = new Date().toISOString();
  request.status = input.status;
  request.updatedAt = now;
  request.resolvedAt = now;
  request.resolvedBy = input.resolvedBy?.trim() || 'supervisor-admin';
  request.resolutionNote = input.resolutionNote?.trim() || undefined;
  await saveWakeChangeRequests(store);
  return request;
}
