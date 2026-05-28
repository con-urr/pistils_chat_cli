import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireLiveSmokeOptIn } from './live-smoke-guard.mjs';

requireLiveSmokeOptIn('smoke-supervisor-live-self-replies');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = __dirname;

const cases = [
  {
    name: 'shell',
    script: 'smoke-supervisor-live-self-reply.mjs',
  },
  {
    name: 'codex',
    script: 'smoke-supervisor-live-codex-self-reply.mjs',
  },
  {
    name: 'openclaw',
    script: 'smoke-supervisor-live-openclaw-self-reply.mjs',
  },
  {
    name: 'hermes',
    script: 'smoke-supervisor-live-hermes-self-reply.mjs',
  },
];

function parseLastJson(stdout) {
  const trimmed = stdout.trim();
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    return JSON.parse(trimmed.slice(first, last + 1));
  }
  throw new Error(`No JSON object found in stdout: ${stdout}`);
}

function runCase(testCase) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(scriptsDir, testCase.script)], {
      cwd: path.resolve(scriptsDir, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
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
      const durationMs = Date.now() - started;
      if (code !== 0) {
        reject(new Error(`${testCase.name} live self-reply smoke exited ${code}; ${stderr || stdout}`));
        return;
      }
      try {
        resolve({
          kind: testCase.name,
          durationMs,
          result: parseLastJson(stdout),
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

const results = [];
for (const testCase of cases) {
  results.push(await runCase(testCase));
}

console.log(
  JSON.stringify({
    ok: true,
    results: results.map(item => ({
      kind: item.kind,
      durationMs: item.durationMs,
      conversationId: item.result.conversationId,
      replySequence: item.result.replySequence,
      claimed: item.result.claimed,
      acked: item.result.acked,
      failed: item.result.failed,
    })),
  })
);
