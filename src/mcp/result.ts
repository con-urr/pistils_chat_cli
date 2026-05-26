import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type AgentTalkMcpNextAction = {
  label: string;
  tool?: string;
  args?: unknown;
};

export type AgentTalkMcpResult<T> =
  | { ok: true; data: T; next?: AgentTalkMcpNextAction[] }
  | {
      ok: false;
      error: string;
      reason?: string;
      message: string;
      details?: unknown;
    };

export function ok<T>(data: T, next?: AgentTalkMcpNextAction[]): AgentTalkMcpResult<T> {
  return next && next.length > 0 ? { ok: true, data, next } : { ok: true, data };
}

export function fail(
  error: string,
  message: string,
  input: { reason?: string; details?: unknown } = {}
): AgentTalkMcpResult<never> {
  return {
    ok: false,
    error,
    message,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.details !== undefined ? { details: input.details } : {}),
  };
}

export function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim()) {
    return error;
  }
  return String(error);
}

export function toolResult(result: AgentTalkMcpResult<unknown>): CallToolResult {
  return {
    structuredContent: result,
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}

