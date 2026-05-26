import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const supervisor = path.join(root, 'dist', 'agenttalk-supervisor.js');
const agenttalk = path.join(root, 'dist', 'agenttalk.js');
const home = path.join(os.tmpdir(), `agenttalk-supervisor-smoke-${process.pid}-${Date.now()}`);

function run(entry, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
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
        reject(new Error(`${path.basename(entry)} ${args.join(' ')} exited ${code}; ${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseJson(result) {
  return JSON.parse(result.stdout);
}

const init = parseJson(await run(supervisor, ['init', '--json']));
if (init.ok !== true || init.created !== true) {
  throw new Error(`unexpected init result: ${JSON.stringify(init)}`);
}

const add = parseJson(
  await run(supervisor, [
    'add-agent',
    '--kind',
    'noop',
    '--name',
    'support',
    '--handle',
    'support-agent',
    '--state-dir',
    path.join(home, 'agents', 'support'),
    '--json',
  ])
);
if (add.ok !== true || add.agent?.kind !== 'noop') {
  throw new Error(`unexpected add-agent result: ${JSON.stringify(add)}`);
}

const status = parseJson(await run(agenttalk, ['supervisor', 'status', '--json']));
if (status.ok !== true || status.agents?.[0]?.name !== 'support') {
  throw new Error(`unexpected status result: ${JSON.stringify(status)}`);
}

const doctor = parseJson(await run(agenttalk, ['supervisor', 'doctor', '--json']));
if (
  doctor.ok !== true ||
  !doctor.checks?.some(check => check.name === 'agent:connector' && check.ok === true)
) {
  throw new Error(`unexpected doctor result: ${JSON.stringify(doctor)}`);
}

const testWake = parseJson(await run(supervisor, ['test-wake', 'support', '--json']));
if (testWake.ok !== true || testWake.result?.handled !== true) {
  throw new Error(`unexpected test-wake result: ${JSON.stringify(testWake)}`);
}

const logs = parseJson(await run(supervisor, ['logs', '--agent', 'support', '--tail', '5', '--json']));
if (logs.ok !== true || !Array.isArray(logs.events)) {
  throw new Error(`unexpected logs result: ${JSON.stringify(logs)}`);
}

const events = parseJson(await run(supervisor, ['events', '--tail', '5', '--json']));
if (events.ok !== true || !Array.isArray(events.events)) {
  throw new Error(`unexpected events result: ${JSON.stringify(events)}`);
}

const service = parseJson(await run(supervisor, ['install-service', '--dry-run', '--json']));
if (service.ok !== true || service.dryRun !== true) {
  throw new Error(`unexpected install-service result: ${JSON.stringify(service)}`);
}

console.log(
  JSON.stringify({
    ok: true,
    entrypoints: ['agenttalk-supervisor', 'agenttalk supervisor'],
    agents: status.agents.length,
    doctorChecks: doctor.checks.length,
    testWake: testWake.result,
    logs: logs.events.length,
    servicePlatform: service.platform,
  })
);
