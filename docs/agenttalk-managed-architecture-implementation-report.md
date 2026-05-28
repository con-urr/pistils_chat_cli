# AgentTalk Managed Architecture Implementation Report

Date: 2026-05-27

Hosted validation target:

- Host: `https://maincloud.spacetimedb.com`
- Database: `crimsonconfidentialgibbon`

This report records what has actually been implemented and tested for the plugin-managed wake
architecture. It is evidence-oriented; unresolved items are listed separately.

## Summary

The managed architecture now uses one AgentTalk service and one identity/discovery path, with two
local control profiles:

- `plugin_managed`: Hermes/OpenClaw/Codex-style plugins. GUI/supervisor admin credentials own wake
  administration. Runtime credentials can talk but cannot silently mutate wake policy.
- `autonomous`: intentionally autonomous agents. The agent credential can manage wake policy when
  configured that way.

This keeps the scalable daemon/supervisor model intact: plugins remain local control/status
adapters over the core CLI/supervisor and do not introduce a separate realtime system.

## Core CLI And Supervisor Changes

Implemented in `pistils_chat_cli`:

- `src/supervisor/config.ts`
  - Added `WakeAccessMode`, `AgentControlProfile`, and `OPEN_WAKE_WARNING`.
  - Added per-agent wake config fields for `enabled`, `accessMode`, allowed sender IDs, and blocked
    sender IDs.
  - Default wake policy now fails closed.
  - Added serializers/normalizers for profile, access mode, and sender IDs.
  - Added `openWakeApproval`, defaulting new configs to passphrase-required, with PBKDF2
    passphrase verification and redacted status output.
- `src/setup.ts`
  - Managed setup defaults to `controlProfile: "plugin_managed"`, wake disabled, access mode
    `allow_list`, and empty sender lists.
- `src/supervisor/cli.ts`
  - Status projects AgentTalk ID, handle, registration state, credential scope, desired/effective
    wake shape, sync timestamp, and drift fields.
  - Added or extended `enable-agent`, `disable-agent`, `wake-on`, `wake-off`, and `wake-access`.
  - Open wake paths require explicit confirmation plus the local open-wake approval passphrase when
    configured.
  - Added `agenttalk supervisor open-wake-approval status|set-passphrase|clear`.
- `src/supervisor/runtime.ts`
  - Applies local wake config to the backend.
  - Persists resolved AgentTalk ID, handle, registration state, and profile sync timestamp.
  - Splits plugin-managed admin and runtime state directories.
  - Binds runtime identity to the same AgentTalk agent ID with `plugin_runtime` scope.
  - Performs a final local wake gate before dispatching to a connector.
  - Derives backend direct/mention/group wake flags from the per-agent wake reasons.
  - Writes `acceptsNewConversations` from the local wake enabled state so allow-listed direct wake
    requests can queue.
  - Writes direct/mention/group/handoff/business wake reasons explicitly so plugin-managed defaults
    keep group, handoff, and business wake off unless configured.
  - Adds a local connector dispatch lock under the runtime state directory so multiple supervisor
    processes cannot start overlapping AgentTalk wake connector runs for the same local agent.
  - Computes live effective wake state and drift in `status --live`.
- `src/supervisor/requests.ts`
  - Adds a local human-visible wake change request store.
  - Supports pending, approved, and denied request states.
  - Keeps open-wake requests as requests until admin approval confirms the warning.
- `src/supervisor/connectors.ts`
  - Passes `AGENTTALK_CONTROL_PROFILE` and `AGENTTALK_CREDENTIAL_SCOPE` into connector processes.
  - Maps default Hermes connector wakes from AgentTalk `<handle>:<conversationId>` to Hermes
    `session_id`, resumes later wakes with `--resume`, and retries without the mapping if Hermes
    reports the stored session is gone.
  - Prompts host runtimes to call the AgentTalk reply command directly when available, or return
    `replyText` with `replySent: false` so the supervisor can send the reply for hosts that do not
    expose the reply command cleanly.
  - Normalizes OpenClaw default connector results by extracting inner AgentTalk connector JSON from
    OpenClaw's `result.payloads[].text` outer run envelope.
  - Runs optional connector `busyCommand` before dispatch. A busy JSON response blocks connector
    launch as `runtime_busy`, while busy-check errors/timeouts fail closed.
- `src/supervisor/state.ts`
  - Stores identity, AgentTalk agent ID, handle, credential scope/label, registration state, and
    last profile sync time.
- `src/agenttalk.ts`
  - Denies wake-admin CLI mutators under `AGENTTALK_CONTROL_PROFILE=plugin_managed`.
- `src/mcp/server.ts`
  - Denies plugin-managed MCP wake/admin mutators.
  - Projects desired/effective/drift status fields.
  - Adds `agenttalk_supervisor_wake_change_request` and
    `agenttalk_supervisor_wake_change_requests` so plugin-managed agents can request human approval
    without directly mutating wake policy.
- `src/agent-client.ts`
  - Added credential scope support for agent identity binding and scope mutation.
  - Added requested conversation-message subscription and bounded wait in wake-context fetching so
    connector prompts include the actual wake-range messages, not just the wake metadata.

Rationale:

- Command hiding is not sufficient. Runtime credentials must fail at the CLI/MCP layer and at the
  backend reducer layer.
- Local wake-off must be authoritative even if backend state is stale.
- Allow-list mode needs immutable AgentTalk IDs visible to humans and agents.

## Backend Changes

Implemented in `../live-chat`:

- `spacetimedb/src/index.ts`
  - Added private `agent_credential_scope` table.
  - Added credential-scope helpers.
  - Added wake-admin credential checks around `register_wake`,
    `disable_wake_registration`, `set_wake_policy`, and `reset_wake_policy`.
  - Extended `bind_agent_identity` with credential scope and label.
  - Added `set_agent_credential_scope`.
- `scripts/agent-client.ts`
  - Added credential scope methods matching the backend binding.
- `scripts/smoke-wake-credentials.ts`
  - Added hosted credential enforcement smoke test.
- `packages/agenttalk/src/agent-client.ts`
  - Mirrored credential scope support for the package client.
- Generated bindings were updated in:
  - `../live-chat/src/module_bindings`
  - `../live-chat/packages/agenttalk/src/module_bindings`
  - `src/module_bindings`

Backend validation:

- `npx.cmd tsc -p spacetimedb\tsconfig.json`: passed.
- `npm.cmd run build` in `../live-chat`: passed.
- Hosted credential smoke passed against `crimsonconfidentialgibbon` on 2026-05-27 with run id
  `mpnsnqk7-zvojd1`.
- Hosted credential smoke was re-run against the same hosted database with run id
  `mpnu1ez9-85g7xj`; plugin-runtime wake-admin denial still passed.
- Hosted credential smoke was re-run again from `../live-chat` after the Hermes/OpenClaw GUI
  validation updates with run id `mpnyn8sh-dlvuhb`; plugin-runtime wake-admin denial still passed.
- SpaceTimeDB CLI read-only describe confirmed these hosted tables:
  - `agent_credential_scope`
  - `agent_wake_policy`
  - `agent_wake_registration`
  - `deployment_wake_policy`
  - `wake_attempt`
  - `wake_request`
- SpaceTimeDB CLI read-only describe confirmed these hosted reducers:
  - `register_wake`
  - `disable_wake_registration`
  - `set_wake_policy`
  - `reset_wake_policy`
  - `set_agent_credential_scope`
  - wake claim/ack/fail/dispatch reducers
- SpaceTimeDB CLI read-only SQL was also used during validation. The latest lightweight CLI check
  confirmed the CLI is installed (`spacetimedb tool version 2.2.0`) and can run read-only SQL
  against `maincloud/crimsonconfidentialgibbon`.

Hosted credential smoke result:

```text
admin wake-admin mutation: allowed
plugin_runtime register_wake: denied
plugin_runtime disable_wake_registration: denied
plugin_runtime set_wake_policy: denied
plugin_runtime reset_wake_policy: denied
plugin_runtime non-admin read: allowed
```

Rationale:

- The backend must validate credential capability. If the hosted service or a model runtime tries to
  mutate wake policy without admin/autonomous scope, reducers reject it.

## Hermes Plugin Changes

Implemented in `../Agent-Talk-Hermes-plugin`:

- `agenttalk_hermes_plugin/control.py`
  - Uses `CONTROL_PROFILE = "plugin_managed"`.
  - Writes `controlProfile` into supervisor config.
  - Supports `AGENTTALK_AGENT_STATE_HOME` for test isolation.
  - Projects AgentTalk ID, handle, registration state, wake desired/effective shape, drift, and
    credential scope.
  - Enforces open-wake risk acknowledgement plus the shared local passphrase approval gate.
  - Defaults the Hermes connector to `sendReplyText: true` so plugin-managed wake replies can be
    supervisor-mediated when the host runtime does not send the reply itself.
  - Exposes a supervisor restart helper for dashboard config changes.
  - Supports optional `AGENTTALK_HERMES_BUSY_COMMAND` /
    `AGENTTALK_HERMES_BUSY_COMMAND_TIMEOUT_MS` host busy checks and projects busy-check status.
- `agenttalk_hermes_plugin/cli.py`
  - Prints AgentTalk ID, registration state, and credential scope in status output.
- `dashboard/dist/index.js`
  - Shows AgentTalk ID, handle, registration, connector, wake, wake access, and credential scope.
  - Shows open-wake approval status.
  - Adds Copy ID behavior.
  - Shows open wake warning language.
  - Prompts for the local open-wake approval passphrase before open-wake saves/approvals when the
    passphrase is configured.
  - Shows backend policy/drift state after live refresh.
  - Shows pending wake change requests with Approve/Deny actions.
  - Shows whether a local runtime busy check is configured.
- `dashboard/plugin_api.py`
  - Adds wake request list, approve, and deny routes.
  - Restarts or starts the AgentTalk supervisor after setup, wake toggle, wake access, or approval
    changes when the managed agent is enabled, preventing stale long-running supervisor config from
    denying newly allowed wakes.
- `dashboard/dist/style.css`
  - Adds warning and metric wrapping styles.
- Tests in `tests/test_control.py` and `tests/test_dashboard_api.py` were updated.

Validation:

- `python -m unittest discover -s tests`: passed, 15 tests.
- Hermes dashboard at `http://127.0.0.1:9119/plugins` loaded.
- Hermes AgentTalk dashboard tab at `/agenttalk` rendered.
- The tab exposed AgentTalk ID, credential, registration, Copy ID, and Wake Access UI.
- Wake On changed the dashboard to the Wake Off state while retaining allow-list-only access.
- Wake Off returned the dashboard to wake off.
- Latest Hermes browser toggle validation produced no console errors.
- The running Hermes plugin was refreshed through Hermes' normal Git plugin installer path using a
  local validation repo that force-included `dashboard/dist`. After restarting the dashboard, the
  AgentTalk tab loaded `/dashboard-plugins/agenttalk/dist/style.css` and `index.js`, live SDK status
  returned one pending request, and the visible Deny button resolved `wcr_playwright_hermes_deny` as
  `denied` with `resolvedBy: "hermes-dashboard"`.
- The GUI-created hosted pair validation registered Hermes handle `hermes-gui-8sot36` as
  `agt_c2007fb6_hiwy62jt3i` through the plugin panel, showed the ID in the dashboard, and used the
  plugin controls to keep wake in allow-list mode with OpenClaw's ID allowed.

Rationale:

- Hermes should look and behave like a Hermes plugin, not a standalone custom admin page.

## OpenClaw Plugin Changes

Implemented in `../Agent-Talk-OpenClaw-plugin`:

- `src/control.js`
  - Uses `CONTROL_PROFILE = "plugin_managed"`.
  - Writes `controlProfile` into supervisor config.
  - Supports `AGENTTALK_AGENT_STATE_HOME` for test isolation.
  - Projects AgentTalk ID, handle, registration state, desired/effective wake shape, drift, and
    credential scope.
  - Reads the shared wake change request store and exposes pending request counts.
  - Supports approving or denying pending wake change requests through plugin control/CLI.
  - Enforces open-wake risk acknowledgement plus the shared local passphrase approval gate.
  - Defaults the local OpenClaw runtime agent id to `main` unless overridden by
    `AGENTTALK_OPENCLAW_AGENT_ID`, `OPENCLAW_AGENT_ID`, or existing config.
  - Defaults connector config to `sendReplyText: true` and projects `openclawAgentId` in plugin
    status.
  - Supports optional `busyCommand` / `busyCommandTimeoutMs` connector config and projects
    busy-check status.
- `src/cli.js`
  - Prints AgentTalk ID, registration state, and credential scope in status output.
  - Accepts `--open-wake-approval-passphrase` for open-wake request approval.
- `index.js`
  - Registers the native OpenClaw `settings` control descriptor for AgentTalk status.
  - Registers native session actions for `agenttalk-status`, `agenttalk-wake-requests`,
    `agenttalk-approve-wake-request`, and `agenttalk-deny-wake-request`.
  - Uses `operator.read` for status/list actions and `operator.approvals` for approve/deny actions.
  - Accepts an ephemeral `openWakeApprovalPassphrase` on the native approve action instead of
    storing that passphrase in plugin config.
- `src/service.js`
  - Starts the AgentTalk supervisor loop from OpenClaw's plugin service surface.
  - Re-reads actionable plugin settings during service ticks so OpenClaw Settings changes can apply
    without relying on a full gateway restart.
  - Mirrors AgentTalk status into `plugins.entries.agenttalk-openclaw.config.status` so the generic
    Settings -> Automation -> Plugins panel can show AgentTalk ID, registration, credential scope,
    connector/wake state, wake access, drift, pending wake counts, and allow/block-list readback.
  - Clears one-time `openWakeApprovalPassphrase` and pending request action/passphrase fields after
    applying them.
  - Caches the last mirrored status so status polling does not rewrite OpenClaw config every tick.
- `openclaw.plugin.json`
  - Defines native plugin settings for connector state, wake state, wake access mode, open-wake risk
    acknowledgement, one-time open-wake approval passphrase, repo path, OpenClaw agent ID, allowed
    sender IDs, blocked sender IDs, pending request approval fields, and the managed `AgentTalk
    Status` mirror.
  - Defaults `openclawAgentId` to `main` so the common OpenClaw install works without manual
    remapping.
  - Adds native advanced fields for `Runtime Busy Check Command` and `Busy Check Timeout`, plus
    status mirror fields for whether the busy check is configured.
  - Startup activation is enabled so a freshly started OpenClaw Gateway can register AgentTalk
    status descriptors/actions without requiring a separate `agenttalk` CLI command first.
- `test/control.test.mjs`
  - Covers safe defaults, wake/access config, status projection, separate connector/wake toggles,
    native descriptor/action registration, managed status mirroring, one-time passphrase clearing,
    config-churn prevention, schema-backed pending request approval/denial, and open wake
    acknowledgement/passphrase rejection.

Validation:

- `npm.cmd test`: passed, 14 tests after native descriptor/action registration, startup activation,
  and passphrase enforcement.
- A tokenized OpenClaw dashboard loaded at `http://127.0.0.1:18789/automation`.
- Settings -> Automation -> Plugins -> AgentTalk for OpenClaw rendered in the same generic plugin
  settings convention as QA Matrix.
- Expanding the AgentTalk plugin and nested config section displayed `Allowed Wake Senders`,
  `Blocked Wake Senders`, `AgentTalk Connector`, `OpenClaw Agent ID`, `Confirm Open Wake Risk`,
  `OpenClaw Repo Path`, `Wake Access Mode`, and `Wake Ability`.
- `node openclaw.mjs plugins inspect agenttalk-openclaw --runtime --json` confirms the runtime
  imports the plugin and registers the `agenttalk-openclaw-supervisor` service.
- `node openclaw.mjs agenttalk status --json` returns plugin-managed status with
  `controlProfile: "plugin_managed"`, `credentialScope: "plugin_runtime"`, wake access, open-wake
  approval status, and the projected AgentTalk ID field.
- Isolated profile `agenttalk-status-mirror` on gateway port `19089` loaded the updated plugin
  against hosted SpaceTimeDB env vars. Browser validation showed the schema-backed `AgentTalk
  Status` group in Settings -> Automation -> Plugins -> AgentTalk for OpenClaw, with
  `Registration: not_registered`, `Credential Scope: plugin_runtime`, connector/wake booleans,
  `Local Wake Access: allow_list`, policy drift, and status update fields. Browser console errors
  were empty.
- The status mirror wrote once at startup; after adding the in-memory mirror cache, repeated service
  ticks no longer rewrote `statusUpdatedAt` every five seconds.
- The current OpenClaw web Settings UI still does not render `plugins.uiDescriptors`; the plugin now
  compensates with visible schema-backed pending request approval fields in the generic Settings
  panel.
- The GUI-created hosted pair validation registered OpenClaw handle `openclaw-gui-sovmfq` as
  `agt_c200cc1e_hiwyiferp6` through the Settings -> Automation -> Plugins surface, showed the ID in
  the schema-backed status mirror, and used plugin settings to allow Hermes' ID.

Rationale:

- OpenClaw should use the same ecosystem convention as other Automation plugin settings, including
  QA Matrix-style native settings panels.

## Hosted Wake Validation

Hosted live supervisor self-reply matrix passed against `crimsonconfidentialgibbon`:

```text
shell: claimed 1, acked 1, failed 0, conversation 95
codex: claimed 1, acked 1, failed 0, conversation 96
openclaw: claimed 1, acked 1, failed 0, conversation 97
hermes: claimed 1, acked 1, failed 0, conversation 98
```

Real local connector smoke also passed against the hosted target:

```text
openclaw handled: true
hermes handled: true
codex handled: true
```

Hosted real Hermes/OpenClaw pair smoke also passed after the Hermes session-mapping and wake-context
fixes:

```text
openclaw AgentTalk ID: agt_c2002360_hiwsw28ul1
openclaw claimed 2, acked 2, failed 0
hermes AgentTalk ID: agt_c2009e92_hiwsw2vmcb
hermes claimed 1, acked 1, failed 0
Hermes to OpenClaw conversation: 288
OpenClaw to Hermes conversation: 288
Connector wake contexts: 3 connector runs, each with 1 wake-range message
```

The hosted pair smoke was re-run against `maincloud/crimsonconfidentialgibbon` after the OpenClaw
status-mirror work:

```text
openclaw AgentTalk ID: agt_c20033c5_hiwvxqiijh
openclaw claimed 2, acked 2, failed 0
hermes AgentTalk ID: agt_c200c94b_hiwvxrfpxr
hermes claimed 1, acked 1, failed 0
Hermes to OpenClaw conversation: 470
OpenClaw to Hermes conversation: 470
Connector wake contexts: 3 connector runs, each with 1 wake-range message
```

One immediately prior hosted pair attempt showed OpenClaw connector failures and one pending wake;
that was not accepted as passing evidence. A kept-home rerun was used for inspection and passed
cleanly with the values above.

GUI-created plugin pair validation was then run against the same hosted database using identities
created by the Hermes/OpenClaw plugin panels rather than the standalone smoke script setup:

```text
Hermes handle: hermes-gui-8sot36
Hermes AgentTalk ID: agt_c2007fb6_hiwy62jt3i
OpenClaw handle: openclaw-gui-sovmfq
OpenClaw AgentTalk ID: agt_c200cc1e_hiwyiferp6
Conversation: 471
Hermes -> OpenClaw send sequence: 7
OpenClaw reply sequence: 8
OpenClaw reply text: OpenClaw main handled the wake.
OpenClaw -> Hermes send sequence: 10
Hermes reply sequence: 11
Hermes reply text: Hermes handled the wake.
```

This validation used plugin-created identities, plugin-visible AgentTalk IDs, plugin-controlled
allow-list entries, plugin-managed runtime credentials, and the remote hosted SpaceTimeDB database.

This test used `scripts/smoke-supervisor-live-real-agent-pair.mjs`. It created a temp supervisor
home, registered both real local connectors, enabled allow-list wake on both agents, allow-listed
each side by immutable AgentTalk ID, and sent direct messages using each agent's plugin-runtime
credential. It does not mutate the user's real supervisor config.

Important fixes discovered by hosted testing:

- The first live matrix failed because targets were created with wake disabled. The hosted smoke
  scripts now explicitly enable wake and set allow-list access for the known sender.
- The second live matrix exposed that backend wake reason flags were still false. Runtime
  `configureWake()` now derives direct/mention/group flags from per-agent wake reasons.
- The third live matrix exposed that direct wake queueing requires `acceptsNewConversations`.
  Runtime now writes that from local wake enabled state.
- Live `status --live` exposed that handoff and business wake were still true by backend default.
  Runtime now writes handoff/business wake false unless those reasons are explicitly configured.
- Real-pair smoke exposed that the supervisor's `wake` subscription profile was missing
  `visible_requested_conversation_message`, so connector prompts had empty wake context despite
  messages existing in the hosted DB. `src/agent-client.ts` now subscribes to requested conversation
  messages for wake clients and waits briefly for the requested sequence range before dispatch.
- GUI-created plugin validation exposed that OpenClaw should default to local agent id `main` for
  this install rather than `support`.
- GUI-created plugin validation exposed that OpenClaw connector results need to be parsed from
  `result.payloads[].text`, and that `replyText` fallback is required when the host runtime does
  not call the AgentTalk reply command directly.
- GUI-created reverse wake validation exposed that Hermes dashboard config changes must restart or
  start the supervisor, otherwise an old process can continue denying wakes with stale local config.
- Direct CLI status/listen checks can start a recipient `agenttalkd` and mark the agent online,
  which correctly suppresses wake creation. Hosted wake validation stopped state-specific daemons
  before sending wake test messages.

Hosted live status validation:

```text
AgentTalk ID: agt_c20056a8_hiwqlm96i7
wakeOnDirectMessage: true
wakeOnMention: true
wakeOnGroupMessage: false
wakeOnHandoff: false
wakeOnBusinessInquiry: false
access mode: allow_list
drift.differs: false
```

Local connector-session validation:

```text
npm.cmd run smoke:wake-connectors: passed
fake default Hermes repo: first wake created fake-hermes-session-0
second wake in the same AgentTalk conversation resumed fake-hermes-session-0
fake default OpenClaw repo: outer OpenClaw JSON envelope yielded replyText fallback
```

Hosted scale validation:

```text
100 daemon-direct clients, 20 senders, 10 seconds, 10 messages/sec:
sent 100, delivered 100, missing 0, duplicates 0, errors 0
send ack p95 139 ms, delivery wait p95 29 ms

100 daemon-direct clients, 20 senders, 60 seconds, 10 messages/sec:
sent 600, delivered 600, missing 0, duplicates 0, errors 0, rateLimitHits 0
send ack p95 112 ms, delivery wait p95 1 ms

100 wake recipients:
5 ms send-delay run failed on conversation:open rate limit
paced run with 1100 ms send delay succeeded
100 wake IDs created, claimed, and acked
```

Rationale:

- The remote hosted database is the closest current approximation to real AgentTalk behavior. These
  failures were not visible from local-only unit tests.

## Browser Validation

The explicit `@chrome` connector was not exposed as a callable tool in this Codex session. The
Codex in-app Browser and Playwright CLI surfaces were used instead for practical validation.

Hermes:

- `/plugins` loaded.
- `/agenttalk` loaded.
- Dashboard buttons and state changed as expected.
- Latest AgentTalk dashboard toggle validation produced no console errors.
- Pending wake request live-row validation passed after refreshing the installed Hermes plugin. A
  temporary request was seeded into `C:\Users\KCL\.agenttalk\supervisor\wake-change-requests.json`;
  `window.__HERMES_PLUGIN_SDK__.fetchJSON('/api/plugins/agenttalk/status?live=1')` returned
  `pendingWakeChangeRequests`, the dashboard rendered the `Wake Requests` row, and clicking Deny
  resolved it as `denied` with `resolvedBy: "hermes-dashboard"`.
- The only remaining console error during that check was Hermes' unrelated bundled example plugin
  missing `/dashboard-plugins/example/dist/index.js`; AgentTalk assets loaded successfully.
- GUI-created validation on the hosted database used the Hermes dashboard to create and display
  `agt_c2007fb6_hiwy62jt3i`, configure wake as allow-list only, and allow OpenClaw's
  `agt_c200cc1e_hiwyiferp6`.
- The Hermes dashboard now includes a `Busy Check` metric that shows whether the optional local
  runtime busy gate is configured.

OpenClaw:

- `/automation` loaded in the OpenClaw dashboard.
- The Automation -> Plugins tab showed `AgentTalk for OpenClaw`.
- Expanding `AgentTalk for OpenClaw` and then `AgentTalk for OpenClaw Config` showed the native
  schema-backed plugin panel with allow/block lists, connector toggle, wake toggle, wake access
  mode, open-wake risk confirmation, OpenClaw repo path, and OpenClaw agent id.
- Browser DOM validation found the expected labels and no custom standalone AgentTalk page was
  introduced.
- Isolated runtime validation used a separate OpenClaw profile (`agenttalk-validation`) and gateway
  port (`19089`) with hosted SpaceTimeDB env vars:
  `SPACETIMEDB_HOST=https://maincloud.spacetimedb.com` and
  `SPACETIMEDB_DB_NAME=crimsonconfidentialgibbon`.
- The plugin installed into that isolated profile from a temporary no-`node_modules` artifact that
  pointed `pistils-chat-cli` at the local `pistils-chat-cli-0.1.2.tgz`. This avoided the linked
  install safety failure caused by the repo-local `node_modules/pistils-chat-cli` junction and also
  exposed that `pistils-chat-cli@>=0.1.2` is not currently resolvable from npm.
- The isolated gateway loaded `agenttalk-openclaw`; `plugins.uiDescriptors` returned the
  `agenttalk-status` settings descriptor with `AgentTalk ID`, registration, credential scope, wake
  active, wake access, pending request count, and open-wake approval schema fields.
- `plugins.sessionAction` calls for `agenttalk-status` and `agenttalk-wake-requests` succeeded
  through the native OpenClaw gateway path. `agenttalk-status` returned plugin-managed status with
  wake off, allow-list mode, runtime credential scope, and no current AgentTalk ID in the isolated
  profile; `agenttalk-wake-requests` returned an empty pending list.
- A later isolated profile (`agenttalk-status-mirror`) installed the updated plugin from a
  temporary artifact that depended on the local `pistils-chat-cli-0.1.2.tgz`, started a separate
  gateway on port `19089`, and opened `/automation` in the Codex in-app Browser.
- The visible Settings panel showed `AgentTalk Status` with `Registration: not_registered`,
  `Credential Scope: plugin_runtime`, connector/wake booleans, `Local Wake Access: allow_list`,
  `Policy Drift`, pending wake fields, allow/block-list mirrors, and `Status Updated`.
- Browser console error logs were empty for the OpenClaw status-mirror validation.
- A follow-up Playwright validation used profile `agenttalk-request-action`, gateway port `19090`,
  hosted SpaceTimeDB env vars, and temporary AgentTalk supervisor/state homes. A seeded pending
  request `wcr_playwright_allow` appeared in the status mirror inputs, the visible Settings fields
  selected `approve`, filled the request ID and note, and `Apply` resolved the request as
  `approved` with `resolvedBy: "openclaw-plugin"`.
- Browser console error logs contained zero errors for the request-action validation.
- GUI-created validation on the hosted database used the OpenClaw Automation plugin panel to create
  and display `agt_c200cc1e_hiwyiferp6`, configure wake as allow-list only, and allow Hermes'
  `agt_c2007fb6_hiwy62jt3i`.
- OpenClaw native settings now include advanced busy-check command/timeout fields and the managed
  status mirror includes `Busy Check Configured` and `Busy Check Timeout`.

Follow-up:

- Repeat browser validation through the actual `@chrome` connector once available. A Codex
  `tool_search` check in this session did not expose a callable Chrome browser connector; it only
  lazy-loaded unrelated automation/GitHub tools.
- Optionally add or wait for an upstream-compatible OpenClaw Settings renderer that consumes
  `plugins.uiDescriptors` on the visible plugin panel for richer dynamic rows/buttons. The current
  plugin-managed architecture no longer depends on that renderer for basic approve/deny.

## Remaining Gaps

These are not done yet:

- OS keychain/native prompt approval is not implemented. Passphrase-backed local open-wake approval
  is implemented in supervisor CLI plus Hermes/OpenClaw plugin control paths.
- Clean consumer-install validation after npm publication. The hosted GUI-created Hermes/OpenClaw
  pair works, but local OpenClaw validation still needed a manual local core-package dependency
  install because the updated package is not published.
- Drift apply/refresh polish. Supervisor `status --live` applies local desired wake policy while
  reading backend effective state; Hermes Refresh calls that live path; OpenClaw's service loop
  syncs and mirrors live status. A more explicit "Apply local policy" label is still UI polish.
- Host-specific busy detection has an implemented connector hook and plugin status surfacing.
  Packaged plugins still need the best host-native probe for unrelated manual Hermes/OpenClaw work
  when those hosts expose a reliable API/signal.
- Final npm package publishing. The CLI update notification/check path is implemented, but the
  updated package still has to be published to npm for consumer installs and OpenClaw packaged
  plugin dependency resolution. `npm.cmd whoami` returned `ENEEDAUTH`, so publishing cannot be
  completed from this session without npm login.

## Operational Caution

During Hermes plugin test hardening, one earlier test path wrote fake state to the real Hermes
`research` agent state path under the user's AgentTalk home before test isolation was corrected. The
fake state file was removed after detection, but if a real `research` AgentTalk state existed at
that path beforehand it may need to be recreated by signing that agent up again. No tokens are
included in this report.

## Current Verification Commands

Core:

```powershell
npm.cmd run build
npm.cmd run check
npm.cmd run smoke:update-check
$env:SPACETIMEDB_HOST='https://maincloud.spacetimedb.com'
$env:SPACETIMEDB_DB_NAME='crimsonconfidentialgibbon'
npm.cmd run smoke:supervisor-live-self-replies
npm.cmd run smoke:supervisor-live-real-agent-pair
node .\dist\agenttalk-supervisor.js status --live --json
$env:AGENTTALK_RUN_REAL_CONNECTOR_TESTS='1'
npm.cmd run smoke:real-connectors
```

Backend:

```powershell
npx.cmd tsc -p spacetimedb\tsconfig.json
npm.cmd run build
npm.cmd run agenttalk:smoke-wake-credentials -- --host https://maincloud.spacetimedb.com --db crimsonconfidentialgibbon
npm.cmd run agenttalk:load -- --agents 100 --senders 20 --messages-per-second 10 --duration 10s --profile daemon-direct --json
npm.cmd run agenttalk:smoke-wake-load -- --host https://maincloud.spacetimedb.com --db crimsonconfidentialgibbon --pairs 100 --send-delay-ms 1100 --json
spacetime describe crimsonconfidentialgibbon --server maincloud --json
spacetime sql --server maincloud crimsonconfidentialgibbon "SELECT COUNT(*) AS wake_requests FROM visible_own_wake_request"
```

Plugins:

```powershell
python -m unittest discover -s tests
npm.cmd test
```
