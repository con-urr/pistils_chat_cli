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

function runWithInput(command, args, input, options = {}) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd ?? root,
        env: cleanEnv(options.env ?? process.env),
        stdio: ['pipe', 'pipe', 'pipe'],
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
    child.stdin.end(input);
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

let cachedGitHubToken;

async function githubTokenFromCredentialHelper() {
  if (cachedGitHubToken !== undefined) {
    return cachedGitHubToken;
  }
  cachedGitHubToken = '';
  const result = await runWithInput(
    'git',
    ['credential', 'fill'],
    'protocol=https\nhost=github.com\n\n'
  );
  if (!result.ok) {
    return cachedGitHubToken;
  }
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.startsWith('password=')) {
      cachedGitHubToken = line.slice('password='.length).trim();
      break;
    }
  }
  return cachedGitHubToken;
}

async function fetchGitHubJson(apiPath) {
  const token = await githubTokenFromCredentialHelper();
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'agenttalk-goal-audit',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetch(`https://api.github.com${apiPath}`, { headers });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return {
    ok: response.ok,
    status: response.status,
    json,
    body: text,
  };
}

async function agentTalkMcpActionChecks(branch, head) {
  if (!branch || !head) {
    return check(
      'fail',
      'github:agent_talk_mcp_actions',
      'Agent-Talk-MCP branch/head is unavailable for GitHub Actions verification'
    );
  }
  let response;
  try {
    response = await fetchGitHubJson(
      `/repos/con-urr/Agent-Talk-MCP/actions/runs?branch=${encodeURIComponent(branch)}&per_page=30`
    );
  } catch (error) {
    return check(
      'fail',
      'github:agent_talk_mcp_actions',
      `GitHub Actions API check failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!response.ok) {
    return check(
      'fail',
      'github:agent_talk_mcp_actions',
      `GitHub Actions API check failed with HTTP ${response.status}`
    );
  }
  const runs = Array.isArray(response.json?.workflow_runs) ? response.json.workflow_runs : [];
  const requiredRuns = [
    { key: 'ci_pull_request', name: 'CI', event: 'pull_request' },
    { key: 'ci_push', name: 'CI', event: 'push' },
    { key: 'publish_image', name: 'Publish AgentTalk MCP image', event: 'push' },
  ];
  const evidence = {};
  const missing = [];
  for (const required of requiredRuns) {
    const run = runs.find(
      item =>
        item?.head_sha === head &&
        item?.name === required.name &&
        item?.event === required.event &&
        item?.status === 'completed' &&
        item?.conclusion === 'success'
    );
    if (run) {
      evidence[required.key] = {
        id: run.id,
        event: run.event,
        status: run.status,
        conclusion: run.conclusion,
        url: run.html_url,
      };
    } else {
      missing.push(required.key);
    }
  }
  return missing.length === 0
    ? check('pass', 'github:agent_talk_mcp_actions', 'Agent-Talk-MCP CI and image workflows passed on the current head', {
        head,
        runs: evidence,
      })
    : check('fail', 'github:agent_talk_mcp_actions', 'Agent-Talk-MCP GitHub Actions are not all green on the current head', {
        head,
        missing,
        runs: evidence,
      });
}

async function githubCommitStatus(repo, head) {
  return fetchGitHubJson(`/repos/con-urr/${repo}/commits/${head}/status`);
}

async function githubCommitCheckRuns(repo, head) {
  return fetchGitHubJson(`/repos/con-urr/${repo}/commits/${head}/check-runs?per_page=30`);
}

function summarizeCheckRuns(runs) {
  const result = {};
  for (const run of runs) {
    if (!run?.name) {
      continue;
    }
    result[run.name] = {
      status: run.status,
      conclusion: run.conclusion,
      url: run.html_url,
    };
  }
  return result;
}

async function pistilsChatCliCheckRuns(head) {
  if (!head) {
    return check(
      'fail',
      'github:pistils_chat_cli_checks',
      'pistils_chat_cli head is unavailable for GitHub check-run verification'
    );
  }
  let response;
  try {
    response = await githubCommitCheckRuns('pistils_chat_cli', head);
  } catch (error) {
    return check(
      'fail',
      'github:pistils_chat_cli_checks',
      `GitHub check-run API failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!response.ok) {
    return check(
      'fail',
      'github:pistils_chat_cli_checks',
      `GitHub check-run API failed with HTTP ${response.status}`
    );
  }
  const runs = Array.isArray(response.json?.check_runs) ? response.json.check_runs : [];
  const required = ['validate (20)', 'validate (22)'];
  const missing = required.filter(
    name =>
      !runs.some(
        run =>
          run?.name === name &&
          run?.status === 'completed' &&
          run?.conclusion === 'success'
      )
  );
  return missing.length === 0
    ? check('pass', 'github:pistils_chat_cli_checks', 'pistils_chat_cli GitHub check-runs passed on the current head', {
        head,
        runs: summarizeCheckRuns(runs.filter(run => required.includes(run?.name))),
      })
    : check('fail', 'github:pistils_chat_cli_checks', 'pistils_chat_cli GitHub check-runs are not all green on the current head', {
        head,
        missing,
        runs: summarizeCheckRuns(runs),
      });
}

async function liveChatDeploymentChecks(head) {
  if (!head) {
    return check(
      'fail',
      'github:live_chat_checks',
      'live-chat head is unavailable for GitHub/Vercel status verification'
    );
  }
  let statusResponse;
  let checksResponse;
  try {
    [statusResponse, checksResponse] = await Promise.all([
      githubCommitStatus('live-chat', head),
      githubCommitCheckRuns('live-chat', head),
    ]);
  } catch (error) {
    return check(
      'fail',
      'github:live_chat_checks',
      `GitHub status API failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!statusResponse.ok) {
    return check(
      'fail',
      'github:live_chat_checks',
      `GitHub combined status API failed with HTTP ${statusResponse.status}`
    );
  }
  if (!checksResponse.ok) {
    return check(
      'fail',
      'github:live_chat_checks',
      `GitHub check-run API failed with HTTP ${checksResponse.status}`
    );
  }
  const statuses = Array.isArray(statusResponse.json?.statuses)
    ? statusResponse.json.statuses
    : [];
  const checkRuns = Array.isArray(checksResponse.json?.check_runs)
    ? checksResponse.json.check_runs
    : [];
  const vercelStatus = statuses.find(
    item => item?.context === 'Vercel' && item?.state === 'success'
  );
  const vercelPreviewComments = checkRuns.find(
    item =>
      item?.name === 'Vercel Preview Comments' &&
      item?.status === 'completed' &&
      item?.conclusion === 'success'
  );
  const requiredCiRuns = ['validate (20.x)', 'validate (22.x)'];
  const missingCiRuns = requiredCiRuns.filter(
    name =>
      !checkRuns.some(
        item =>
          item?.name === name &&
          item?.status === 'completed' &&
          item?.conclusion === 'success'
      )
  );
  const state = statusResponse.json?.state;
  return state === 'success' && vercelStatus && vercelPreviewComments && missingCiRuns.length === 0
    ? check('pass', 'github:live_chat_checks', 'live-chat CI, Vercel status, and preview-comment check passed on the current head', {
        head,
        combinedState: state,
        statuses: [
          {
            context: vercelStatus.context,
            state: vercelStatus.state,
            url: vercelStatus.target_url,
          },
        ],
        runs: summarizeCheckRuns([
          vercelPreviewComments,
          ...checkRuns.filter(item => requiredCiRuns.includes(item?.name)),
        ]),
      })
    : check('fail', 'github:live_chat_checks', 'live-chat GitHub CI/Vercel checks are not green on the current head', {
        head,
        combinedState: state ?? 'unknown',
        missingCiRuns,
        statuses: statuses.map(item => ({
          context: item.context,
          state: item.state,
          url: item.target_url,
        })),
        runs: summarizeCheckRuns(checkRuns),
      });
}

const checks = [];
const repoStates = {};

const goalPath = path.join(root, 'Codex Goals', 'wake + mcp goal.txt');
const auditPath = path.join(root, 'docs', 'agenttalk-production-readiness-audit.md');
const buildPlanPath = path.join(root, 'docs', 'agenttalk-mcp-wake-supervisor-build-plan.md');
const packagePath = path.join(root, 'package.json');
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

let packageJson;
try {
  packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
} catch {
  packageJson = undefined;
}
const packageScripts = packageJson?.scripts ?? {};
checks.push(
  existsSync(path.join(root, 'scripts', 'smoke-setup.mjs')) &&
    packageScripts['smoke:setup'] === 'node scripts/smoke-setup.mjs' &&
    packageScripts.check?.includes('smoke:setup')
    ? check('pass', 'setup:smoke_artifacts', 'consumer setup smoke is present and wired into npm run check')
    : check('fail', 'setup:smoke_artifacts', 'consumer setup smoke is missing or not wired into npm run check')
);
checks.push(
  existsSync(path.join(root, 'scripts', 'hermes-codex-oauth.mjs')) &&
    existsSync(path.join(root, 'scripts', 'smoke-hermes-codex-oauth-guard.mjs')) &&
    existsSync(path.join(root, 'scripts', 'smoke-hermes-codex-oauth-timeout.mjs')) &&
    packageScripts['hermes:codex-oauth'] === 'node scripts/hermes-codex-oauth.mjs' &&
    packageScripts['smoke:hermes-codex-oauth-guard'] === 'node scripts/smoke-hermes-codex-oauth-guard.mjs' &&
    packageScripts['smoke:hermes-codex-oauth-timeout'] === 'node scripts/smoke-hermes-codex-oauth-timeout.mjs' &&
    packageScripts.check?.includes('smoke:hermes-codex-oauth-guard') &&
    packageScripts.check?.includes('smoke:hermes-codex-oauth-timeout') &&
    packageJson?.files?.includes('scripts/hermes-codex-oauth.mjs')
    ? check('pass', 'hermes:codex_oauth_helper_artifacts', 'Hermes Codex OAuth helper is package-included and guard/timeout smokes are wired into npm run check')
    : check('fail', 'hermes:codex_oauth_helper_artifacts', 'Hermes Codex OAuth helper, guard/timeout smokes, check wiring, or package inclusion is missing')
);
const setupSmoke = await runNpm(['run', 'smoke:setup'], { cwd: root });
const setupSmokePayload = parseJsonFromOutput(setupSmoke.stdout);
checks.push(
  setupSmoke.ok && setupSmokePayload?.ok === true
    ? check('pass', 'setup:smoke', 'consumer setup smoke passed', {
        configured: setupSmokePayload.configured,
      })
    : check('fail', 'setup:smoke', redact(setupSmoke.stderr || setupSmoke.stdout || 'consumer setup smoke failed'))
);
const hermesOauthGuardSmoke = await runNpm(['run', 'smoke:hermes-codex-oauth-guard'], { cwd: root });
checks.push(
  hermesOauthGuardSmoke.ok
    ? check('pass', 'hermes:codex_oauth_guard_smoke', 'Hermes Codex OAuth helper no-confirm guard smoke passed')
    : check('fail', 'hermes:codex_oauth_guard_smoke', redact(hermesOauthGuardSmoke.stderr || hermesOauthGuardSmoke.stdout || 'Hermes Codex OAuth helper guard smoke failed'))
);
const hermesOauthTimeoutSmoke = await runNpm(['run', 'smoke:hermes-codex-oauth-timeout'], { cwd: root });
checks.push(
  hermesOauthTimeoutSmoke.ok
    ? check('pass', 'hermes:codex_oauth_timeout_smoke', 'Hermes Codex OAuth helper timeout cleanup smoke passed')
    : check('fail', 'hermes:codex_oauth_timeout_smoke', redact(hermesOauthTimeoutSmoke.stderr || hermesOauthTimeoutSmoke.stdout || 'Hermes Codex OAuth helper timeout smoke failed'))
);

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
  repoStates[name] = state;
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

checks.push(await pistilsChatCliCheckRuns(repoStates.pistils_chat_cli?.head));
checks.push(await liveChatDeploymentChecks(repoStates['live-chat']?.head));

if (existsSync(agentTalkMcpRepo)) {
  checks.push(
    await agentTalkMcpActionChecks(
      repoStates['Agent-Talk-MCP']?.branch,
      repoStates['Agent-Talk-MCP']?.head
    )
  );

  const mcpPackagePath = path.join(agentTalkMcpRepo, 'package.json');
  const renderCreatePath = path.join(agentTalkMcpRepo, 'scripts', 'render-create-service.mjs');
  const renderCreateGuardSmokePath = path.join(agentTalkMcpRepo, 'scripts', 'smoke-render-create-guard.mjs');
  let mcpPackage;
  try {
    mcpPackage = JSON.parse(readFileSync(mcpPackagePath, 'utf8'));
  } catch {
    mcpPackage = undefined;
  }
  const scripts = mcpPackage?.scripts ?? {};
  checks.push(
    existsSync(renderCreatePath) &&
      existsSync(renderCreateGuardSmokePath) &&
      scripts['render:create'] === 'node scripts/render-create-service.mjs' &&
      scripts['smoke:render-create-guard'] === 'node scripts/smoke-render-create-guard.mjs' &&
      scripts.check?.includes('smoke:render-create-guard')
      ? check('pass', 'render:create_guard_artifacts', 'Agent-Talk-MCP has the guarded Render create helper and CI smoke wired into check')
      : check('fail', 'render:create_guard_artifacts', 'Agent-Talk-MCP guarded Render create helper or CI smoke wiring is missing')
  );

  const guardSmoke = await runNpm(['run', 'smoke:render-create-guard'], {
    cwd: agentTalkMcpRepo,
    env: process.env,
  });
  checks.push(
    guardSmoke.ok
      ? check('pass', 'render:create_guard_smoke', 'Render create no-confirm guard smoke passed')
      : check('fail', 'render:create_guard_smoke', redact(guardSmoke.stderr || guardSmoke.stdout || 'Render create guard smoke failed'))
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
const renderMcpToolCatalog = checkByName(renderPayload, 'render:mcp_tool_catalog');
const renderMcpWorkspaceSession = checkByName(renderPayload, 'render:mcp_workspace_session');
const renderMcpCreateScope = checkByName(renderPayload, 'render:mcp_create_scope');
const githubSourceVisibility = checkByName(renderPayload, 'github:source_repo_visibility');
const githubRenderAppAccess = checkByName(renderPayload, 'github:render_app_installation_access');
checks.push(
  renderMcpToolCatalog?.status === 'pass' &&
    renderMcpWorkspaceSession?.status === 'pass'
    ? check('pass', 'render:mcp_readonly_probe', 'Render MCP read-only tool catalog and workspace/service listing probes passed')
    : check('fail', 'render:mcp_readonly_probe', 'Render MCP read-only probes did not pass', {
        toolCatalogStatus: renderMcpToolCatalog?.status ?? 'missing',
        workspaceSessionStatus: renderMcpWorkspaceSession?.status ?? 'missing',
      })
);
checks.push(
  renderMcpCreateScope?.status === 'warn' &&
    renderMcpCreateScope?.hasCreateWebService === true &&
    renderMcpCreateScope?.supportsEnvironmentId === false
    ? check('pass', 'render:mcp_create_scope_boundary', 'Render MCP create_web_service limitation is recorded; CLI/REST remains required for environment-targeted deploy')
    : check('fail', 'render:mcp_create_scope_boundary', 'Render MCP create scope boundary was not reported as expected', {
        status: renderMcpCreateScope?.status ?? 'missing',
        hasCreateWebService: renderMcpCreateScope?.hasCreateWebService,
        supportsEnvironmentId: renderMcpCreateScope?.supportsEnvironmentId,
      })
);
checks.push(
  githubSourceVisibility && githubRenderAppAccess
    ? check('pass', 'render:github_source_access_probe', 'Render preflight reports GitHub source visibility and Render app installation access diagnostics', {
        sourceRepoStatus: githubSourceVisibility.status,
        sourceRepoVisibility: githubSourceVisibility.visibility,
        renderAppAccessStatus: githubRenderAppAccess.status,
        renderAppAccessStatusCode: githubRenderAppAccess.statusCode,
      })
    : check('fail', 'render:github_source_access_probe', 'Render preflight did not report GitHub source visibility and app installation diagnostics')
);
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
      ? ['Run npm run hermes:codex-oauth -- --confirm for Hermes-owned Codex OAuth, or configure an API-key provider, then rerun npm run preflight:hermes.']
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
