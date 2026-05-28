import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const agenttalk = path.join(root, 'dist', 'agenttalk.js');
const home = path.join(os.tmpdir(), `agenttalk-setup-smoke-${process.pid}-${Date.now()}`);
const openclawRepo = path.join(home, 'repos', 'openclaw');
const hermesRepo = path.join(home, 'repos', 'hermes-agent');
const hermesPython = process.platform === 'win32'
  ? path.join(hermesRepo, 'venv', 'Scripts', 'python.exe')
  : path.join(hermesRepo, 'venv', 'bin', 'python');

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [agenttalk, ...args], {
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
        reject(new Error(`agenttalk ${args.join(' ')} exited ${code}; ${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseJson(result) {
  return JSON.parse(result.stdout);
}

await fs.mkdir(openclawRepo, { recursive: true });
await fs.writeFile(
  path.join(openclawRepo, 'openclaw.mjs'),
  `if (process.argv.includes('agents') && process.argv.includes('list') && process.argv.includes('--json')) {
  console.log(JSON.stringify([{ id: 'main', isDefault: true }]));
} else {
  console.log('openclaw stub');
}
`,
  'utf8'
);
await fs.mkdir(path.dirname(hermesPython), { recursive: true });
await fs.writeFile(path.join(hermesRepo, 'hermes'), '# hermes stub\n', 'utf8');
await fs.writeFile(hermesPython, '', 'utf8');

const defaultSetup = parseJson(
  await run([
    'setup',
    '--agents',
    '--dry-run',
    '--json',
    '--openclaw-repo',
    openclawRepo,
    '--hermes-repo',
    hermesRepo,
    '--no-codex',
  ])
);

if (defaultSetup.ok !== true || defaultSetup.configured?.length !== 1) {
  throw new Error(`unexpected default setup result: ${JSON.stringify(defaultSetup)}`);
}
if (!defaultSetup.configured.some(entry => entry.agent?.kind === 'openclaw')) {
  throw new Error(`openclaw was not configured by default: ${JSON.stringify(defaultSetup)}`);
}
if (!defaultSetup.skipped.some(entry => entry.kind === 'hermes')) {
  throw new Error(`unconfigured hermes was not skipped by default: ${JSON.stringify(defaultSetup)}`);
}
if (
  !defaultSetup.nextActions?.some(
    entry =>
      entry.label === 'Start the Hermes-owned Codex OAuth helper' &&
      entry.command === 'agenttalk hermes codex-oauth --confirm'
  ) ||
  !defaultSetup.nextActions?.some(
    entry =>
      entry.label === 'Create a Hermes-owned Codex OAuth session' &&
      entry.command.includes('<hermes-repo>') &&
      entry.command.includes('openai-codex') &&
      !entry.command.includes(hermesRepo)
  ) ||
  !defaultSetup.nextActions?.some(
    entry =>
      entry.label === 'API-key provider option' &&
      entry.command.includes('<hermes-repo>') &&
      entry.command.includes('openrouter') &&
      !entry.command.includes(hermesRepo)
  ) ||
  !defaultSetup.nextActions?.some(
    entry =>
      entry.label === 'Re-run Hermes preflight' &&
      entry.command === 'agenttalk hermes preflight'
  )
) {
  throw new Error(`unconfigured hermes did not include redacted credential next action: ${JSON.stringify(defaultSetup)}`);
}

const setup = parseJson(
  await run([
    'setup',
    '--agents',
    '--json',
    '--openclaw-repo',
    openclawRepo,
    '--hermes-repo',
    hermesRepo,
    '--allow-unconfigured-hermes',
    '--no-codex',
  ])
);

if (setup.ok !== true || setup.configured?.length !== 2) {
  throw new Error(`unexpected setup result: ${JSON.stringify(setup)}`);
}
if (!setup.configured.some(entry => entry.agent?.kind === 'openclaw')) {
  throw new Error(`openclaw was not configured: ${JSON.stringify(setup)}`);
}
if (!setup.configured.some(entry => entry.agent?.kind === 'hermes')) {
  throw new Error(`hermes was not configured: ${JSON.stringify(setup)}`);
}
if (!setup.configured.every(entry => entry.agent?.wake?.enabled === false)) {
  throw new Error(`setup should default wake off for every configured agent: ${JSON.stringify(setup)}`);
}
if (
  !setup.configured.every(
    entry =>
      entry.agent?.wake?.accessMode === 'allow_list' &&
      Array.isArray(entry.agent?.wake?.allowedWakeSenderAgentIds) &&
      entry.agent.wake.allowedWakeSenderAgentIds.length === 0 &&
      Array.isArray(entry.agent?.wake?.blockedWakeSenderAgentIds) &&
      entry.agent.wake.blockedWakeSenderAgentIds.length === 0
  )
) {
  throw new Error(`setup should default wake access lists empty: ${JSON.stringify(setup)}`);
}

const status = parseJson(await run(['supervisor', 'status', '--json']));
if (status.ok !== true || status.agents?.length !== 2) {
  throw new Error(`unexpected supervisor status: ${JSON.stringify(status)}`);
}

await fs.rm(home, { recursive: true, force: true });

console.log(JSON.stringify({ ok: true, configured: setup.configured.length }));
