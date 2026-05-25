import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type * as ModuleTypes from './module_bindings/types';

export {
  AgentTalkWakeClient,
  type AgentTalkWakeHandler,
  type WakeClaimInput,
  type WakePolicyInput,
  type WakeRegistrationInput,
} from './agent-client';

export type WakeDispatchPayload = {
  type: 'agenttalk.wake';
  version: '1';
  wakeId: string;
  recipientAgentId: string;
  conversationId: string;
  minSequence: string;
  maxSequence: string;
  reason: string;
  issuedAt: string;
  nonce: string;
  signature?: string;
};

export type WakeDispatchVerificationOptions = {
  secret: string;
  now?: Date;
  maxAgeMs?: number;
  maxFutureSkewMs?: number;
};

const WAKE_DISPATCH_SIGNATURE_PREFIX = 'hmac-sha256=';

export function canonicalWakeDispatchPayload(payload: WakeDispatchPayload) {
  return JSON.stringify({
    type: payload.type,
    version: payload.version,
    wakeId: payload.wakeId,
    recipientAgentId: payload.recipientAgentId,
    conversationId: payload.conversationId,
    minSequence: payload.minSequence,
    maxSequence: payload.maxSequence,
    reason: payload.reason,
    issuedAt: payload.issuedAt,
    nonce: payload.nonce,
  });
}

function signWakeDispatchPayload(payload: WakeDispatchPayload, secret: string) {
  return `${WAKE_DISPATCH_SIGNATURE_PREFIX}${createHmac('sha256', secret)
    .update(canonicalWakeDispatchPayload(payload))
    .digest('hex')}`;
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function createWakeDispatchPayload(
  wake: ModuleTypes.WakeRequestView,
  options: { secret?: string; issuedAt?: Date; nonce?: string } = {}
): WakeDispatchPayload {
  const payload: WakeDispatchPayload = {
    type: 'agenttalk.wake',
    version: '1',
    wakeId: wake.wakeId,
    recipientAgentId: wake.recipientAgentId,
    conversationId: wake.conversationId.toString(),
    minSequence: wake.minSequence.toString(),
    maxSequence: wake.maxSequence.toString(),
    reason: wake.reason,
    issuedAt: (options.issuedAt ?? new Date()).toISOString(),
    nonce: options.nonce ?? randomUUID(),
  };

  if (options.secret) {
    payload.signature = signWakeDispatchPayload(payload, options.secret);
  }

  return payload;
}

export function verifyWakeDispatchPayload(
  payload: WakeDispatchPayload,
  options: WakeDispatchVerificationOptions | string
) {
  const verification =
    typeof options === 'string' ? { secret: options } : options;
  if (!payload.signature || !payload.signature.startsWith(WAKE_DISPATCH_SIGNATURE_PREFIX)) {
    return false;
  }
  if (payload.type !== 'agenttalk.wake' || payload.version !== '1') {
    return false;
  }

  const issuedAtMs = Date.parse(payload.issuedAt);
  if (!Number.isFinite(issuedAtMs)) {
    return false;
  }
  const nowMs = (verification.now ?? new Date()).getTime();
  const maxFutureSkewMs = verification.maxFutureSkewMs ?? 60000;
  if (issuedAtMs - nowMs > maxFutureSkewMs) {
    return false;
  }
  if (
    verification.maxAgeMs !== undefined &&
    nowMs - issuedAtMs > verification.maxAgeMs
  ) {
    return false;
  }

  return safeEqual(payload.signature, signWakeDispatchPayload(payload, verification.secret));
}
