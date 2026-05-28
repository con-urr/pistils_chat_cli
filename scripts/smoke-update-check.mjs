#!/usr/bin/env node
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const cli = path.join(root, 'dist', 'agenttalk.js');

function run(args, env, { expectCode = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
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
      if (code !== expectCode) {
        reject(new Error(`agenttalk ${args.join(' ')} exited ${code}; stderr=${stderr}`));
        return;
      }
      resolve({ stdout, stderr, code });
    });
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ version: '9.9.9' }));
});

const tempState = await mkdtemp(path.join(os.tmpdir(), 'agenttalk-update-check-'));
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('update-check smoke server did not bind to a TCP port');
  }
  const env = {
    AGENTTALK_STATE_DIR: tempState,
    AGENTTALK_UPDATE_CHECK: '1',
    AGENTTALK_UPDATE_CHECK_URL: `http://127.0.0.1:${address.port}/latest`,
    AGENTTALK_UPDATE_CHECK_TTL_MS: '1',
    AGENTTALK_UPDATE_CHECK_TIMEOUT_MS: '2000',
  };

  const json = await run(['update', 'check', '--force', '--json'], env);
  const payload = JSON.parse(json.stdout);
  assert(payload.ok === true, `update check did not succeed: ${json.stdout}`);
  assert(payload.currentVersion === '0.1.2', `unexpected current version: ${json.stdout}`);
  assert(payload.latestVersion === '9.9.9', `unexpected latest version: ${json.stdout}`);
  assert(payload.updateAvailable === true, `expected updateAvailable: ${json.stdout}`);

  const text = await run(['update', 'check', '--force'], env);
  assert(
    text.stdout.includes('pistils-chat-cli 9.9.9 is available; current 0.1.2'),
    `human update notice missing: ${text.stdout}`
  );

  const passive = await run(['doctor'], env);
  assert(
    passive.stderr.includes('pistils-chat-cli 9.9.9 is available; current 0.1.2'),
    `passive update notice missing: ${passive.stderr}`
  );

  const quietJson = await run(['doctor', '--json'], env);
  assert(
    !quietJson.stderr.includes('pistils-chat-cli 9.9.9 is available'),
    `json command must not emit passive update notice: ${quietJson.stderr}`
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        checks: ['update-check-json', 'update-check-human', 'passive-notice', 'json-silent'],
      },
      null,
      2
    )
  );
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(tempState, { recursive: true, force: true });
}
