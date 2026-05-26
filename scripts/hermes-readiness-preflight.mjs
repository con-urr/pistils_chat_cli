import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const strict = process.argv.includes('--strict');
const repoFlagIndex = process.argv.indexOf('--repo');
const configuredRepo =
  repoFlagIndex >= 0 && process.argv[repoFlagIndex + 1]
    ? process.argv[repoFlagIndex + 1]
    : process.env.AGENTTALK_HERMES_REPO || process.env.HERMES_REPO;
const repo = path.resolve(configuredRepo || path.join(os.homedir(), 'Documents', 'GitHub', 'hermes-agent'));
const hermes = path.join(repo, 'hermes');
const python = process.platform === 'win32'
  ? path.join(repo, 'venv', 'Scripts', 'python.exe')
  : path.join(repo, 'venv', 'bin', 'python');
const repoLocalPython = process.platform === 'win32' ? '.\\venv\\Scripts\\python.exe' : './venv/bin/python';
const repoLocalHermes = process.platform === 'win32' ? '.\\hermes' : './hermes';
const codexCommand = process.platform === 'win32' ? 'cmd.exe' : 'codex';
const codexLoginStatusArgs = process.platform === 'win32'
  ? ['/d', '/s', '/c', 'codex login status']
  : ['login', 'status'];
const inferenceCredentialEnvVars = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'DEEPSEEK_API_KEY',
  'GEMINI_API_KEY',
  'GLM_API_KEY',
  'GOOGLE_API_KEY',
  'KIMI_API_KEY',
  'KIMI_CODING_API_KEY',
  'MINIMAX_API_KEY',
  'NOUS_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'QWEN_API_KEY',
  'XAI_API_KEY',
  'ZAI_API_KEY',
  'Z_AI_API_KEY',
];

function check(status, name, detail, extra = {}) {
  return { status, name, detail, ...extra };
}

function run(command, args, options = {}) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd ?? repo,
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
      resolve({
        ok: false,
        code: -1,
        stdout,
        stderr: error.message,
      });
    });
    child.on('close', code => {
      resolve({
        ok: code === 0,
        code: code ?? 0,
        stdout,
        stderr,
      });
    });
  });
}

function localHermesCredentialParser(stdout) {
  const checkMark = String.fromCharCode(0x2713);
  const inferenceCredentialLabels = new Set([
    'anthropic',
    'deepseek',
    'google / gemini',
    'kimi',
    'kimi / moonshot',
    'minimax',
    'minimax (china)',
    'minimax-cn',
    'minimax oauth',
    'nvidia nim',
    'nous portal',
    'openai',
    'openai codex',
    'openrouter',
    'qwen oauth',
    'stepfun step plan',
    'xai / grok',
    'xai oauth',
    'z.ai / glm',
  ]);
  function section(text, start, end) {
    const startIndex = text.indexOf(start);
    if (startIndex < 0) {
      return '';
    }
    const endIndex = text.indexOf(end, startIndex + start.length);
    return endIndex < 0 ? text.slice(startIndex) : text.slice(startIndex, endIndex);
  }
  function normalizeCredentialLabel(line) {
    const checkIndex = line.indexOf(checkMark);
    if (checkIndex < 0) {
      return undefined;
    }
    return line
      .slice(0, checkIndex)
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }
  const credentialStatus = [
    section(stdout, 'API Keys', 'Auth Providers'),
    section(stdout, 'Auth Providers', 'API-Key Providers'),
    section(stdout, 'API-Key Providers', 'Terminal Backend'),
  ].join('\n');
  return credentialStatus
    .split(/\r?\n/)
    .some(line => {
      const label = normalizeCredentialLabel(line);
      return label ? inferenceCredentialLabels.has(label) : false;
    });
}

function hermesStatusHasInferenceCredentials(stdout) {
  try {
    return require('../dist/supervisor/hermes.js').hermesStatusHasInferenceCredentials(stdout);
  } catch {
    return localHermesCredentialParser(stdout);
  }
}

function commandOutputIncludes(result, ...needles) {
  const output = `${result.stdout}\n${result.stderr}`;
  return result.ok && needles.every(needle => output.includes(needle));
}

function parseLoggedInStatus(stdout) {
  return /:\s*logged in\b/i.test(stdout) || /^logged in\b/i.test(stdout.trim());
}

function redact(text) {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/([A-Z0-9_]*API_KEY=)[^\s]+/gi, '$1[redacted]');
}

function hermesRepoCommand(args) {
  const separator = process.platform === 'win32' ? ';' : '&&';
  return `cd <hermes-repo> ${separator} ${repoLocalPython} ${repoLocalHermes} ${args}`;
}

async function probeJsonEndpoint(name, url) {
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
    });
    let itemCount;
    if (response.ok) {
      const body = await response.json();
      if (Array.isArray(body?.models)) {
        itemCount = body.models.length;
      } else if (Array.isArray(body?.data)) {
        itemCount = body.data.length;
      }
    }
    return {
      name,
      url,
      statusCode: response.status,
      reachable: response.ok,
      itemCount,
    };
  } catch {
    return {
      name,
      url,
      reachable: false,
    };
  }
}

async function probeLocalInferenceEndpoints() {
  const probes = await Promise.all([
    probeJsonEndpoint('ollama', 'http://127.0.0.1:11434/api/tags'),
    probeJsonEndpoint('lmstudio', 'http://127.0.0.1:1234/v1/models'),
  ]);
  return {
    probes,
    reachable: probes.filter(item => item.reachable),
  };
}

const checks = [];
let hasInferenceCredentials = false;
const diagnostics = {
  inferenceCredentialEnvVarsSet: inferenceCredentialEnvVars.filter(name => Boolean(process.env[name])),
  codexCliLogin: 'not-checked',
  hermesOpenAiCodexAuth: 'not-checked',
  localInferenceEndpoints: [],
  note: 'Only variable names and auth states are reported; secret values are never read or printed.',
};

checks.push(
  existsSync(repo)
    ? check('pass', 'hermes:repo', 'Hermes repo exists', { repo: '[redacted]' })
    : check('fail', 'hermes:repo', 'Hermes repo was not found', { repo: '[redacted]' })
);
checks.push(
  existsSync(hermes)
    ? check('pass', 'hermes:entrypoint', 'Hermes entrypoint exists')
    : check('fail', 'hermes:entrypoint', 'Hermes entrypoint was not found')
);
checks.push(
  existsSync(python)
    ? check('pass', 'hermes:python', 'Hermes virtualenv python exists')
    : check('fail', 'hermes:python', 'Hermes virtualenv python was not found')
);

let chatHelp;
if (existsSync(hermes) && existsSync(python)) {
  chatHelp = await run(python, [hermes, 'chat', '--help']);
  const help = chatHelp.stdout;
  checks.push(
    chatHelp.ok &&
      help.includes('--query') &&
      help.includes('--quiet') &&
      help.includes('--source')
      ? check('pass', 'hermes:chat_command', 'Hermes chat supports --query, --quiet, and --source')
      : check('fail', 'hermes:chat_command', redact(chatHelp.stderr || chatHelp.stdout || 'Hermes chat help failed'))
  );

  const authAddHelp = await run(python, [hermes, 'auth', 'add', '--help']);
  checks.push(
    commandOutputIncludes(authAddHelp, '--type', '--api-key', 'provider')
      ? check('pass', 'hermes:auth_add_command', 'Hermes auth add supports non-interactive API-key setup and OAuth provider selection')
      : check('fail', 'hermes:auth_add_command', redact(authAddHelp.stderr || authAddHelp.stdout || 'Hermes auth add help failed'))
  );

  const configSetHelp = await run(python, [hermes, 'config', 'set', '--help']);
  checks.push(
    commandOutputIncludes(configSetHelp, 'key', 'value')
      ? check('pass', 'hermes:config_set_command', 'Hermes config set can persist provider/model choices')
      : check('fail', 'hermes:config_set_command', redact(configSetHelp.stderr || configSetHelp.stdout || 'Hermes config set help failed'))
  );

  const hermesCodexAuth = await run(python, [hermes, 'auth', 'status', 'openai-codex']);
  if (hermesCodexAuth.ok) {
    diagnostics.hermesOpenAiCodexAuth = parseLoggedInStatus(hermesCodexAuth.stdout) ? 'logged-in' : 'logged-out';
  } else {
    diagnostics.hermesOpenAiCodexAuth = 'unavailable';
  }

  const codexLoginStatus = await run(codexCommand, codexLoginStatusArgs, { cwd: process.cwd() });
  if (codexLoginStatus.ok) {
    const codexStatusOutput = `${codexLoginStatus.stdout}\n${codexLoginStatus.stderr}`;
    diagnostics.codexCliLogin = /logged in/i.test(codexStatusOutput) ? 'logged-in' : 'logged-out';
  } else {
    diagnostics.codexCliLogin = 'unavailable';
  }

  const status = await run(python, [hermes, 'status']);
  if (status.ok) {
    hasInferenceCredentials = hermesStatusHasInferenceCredentials(status.stdout);
    checks.push(check('pass', 'hermes:status', 'Hermes status command completed'));
    checks.push(
      hasInferenceCredentials
        ? check('pass', 'hermes:inference_credentials', 'Hermes has non-interactive model/provider credentials')
        : check(
            'fail',
            'hermes:inference_credentials',
            'Hermes has no configured non-interactive model/provider credentials'
          )
    );
  } else {
    checks.push(check('fail', 'hermes:status', redact(status.stderr || status.stdout || 'Hermes status failed')));
  }
}

if (!hasInferenceCredentials) {
  const localInference = await probeLocalInferenceEndpoints();
  diagnostics.localInferenceEndpoints = localInference.probes;
  checks.push(
    localInference.reachable.length > 0
      ? check(
          'warn',
          'hermes:local_inference_endpoints',
          'A local no-key inference endpoint is reachable, but Hermes is not configured to use it',
          {
            endpoints: localInference.reachable.map(item => ({
              name: item.name,
              statusCode: item.statusCode,
              itemCount: item.itemCount,
            })),
          }
        )
      : check(
          'warn',
          'hermes:local_inference_endpoints',
          'No common no-key local inference endpoint is reachable for Hermes fallback',
          {
            endpoints: localInference.probes.map(item => ({
              name: item.name,
              reachable: item.reachable,
              statusCode: item.statusCode,
            })),
          }
        )
  );
}

const failures = checks.filter(item => item.status === 'fail');
const warnings = checks.filter(item => item.status === 'warn');
const ok = failures.length === 0 && warnings.length === 0;
const payload = {
  ok,
  strict,
  checks,
  diagnostics,
  gates: {
    realHermesConnectorSmoke: ok ? 'ready' : 'requires-non-interactive-inference-credentials',
  },
  nextActions: ok
    ? [
        {
          label: 'Run real connector smoke',
          command: 'AGENTTALK_RUN_REAL_CONNECTOR_TESTS=1 npm run smoke:real-connectors',
        },
      ]
    : [
        {
          label: 'Hermes-owned Codex OAuth helper',
          command: 'agenttalk hermes codex-oauth --confirm',
          note: 'Starts the packaged Hermes OAuth flow, configures model.provider/model.default after approval, and cleans up the auth process tree after the default 10 minute timeout. Repo-local alias: npm run hermes:codex-oauth -- --confirm.',
        },
        {
          label: 'Hermes-owned Codex OAuth login',
          command: hermesRepoCommand('auth add openai-codex --type oauth'),
          note: 'Creates a Hermes-owned OAuth session. Avoid importing Codex CLI tokens unless you accept refresh-token conflict risk.',
        },
        {
          label: 'Set Hermes Codex provider',
          command: hermesRepoCommand('config set model.provider openai-codex'),
        },
        {
          label: 'Set Hermes Codex model',
          command: hermesRepoCommand('config set model.default gpt-5.3-codex'),
        },
        {
          label: 'API-key provider option',
          command: hermesRepoCommand('auth add openrouter --type api-key --label agenttalk'),
          note: 'Prompts securely when --api-key is omitted; then set model.provider/model.default for the chosen provider.',
        },
        {
          label: 'Nous OAuth option',
          command: hermesRepoCommand('login --provider nous'),
        },
        {
          label: 'Re-run this preflight',
          command: 'agenttalk hermes preflight',
        },
      ],
};

console.log(JSON.stringify(payload, null, 2));

if (strict && !ok) {
  process.exitCode = 1;
}
