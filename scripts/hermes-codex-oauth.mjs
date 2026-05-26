import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const confirmed = args.includes('--confirm');
const repoFlagIndex = args.indexOf('--repo');
const configuredRepo =
  repoFlagIndex >= 0 && args[repoFlagIndex + 1]
    ? args[repoFlagIndex + 1]
    : process.env.AGENTTALK_HERMES_REPO || process.env.HERMES_REPO;
const repo = path.resolve(configuredRepo || path.join(os.homedir(), 'Documents', 'GitHub', 'hermes-agent'));
const hermes = path.join(repo, 'hermes');
const python = process.platform === 'win32'
  ? path.join(repo, 'venv', 'Scripts', 'python.exe')
  : path.join(repo, 'venv', 'bin', 'python');
const repoLocalPython = process.platform === 'win32' ? '.\\venv\\Scripts\\python.exe' : './venv/bin/python';
const repoLocalHermes = process.platform === 'win32' ? '.\\hermes' : './hermes';
const separator = process.platform === 'win32' ? ';' : '&&';

function redactedCommand(commandArgs) {
  return `cd <hermes-repo> ${separator} ${repoLocalPython} ${repoLocalHermes} ${commandArgs.join(' ')}`;
}

function runInteractive(commandArgs) {
  return new Promise(resolve => {
    const child = spawn(python, [hermes, ...commandArgs], {
      cwd: repo,
      stdio: 'inherit',
      windowsHide: false,
    });
    child.on('error', error => {
      console.error(error.message);
      resolve(false);
    });
    child.on('close', code => {
      resolve(code === 0);
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
  console.error('Usage: npm run hermes:codex-oauth -- --confirm');
  process.exit(2);
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
  note: 'Do not import Codex CLI tokens into Hermes unless you accept refresh-token conflict risk.',
}, null, 2));

const authOk = await runInteractive(['auth', 'add', 'openai-codex', '--type', 'oauth']);
if (!authOk) {
  fail('Hermes Codex OAuth command did not complete successfully');
}

const providerOk = await runInteractive(['config', 'set', 'model.provider', 'openai-codex']);
if (!providerOk) {
  fail('Hermes provider config command did not complete successfully');
}

const modelOk = await runInteractive(['config', 'set', 'model.default', 'gpt-5.3-codex']);
if (!modelOk) {
  fail('Hermes model config command did not complete successfully');
}

console.log(JSON.stringify({
  ok: true,
  action: 'hermes-codex-oauth-configured',
  nextCommand: 'npm run preflight:hermes',
}, null, 2));
