import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function run(command, args, options = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...options,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', error => {
      resolve({ code: -1, stdout, stderr: error.message });
    });
    child.on('close', code => {
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'agenttalk-hermes-oauth-timeout-'));
const fakeHermes = path.join(tempDir, 'fake-hermes.mjs');
const fakeGrandchild = path.join(tempDir, 'fake-grandchild.mjs');
const pidFile = path.join(tempDir, 'child.pid');
const grandchildPidFile = path.join(tempDir, 'grandchild.pid');

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

try {
  await writeFile(fakeGrandchild, `
import { writeFileSync } from 'node:fs';

writeFileSync(process.env.AGENTTALK_FAKE_HERMES_GRANDCHILD_PID_FILE, String(process.pid));
setInterval(() => {}, 1000);
`, 'utf8');

  await writeFile(fakeHermes, `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

writeFileSync(process.env.AGENTTALK_FAKE_HERMES_PID_FILE, String(process.pid));
spawn(process.execPath, [process.env.AGENTTALK_FAKE_HERMES_GRANDCHILD], {
  stdio: 'ignore',
  windowsHide: true,
});
setInterval(() => {}, 1000);
`, 'utf8');

  const result = await run(process.execPath, [
    'scripts/hermes-codex-oauth.mjs',
    '--confirm',
    '--repo',
    tempDir,
    '--python',
    process.execPath,
    '--hermes-entrypoint',
    fakeHermes,
    '--timeout-seconds',
    '1',
  ], {
    env: {
      ...process.env,
      AGENTTALK_FAKE_HERMES_PID_FILE: pidFile,
      AGENTTALK_FAKE_HERMES_GRANDCHILD_PID_FILE: grandchildPidFile,
      AGENTTALK_FAKE_HERMES_GRANDCHILD: fakeGrandchild,
    },
  });
  const output = `${result.stdout}\n${result.stderr}`;

  if (result.code !== 3) {
    throw new Error(`hermes-codex-oauth timeout exited ${result.code}, expected 3: ${output}`);
  }
  if (!output.includes('Hermes Codex OAuth command timed out before approval completed')) {
    throw new Error(`hermes-codex-oauth timeout did not explain the timeout: ${output}`);
  }
  if (!output.includes('hermes-command-timeout')) {
    throw new Error(`hermes-codex-oauth timeout did not emit command timeout telemetry: ${output}`);
  }
  if (!output.includes('<hermes-repo>') || output.includes(tempDir)) {
    throw new Error(`hermes-codex-oauth timeout output did not keep repo path redacted: ${output}`);
  }
  if (!existsSync(pidFile)) {
    throw new Error('hermes-codex-oauth timeout smoke did not observe the fake child process');
  }
  if (!existsSync(grandchildPidFile)) {
    throw new Error('hermes-codex-oauth timeout smoke did not observe the fake grandchild process');
  }
  const childPid = Number(readFileSync(pidFile, 'utf8'));
  const grandchildPid = Number(readFileSync(grandchildPidFile, 'utf8'));
  if (!Number.isInteger(childPid) || childPid <= 0) {
    throw new Error(`hermes-codex-oauth timeout smoke recorded an invalid child pid: ${childPid}`);
  }
  if (!Number.isInteger(grandchildPid) || grandchildPid <= 0) {
    throw new Error(`hermes-codex-oauth timeout smoke recorded an invalid grandchild pid: ${grandchildPid}`);
  }
  if (isProcessRunning(childPid)) {
    throw new Error(`hermes-codex-oauth timeout left fake child process ${childPid} running`);
  }
  if (isProcessRunning(grandchildPid)) {
    throw new Error(`hermes-codex-oauth timeout left fake grandchild process ${grandchildPid} running`);
  }
  if (/Bearer\s+[A-Za-z0-9._-]+|[A-Z0-9_]*API_KEY=[^\s]+/i.test(output)) {
    throw new Error('hermes-codex-oauth timeout leaked a credential-shaped value');
  }

  console.log(JSON.stringify({ ok: true, guard: 'timeout-cleans-process-tree' }));
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
