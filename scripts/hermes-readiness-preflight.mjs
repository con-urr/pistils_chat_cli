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

function redact(text) {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/([A-Z0-9_]*API_KEY=)[^\s]+/gi, '$1[redacted]');
}

const checks = [];

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

  const status = await run(python, [hermes, 'status']);
  if (status.ok) {
    const hasInferenceCredentials = hermesStatusHasInferenceCredentials(status.stdout);
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

const failures = checks.filter(item => item.status === 'fail');
const warnings = checks.filter(item => item.status === 'warn');
const ok = failures.length === 0 && warnings.length === 0;
const payload = {
  ok,
  strict,
  checks,
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
          label: 'Configure Hermes provider',
          command: 'hermes model',
        },
        {
          label: 'OAuth login option',
          command: 'hermes login --provider nous',
        },
        {
          label: 'Re-run this preflight',
          command: 'npm run preflight:hermes',
        },
      ],
};

console.log(JSON.stringify(payload, null, 2));

if (strict && !ok) {
  process.exitCode = 1;
}
