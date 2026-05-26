import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const confirmed = args.includes('--confirm');
const repoFlagIndex = args.indexOf('--repo');
const pythonFlagIndex = args.indexOf('--python');
const hermesFlagIndex = args.indexOf('--hermes-entrypoint');
const timeoutFlagIndex = args.indexOf('--timeout-seconds');
const configuredRepo =
  repoFlagIndex >= 0 && args[repoFlagIndex + 1]
    ? args[repoFlagIndex + 1]
    : process.env.AGENTTALK_HERMES_REPO || process.env.HERMES_REPO;
const repo = path.resolve(configuredRepo || path.join(os.homedir(), 'Documents', 'GitHub', 'hermes-agent'));
const configuredHermes =
  hermesFlagIndex >= 0 && args[hermesFlagIndex + 1]
    ? args[hermesFlagIndex + 1]
    : undefined;
const configuredPython =
  pythonFlagIndex >= 0 && args[pythonFlagIndex + 1]
    ? args[pythonFlagIndex + 1]
    : undefined;
const hermes = path.resolve(configuredHermes || path.join(repo, 'hermes'));
const python = path.resolve(configuredPython || (process.platform === 'win32'
  ? path.join(repo, 'venv', 'Scripts', 'python.exe')
  : path.join(repo, 'venv', 'bin', 'python')));
const repoLocalPython = process.platform === 'win32' ? '.\\venv\\Scripts\\python.exe' : './venv/bin/python';
const repoLocalHermes = process.platform === 'win32' ? '.\\hermes' : './hermes';
const separator = process.platform === 'win32' ? ';' : '&&';
const timeoutSecondsValue =
  timeoutFlagIndex >= 0 && args[timeoutFlagIndex + 1]
    ? args[timeoutFlagIndex + 1]
    : process.env.AGENTTALK_HERMES_OAUTH_TIMEOUT_SECONDS;
const timeoutSeconds = timeoutSecondsValue === undefined ? 600 : Number(timeoutSecondsValue);
const timeoutMs = timeoutSeconds > 0 ? Math.ceil(timeoutSeconds * 1000) : 0;
let activeChild;

function redactedCommand(commandArgs) {
  return `cd <hermes-repo> ${separator} ${repoLocalPython} ${repoLocalHermes} ${commandArgs.join(' ')}`;
}

function killProcessTree(child) {
  if (!child || !child.pid) {
    return;
  }
  if (process.platform === 'win32') {
    spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    }).on('error', () => {});
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill();
  }
}

function stopActiveChild() {
  if (activeChild) {
    killProcessTree(activeChild);
  }
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, () => {
    stopActiveChild();
    process.exit(130);
  });
}

function runInteractive(commandArgs) {
  return new Promise(resolve => {
    const child = spawn(python, [hermes, ...commandArgs], {
      cwd: repo,
      stdio: 'inherit',
      windowsHide: false,
      detached: process.platform !== 'win32',
    });
    activeChild = child;
    let timedOut = false;
    let settled = false;
    let closed = false;
    let forceKillTimer;
    const timeoutTimer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          console.error(JSON.stringify({
            ok: false,
            action: 'hermes-command-timeout',
            command: redactedCommand(commandArgs),
            timeoutSeconds,
            repo: '[redacted]',
          }, null, 2));
          killProcessTree(child);
          forceKillTimer = setTimeout(() => {
            if (!closed) {
              if (process.platform === 'win32') {
                killProcessTree(child);
              } else {
                try {
                  process.kill(-child.pid, 'SIGKILL');
                } catch {
                  child.kill('SIGKILL');
                }
              }
            }
          }, 2000);
        }, timeoutMs)
      : undefined;
    function finish(result) {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      if (activeChild === child) {
        activeChild = undefined;
      }
      resolve(result);
    }
    child.on('error', error => {
      console.error(error.message);
      finish({ ok: false, error: error.message });
    });
    child.on('close', code => {
      closed = true;
      finish({ ok: !timedOut && code === 0, timedOut, code });
    });
  });
}

function fail(message, code = 1, extra = {}) {
  console.error(JSON.stringify({ ok: false, error: message, ...extra }, null, 2));
  process.exit(code);
}

if (!confirmed) {
  console.error('Refusing to start Hermes Codex OAuth without --confirm.');
  console.error('This opens an interactive Hermes-owned OAuth flow and may launch a browser.');
  console.error(`Command: ${redactedCommand(['auth', 'add', 'openai-codex', '--type', 'oauth'])}`);
  console.error('Usage: npm run hermes:codex-oauth -- --confirm [--timeout-seconds 600]');
  process.exit(2);
}

if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) {
  fail('Invalid --timeout-seconds value', 2);
}
if (!existsSync(repo)) {
  fail('Hermes repo was not found', 1, { repo: '[redacted]' });
}
if (!existsSync(hermes)) {
  fail('Hermes entrypoint was not found', 1);
}
if (!existsSync(python)) {
  fail('Hermes virtualenv Python was not found', 1);
}

console.log(JSON.stringify({
  ok: true,
  action: 'starting-hermes-owned-codex-oauth',
  repo: '[redacted]',
  authCommand: redactedCommand(['auth', 'add', 'openai-codex', '--type', 'oauth']),
  configCommands: [
    redactedCommand(['config', 'set', 'model.provider', 'openai-codex']),
    redactedCommand(['config', 'set', 'model.default', 'gpt-5.3-codex']),
  ],
  timeoutSeconds: timeoutMs > 0 ? timeoutSeconds : null,
  note: 'Do not import Codex CLI tokens into Hermes unless you accept refresh-token conflict risk.',
}, null, 2));

const authResult = await runInteractive(['auth', 'add', 'openai-codex', '--type', 'oauth']);
if (authResult.timedOut) {
  fail('Hermes Codex OAuth command timed out before approval completed', 3, { timeoutSeconds });
}
if (!authResult.ok) {
  fail('Hermes Codex OAuth command did not complete successfully');
}

const providerResult = await runInteractive(['config', 'set', 'model.provider', 'openai-codex']);
if (providerResult.timedOut) {
  fail('Hermes provider config command timed out', 3, { timeoutSeconds });
}
if (!providerResult.ok) {
  fail('Hermes provider config command did not complete successfully');
}

const modelResult = await runInteractive(['config', 'set', 'model.default', 'gpt-5.3-codex']);
if (modelResult.timedOut) {
  fail('Hermes model config command timed out', 3, { timeoutSeconds });
}
if (!modelResult.ok) {
  fail('Hermes model config command did not complete successfully');
}

console.log(JSON.stringify({
  ok: true,
  action: 'hermes-codex-oauth-configured',
  nextCommand: 'npm run preflight:hermes',
}, null, 2));
