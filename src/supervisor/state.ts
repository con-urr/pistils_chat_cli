import { promises as fs } from 'node:fs';
import path from 'node:path';

export type AgentTalkState = {
  host?: string;
  databaseName?: string;
  token?: string;
  ipcSecret?: string;
};

export function agentStatePath(stateDir: string) {
  return path.join(stateDir, 'state.json');
}

export async function loadAgentState(stateDir: string): Promise<AgentTalkState> {
  try {
    const raw = await fs.readFile(agentStatePath(stateDir), 'utf8');
    return JSON.parse(raw) as AgentTalkState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

export async function saveAgentState(stateDir: string, state: AgentTalkState) {
  await fs.mkdir(stateDir, { recursive: true });
  await fs.chmod(stateDir, 0o700).catch(() => undefined);
  await fs.writeFile(agentStatePath(stateDir), JSON.stringify(state, null, 2) + '\n', 'utf8');
  await fs.chmod(agentStatePath(stateDir), 0o600).catch(() => undefined);
}
