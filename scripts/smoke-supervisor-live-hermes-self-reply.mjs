import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRealtimeClient } from '../dist/agent-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const supervisor = path.join(root, 'dist', 'agenttalk-supervisor.js');
const started = Date.now();
const suffix = `${process.pid}-${started}`;
const home = path.join(os.tmpdir(), `agenttalk-supervisor-live-hermes-self-reply-${suffix}`);
const fakeHermesRepo = path.join(home, 'fake-hermes');
const senderStateDir = path.join(home, 'sender');
const targetHandle = `hermes-tgt-${suffix}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40);
const senderHandle = `hermes-src-${suffix}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40);
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

async function installFakePython() {
  if (process.platform === 'win32') {
    const binDir = path.join(fakeHermesRepo, 'venv', 'Scripts');
    await fs.mkdir(binDir, { recursive: true });
    await fs.copyFile(process.execPath, path.join(binDir, 'python.exe'));
    return;
  }
  const binDir = path.join(fakeHermesRepo, 'venv', 'bin');
  await fs.mkdir(binDir, { recursive: true });
  const pythonPath = path.join(binDir, 'python');
  await fs.writeFile(pythonPath, `#!/usr/bin/env sh\nexec "${process.execPath}" "$@"\n`, 'utf8');
  await fs.chmod(pythonPath, 0o755);
}

async function installFakeHermes(expectedReply) {
  await fs.mkdir(fakeHermesRepo, { recursive: true });
  await installFakePython();
  await fs.writeFile(
    path.join(fakeHermesRepo, 'hermes'),
    `import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
if (args[0] !== 'chat') {
  process.stderr.write('expected chat subcommand');
  process.exit(2);
}
const queryIndex = args.indexOf('--query');
if (queryIndex === -1 || !args[queryIndex + 1]?.includes('woken by AgentTalk')) {
  process.stderr.write('missing AgentTalk wake query');
  process.exit(3);
}
if (!args.includes('--quiet')) {
  process.stderr.write('missing --quiet');
  process.exit(4);
}
const sourceIndex = args.indexOf('--source');
if (sourceIndex === -1 || args[sourceIndex + 1] !== 'agenttalk') {
  process.stderr.write('unexpected --source');
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
  message: 'fake Hermes replied through AgentTalk command contract',
  metadata: {
    fakeHermes: true
  }
}));
`,
    'utf8'
  );
}

await fs.mkdir(home, { recursive: true });
const expectedReply = `fake hermes self reply ${suffix}`;
await installFakeHermes(expectedReply);

await runSupervisorCommand(['init', '--json']);
await runSupervisorCommand([
  'add-agent',
  '--kind',
  'hermes',
  '--name',
  'target',
  '--handle',
  targetHandle,
  '--state-dir',
  path.join(home, 'agents', 'target'),
  '--repo',
  fakeHermesRepo,
  '--timeout-ms',
  '60000',
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
    `${JSON.stringify({ host, databaseName, token: sender.token }, null, 2)}\n`,
    'utf8'
  );
  await sender.createAccount({
    handle: senderHandle,
    displayName: senderHandle,
    role: 'agent',
    bio: 'live supervisor fake Hermes self-reply smoke sender',
    clientRequestId: `live-supervisor-hermes-self-reply:${suffix}:sender`,
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
    text: `live fake hermes self-reply smoke ${suffix}`,
    clientRequestId: `live-supervisor-hermes-self-reply:${suffix}:message`,
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
    throw new Error(`Expected fake Hermes self-reply was not visible: ${JSON.stringify(messages)}`);
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
