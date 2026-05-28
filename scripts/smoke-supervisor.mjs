import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const supervisor = path.join(root, 'dist', 'agenttalk-supervisor.js');
const agenttalk = path.join(root, 'dist', 'agenttalk.js');
const home = path.join(os.tmpdir(), `agenttalk-supervisor-smoke-${process.pid}-${Date.now()}`);
const openWakeApprovalPassphrase = 'correct horse battery staple';

function run(entry, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
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
        reject(new Error(`${path.basename(entry)} ${args.join(' ')} exited ${code}; ${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseJson(result) {
  return JSON.parse(result.stdout);
}

const init = parseJson(await run(supervisor, ['init', '--json']));
if (init.ok !== true || init.created !== true) {
  throw new Error(`unexpected init result: ${JSON.stringify(init)}`);
}

const add = parseJson(
  await run(supervisor, [
    'add-agent',
    '--kind',
    'noop',
    '--name',
    'support',
    '--handle',
    'support-agent',
    '--state-dir',
    path.join(home, 'agents', 'support'),
    '--allow-senders',
    'sender-a,sender-b',
    '--block-senders',
    'sender-c',
    '--json',
  ])
);
if (add.ok !== true || add.agent?.kind !== 'noop') {
  throw new Error(`unexpected add-agent result: ${JSON.stringify(add)}`);
}
if (add.agent?.wake?.enabled !== false) {
  throw new Error(`new supervisor agents should default wake off: ${JSON.stringify(add)}`);
}
if (add.agent?.wake?.accessMode !== 'allow_list') {
  throw new Error(`new supervisor agents should default wake access to allow_list: ${JSON.stringify(add)}`);
}
if (
  add.agent?.wake?.allowedWakeSenderAgentIds?.join(',') !== 'sender-a,sender-b' ||
  add.agent?.wake?.blockedWakeSenderAgentIds?.join(',') !== 'sender-c'
) {
  throw new Error(`supervisor add-agent should store wake access lists: ${JSON.stringify(add)}`);
}

const status = parseJson(await run(agenttalk, ['supervisor', 'status', '--json']));
if (status.ok !== true || status.agents?.[0]?.name !== 'support') {
  throw new Error(`unexpected status result: ${JSON.stringify(status)}`);
}
if (status.agents?.[0]?.wakeEnabled !== false || status.agents?.[0]?.wakeable !== false) {
  throw new Error(`supervisor status should report wake off by default: ${JSON.stringify(status)}`);
}
if (
  status.agents?.[0]?.wakeAccess?.mode !== 'allow_list' ||
  status.agents?.[0]?.wakeAccess?.allowedWakeSenderAgentIds?.length !== 2 ||
  status.agents?.[0]?.wakeAccess?.blockedWakeSenderAgentIds?.[0] !== 'sender-c'
) {
  throw new Error(`supervisor status should report wake access lists: ${JSON.stringify(status)}`);
}

const access = parseJson(
  await run(supervisor, [
    'wake-access',
    'support',
    '--clear-allow-senders',
    '--block-senders',
    'sender-d',
    '--json',
  ])
);
if (
  access.ok !== true ||
  access.agent?.wakeAccess?.mode !== 'allow_list' ||
  access.agent?.wakeAccess?.allowedWakeSenderAgentIds?.length !== 0 ||
  access.agent?.wakeAccess?.blockedWakeSenderAgentIds?.[0] !== 'sender-d'
) {
  throw new Error(`unexpected wake-access result: ${JSON.stringify(access)}`);
}

let openWakeRejected = false;
try {
  await run(supervisor, ['wake-access', 'support', '--wake-access', 'open', '--json']);
} catch (error) {
  openWakeRejected = String(error.message || error).includes('i-understand-open-wake-risk');
}
if (!openWakeRejected) {
  throw new Error('open wake mode should require explicit risk acknowledgement');
}

const openWakeApprovalSet = parseJson(
  await run(supervisor, [
    'open-wake-approval',
    'set-passphrase',
    '--passphrase',
    openWakeApprovalPassphrase,
    '--json',
  ])
);
if (
  openWakeApprovalSet.ok !== true ||
  openWakeApprovalSet.openWakeApproval?.mode !== 'passphrase' ||
  openWakeApprovalSet.openWakeApproval?.configured !== true
) {
  throw new Error(`unexpected open-wake-approval result: ${JSON.stringify(openWakeApprovalSet)}`);
}

let openWakePassphraseRejected = false;
try {
  await run(supervisor, [
    'wake-access',
    'support',
    '--wake-access',
    'open',
    '--i-understand-open-wake-risk',
    '--json',
  ]);
} catch (error) {
  openWakePassphraseRejected = String(error.message || error).includes('approval passphrase');
}
if (!openWakePassphraseRejected) {
  throw new Error('open wake mode should require local approval passphrase when configured');
}

const openAccessResult = await run(supervisor, [
  'wake-access',
  'support',
  '--wake-access',
  'open',
  '--i-understand-open-wake-risk',
  '--open-wake-approval-passphrase',
  openWakeApprovalPassphrase,
  '--json',
]);
const openAccess = parseJson(openAccessResult);
if (
  openAccess.ok !== true ||
  openAccess.agent?.wakeAccess?.mode !== 'open' ||
  !openAccessResult.stderr.includes('open wake requests')
) {
  throw new Error(`unexpected open wake result: ${JSON.stringify(openAccess)} stderr=${openAccessResult.stderr}`);
}

const wakeOn = parseJson(await run(supervisor, ['wake-on', 'support', '--json']));
if (
  wakeOn.ok !== true ||
  wakeOn.agent?.wakeEnabled !== true ||
  wakeOn.agent?.wakeAccess?.mode !== 'allow_list' ||
  wakeOn.agent?.wakeAccess?.allowedWakeSenderAgentIds?.length !== 0
) {
  throw new Error(`wake-on should default back to allow_list mode: ${JSON.stringify(wakeOn)}`);
}

const request = parseJson(
  await run(supervisor, [
    'request-wake-change',
    'support',
    '--wake-access',
    'open',
    '--reason',
    'smoke test open wake approval request',
    '--json',
  ])
);
if (
  request.ok !== true ||
  request.request?.status !== 'pending' ||
  request.request?.desired?.wakeAccessMode !== 'open' ||
  !request.request?.warning?.includes('open wake requests')
) {
  throw new Error(`unexpected wake change request result: ${JSON.stringify(request)}`);
}

const requests = parseJson(await run(supervisor, ['requests', '--json']));
if (
  requests.ok !== true ||
  requests.requests?.length !== 1 ||
  requests.requests?.[0]?.id !== request.request.id
) {
  throw new Error(`unexpected wake change requests list: ${JSON.stringify(requests)}`);
}

let requestApprovalRejected = false;
try {
  await run(supervisor, ['approve-request', request.request.id, '--json']);
} catch (error) {
  requestApprovalRejected = String(error.message || error).includes('i-understand-open-wake-risk');
}
if (!requestApprovalRejected) {
  throw new Error('approving open wake request should require explicit risk acknowledgement');
}

let requestApprovalPassphraseRejected = false;
try {
  await run(supervisor, [
    'approve-request',
    request.request.id,
    '--i-understand-open-wake-risk',
    '--json',
  ]);
} catch (error) {
  requestApprovalPassphraseRejected = String(error.message || error).includes('approval passphrase');
}
if (!requestApprovalPassphraseRejected) {
  throw new Error('approving open wake request should require local approval passphrase when configured');
}

const approved = parseJson(
  await run(supervisor, [
    'approve-request',
    request.request.id,
    '--i-understand-open-wake-risk',
    '--open-wake-approval-passphrase',
    openWakeApprovalPassphrase,
    '--json',
  ])
);
if (
  approved.ok !== true ||
  approved.request?.status !== 'approved' ||
  approved.agent?.wakeAccess?.mode !== 'open'
) {
  throw new Error(`unexpected wake change approval result: ${JSON.stringify(approved)}`);
}

const denyRequest = parseJson(
  await run(supervisor, [
    'request-wake-change',
    'support',
    '--allow-senders',
    'sender-z',
    '--json',
  ])
);
const denied = parseJson(await run(supervisor, ['deny-request', denyRequest.request.id, '--json']));
if (denied.ok !== true || denied.request?.status !== 'denied') {
  throw new Error(`unexpected wake change deny result: ${JSON.stringify(denied)}`);
}

const doctor = parseJson(await run(agenttalk, ['supervisor', 'doctor', '--json']));
if (
  doctor.ok !== true ||
  !doctor.checks?.some(check => check.name === 'agent:connector' && check.ok === true)
) {
  throw new Error(`unexpected doctor result: ${JSON.stringify(doctor)}`);
}

const testWake = parseJson(await run(supervisor, ['test-wake', 'support', '--json']));
if (testWake.ok !== true || testWake.result?.handled !== true) {
  throw new Error(`unexpected test-wake result: ${JSON.stringify(testWake)}`);
}

const busyCode = "process.stdout.write(JSON.stringify({busy:true,reason:'manual host session active'}));";
const busyCommand = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(busyCode)}`;
const busyAdd = parseJson(
  await run(supervisor, [
    'add-agent',
    '--kind',
    'noop',
    '--name',
    'busy-support',
    '--handle',
    'busy-support-agent',
    '--state-dir',
    path.join(home, 'agents', 'busy-support'),
    '--busy-command',
    busyCommand,
    '--json',
  ])
);
if (
  busyAdd.ok !== true ||
  !busyAdd.agent?.connector?.busyCommand ||
  busyAdd.agent?.connector?.busyCommandTimeoutMs !== 5000
) {
  throw new Error(`unexpected busy add-agent result: ${JSON.stringify(busyAdd)}`);
}
let busyRejected = false;
try {
  await run(supervisor, ['test-wake', 'busy-support', '--json']);
} catch (error) {
  busyRejected = String(error.message || error).includes('runtime_busy: manual host session active');
}
if (!busyRejected) {
  throw new Error('busy command should block connector wake dispatch');
}

const logs = parseJson(await run(supervisor, ['logs', '--agent', 'support', '--tail', '5', '--json']));
if (logs.ok !== true || !Array.isArray(logs.events)) {
  throw new Error(`unexpected logs result: ${JSON.stringify(logs)}`);
}

const events = parseJson(await run(supervisor, ['events', '--tail', '5', '--json']));
if (events.ok !== true || !Array.isArray(events.events)) {
  throw new Error(`unexpected events result: ${JSON.stringify(events)}`);
}

const service = parseJson(await run(supervisor, ['install-service', '--dry-run', '--json']));
if (service.ok !== true || service.dryRun !== true) {
  throw new Error(`unexpected install-service result: ${JSON.stringify(service)}`);
}

console.log(
  JSON.stringify({
    ok: true,
    entrypoints: ['agenttalk-supervisor', 'agenttalk supervisor'],
    agents: status.agents.length,
    doctorChecks: doctor.checks.length,
    testWake: testWake.result,
    logs: logs.events.length,
    servicePlatform: service.platform,
  })
);
