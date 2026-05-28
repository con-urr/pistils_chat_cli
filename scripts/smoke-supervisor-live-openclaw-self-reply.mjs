import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRealtimeClient } from '../dist/agent-client.js';
import { requireLiveSmokeOptIn } from './live-smoke-guard.mjs';

requireLiveSmokeOptIn('smoke-supervisor-live-openclaw-self-reply');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const supervisor = path.join(root, 'dist', 'agenttalk-supervisor.js');
const started = Date.now();
const suffix = `${process.pid}-${started}`;
const home = path.join(os.tmpdir(), `agenttalk-supervisor-live-openclaw-self-reply-${suffix}`);
const fakeOpenClawRepo = path.join(home, 'fake-openclaw');
const senderStateDir = path.join(home, 'sender');
const targetHandle = `openclaw-tgt-${suffix}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40);
const senderHandle = `openclaw-src-${suffix}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40);
const host = process.env.SPACETIMEDB_HOST ?? 'https://maincloud.spacetimedb.com';
const databaseName = process.env.SPACETIMEDB_DB_NAME ?? 'crimsonconfidentialgibbon';
const keepSmokeHome = process.env.AGENTTALK_KEEP_SMOKE_HOME === '1';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function smokeEnv() {
  return {
    ...process.env,
    AGENTTALK_SUPERVISOR_HOME: home,
  };
}

function runSupervisorCommand(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [supervisor, ...args], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: smokeEnv(),
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
        reject(new Error(`agenttalk-supervisor ${args.join(' ')} exited ${code}; ${stderr || stdout}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function spawnSupervisorRun() {
  const child = spawn(
    process.execPath,
    [supervisor, 'run', '--duration-ms', '22000', '--poll-ms', '500', '--json'],
    {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: smokeEnv(),
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
            reject(new Error(`supervisor run exited ${code}; ${stderr || stdout}`));
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

async function installFakeOpenClaw(expectedReply) {
  await fs.mkdir(fakeOpenClawRepo, { recursive: true });
  await fs.writeFile(
    path.join(fakeOpenClawRepo, 'openclaw.mjs'),
    `import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
if (args[0] !== 'agent') {
  process.stderr.write('expected agent subcommand');
  process.exit(2);
}
if (!args.includes('--json')) {
  process.stderr.write('missing --json');
  process.exit(3);
}
const agentIndex = args.indexOf('--agent');
if (agentIndex === -1 || args[agentIndex + 1] !== 'fake-openclaw-agent') {
  process.stderr.write('unexpected --agent');
  process.exit(4);
}
const messageIndex = args.indexOf('--message');
if (messageIndex === -1 || !args[messageIndex + 1]?.includes('woken by AgentTalk')) {
  process.stderr.write('missing AgentTalk wake prompt');
  process.exit(5);
}
const contract = JSON.parse(process.env.AGENTTALK_REPLY_ARGS_JSON ?? '{}');
if (!contract.command || !Array.isArray(contract.args)) {
  process.stderr.write('missing reply args contract');
  process.exit(6);
}
const replyArgs = contract.args.map(arg => arg === contract.messagePlaceholder ? ${JSON.stringify(expectedReply)} : arg);
const reply = spawnSync(contract.command, replyArgs, {
  cwd: process.cwd(),
  env: process.env,
  encoding: 'utf8'
});
try {
  const stopArgs = [contract.args[0], 'daemon', 'stop', '--json'];
  spawnSync(contract.command, stopArgs, {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8'
  });
} catch {
  // Best-effort cleanup only.
}
if (reply.status !== 0) {
  process.stderr.write(reply.stderr || reply.stdout || 'reply command failed');
  process.exit(reply.status ?? 1);
}
process.stdout.write(JSON.stringify({
  ok: true,
  handled: true,
  replySent: true,
  message: 'fake OpenClaw replied through AgentTalk command contract',
  metadata: {
    fakeOpenClaw: true
  }
}));
`,
    'utf8'
  );
}

await fs.mkdir(home, { recursive: true });
const expectedReply = `fake openclaw self reply ${suffix}`;
await installFakeOpenClaw(expectedReply);

await runSupervisorCommand(['init', '--json']);
const sender = await AgentRealtimeClient.connect({
  host,
  databaseName,
  subscriptionProfile: 'direct',
});
try {
  await fs.mkdir(senderStateDir, { recursive: true });
  await fs.writeFile(
    path.join(senderStateDir, 'state.json'),
    `${JSON.stringify({ host, databaseName, token: sender.token }, null, 2)}\n`,
    'utf8'
  );
  await sender.createAccount({
    handle: senderHandle,
    displayName: senderHandle,
    role: 'agent',
    bio: 'live supervisor fake OpenClaw self-reply smoke sender',
    clientRequestId: `live-supervisor-openclaw-self-reply:${suffix}:sender`,
  });
  await sleep(1000);
  const senderAgentId = sender.currentAgentProfile()?.agentId;
  if (!senderAgentId) {
    throw new Error('Sender account did not expose an AgentTalk agent id');
  }
  await runSupervisorCommand([
    'add-agent',
    '--kind',
    'openclaw',
    '--name',
    'target',
    '--handle',
    targetHandle,
    '--state-dir',
    path.join(home, 'agents', 'target'),
    '--repo',
    fakeOpenClawRepo,
    '--openclaw-agent-id',
    'fake-openclaw-agent',
    '--timeout-ms',
    '60000',
    '--wake-enabled',
    'true',
    '--wake-access',
    'allow-list',
    '--allowed-wake-senders',
    senderAgentId,
    '--json',
  ]);

  const supervisorRun = spawnSupervisorRun();
  await sleep(3500);

  await sender.requestAccountDirectory({ handle: targetHandle, limit: 1n });
  await sleep(750);
  const target = sender.searchAccounts({ handle: targetHandle })[0];
  if (!target?.agentId) {
    throw new Error(`Target account @${targetHandle} was not visible to sender`);
  }
  const messageRequestId = await sender.sendDirectMessage({
    targetAgentId: target.agentId,
    text: `live fake openclaw self-reply smoke ${suffix}`,
    clientRequestId: `live-supervisor-openclaw-self-reply:${suffix}:message`,
  });
  const receipt = await sender.waitForReceipt(messageRequestId, 8000, 'send_direct_message');
  if (!receipt.conversationId) {
    throw new Error(`Direct message receipt did not include a conversationId: ${JSON.stringify(receipt)}`);
  }

  const runResult = parseLastJson((await supervisorRun.wait()).stdout);
  const targetStatus = runResult.agents?.find(agent => agent.handle === targetHandle);
  if (!targetStatus || Number(targetStatus.acked ?? 0) < 1) {
    throw new Error(`Expected supervisor to ack at least one wake: ${JSON.stringify(runResult)}`);
  }

  await sender.requestConversationMessages({ conversationId: receipt.conversationId, limit: 20n });
  await sleep(1000);
  const messages = sender.listConversationMessages(receipt.conversationId);
  const reply = messages.find(message => message.text === expectedReply);
  if (!reply) {
    throw new Error(`Expected fake OpenClaw self-reply was not visible: ${JSON.stringify(messages)}`);
  }

  console.log(
    JSON.stringify({
      ok: true,
      targetHandle,
      senderHandle,
      conversationId: receipt.conversationId.toString(),
      replySequence: reply.sequence.toString(),
      acked: targetStatus.acked,
      claimed: targetStatus.claimed,
      failed: targetStatus.failed,
    })
  );
} catch (error) {
  if (keepSmokeHome) {
    console.error(`SMOKE_HOME=${home}`);
  }
  throw error;
} finally {
  sender.disconnect();
  if (!keepSmokeHome) {
    await fs.rm(home, { recursive: true, force: true });
  }
}
