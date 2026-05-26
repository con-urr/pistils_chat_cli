# AgentTalk MCP + Wake Supervisor Build Plan

Last updated: 2026-05-26

This document closes Phase 0 for the AgentTalk MCP/wake-supervisor goal. It records the inspected repos, detected local runtime commands, connector environment contracts, known risks, and the implementation plan. The goal file remains the source of truth for acceptance.

## Repos Found

Primary repos under `C:\Users\KCL\Documents\GitHub`:

- `C:\Users\KCL\Documents\GitHub\live-chat`
- `C:\Users\KCL\Documents\GitHub\pistils_chat_cli`
- `C:\Users\KCL\Documents\GitHub\Agent-Talk-MCP`
- `C:\Users\KCL\Documents\GitHub\openclaw`
- `C:\Users\KCL\Documents\GitHub\hermes-agent`

Additional agent-related repos found:

- `C:\Users\KCL\Documents\GitHub\agency-agents`
- `C:\Users\KCL\Documents\GitHub\Agent-directory`
- `C:\Users\KCL\Documents\GitHub\Agent_businesses`

## Inspected Source

Live-chat architecture and wake docs:

- `C:\Users\KCL\Documents\GitHub\live-chat\docs\agenttalk-mcp-architecture.md`
- `C:\Users\KCL\Documents\GitHub\live-chat\docs\agenttalk-wake-protocol.md`
- `C:\Users\KCL\Documents\GitHub\live-chat\docs\agenttalk-open-beta-architecture.md`
- `C:\Users\KCL\Documents\GitHub\live-chat\docs\agenttalk-open-beta-readiness.md`

CLI/SDK source:

- `C:\Users\KCL\Documents\GitHub\pistils_chat_cli\README.md`
- `C:\Users\KCL\Documents\GitHub\pistils_chat_cli\src\agenttalk.ts`
- `C:\Users\KCL\Documents\GitHub\pistils_chat_cli\src\agenttalkd.ts`
- `C:\Users\KCL\Documents\GitHub\pistils_chat_cli\src\agent-client.ts`
- `C:\Users\KCL\Documents\GitHub\pistils_chat_cli\src\wake.ts`
- `C:\Users\KCL\Documents\GitHub\pistils_chat_cli\package.json`

Runtime repos:

- `C:\Users\KCL\Documents\GitHub\openclaw\README.md`
- `C:\Users\KCL\Documents\GitHub\openclaw\package.json`
- `C:\Users\KCL\Documents\GitHub\openclaw\openclaw.mjs`
- `C:\Users\KCL\Documents\GitHub\hermes-agent\README.md`
- `C:\Users\KCL\Documents\GitHub\hermes-agent\pyproject.toml`
- `C:\Users\KCL\Documents\GitHub\hermes-agent\hermes`
- Codex CLI help: `codex --version`, `codex exec --help`, `codex mcp --help`, `codex mcp add --help`

## Detected Commands

### OpenClaw

Local repo command verified:

```powershell
cd C:\Users\KCL\Documents\GitHub\openclaw
node .\openclaw.mjs --version
node .\openclaw.mjs agent --help
```

Detected version:

```text
OpenClaw 2026.5.25 (fe33747)
```

JSON-capable one-turn agent command:

```powershell
node C:\Users\KCL\Documents\GitHub\openclaw\openclaw.mjs agent --agent <openclaw-agent-id> --session-key agenttalk:<agenttalk-handle>:<conversation-id> --message <prompt> --json
```

Useful options from the verified help:

- `--agent <id>` selects an OpenClaw isolated agent.
- `--message <text>` passes the prompt.
- `--json` requests structured output.
- `--local` runs the embedded agent locally when model provider keys are in the shell.
- `--timeout <seconds>` overrides the agent command timeout.
- `--thinking <level>` supports `off|minimal|low|medium|high|xhigh|adaptive|max`.
- `--profile <name>` isolates OpenClaw state/config under a named profile.

Connector default:

```powershell
node <repoPath>\openclaw.mjs agent --agent <configuredAgentId> --session-key agenttalk:<handle>:<conversationId> --message <wakePrompt> --json --timeout 300
```

`--deliver` must not be used by default. AgentTalk should remain the delivery channel; the connector should either reply through AgentTalk itself or return a structured result that the supervisor can optionally turn into a reply when explicitly configured.

### Hermes Agent

Local repo command verified:

```powershell
cd C:\Users\KCL\Documents\GitHub\hermes-agent
.\venv\Scripts\python.exe .\hermes --help
.\venv\Scripts\python.exe .\hermes chat --help
.\venv\Scripts\python.exe .\hermes mcp --help
```

Detected package metadata:

```text
name = hermes-agent
version = 0.14.0
```

Non-interactive commands:

```powershell
.\venv\Scripts\python.exe .\hermes --oneshot <prompt> --quiet --source agenttalk
.\venv\Scripts\python.exe .\hermes chat --query <prompt> --quiet --source agenttalk
```

Useful options from the verified help:

- `--oneshot` / `-z` sends a single prompt and prints the final response.
- `chat --query` / `-q` sends a single query in chat mode.
- `--quiet` suppresses banners/spinners/tool previews for programmatic use.
- `--source <source>` tags the session source.
- `--provider`, `--model`, `--toolsets`, and `--skills` are configurable connector options.
- `--accept-hooks` is useful for headless runs that cannot prompt.
- `mcp serve` exists, but AgentTalk supervisor should call Hermes as a wake runner first; Hermes-as-MCP can be a later integration path.

Connector default:

```powershell
<repoPath>\venv\Scripts\python.exe <repoPath>\hermes --oneshot <wakePrompt> --quiet --source agenttalk
```

### Codex

Installed command verified:

```text
C:\Users\KCL\AppData\Roaming\npm\codex.ps1
codex-cli 0.130.0
```

MCP setup commands from verified `codex mcp add --help`:

```powershell
codex mcp add agenttalk -- npx -y pistils-chat-cli agenttalk-mcp
codex mcp add agenttalk-dev -- node C:\Users\KCL\Documents\GitHub\pistils_chat_cli\dist\mcp-server.js
codex mcp add agenttalk-remote --url https://<render-service>.onrender.com/mcp --bearer-token-env-var AGENTTALK_MCP_TOKEN
```

Wake runner command from verified `codex exec --help`:

```powershell
Get-Content -Raw $env:AGENTTALK_WAKE_INPUT_JSON | codex exec - --json --sandbox read-only --cd <workdir> --output-schema <schema-file>
```

Useful options:

- `--json` emits JSONL events.
- `--sandbox read-only|workspace-write|danger-full-access` controls command sandboxing.
- `--cd <DIR>` sets the working root.
- `--output-schema <FILE>` constrains the final response.
- `--output-last-message <FILE>` can simplify parsing the final assistant message.
- `--profile <CONFIG_PROFILE>` can select a Codex config profile.

Default connector posture should be `read-only`. `workspace-write` should require explicit supervisor config.

### Render CLI

Render CLI was installed and authenticated outside the package:

```text
C:\Users\KCL\.codex\tools\render-cli\2.18.0\render.exe
render v2.18.0
```

Active workspace:

```text
Connor's workspace
tea-d51f80re5dus73814oj0
```

Existing service observed and must not be touched:

```text
CrisisTrainingSim
srv-d7badkma2pns73bf9s20
https://crisistrainingsim.onrender.com
```

## Required Connector Env

All wake connectors receive the common AgentTalk env:

```text
AGENTTALK_WAKE_ID
AGENTTALK_WAKE_ATTEMPT_ID
AGENTTALK_AGENT_NAME
AGENTTALK_AGENT_HANDLE
AGENTTALK_AGENT_ID
AGENTTALK_CONVERSATION_ID
AGENTTALK_MIN_SEQUENCE
AGENTTALK_MAX_SEQUENCE
AGENTTALK_REASON
AGENTTALK_STATE_DIR
AGENTTALK_HOST
AGENTTALK_DB
AGENTTALK_WAKE_INPUT_JSON
AGENTTALK_WAKE_CONTEXT_JSON
AGENTTALK_WAKE_PAYLOAD_JSON
```

OpenClaw-specific config/env:

```text
OPENCLAW_PROFILE
OPENCLAW_STATE_DIR
OPENCLAW_CONFIG_PATH
OPENCLAW_AGENT_ID
OPENCLAW_THINKING
OPENCLAW_TIMEOUT_SECONDS
```

Hermes-specific config/env:

```text
HERMES_HOME
HERMES_CONFIG_PATH
HERMES_INFERENCE_MODEL
HERMES_ACCEPT_HOOKS
HERMES_TOOLSETS
HERMES_SKILLS
HERMES_TIMEOUT_SECONDS
```

Codex-specific config/env:

```text
CODEX_HOME
AGENTTALK_CODEX_WORKDIR
AGENTTALK_CODEX_SANDBOX
AGENTTALK_CODEX_PROFILE
AGENTTALK_CODEX_OUTPUT_SCHEMA
AGENTTALK_MCP_TOKEN
```

Remote MCP env:

```text
NODE_ENV=production
PORT=10000
SPACETIMEDB_HOST=https://maincloud.spacetimedb.com
SPACETIMEDB_DB_NAME=crimsonconfidentialgibbon
AGENTTALK_MCP_BASE_URL=https://<service>.onrender.com
AGENTTALK_REMOTE_MCP_ENCRYPTION_KEY=<32-byte-base64>
AGENTTALK_REMOTE_MCP_SIGNING_SECRET=<secret>
AGENTTALK_ALLOWED_ORIGINS=<comma-separated>
AGENTTALK_SESSION_STORE=memory|postgres
DATABASE_URL=<Render Postgres if using postgres>
LOG_LEVEL=info
```

Never log these values raw. Redact tokens, endpoint refs, auth files, secrets, and private local paths in command output, MCP results, and logs.

## Risks And Unknowns

1. Wake suppression remains the main production blocker.
   A target-agent listener can mark the target online and prevent the backend from creating a wake request. Supervisor must claim wakes through a non-presence dispatcher, separate dispatcher identity/profile, or backend `clientKind`/`presenceMode` semantics. This must be proven with a live wake smoke.

2. Hosted MCP auth cannot be called production-ready with a shared bearer token.
   Private-beta bearer auth is acceptable as an interim feature only if the docs and code are explicit. Production remote MCP needs per-user/workspace identity mapping, encrypted token storage, revocation, and a token rotation path.

3. Connector output contracts differ.
   OpenClaw supports `--json`; Codex supports JSONL and optional output schema; Hermes quiet mode returns text. The supervisor should normalize all runner outputs into `WakeConnectorResult` and should not auto-send stdout.

4. Real connector tests may need model/provider auth.
   Mock connector tests should always run. Real OpenClaw/Hermes/Codex tests should detect local auth/runtime state and skip clearly when not configured.

5. Windows support should be direct, but service install is macOS/Linux first.
   The user's active environment is Windows. The package should support Windows `supervisor run` and connector execution, while LaunchAgent/systemd service installation stays macOS/Linux initially.

6. Render deployment must create a new free service only.
   Existing `CrisisTrainingSim` service must remain untouched. The `Agent-Talk-MCP` repo should ship `render.yaml` and Dockerfile before creating the Render service.

## Implementation Plan

### Slice 1: Local MCP

- Add `@modelcontextprotocol/sdk` and `zod`.
- Add `agenttalk-mcp` bin and `agenttalk mcp` alias.
- Implement stdio transport only in `pistils_chat_cli`.
- Use `AgentRealtimeClient` directly, not `agenttalk` shell calls.
- Implement schema-validated tools:
  - `agenttalk_whoami`
  - `agenttalk_doctor`
  - `agenttalk_init_account`
  - `agenttalk_search_accounts`
  - `agenttalk_chat_start`
  - `agenttalk_conversation_reply`
  - `agenttalk_conversation_list`
  - `agenttalk_conversation_messages`
  - `agenttalk_inbox`
  - `agenttalk_mark_read`
  - `agenttalk_wake_status`
  - `agenttalk_wake_enable`
  - `agenttalk_wake_disable`
  - `agenttalk_wake_policy_get`
  - `agenttalk_wake_policy_set`
  - `agenttalk_wake_requests`
  - `agenttalk_wake_ack`
  - `agenttalk_wake_fail`
  - supervisor config/status placeholders that return honest unavailable results until implemented.
- Add `npm run smoke:mcp` using a local JSON-RPC stdio harness.

### Slice 2: Supervisor Noop

- Add `agenttalk supervisor init/add-agent/list/status/run/test-wake`.
- Store config at `~\.agenttalk\supervisor\config.json`.
- Support multiple agents with distinct state dirs/handles.
- Implement noop connector first.
- Normalize connector run input/result files under `~\.agenttalk\supervisor\runs`.
- Enforce per-agent concurrency, timeout, ack-on-success, fail-on-error.
- Add `npm run smoke:supervisor`.

### Slice 3: Wake Suppression Fix

- Prove whether the current backend can create wakes while a supervisor dispatcher is connected.
- If not, update `live-chat` backend with explicit non-presence dispatcher/client semantics or a separate dispatcher identity that does not count as target availability.
- Regenerate and sync bindings to:
  - `C:\Users\KCL\Documents\GitHub\live-chat\packages\agenttalk\src\module_bindings`
  - `C:\Users\KCL\Documents\GitHub\pistils_chat_cli\src\module_bindings`
- Add a live smoke proving listener/supervisor presence does not suppress wake creation.

### Slice 4: Connectors

- Implement connector abstraction and mocks.
- Add OpenClaw connector using `node <repo>\openclaw.mjs agent ... --json`.
- Add Hermes connector using `<repo>\venv\Scripts\python.exe <repo>\hermes --oneshot ... --quiet`.
- Add Codex connector using `codex exec --json --sandbox read-only --output-schema`.
- Add docs under `docs\integrations`.
- Add `npm run smoke:wake-connectors`.

### Slice 5: Setup UX

- Add `agenttalk setup --agents` and `agenttalk supervisor init --wizard`.
- Detect OpenClaw, Hermes, and Codex.
- Generate per-agent state dirs, conservative wake policies, and supervisor config.
- Show local MCP/Codex setup command.
- Add `--json` output for automation.

### Slice 6: Remote MCP On Render

- Initialize `C:\Users\KCL\Documents\GitHub\Agent-Talk-MCP` as a Node/TypeScript HTTP MCP service.
- Share MCP tool handlers with the local package where practical.
- Implement `/healthz`, `/readyz`, and `/mcp`.
- Add CORS, rate limiting, request IDs, auth/session mapping, redaction, Dockerfile, and `render.yaml`.
- Deploy as a new free Render service in Connor's workspace under My project, leaving `CrisisTrainingSim` unchanged.
- Add `npm run smoke:remote-mcp`.

## Completion Gates

Do not call this work complete until:

- `npm run build`, existing CLI smoke, and new MCP/supervisor/connector smokes pass.
- Local MCP starts over stdio and exposes a tool list.
- Codex can add local MCP through `codex mcp add`.
- Supervisor can route at least a noop wake without suppressing backend wake creation.
- OpenClaw/Hermes/Codex connectors either pass real local tests or skip with precise setup messages.
- Remote MCP has deploy artifacts, auth, health checks, and Render validation.
- Docs cover quickstart, security, auth, wake suppression, failed connectors, and service install/uninstall.
