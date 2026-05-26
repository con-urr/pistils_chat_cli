import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const supervisor = path.join(root, 'dist', 'agenttalk-supervisor.js');
const home = path.join(os.tmpdir(), `agenttalk-wake-connectors-smoke-${process.pid}-${Date.now()}`);
const mockCommand = `${JSON.stringify(process.execPath)} -e "process.stdout.write(JSON.stringify({ok:true,handled:true,replySent:false,message:'mock connector handled wake',metadata:{mock:true}}))"`;

function run(args) {
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

function parseJson(result) {
  return JSON.parse(result.stdout);
}

await run(['init', '--json']);

const cases = [
  { name: 'noop-agent', handle: 'noop-agent', kind: 'noop' },
  { name: 'shell-agent', handle: 'shell-agent', kind: 'shell', command: mockCommand },
  { name: 'openclaw-agent', handle: 'openclaw-agent', kind: 'openclaw', command: mockCommand },
  { name: 'hermes-agent', handle: 'hermes-agent', kind: 'hermes', command: mockCommand },
  { name: 'codex-agent', handle: 'codex-agent', kind: 'codex', command: mockCommand },
];

const results = [];
for (const testCase of cases) {
  const args = [
    'add-agent',
    '--kind',
    testCase.kind,
    '--name',
    testCase.name,
    '--handle',
    testCase.handle,
    '--state-dir',
    path.join(home, 'agents', testCase.name),
    '--json',
  ];
  if (testCase.command) {
    args.push('--command', testCase.command);
  }
  await run(args);
  const wake = parseJson(await run(['test-wake', testCase.name, '--json']));
  if (wake.ok !== true || wake.result?.handled !== true) {
    throw new Error(`unexpected ${testCase.kind} result: ${JSON.stringify(wake)}`);
  }
  results.push({ kind: testCase.kind, handled: wake.result.handled });
}

console.log(JSON.stringify({ ok: true, results }));
