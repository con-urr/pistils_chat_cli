import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const supervisor = path.join(root, 'dist', 'agenttalk-supervisor.js');
const home = path.join(os.tmpdir(), `agenttalk-wake-connectors-smoke-${process.pid}-${Date.now()}`);
const fakeBin = path.join(home, 'fake-bin');
const fakeHermesRepo = path.join(home, 'fake-hermes-repo');
const fakeOpenClawRepo = path.join(home, 'fake-openclaw-repo');
const mockCode = [
  "const required=['AGENTTALK_STATE_DIR','AGENTTALK_CONVERSATION_ID','AGENTTALK_CLI','AGENTTALK_REPLY_COMMAND','AGENTTALK_REPLY_ARGS_JSON','SPACETIMEDB_HOST','SPACETIMEDB_DB_NAME'];",
  "const missing=required.filter(name=>!process.env[name]);",
  "if(missing.length){process.stderr.write('missing env: '+missing.join(','));process.exit(2);}",
  "const replyArgs=JSON.parse(process.env.AGENTTALK_REPLY_ARGS_JSON);",
  "if(replyArgs.conversationId!==process.env.AGENTTALK_CONVERSATION_ID){process.stderr.write('reply args conversationId mismatch');process.exit(3);}",
  "process.stdout.write(JSON.stringify({ok:true,handled:true,replySent:false,message:'mock connector handled wake',metadata:{mock:true,replyContract:true,hostFromSupervisor:process.env.SPACETIMEDB_HOST}}));",
].join('');
const mockCommand = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(mockCode)}`;
const mockCodexJsonlCode = [
  "const required=['AGENTTALK_STATE_DIR','AGENTTALK_CONVERSATION_ID','AGENTTALK_CLI','AGENTTALK_REPLY_COMMAND','AGENTTALK_REPLY_ARGS_JSON','SPACETIMEDB_HOST','SPACETIMEDB_DB_NAME'];",
  "const missing=required.filter(name=>!process.env[name]);",
  "if(missing.length){process.stderr.write('missing env: '+missing.join(','));process.exit(2);}",
  "const replyArgs=JSON.parse(process.env.AGENTTALK_REPLY_ARGS_JSON);",
  "if(replyArgs.conversationId!==process.env.AGENTTALK_CONVERSATION_ID){process.stderr.write('reply args conversationId mismatch');process.exit(3);}",
  "const result={ok:true,handled:true,replySent:true,message:'codex jsonl handled wake',metadata:{mock:true,replyContract:true,codexJsonl:true}};",
  "const newline=String.fromCharCode(10);",
  "const events=[{type:'thread.started',thread_id:'mock-codex'},{type:'item.completed',item:{id:'item_0',type:'agent_message',text:JSON.stringify(result)}},{type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}];",
  "process.stdout.write(events.map(event=>JSON.stringify(event)).join(newline)+newline);",
].join('');
const mockCodexJsonlCommand = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(mockCodexJsonlCode)}`;

async function installFakeCodex() {
  await fs.mkdir(fakeBin, { recursive: true });
  const fakeCodexScript = path.join(fakeBin, 'fake-codex.mjs');
  await fs.writeFile(
    fakeCodexScript,
    [
      "import { existsSync, readFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      "const schemaIndex = args.indexOf('--output-schema');",
      "if (schemaIndex === -1 || !args[schemaIndex + 1]) { process.stderr.write('missing --output-schema'); process.exit(2); }",
      "if (!args.includes('--json')) { process.stderr.write('missing --json'); process.exit(3); }",
      "const sandboxIndex = args.indexOf('--sandbox');",
      "if (sandboxIndex === -1 || args[sandboxIndex + 1] !== 'read-only') { process.stderr.write('unexpected sandbox'); process.exit(4); }",
      "const schemaPath = args[schemaIndex + 1];",
      "if (!existsSync(schemaPath)) { process.stderr.write('schema file missing'); process.exit(5); }",
      "const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));",
      "if (!schema.required?.includes('ok') || !schema.required?.includes('handled') || !schema.required?.includes('replySent')) { process.stderr.write('schema missing connector result requirements'); process.exit(6); }",
      "const result = { ok: true, handled: true, replySent: true, replyText: null, message: 'fake codex default handled wake', error: null, artifacts: null, metadata: 'defaultCodex' };",
      "const newline = String.fromCharCode(10);",
      "const events = [{ type: 'thread.started', thread_id: 'fake-codex-default' }, { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: JSON.stringify(result) } }, { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }];",
      "process.stdout.write(events.map(event => JSON.stringify(event)).join(newline) + newline);",
    ].join('\n'),
    'utf8'
  );
  if (process.platform === 'win32') {
    await fs.writeFile(
      path.join(fakeBin, 'codex.cmd'),
      `@echo off\r\n"${process.execPath}" "${fakeCodexScript}" %*\r\n`,
      'utf8'
    );
  } else {
    const codexPath = path.join(fakeBin, 'codex');
    await fs.writeFile(codexPath, `#!/usr/bin/env sh\nexec "${process.execPath}" "${fakeCodexScript}" "$@"\n`, 'utf8');
    await fs.chmod(codexPath, 0o755);
  }
}

async function installFakeHermesRepo() {
  const pythonPath = process.platform === 'win32'
    ? path.join(fakeHermesRepo, 'venv', 'Scripts', 'python.exe')
    : path.join(fakeHermesRepo, 'venv', 'bin', 'python');
  await fs.mkdir(path.dirname(pythonPath), { recursive: true });
  await fs.copyFile(process.execPath, pythonPath);
  const hermesScript = path.join(fakeHermesRepo, 'hermes');
  await fs.writeFile(
    hermesScript,
    [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const args = process.argv.slice(2);",
      "if (args[0] !== 'chat') { process.stderr.write('missing chat command'); process.exit(2); }",
      "if (!args.includes('--quiet')) { process.stderr.write('missing --quiet'); process.exit(3); }",
      "if (!args.includes('--pass-session-id')) { process.stderr.write('missing --pass-session-id'); process.exit(4); }",
      "const sourceIndex = args.indexOf('--source');",
      "if (sourceIndex === -1 || args[sourceIndex + 1] !== 'agenttalk') { process.stderr.write('missing agenttalk source'); process.exit(5); }",
      "const resumeIndex = args.indexOf('--resume');",
      "const sessionId = resumeIndex === -1 ? 'fake-hermes-session-0' : args[resumeIndex + 1];",
      "const stateDir = process.env.AGENTTALK_STATE_DIR;",
      "if (!stateDir) { process.stderr.write('missing AGENTTALK_STATE_DIR'); process.exit(6); }",
      "const callsPath = path.join(stateDir, 'fake-hermes-calls.json');",
      "let calls = [];",
      "try { calls = JSON.parse(fs.readFileSync(callsPath, 'utf8')); } catch {}",
      "calls.push({ hasResume: resumeIndex !== -1, resumeSessionId: resumeIndex === -1 ? null : args[resumeIndex + 1], sessionId, conversationId: process.env.AGENTTALK_CONVERSATION_ID });",
      "fs.writeFileSync(callsPath, JSON.stringify(calls, null, 2));",
      "process.stdout.write(JSON.stringify({ ok: true, handled: true, replySent: false, message: 'fake hermes default handled wake', metadata: { fakeHermes: true, sessionId } }));",
      "process.stderr.write('\\nsession_id: ' + sessionId + '\\n');",
    ].join('\n'),
    'utf8'
  );
  if (process.platform !== 'win32') {
    await fs.chmod(pythonPath, 0o755);
    await fs.chmod(hermesScript, 0o755);
  }
}

async function installFakeOpenClawRepo() {
  await fs.mkdir(fakeOpenClawRepo, { recursive: true });
  const openclawScript = path.join(fakeOpenClawRepo, 'openclaw.mjs');
  await fs.writeFile(
    openclawScript,
    [
      "const args = process.argv.slice(2);",
      "if (args[0] !== 'agent') { process.stderr.write('missing agent command'); process.exit(2); }",
      "const agentIndex = args.indexOf('--agent');",
      "if (agentIndex === -1 || args[agentIndex + 1] !== 'main') { process.stderr.write('unexpected openclaw agent id'); process.exit(3); }",
      "if (!args.includes('--json')) { process.stderr.write('missing --json'); process.exit(4); }",
      "const result = { ok: true, handled: true, replySent: false, replyText: 'fake openclaw payload reply', message: 'fake openclaw handled wake', metadata: { fakeOpenClaw: true } };",
      "process.stdout.write(JSON.stringify({ runId: 'fake-openclaw-run', status: 'ok', result: { payloads: [{ text: JSON.stringify(result), mediaUrl: null }] } }));",
    ].join('\n'),
    'utf8'
  );
}

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [supervisor, ...args], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
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

await installFakeCodex();
await installFakeHermesRepo();
await installFakeOpenClawRepo();
await run(['init', '--json']);

const cases = [
  { name: 'noop-agent', handle: 'noop-agent', kind: 'noop' },
  { name: 'shell-agent', handle: 'shell-agent', kind: 'shell', command: mockCommand },
  { name: 'openclaw-agent', handle: 'openclaw-agent', kind: 'openclaw', command: mockCommand },
  { name: 'hermes-agent', handle: 'hermes-agent', kind: 'hermes', command: mockCommand },
  { name: 'codex-agent', handle: 'codex-agent', kind: 'codex', command: mockCommand },
  {
    name: 'codex-default-agent',
    handle: 'codex-default-agent',
    kind: 'codex',
    repo: root,
    expectReplySent: true,
  },
  {
    name: 'codex-jsonl-agent',
    handle: 'codex-jsonl-agent',
    kind: 'codex',
    command: mockCodexJsonlCommand,
    expectReplySent: true,
  },
  {
    name: 'openclaw-default-agent',
    handle: 'openclaw-default-agent',
    kind: 'openclaw',
    repo: fakeOpenClawRepo,
    openclawAgentId: 'main',
    expectReplyText: 'fake openclaw payload reply',
  },
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
  if (testCase.repo) {
    args.push('--repo', testCase.repo);
  }
  if (testCase.openclawAgentId) {
    args.push('--openclaw-agent-id', testCase.openclawAgentId);
  }
  await run(args);
  const wake = parseJson(await run(['test-wake', testCase.name, '--json']));
  if (wake.ok !== true || wake.result?.handled !== true) {
    throw new Error(`unexpected ${testCase.kind} result: ${JSON.stringify(wake)}`);
  }
  if (testCase.command && wake.result?.metadata?.replyContract !== true) {
    throw new Error(`missing reply contract metadata for ${testCase.kind}: ${JSON.stringify(wake)}`);
  }
  if (testCase.expectReplySent && wake.result?.replySent !== true) {
    throw new Error(`expected ${testCase.kind} JSONL result replySent=true: ${JSON.stringify(wake)}`);
  }
  if (testCase.expectReplyText && wake.result?.replyText !== testCase.expectReplyText) {
    throw new Error(`expected ${testCase.kind} payload replyText: ${JSON.stringify(wake)}`);
  }
  results.push({
    kind: testCase.kind,
    handled: wake.result.handled,
    replyContract: testCase.command ? wake.result.metadata.replyContract === true : undefined,
    defaultCodex: wake.result.message === 'fake codex default handled wake',
    defaultOpenClaw: wake.result.message === 'fake openclaw handled wake',
    replySent: wake.result.replySent === true,
    replyText: wake.result.replyText,
  });
}

const hermesDefaultStateDir = path.join(home, 'agents', 'hermes-default-agent');
await run([
  'add-agent',
  '--kind',
  'hermes',
  '--name',
  'hermes-default-agent',
  '--handle',
  'hermes-default-agent',
  '--repo',
  fakeHermesRepo,
  '--state-dir',
  hermesDefaultStateDir,
  '--json',
]);
const firstHermesWake = parseJson(await run(['test-wake', 'hermes-default-agent', '--json']));
const secondHermesWake = parseJson(await run(['test-wake', 'hermes-default-agent', '--json']));
if (
  firstHermesWake.ok !== true ||
  secondHermesWake.ok !== true ||
  firstHermesWake.result?.metadata?.hermesSessionId !== 'fake-hermes-session-0' ||
  secondHermesWake.result?.metadata?.hermesSessionId !== 'fake-hermes-session-0'
) {
  throw new Error(`unexpected default hermes results: ${JSON.stringify({ firstHermesWake, secondHermesWake })}`);
}
const hermesCalls = JSON.parse(await fs.readFile(path.join(hermesDefaultStateDir, 'fake-hermes-calls.json'), 'utf8'));
if (
  hermesCalls.length !== 2 ||
  hermesCalls[0].hasResume !== false ||
  hermesCalls[1].hasResume !== true ||
  hermesCalls[1].resumeSessionId !== 'fake-hermes-session-0'
) {
  throw new Error(`default hermes connector should resume the first wake session: ${JSON.stringify(hermesCalls)}`);
}

console.log(JSON.stringify({ ok: true, results }));
