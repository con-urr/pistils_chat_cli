import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const supervisor = path.join(root, 'dist', 'agenttalk-supervisor.js');
const home = path.join(os.tmpdir(), `agenttalk-real-connectors-${process.pid}-${Date.now()}`);
const githubRoot = path.join(os.homedir(), 'Documents', 'GitHub');

function exists(filePath) {
  return fs.access(filePath).then(() => true, () => false);
}

function run(args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [supervisor, ...args], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...extraEnv,
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
        reject(new Error(`agenttalk-supervisor ${args.join(' ')} exited ${code}; ${stderr || stdout}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseJson(result) {
  return JSON.parse(result.stdout);
}

async function findOnPath(command) {
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').map(ext => ext.toLowerCase())
    : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    for (const ext of exts) {
      if (await exists(path.join(dir, `${command}${ext}`))) {
        return true;
      }
    }
  }
  return false;
}

async function detect() {
  const openclaw = path.join(githubRoot, 'openclaw');
  const hermes = path.join(githubRoot, 'hermes-agent');
  const codexWorkdir = root;
  const found = [];
  if (await exists(path.join(openclaw, 'openclaw.mjs'))) {
    found.push({
      kind: 'openclaw',
      name: 'support',
      handle: `real-openclaw-${process.pid}`,
      repo: openclaw,
    });
  }
  const hermesPython = process.platform === 'win32'
    ? path.join(hermes, 'venv', 'Scripts', 'python.exe')
    : path.join(hermes, 'venv', 'bin', 'python');
  if ((await exists(path.join(hermes, 'hermes'))) && (await exists(hermesPython))) {
    found.push({
      kind: 'hermes',
      name: 'research',
      handle: `real-hermes-${process.pid}`,
      repo: hermes,
    });
  }
  if (await findOnPath('codex')) {
    found.push({
      kind: 'codex',
      name: 'coder',
      handle: `real-codex-${process.pid}`,
      repo: codexWorkdir,
    });
  }
  return found;
}

if (process.env.AGENTTALK_RUN_REAL_CONNECTOR_TESTS !== '1') {
  const candidates = await detect();
  console.log(
    JSON.stringify({
      ok: true,
      skipped: true,
      reason: 'Set AGENTTALK_RUN_REAL_CONNECTOR_TESTS=1 to run local agent runtimes.',
      detected: candidates.map(candidate => ({ kind: candidate.kind, ready: true })),
    })
  );
  process.exit(0);
}

const candidates = await detect();
const results = [];
try {
  parseJson(await run(['init', '--json']));
  for (const candidate of candidates) {
    parseJson(
      await run([
        'add-agent',
        '--kind',
        candidate.kind,
        '--name',
        candidate.name,
        '--handle',
        candidate.handle,
        '--repo',
        candidate.repo,
        '--state-dir',
        path.join(home, 'agents', candidate.name),
        '--timeout-ms',
        candidate.kind === 'codex' ? '120000' : '60000',
        '--json',
      ])
    );
    const result = parseJson(await run(['test-wake', candidate.name, '--json']));
    results.push({ kind: candidate.kind, handled: result.result?.handled === true });
  }
} finally {
  await fs.rm(home, { recursive: true, force: true });
}

if (results.some(result => !result.handled)) {
  throw new Error(`one or more real connectors did not handle test wake: ${JSON.stringify(results)}`);
}

console.log(JSON.stringify({ ok: true, results }));
