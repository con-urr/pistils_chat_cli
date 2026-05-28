import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRealtimeClient } from '../dist/agent-client.js';

const require = createRequire(import.meta.url);
const { hermesStatusHasInferenceCredentials } = require('../dist/supervisor/hermes.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const supervisor = path.join(root, 'dist', 'agenttalk-supervisor.js');
const githubRoot = path.join(os.homedir(), 'Documents', 'GitHub');
const started = Date.now();
const suffix = `${process.pid}-${started}`;
const home = path.join(os.tmpdir(), `agenttalk-supervisor-live-real-agent-pair-${suffix}`);
const host = process.env.SPACETIMEDB_HOST ?? 'https://maincloud.spacetimedb.com';
const databaseName = process.env.SPACETIMEDB_DB_NAME ?? 'crimsonconfidentialgibbon';
const keepSmokeHome = process.env.AGENTTALK_KEEP_SMOKE_HOME === '1';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function exists(filePath) {
  return fs.access(filePath).then(() => true, () => false);
}

function commandEnv() {
  return {
    ...process.env,
    AGENTTALK_SUPERVISOR_HOME: home,
    SPACETIMEDB_HOST: host,
    SPACETIMEDB_DB_NAME: databaseName,
  };
}

function runRaw(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(options.env ?? {}),
      },
      windowsHide: true,
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
        reject(new Error(`${command} ${args.join(' ')} exited ${code}; ${stderr || stdout}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function runSupervisorCommand(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [supervisor, ...args], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: commandEnv(),
      windowsHide: true,
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

function spawnSupervisorRun(durationMs) {
  const child = spawn(
    process.execPath,
    [supervisor, 'run', '--duration-ms', String(durationMs), '--poll-ms', '500', '--json'],
    {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: commandEnv(),
      windowsHide: true,
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

async function detectOpenClawAgentId(openclawRepo) {
  const result = await runRaw(
    process.execPath,
    [path.join(openclawRepo, 'openclaw.mjs'), 'agents', 'list', '--json'],
    { cwd: openclawRepo }
  );
  const agents = JSON.parse(result.stdout);
  const selected = agents.find(agent => agent.isDefault === true) ?? agents[0];
  if (!selected?.id) {
    throw new Error('OpenClaw agents list did not return a configured agent id');
  }
  return selected.id;
}

async function detectHermesReady(hermesRepo, hermesPython) {
  try {
    const result = await runRaw(hermesPython, [path.join(hermesRepo, 'hermes'), 'status'], {
      cwd: hermesRepo,
    });
    return hermesStatusHasInferenceCredentials(result.stdout);
  } catch {
    return false;
  }
}

async function detectRealAgents() {
  const openclawRepo = path.join(githubRoot, 'openclaw');
  const hermesRepo = path.join(githubRoot, 'hermes-agent');
  const hermesPython = process.platform === 'win32'
    ? path.join(hermesRepo, 'venv', 'Scripts', 'python.exe')
    : path.join(hermesRepo, 'venv', 'bin', 'python');

  const missing = [];
  if (!(await exists(path.join(openclawRepo, 'openclaw.mjs')))) {
    missing.push('OpenClaw repo not found');
  }
  if (!(await exists(path.join(hermesRepo, 'hermes')))) {
    missing.push('Hermes repo not found');
  }
  if (!(await exists(hermesPython))) {
    missing.push('Hermes Python venv not found');
  }
  if (missing.length) {
    return { ready: false, missing };
  }

  const [openclawAgentId, hermesReady] = await Promise.all([
    detectOpenClawAgentId(openclawRepo),
    detectHermesReady(hermesRepo, hermesPython),
  ]);
  if (!hermesReady) {
    return { ready: false, missing: ['Hermes inference credentials not ready'] };
  }

  return {
    ready: true,
    openclawRepo,
    openclawAgentId,
    hermesRepo,
  };
}

async function readRuntimeState(agentName) {
  const statePath = path.join(home, 'agents', agentName, 'runtime', 'state.json');
  const raw = await fs.readFile(statePath, 'utf8');
  const state = JSON.parse(raw);
  if (!state.token || !state.agentId) {
    throw new Error(`runtime state for ${agentName} is missing token or agentId`);
  }
  return state;
}

async function findInputFiles(dir) {
  const out = [];
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await findInputFiles(fullPath));
    } else if (entry.isFile() && entry.name === 'input.json') {
      out.push(fullPath);
    }
  }
  return out;
}

async function readConnectorInputs() {
  const files = await findInputFiles(path.join(home, 'runs'));
  const inputs = [];
  for (const file of files) {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    inputs.push({ file, input: parsed });
  }
  return inputs;
}

async function connectFromRuntimeState(state) {
  const client = await AgentRealtimeClient.connect({
    host,
    databaseName,
    token: state.token,
    subscriptionProfile: 'direct',
  });
  await sleep(1000);
  return client;
}

async function sendDirectFromRuntime({ senderName, targetAgentId, text }) {
  const state = await readRuntimeState(senderName);
  const client = await connectFromRuntimeState(state);
  try {
    const profile = client.currentAgentProfile();
    if (!profile?.agentId || profile.agentId !== state.agentId) {
      throw new Error(`runtime credential for ${senderName} did not resolve its AgentTalk profile`);
    }
    const requestId = await client.sendDirectMessage({
      targetAgentId,
      text,
      clientRequestId: `real-agent-pair:${suffix}:${senderName}:${targetAgentId}`,
    });
    const receipt = await client.waitForReceipt(requestId, 15000, 'send_direct_message');
    if (!receipt.conversationId) {
      throw new Error(`send receipt for ${senderName} did not include conversationId`);
    }
    return {
      senderAgentId: profile.agentId,
      conversationId: receipt.conversationId.toString(),
    };
  } finally {
    client.disconnect();
  }
}

function agentByName(result, name) {
  const agent = result.agents?.find(row => row.name === name);
  if (!agent?.agentTalkAgentId) {
    throw new Error(`run result did not include AgentTalk ID for ${name}: ${JSON.stringify(result)}`);
  }
  return agent;
}

const detected = await detectRealAgents();
if (!detected.ready) {
  console.log(
    JSON.stringify({
      ok: true,
      skipped: true,
      reason: 'Real Hermes/OpenClaw pair smoke requires local configured agents.',
      missing: detected.missing,
    })
  );
  process.exit(0);
}

await fs.mkdir(home, { recursive: true });

try {
  await runSupervisorCommand(['init', '--json']);
  await runSupervisorCommand([
    'add-agent',
    '--kind',
    'openclaw',
    '--name',
    'openclaw',
    '--handle',
    `pair-openclaw-${suffix}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 62),
    '--repo',
    detected.openclawRepo,
    '--state-dir',
    path.join(home, 'agents', 'openclaw'),
    '--openclaw-agent-id',
    detected.openclawAgentId,
    '--timeout-ms',
    '120000',
    '--json',
  ]);
  await runSupervisorCommand([
    'add-agent',
    '--kind',
    'hermes',
    '--name',
    'hermes',
    '--handle',
    `pair-hermes-${suffix}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 62),
    '--repo',
    detected.hermesRepo,
    '--state-dir',
    path.join(home, 'agents', 'hermes'),
    '--timeout-ms',
    '120000',
    '--json',
  ]);

  const registration = parseLastJson((await spawnSupervisorRun(12000).wait()).stdout);
  const openclaw = agentByName(registration, 'openclaw');
  const hermes = agentByName(registration, 'hermes');

  await runSupervisorCommand([
    'wake-on',
    'openclaw',
    '--wake-access',
    'allow-list',
    '--allowed-wake-senders',
    hermes.agentTalkAgentId,
    '--json',
  ]);
  await runSupervisorCommand([
    'wake-on',
    'hermes',
    '--wake-access',
    'allow-list',
    '--allowed-wake-senders',
    openclaw.agentTalkAgentId,
    '--json',
  ]);

  const run = spawnSupervisorRun(180000);
  await sleep(8000);

  const hermesToOpenClaw = await sendDirectFromRuntime({
    senderName: 'hermes',
    targetAgentId: openclaw.agentTalkAgentId,
    text: `Hermes runtime wake test to OpenClaw ${suffix}. Please acknowledge briefly through AgentTalk if appropriate.`,
  });
  await sleep(12000);
  const openClawToHermes = await sendDirectFromRuntime({
    senderName: 'openclaw',
    targetAgentId: hermes.agentTalkAgentId,
    text: `OpenClaw runtime wake test to Hermes ${suffix}. Please acknowledge briefly through AgentTalk if appropriate.`,
  });

  const final = parseLastJson((await run.wait()).stdout);
  const openclawFinal = agentByName(final, 'openclaw');
  const hermesFinal = agentByName(final, 'hermes');
  if (Number(openclawFinal.acked ?? 0) < 1 || Number(hermesFinal.acked ?? 0) < 1) {
    throw new Error(`expected each real connector to ack at least one wake: ${JSON.stringify(final)}`);
  }
  if (Number(openclawFinal.failed ?? 0) > 0 || Number(hermesFinal.failed ?? 0) > 0) {
    throw new Error(`expected zero failed wake attempts in real connector smoke: ${JSON.stringify(final)}`);
  }
  const connectorInputs = await readConnectorInputs();
  const missingContext = connectorInputs.filter(row => {
    const messages = row.input?.contextMessages;
    return !Array.isArray(messages) || messages.length === 0;
  });
  if (missingContext.length) {
    throw new Error(
      `expected real connector wake prompts to include wake-range messages: ${JSON.stringify(
        missingContext.map(row => ({ file: row.file, wakeId: row.input?.wake?.wakeId }))
      )}`
    );
  }

  console.log(
    JSON.stringify({
      ok: true,
      host,
      databaseName,
      agents: {
        openclaw: {
          agentTalkAgentId: openclaw.agentTalkAgentId,
          acked: openclawFinal.acked,
          claimed: openclawFinal.claimed,
          failed: openclawFinal.failed,
        },
        hermes: {
          agentTalkAgentId: hermes.agentTalkAgentId,
          acked: hermesFinal.acked,
          claimed: hermesFinal.claimed,
          failed: hermesFinal.failed,
        },
      },
      conversations: {
        hermesToOpenClaw: hermesToOpenClaw.conversationId,
        openClawToHermes: openClawToHermes.conversationId,
      },
      contextMessages: connectorInputs.map(row => ({
        agent: row.input?.agentName,
        wakeId: row.input?.wake?.wakeId,
        count: row.input?.contextMessages?.length ?? 0,
      })),
    })
  );
} catch (error) {
  if (keepSmokeHome) {
    console.error(`SMOKE_HOME=${home}`);
  }
  throw error;
} finally {
  if (!keepSmokeHome) {
    await fs.rm(home, { recursive: true, force: true });
  }
}
