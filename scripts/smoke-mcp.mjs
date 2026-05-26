import { spawn } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const serverPath = path.join(root, 'dist', 'mcp-server.js');
const cliPath = path.join(root, 'dist', 'agenttalk.js');
const useAgenttalkAlias = process.argv.includes('--agenttalk');
const smokeStateDir = path.join(
  os.tmpdir(),
  `agenttalk-mcp-smoke-${process.pid}-${Date.now()}`
);
const childEnv = { ...process.env };
delete childEnv.AGENTTALK_TOKEN;

const child = spawn(process.execPath, useAgenttalkAlias ? [cliPath, 'mcp'] : [serverPath], {
  cwd: root,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...childEnv,
    AGENTTALK_STATE_DIR: smokeStateDir,
    SPACETIMEDB_HOST: 'https://maincloud.spacetimedb.com',
    SPACETIMEDB_DB_NAME: 'crimsonconfidentialgibbon',
    AGENTTALK_MCP_SMOKE: '1',
  },
});

let nextId = 1;
let stdoutBuffer = '';
let stderrBuffer = '';
const pending = new Map();

function fail(message) {
  child.kill();
  throw new Error(message);
}

child.stderr.on('data', chunk => {
  stderrBuffer += chunk.toString('utf8');
});

child.stdout.on('data', chunk => {
  stdoutBuffer += chunk.toString('utf8');
  while (true) {
    const index = stdoutBuffer.indexOf('\n');
    if (index < 0) {
      break;
    }
    const line = stdoutBuffer.slice(0, index).trim();
    stdoutBuffer = stdoutBuffer.slice(index + 1);
    if (!line) {
      continue;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      fail(`MCP server wrote non-JSON stdout: ${line}`);
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject, timer } = pending.get(message.id);
      clearTimeout(timer);
      pending.delete(message.id);
      if (message.error) {
        reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      } else {
        resolve(message.result);
      }
    }
  }
});

function request(method, params, timeoutMs = 30_000) {
  const id = nextId++;
  const payload = {
    jsonrpc: '2.0',
    id,
    method,
    ...(params === undefined ? {} : { params }),
  };
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
  });
  child.stdin.write(`${JSON.stringify(payload)}\n`);
  return promise;
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

try {
  const init = await request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'agenttalk-mcp-smoke', version: '0.1.0' },
  });
  if (!init?.serverInfo?.name) {
    fail(`Initialize did not return serverInfo: ${JSON.stringify(init)}`);
  }

  notify('notifications/initialized', {});

  const tools = await request('tools/list', {});
  const names = new Set((tools.tools ?? []).map(tool => tool.name));
  for (const required of [
    'agenttalk_whoami',
    'agenttalk_search_accounts',
    'agenttalk_chat_start',
    'agenttalk_inbox',
    'agenttalk_wake_status',
  ]) {
    if (!names.has(required)) {
      fail(`Missing MCP tool ${required}`);
    }
  }

  const whoami = await request('tools/call', {
    name: 'agenttalk_whoami',
    arguments: {},
  });
  const whoamiText = whoami?.content?.[0]?.text ?? '';
  const parsed = JSON.parse(whoamiText);
  if (parsed.ok !== true || !parsed.data?.identity) {
    fail(`agenttalk_whoami returned unexpected payload: ${whoamiText}`);
  }

  console.log(
    JSON.stringify({
      ok: true,
      entrypoint: useAgenttalkAlias ? 'agenttalk mcp' : 'agenttalk-mcp',
      server: init.serverInfo,
      toolCount: tools.tools.length,
      whoami: {
        identity: parsed.data.identity,
        account: parsed.data.account?.handle ?? null,
      },
    })
  );
} finally {
  child.stdin.end();
  child.kill();
  await Promise.race([
    once(child, 'exit'),
    new Promise(resolve => setTimeout(resolve, 1000)),
  ]);
  if (stderrBuffer.trim() && process.env.AGENTTALK_MCP_SMOKE_DEBUG) {
    process.stderr.write(stderrBuffer);
  }
}
