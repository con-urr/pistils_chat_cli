#!/usr/bin/env node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const cli = path.join(root, 'dist', 'agenttalk.js');
const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const base = await mkdtemp(path.join(tmpdir(), `agenttalk-daemon-routing-${suffix}-`));
const alpha = path.join(base, 'alpha');
const beta = path.join(base, 'beta');
const runState = path.join(base, 'run-jsonl');
const alphaHandle = `smoke-daemon-alpha-${suffix}`;
const betaHandle = `smoke-daemon-beta-${suffix}`;

function run(args, { stateDir, env = {}, input, expectCode = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: root,
      env: {
        ...process.env,
        AGENTTALK_STATE_DIR: stateDir,
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
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
    if (input) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

function parseJson(result) {
  return JSON.parse(result.stdout);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function actionArgs(payload, name) {
  const action = payload.nextActions?.find(item => item.name === name);
  return action?.args ?? [];
}

function assertCursorAction(payload, name, expectedAfter, message) {
  const args = actionArgs(payload, name);
  assert(args.length > 0, `${message}: missing ${name} nextAction`);
  if (expectedAfter) {
    const afterIndex = args.indexOf('--after');
    assert(afterIndex >= 0, `${message}: ${name} nextAction must include --after`);
    assert(args[afterIndex + 1] === expectedAfter, `${message}: ${name} nextAction after cursor mismatch`);
  }
}

async function stopDaemon(stateDir) {
  try {
    await run(['daemon', 'stop', '--json'], { stateDir });
  } catch {
    // Best-effort cleanup for smoke states.
  }
}

async function waitForDaemonStopped(stateDir, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const status = parseJson(await run(['daemon', 'status', '--json'], { stateDir }));
    if (status.running === false) {
      return status;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return parseJson(await run(['daemon', 'status', '--json'], { stateDir }));
}

try {
  const initialStatus = parseJson(await run(['daemon', 'status', '--json'], { stateDir: alpha }));
  assert(initialStatus.running === false, 'fresh alpha daemon should not be running');

  const alphaInitResult = await run(
    [
      'init',
      '--handle',
      alphaHandle,
      '--name',
      'Daemon Routing Alpha Smoke',
      '--role',
      'agent',
      '--bio',
      'daemon routing smoke',
      '--json',
    ],
    { stateDir: alpha }
  );
  const alphaInit = parseJson(alphaInitResult);
  assert(alphaInit.transport === 'daemon' && alphaInit.daemon === true, 'init must use daemon');
  assert(alphaInitResult.stdout.trim().startsWith('{'), 'init --json should emit JSON stdout');
  assert(alphaInit.daemonStarted === true, 'init should report daemonStarted on first use');
  assert(
    !alphaInitResult.stderr.includes('[info] agenttalkd not running; starting...'),
    'init --json should not emit the daemon-start info line'
  );

  const alphaStatus = parseJson(await run(['daemon', 'status', '--json'], { stateDir: alpha }));
  assert(alphaStatus.running === true, 'init should auto-start alpha daemon');

  const alphaDoctor = parseJson(await run(['daemon', 'doctor', '--json'], { stateDir: alpha }));
  assert(
    alphaDoctor.whoami?.account?.handle === alphaHandle,
    'daemon doctor should report the same account as whoami'
  );

  const betaInit = parseJson(
    await run(
      [
        'init',
        '--handle',
        betaHandle,
        '--name',
        'Daemon Routing Beta Smoke',
        '--role',
        'agent',
        '--bio',
        'daemon routing smoke',
        '--json',
      ],
      { stateDir: beta }
    )
  );
  assert(betaInit.transport === 'daemon' && betaInit.daemon === true, 'beta init must use daemon');
  assert(betaInit.daemonStarted === true, 'beta init should report daemonStarted on first use');

  const findBeta = parseJson(await run(['find', betaHandle, '--json'], { stateDir: alpha }));
  assert(findBeta.transport === 'daemon' && findBeta.accounts.length === 1, 'find must use daemon');

  await stopDaemon(alpha);
  const stopped = await waitForDaemonStopped(alpha);
  assert(stopped.running === false, 'alpha daemon stop should stop daemon');

  const chat = parseJson(
    await run(
      ['chat', `@${betaHandle}`, '--message', 'daemon routing smoke chat', '--json'],
      { stateDir: alpha }
    )
  );
  assert(chat.transport === 'daemon' && chat.daemon === true, 'chat must auto-start daemon');
  assert(chat.daemonStarted === true, 'chat should report daemonStarted after daemon stop');
  assert(chat.conversationId, 'chat should return conversationId');
  assert(chat.nextAfterSequence, 'chat should return a cursor after send');
  assertCursorAction(chat, 'listen', chat.nextAfterSequence, 'chat');

  const inbox = parseJson(
    await run(['inbox', '--wait', '5s', '--min', '1', '--max', '1', '--json'], {
      stateDir: beta,
    })
  );
  assert(inbox.transport === 'daemon' && inbox.count >= 1, 'inbox wait must use daemon');
  assert(!('result' in inbox), 'inbox should not expose raw daemon items/result');
  assert(inbox.unhydratedDeliveryCount === 0, 'inbox should not expose unhydrated delivery rows');
  assert(inbox.conversationId === chat.conversationId, 'inbox should expose top-level conversationId');
  assert(inbox.nextAfterSequence, 'inbox should return a cursor');
  assertCursorAction(inbox, 'listen', inbox.nextAfterSequence, 'inbox');

  const reply = parseJson(
    await run(
      ['reply', chat.conversationId, '--message', 'daemon routing smoke reply', '--json'],
      { stateDir: beta }
    )
  );
  assert(reply.transport === 'daemon' && reply.daemon === true, 'reply must use daemon');
  assert(reply.nextAfterSequence, 'reply should return a cursor after send');
  assertCursorAction(reply, 'listen', reply.nextAfterSequence, 'reply');

  const listen = parseJson(
    await run(
      ['listen', '--conversation', chat.conversationId, '--after', '1', '--timeout', '5s', '--json'],
      { stateDir: alpha }
    )
  );
  assert(listen.transport === 'daemon' && listen.count >= 1, 'listen must use daemon');

  const alphaInbox = parseJson(
    await run(['inbox', '--max', '10', '--json'], {
      stateDir: alpha,
    })
  );
  assert(!('result' in alphaInbox), 'plain inbox should not expose raw daemon items/result');
  assert(
    alphaInbox.messages.every(message => message && message.text),
    'plain inbox messages should be hydrated'
  );

  const transcript = parseJson(
    await run(['transcript', '--conversation', chat.conversationId, '--json'], {
      stateDir: alpha,
    })
  );
  assert(
    transcript.transport === 'daemon' && transcript.messages.length >= 2,
    'transcript must use daemon'
  );
  assert(
    transcript.messages[0]?.sequence === '1',
    'transcript without cursor should start at the beginning of the hot conversation'
  );
  assert(!('result' in transcript), 'transcript should not duplicate messages under result.messages');
  assertCursorAction(transcript, 'listen', transcript.nextAfterSequence, 'transcript');

  const denied = await run(
    ['chat', `@${betaHandle}`, '--message', 'must fail', '--no-daemon', '--json'],
    { stateDir: alpha, expectCode: 1 }
  );
  assert(
    denied.stderr.includes('Direct SpaceTimeDB CLI mode is not available through agenttalk'),
    '--no-daemon must be blocked'
  );

  const directDenied = await run(
    ['chat', `@${betaHandle}`, '--message', 'must fail', '--direct', '--json'],
    { stateDir: alpha, env: { AGENTTALK_ALLOW_DIRECT_CLI: '1' }, expectCode: 1 }
  );
  assert(
    directDenied.stderr.includes('Direct SpaceTimeDB CLI mode is not available through agenttalk'),
    '--direct must remain blocked even with legacy env'
  );

  const jsonl = await run(['run', '--jsonl'], {
    stateDir: runState,
    input: '{"id":"1","cmd":"ping"}\n{"id":"2","cmd":"shutdown"}\n',
  });
  const jsonlLines = jsonl.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert(
    jsonlLines.every(line => line.transport === 'daemon' && line.daemon === true),
    'run --jsonl must use daemon transport'
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        conversationId: chat.conversationId,
        checks: [
          'init-autostart',
          'find',
          'chat-autostart',
          'inbox',
          'reply',
          'listen',
          'transcript',
          'direct-denied',
          'run-jsonl',
        ],
      },
      null,
      2
    )
  );
} finally {
  await stopDaemon(alpha);
  await stopDaemon(beta);
  if (process.env.AGENTTALK_KEEP_SMOKE_STATE !== '1') {
    await rm(base, { recursive: true, force: true });
  }
}
