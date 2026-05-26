import { spawn } from 'node:child_process';

function run(command, args) {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', error => {
      resolve({ code: -1, stdout, stderr: error.message });
    });
    child.on('close', code => {
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

const result = await run(process.execPath, ['scripts/hermes-codex-oauth.mjs']);
const output = `${result.stdout}\n${result.stderr}`;

if (result.code !== 2) {
  throw new Error(`hermes-codex-oauth no-confirm guard exited ${result.code}, expected 2: ${output}`);
}

if (!output.includes('Refusing to start Hermes Codex OAuth without --confirm.')) {
  throw new Error(`hermes-codex-oauth no-confirm guard did not explain refusal: ${output}`);
}

if (!output.includes('<hermes-repo>') || output.includes('Documents\\GitHub\\hermes-agent')) {
  throw new Error(`hermes-codex-oauth guard did not keep repo path redacted: ${output}`);
}

if (/Bearer\s+[A-Za-z0-9._-]+|[A-Z0-9_]*API_KEY=[^\s]+/i.test(output)) {
  throw new Error('hermes-codex-oauth guard leaked a credential-shaped value');
}

console.log(JSON.stringify({ ok: true, guard: 'requires-confirm' }));
