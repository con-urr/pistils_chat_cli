#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const strict = process.argv.includes('--strict');
const renderUrlFlagIndex = process.argv.indexOf('--render-url');
let renderUrl =
  renderUrlFlagIndex >= 0 && process.argv[renderUrlFlagIndex + 1]
    ? process.argv[renderUrlFlagIndex + 1]
    : process.env.AGENTTALK_MCP_BASE_URL;
const githubRoot = path.join(os.homedir(), 'Documents', 'GitHub');
const agentTalkMcpRepo = path.resolve(
  process.env.AGENTTALK_MCP_REPO || path.join(githubRoot, 'Agent-Talk-MCP')
);
const liveChatRepo = path.resolve(
  process.env.AGENTTALK_LIVE_CHAT_REPO || path.join(githubRoot, 'live-chat')
);

function check(status, name, detail, extra = {}) {
  return { status, name, detail, ...extra };
}

function redact(text) {
  return String(text)
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/([A-Z0-9_]*API_KEY=)[^\s]+/gi, '$1[redacted]')
    .replace(/(AGENTTALK_MCP_TOKEN=)[^\s]+/gi, '$1[redacted]');
}

function cleanEnv(env) {
  const output = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key || key.includes('=') || value === undefined) {
      continue;
    }
    output[key] = String(value);
  }
  return output;
}

function quoteWindowsShellArg(arg) {
  return /^[A-Za-z0-9_@./:=,-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

function run(command, args, options = {}) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd ?? root,
        env: cleanEnv(options.env ?? process.env),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolve({
        ok: false,
        code: -1,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', error => {
      resolve({ ok: false, code: -1, stdout, stderr: error.message });
    });
    child.on('close', code => {
      resolve({ ok: code === 0, code: code ?? 0, stdout, stderr });
    });
  });
}

function runNpm(args, options = {}) {
  if (process.platform === 'win32') {
    return run(
      'cmd.exe',
      ['/d', '/s', '/c', ['npm.cmd', ...args].map(quoteWindowsShellArg).join(' ')],
      options
    );
  }
  return run('npm', args, options);
}

async function readWindowsUserEnv(name) {
  if (process.platform !== 'win32') {
    return '';
  }
  const result = await run('powershell.exe', [
    '-NoProfile',
    '-Command',
    `[Environment]::GetEnvironmentVariable('${name}','User')`,
  ]);
  return result.ok ? result.stdout.trim() : '';
}

function parseJsonFromOutput(output) {
  const text = String(output);
  for (let index = text.indexOf('{'); index >= 0; index = text.indexOf('{', index + 1)) {
    try {
      return JSON.parse(text.slice(index));
    } catch {
      // npm prepends lifecycle lines; keep scanning until a JSON object parses.
    }
  }
  return undefined;
}

function checkByName(payload, name) {
  return payload?.checks?.find(item => item.name === name);
}

async function gitHead(repo) {
  const branch = await run('git', ['branch', '--show-current'], { cwd: repo });
  const head = await run('git', ['rev-parse', 'HEAD'], { cwd: repo });
  const trackedDirty = await run('git', ['status', '--short', '--untracked-files=no'], { cwd: repo });
  return {
    branch: branch.stdout.trim(),
    head: head.stdout.trim(),
    trackedDirty: trackedDirty.stdout.trim(),
    ok: branch.ok && head.ok && trackedDirty.ok,
  };
}

const checks = [];

const goalPath = path.join(root, 'Codex Goals', 'wake + mcp goal.txt');
const auditPath = path.join(root, 'docs', 'agenttalk-production-readiness-audit.md');
const buildPlanPath = path.join(root, 'docs', 'agenttalk-mcp-wake-supervisor-build-plan.md');
checks.push(
  existsSync(goalPath)
    ? check('pass', 'goal:source_of_truth', 'goal log exists')
    : check('fail', 'goal:source_of_truth', 'goal log is missing')
);
checks.push(
  existsSync(auditPath)
    ? check('pass', 'audit:document', 'production readiness audit exists')
    : check('fail', 'audit:document', 'production readiness audit is missing')
);
checks.push(
  existsSync(buildPlanPath)
    ? check('pass', 'phase0:integration_notes', 'Phase 0 integration notes exist')
    : check('fail', 'phase0:integration_notes', 'Phase 0 integration notes are missing')
);
if (existsSync(auditPath)) {
  const audit = readFileSync(auditPath, 'utf8');
  checks.push(
    audit.includes('Required Completion Gates') &&
      audit.includes('Render source access is resolved') &&
      audit.includes('Hermes has non-interactive inference credentials')
      ? check('pass', 'audit:required_gates', 'audit lists the required completion gates')
      : check('fail', 'audit:required_gates', 'audit does not list the required completion gates')
  );
}

for (const [name, repo] of [
  ['pistils_chat_cli', root],
  ['live-chat', liveChatRepo],
  ['Agent-Talk-MCP', agentTalkMcpRepo],
]) {
  if (!existsSync(repo)) {
    checks.push(check('fail', `repo:${name}`, `${name} repo was not found`, { repo: '[redacted]' }));
    continue;
  }
  const state = await gitHead(repo);
  checks.push(
    state.ok
      ? check('pass', `repo:${name}`, `${name} git state captured`, {
          branch: state.branch,
          head: state.head,
        })
      : check('fail', `repo:${name}`, `${name} git state could not be captured`)
  );
  checks.push(
    state.trackedDirty
      ? check('warn', `repo:${name}:tracked_worktree`, `${name} has tracked worktree changes`)
      : check('pass', `repo:${name}:tracked_worktree`, `${name} has no tracked worktree changes`)
  );
}

const renderEnv = { ...process.env };
if (!renderEnv.RENDER_API_KEY) {
  const userKey = await readWindowsUserEnv('RENDER_API_KEY');
  if (userKey) {
    renderEnv.RENDER_API_KEY = userKey;
  }
}
let renderPayload;
if (existsSync(agentTalkMcpRepo)) {
  const result = await runNpm(['run', 'preflight:render'], {
    cwd: agentTalkMcpRepo,
    env: renderEnv,
  });
  renderPayload = parseJsonFromOutput(result.stdout);
  checks.push(
    renderPayload
      ? check('pass', 'render:preflight_ran', 'Agent-Talk-MCP Render preflight returned JSON')
      : check('fail', 'render:preflight_ran', redact(result.stderr || result.stdout || 'Render preflight did not return JSON'))
  );
} else {
  checks.push(check('fail', 'render:preflight_ran', 'Agent-Talk-MCP repo is missing'));
}

const targetServiceCheck = checkByName(renderPayload, 'render:target_service_absent');
const targetService = renderPayload?.targetService;
const serviceCreated =
  targetServiceCheck?.status === 'warn' &&
  /already exists/i.test(targetServiceCheck.detail ?? '') &&
  targetService?.projectName === 'My project' &&
  targetService?.environmentName === 'Cervaris' &&
  targetService?.environmentId === 'evm-d7ampnp4tr6s739q3q9g';
if (!renderUrl && serviceCreated && targetService?.url) {
  renderUrl = targetService.url;
}
const sourceAccessReady =
  serviceCreated ||
  renderPayload?.createCommands?.gitBacked?.status === 'ready' ||
  renderPayload?.createCommands?.imageBacked?.status === 'ready' ||
  String(renderPayload?.createCommands?.imageBackedWithRegistryCredential?.status ?? '').startsWith('ready');
checks.push(
  sourceAccessReady
    ? check('pass', 'render:source_access', 'Render has a ready source/image path or the service already exists')
    : check('fail', 'render:source_access', 'Render source/image access is still blocked', {
        gitBackedDeploy: renderPayload?.gates?.gitBackedDeploy ?? 'unknown',
        imageDeploy: renderPayload?.gates?.imageDeploy ?? 'unknown',
      })
);
checks.push(
  serviceCreated
    ? check('pass', 'render:service_created', 'agent-talk-mcp exists in the target Render project/environment')
    : check('fail', 'render:service_created', 'agent-talk-mcp is not present in the target Render project/environment')
);
checks.push(
  checkByName(renderPayload, 'render:crisistrainingsim_untouched')?.status === 'pass'
    ? check('pass', 'render:crisistrainingsim_untouched', 'CrisisTrainingSim remains present in inventory')
    : check('fail', 'render:crisistrainingsim_untouched', 'CrisisTrainingSim inventory check did not pass')
);
const githubPackageMetadata = checkByName(renderPayload, 'github:ghcr_package_metadata');
checks.push(
  githubPackageMetadata?.status === 'pass'
    ? check('pass', 'render:ghcr_package_metadata', githubPackageMetadata.detail)
    : check('warn', 'render:ghcr_package_metadata', githubPackageMetadata?.detail ?? 'Render preflight did not report GHCR package metadata credential readiness', {
        results: githubPackageMetadata?.results,
      })
);
checks.push(
  renderPayload?.gates?.renderMcpAuth === 'ready' &&
    renderPayload?.gates?.targetProjectEnvironment === 'ready'
    ? check('pass', 'render:auth_and_target', 'Render API/MCP auth and target project/environment are ready')
    : check('fail', 'render:auth_and_target', 'Render auth or target project/environment is not ready', {
        renderMcpAuth: renderPayload?.gates?.renderMcpAuth ?? 'unknown',
        targetProjectEnvironment: renderPayload?.gates?.targetProjectEnvironment ?? 'unknown',
      })
);

if (renderUrl && existsSync(agentTalkMcpRepo)) {
  const smoke = await runNpm(['run', 'smoke:deployed'], {
    cwd: agentTalkMcpRepo,
    env: {
      ...renderEnv,
      AGENTTALK_MCP_BASE_URL: renderUrl,
      AGENTTALK_MCP_TOKEN: process.env.AGENTTALK_MCP_TOKEN ?? '',
    },
  });
  checks.push(
    smoke.ok
      ? check('pass', 'render:deployed_smoke', 'deployed Render smoke passed', {
          tokenMode: process.env.AGENTTALK_MCP_TOKEN ? 'token' : 'auth-boundary',
        })
      : check('fail', 'render:deployed_smoke', redact(smoke.stderr || smoke.stdout || 'deployed smoke failed'))
  );
} else {
  checks.push(
    check(
      'fail',
      'render:deployed_smoke',
      'AGENTTALK_MCP_BASE_URL, --render-url, or target service URL from Render inventory is required for deployed smoke'
    )
  );
}

const hermesPreflight = await runNpm(['run', 'preflight:hermes'], { cwd: root });
const hermesPayload = parseJsonFromOutput(hermesPreflight.stdout);
const hermesReady = hermesPayload?.gates?.realHermesConnectorSmoke === 'ready';
checks.push(
  hermesPayload
    ? check('pass', 'hermes:preflight_ran', 'Hermes preflight returned JSON')
    : check('fail', 'hermes:preflight_ran', redact(hermesPreflight.stderr || hermesPreflight.stdout || 'Hermes preflight did not return JSON'))
);
checks.push(
  hermesReady
    ? check('pass', 'hermes:credentials', 'Hermes has non-interactive model/provider credentials')
    : check('fail', 'hermes:credentials', 'Hermes still lacks non-interactive model/provider credentials', {
        gate: hermesPayload?.gates?.realHermesConnectorSmoke ?? 'unknown',
      })
);
const hermesLocalInference = checkByName(hermesPayload, 'hermes:local_inference_endpoints');
if (hermesLocalInference) {
  checks.push(
    check(hermesLocalInference.status, 'hermes:local_inference_endpoints', hermesLocalInference.detail, {
      endpoints: hermesLocalInference.endpoints,
    })
  );
}

if (hermesReady) {
  const realSmoke = await runNpm(['run', 'smoke:real-connectors'], {
    cwd: root,
    env: {
      ...process.env,
      AGENTTALK_RUN_REAL_CONNECTOR_TESTS: '1',
    },
  });
  const realSmokePayload = parseJsonFromOutput(realSmoke.stdout);
  const hermesHandled = realSmokePayload?.results?.some(
    item => item.kind === 'hermes' && item.handled === true
  );
  checks.push(
    realSmoke.ok && hermesHandled
      ? check('pass', 'hermes:real_connector_smoke', 'real Hermes connector smoke handled a wake')
      : check('fail', 'hermes:real_connector_smoke', redact(realSmoke.stderr || realSmoke.stdout || 'real Hermes connector smoke did not handle'))
  );
} else {
  checks.push(
    check('fail', 'hermes:real_connector_smoke', 'real Hermes connector smoke was not run because Hermes is not ready')
  );
}

const failures = checks.filter(item => item.status === 'fail');
const warnings = checks.filter(item => item.status === 'warn');
const ok = failures.length === 0;
const payload = {
  ok,
  strict,
  checks,
  gates: {
    renderSourceAccess: sourceAccessReady ? 'ready' : 'blocked',
    renderService: serviceCreated ? 'created' : 'not-created',
    renderDeployedSmoke: checks.find(item => item.name === 'render:deployed_smoke')?.status === 'pass'
      ? 'ready'
      : 'blocked',
    hermesCredentials: hermesReady ? 'ready' : 'blocked',
    finalCompletion: ok ? 'ready' : 'blocked',
  },
  nextActions: [
    ...(!sourceAccessReady
      ? [
          'Grant Render GitHub access to con-urr/Agent-Talk-MCP or unblock GHCR image pulls.',
        ]
      : []),
    ...(!serviceCreated
      ? ['Create the free agent-talk-mcp Render service after source/image access is ready.']
      : []),
    ...(checks.find(item => item.name === 'render:deployed_smoke')?.status !== 'pass'
      ? ['Run npm run smoke:deployed after deployment; audit:goal can derive the URL once Render inventory includes agent-talk-mcp, or use AGENTTALK_MCP_BASE_URL/--render-url.']
      : []),
    ...(!hermesReady
      ? ['Configure Hermes-owned OAuth or an API-key provider, then rerun npm run preflight:hermes.']
      : []),
  ],
  summary: {
    pass: checks.filter(item => item.status === 'pass').length,
    warn: warnings.length,
    fail: failures.length,
  },
};

console.log(JSON.stringify(payload, null, 2));

if (strict && !ok) {
  process.exitCode = 1;
}
