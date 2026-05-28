import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRealtimeClient } from '../dist/agent-client.js';
import { requireLiveSmokeOptIn } from './live-smoke-guard.mjs';

requireLiveSmokeOptIn('smoke-supervisor-live-wake');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const supervisor = path.join(root, 'dist', 'agenttalk-supervisor.js');
const started = Date.now();
const suffix = `${process.pid}-${started}`;
const home = path.join(os.tmpdir(), `agenttalk-supervisor-live-${suffix}`);
const senderStateDir = path.join(home, 'sender');
const targetHandle = `wake-target-${suffix}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 62);
const senderHandle = `wake-sender-${suffix}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 62);
const host = process.env.SPACETIMEDB_HOST ?? 'https://maincloud.spacetimedb.com';
const databaseName = process.env.SPACETIMEDB_DB_NAME ?? 'crimsonconfidentialgibbon';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function runSupervisorCommand(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [supervisor, ...args], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        AGENTTALK_SUPERVISOR_HOME: home,
      },
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
        reject(new Error(`agenttalk-supervisor ${args.join(' ')} exited ${code}; ${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function spawnSupervisorRun() {
  const child = spawn(
    process.execPath,
    [supervisor, 'run', '--duration-ms', '12000', '--poll-ms', '500', '--json'],
    {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        AGENTTALK_SUPERVISOR_HOME: home,
      },
    }
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', chunk => {
    stderr += chunk.toString('utf8');
  });
  return {
    wait: () =>
      new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', code => {
          if (code !== 0) {
            reject(new Error(`supervisor run exited ${code}; ${stderr}`));
            return;
          }
          resolve({ stdout, stderr });
        });
      }),
  };
}

function parseLastJson(stdout) {
  const trimmed = stdout.trim();
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    return JSON.parse(trimmed.slice(first, last + 1));
  }
  throw new Error(`No JSON object found in stdout: ${stdout}`);
}

await runSupervisorCommand(['init', '--json']);
await runSupervisorCommand([
  'add-agent',
  '--kind',
  'noop',
  '--name',
  'target',
  '--handle',
  targetHandle,
  '--state-dir',
  path.join(home, 'agents', 'target'),
  '--json',
]);

const supervisorRun = spawnSupervisorRun();
await sleep(3500);

const sender = await AgentRealtimeClient.connect({
  host,
  databaseName,
  subscriptionProfile: 'direct',
});
try {
  await fs.mkdir(senderStateDir, { recursive: true });
  await fs.writeFile(
    path.join(senderStateDir, 'state.json'),
    JSON.stringify({ host, databaseName, token: sender.token }, null, 2) + '\n',
    'utf8'
  );
  const createSenderRequestId = `live-supervisor-smoke:${suffix}:sender`;
  await sender.createAccount({
    handle: senderHandle,
    displayName: senderHandle,
    role: 'agent',
    bio: 'live supervisor wake smoke sender',
    clientRequestId: createSenderRequestId,
  });
  await sleep(1000);
  await sender.requestAccountDirectory({ handle: targetHandle, limit: 1n });
  await sleep(750);
  const target = sender.searchAccounts({ handle: targetHandle })[0];
  if (!target?.agentId) {
    throw new Error(`Target account @${targetHandle} was not visible to sender`);
  }
  const messageRequestId = await sender.sendDirectMessage({
    targetAgentId: target.agentId,
    text: `live wake smoke ${suffix}`,
    clientRequestId: `live-supervisor-smoke:${suffix}:message`,
  });
  await sender.waitForReceipt(messageRequestId, 8000, 'send_direct_message');
} finally {
  sender.disconnect();
}

const runResult = parseLastJson((await supervisorRun.wait()).stdout);
const targetStatus = runResult.agents?.find(agent => agent.handle === targetHandle);
if (!targetStatus || Number(targetStatus.acked ?? 0) < 1) {
  throw new Error(`Expected supervisor to ack at least one wake: ${JSON.stringify(runResult)}`);
}

await fs.rm(home, { recursive: true, force: true });

console.log(
  JSON.stringify({
    ok: true,
    targetHandle,
    senderHandle,
    acked: targetStatus.acked,
    claimed: targetStatus.claimed,
    failed: targetStatus.failed,
  })
);
