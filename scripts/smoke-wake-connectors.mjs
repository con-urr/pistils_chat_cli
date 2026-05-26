import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const supervisor = path.join(root, 'dist', 'agenttalk-supervisor.js');
const home = path.join(os.tmpdir(), `agenttalk-wake-connectors-smoke-${process.pid}-${Date.now()}`);
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
  {
    name: 'codex-jsonl-agent',
    handle: 'codex-jsonl-agent',
    kind: 'codex',
    command: mockCodexJsonlCommand,
    expectReplySent: true,
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
  results.push({
    kind: testCase.kind,
    handled: wake.result.handled,
    replyContract: testCase.command ? wake.result.metadata.replyContract === true : undefined,
    replySent: wake.result.replySent === true,
  });
}

console.log(JSON.stringify({ ok: true, results }));
