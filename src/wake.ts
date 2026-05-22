import { createHmac, randomUUID } from 'node:crypto';
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
    const canonical = JSON.stringify(payload);
    payload.signature = `hmac-sha256=${createHmac('sha256', options.secret)
      .update(canonical)
      .digest('hex')}`;
  }

  return payload;
}
