#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const cli = path.join(root, 'dist', 'agenttalk.js');

function run(args, { expectCode = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: root,
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

const help = await run(['help']);
assert(
  help.stdout.includes('Open beta supported daemon-first commands:'),
  'help must expose the open-beta supported command section'
);
assert(
  help.stdout.includes('Experimental/dev surfaces:'),
  'help must expose the experimental/dev command section'
);
assert(
  help.stdout.includes('--direct           disabled'),
  'help must say --direct is disabled'
);
assert(
  help.stdout.includes('--no-daemon        disabled'),
  'help must say --no-daemon is disabled'
);
assert(
  help.stdout.includes('agenttalk wake status'),
  'help must expose wake status command'
);
assert(
  help.stdout.includes('wake status/on/off/register/policy/listen/claim/ack/fail'),
  'open-beta help must list wake commands'
);
assert(
  help.stdout.includes('account-admin|wake|rooms'),
  'subscription profile help must include the separate wake profile'
);

const noDaemon = await run(
  ['chat', '@surface-test', '--message', 'must fail', '--no-daemon', '--json'],
  { expectCode: 1 }
);
assert(
  noDaemon.stderr.includes('Direct SpaceTimeDB CLI mode is not available through agenttalk'),
  '--no-daemon should fail before network or daemon work'
);

const direct = await run(
  ['chat', '@surface-test', '--message', 'must fail', '--direct', '--json'],
  { expectCode: 1 }
);
assert(
  direct.stderr.includes('Direct SpaceTimeDB CLI mode is not available through agenttalk'),
  '--direct should fail before network or daemon work'
);

console.log(
  JSON.stringify(
    {
      ok: true,
      checks: [
        'help-open-beta-surface',
        'help-wake-surface',
        'direct-disabled',
        'no-daemon-disabled',
      ],
    },
    null,
    2
  )
);
