# AgentTalk Production Readiness Audit

Date: 2026-05-26

This audit maps the goal requirements to current artifacts and validation evidence. It is intentionally conservative: blocked external dependencies remain open even when the local code path is implemented and smoke-tested.

## Current Verdict

Not complete.

The local MCP, non-presence wake supervisor, setup flow, connector framework, Codex/OpenClaw/Hermes deterministic live wake/reply paths, hosted MCP code, and Render deploy artifacts are implemented and validated. The remaining hard gates are external:

- Render cannot yet create `agent-talk-mcp` because it cannot fetch the private `con-urr/Agent-Talk-MCP` repo, and anonymous GHCR pulls for the branch image return HTTP 401.
- Render MCP auth is configured in the Windows user environment with the existing Render CLI token and redacted probes return HTTP 200 from Render API and Render MCP. `codex mcp list` and `codex mcp get render` confirm the Render MCP server registration is enabled for new Codex processes. This may require restarting Codex Desktop to load the env var/tooling in the current app session, and a non-expiring Dashboard API key should replace the CLI token before relying on it long term.
- `npm run preflight:hermes` verifies the local Hermes repo, venv, chat command shape, status command, auth setup commands, Codex CLI login state, and Hermes-owned Codex auth state, but real Hermes runtime execution is still skipped until Hermes has non-interactive model/provider credentials. A fresh Hermes-owned OpenAI Codex OAuth device-code flow was started and opened in the browser, but it remained waiting for user approval and was stopped cleanly.

## Repo State Evidence

| Repo | Branch | Evidence |
| --- | --- | --- |
| `pistils_chat_cli` | `codex/agenttalk-mcp-supervisor` | PR `con-urr/pistils_chat_cli#1`; this committed audit is on the pushed branch; only an unrelated untracked image remains locally. |
| `live-chat` | `codex/agenttalk-wake-presence` | Head `7e0a759935f2856d618f76983c4a4cce0d7adb80`; PR `con-urr/live-chat#1`. |
| `Agent-Talk-MCP` | `codex/render-mcp-service` | Head `249099dbd0ec847d40851f8c6617622802a40612`; PR `con-urr/Agent-Talk-MCP#1`. |

## Checklist

| Requirement | Status | Evidence | Remaining work |
| --- | --- | --- | --- |
| Phase 0 repo inspection and integration notes | Complete | `docs/agenttalk-mcp-wake-supervisor-build-plan.md` records discovered OpenClaw, Hermes, Codex, Render CLI, risks, and implementation plan. | None known. |
| Local stdio MCP server | Complete | `package.json` exposes `agenttalk-mcp`; `docs/agenttalk-mcp.md` documents stdio usage; `src/mcp` implements shared MCP handlers; `npm run smoke:mcp` validates tool listing and representative calls. | None known. |
| MCP result envelope and safe tool surface | Complete | MCP docs list bounded tools and constrained supervisor config updates; README states no generic shell execution; `docs/agenttalk-mcp.md` documents bounded listen and `agenttalk_supervisor_config_set` limits. | None known. |
| MCP client setup helpers | Complete | `agenttalk mcp install-codex` supports package, local dev, and remote Render URL modes; `agenttalk mcp config --client all` prints non-mutating Codex, Claude Code, and Cursor setup commands/snippets; docs in `docs/agenttalk-mcp.md` and `docs/integrations/codex.md`; dry-run/config commands validated in PR. | Actual Codex config mutation is intentionally opt-in. Claude/Cursor config output is non-mutating by design. |
| Backend non-presence wake dispatcher model | Complete | `live-chat/spacetimedb/src/index.ts` uses `clientKind`, `isPresenceBearingClientKind`, `wake_dispatcher`, `agenttalk-supervisor`, and `visible_dispatcher_wake_request`; `live-chat` commit `7e0a759` adds non-presence semantics. | None known. |
| Supervisor for multiple local agents | Complete | `agenttalk-supervisor` bin and `agenttalk supervisor` commands exist; `docs/agenttalk-supervisor.md` documents init/add/list/status/doctor/test-wake/run/install-service/uninstall/logs; `smoke:supervisor` covers init, add-agent, status, doctor, dry-run service install, and test-wake. | Windows service support is best-effort via start script, as scoped in the goal. |
| Connector framework | Complete | `docs/agenttalk-wake-connectors.md` documents input files, env contract, result shape, reply ownership, and `AGENTTALK_REPLY_ARGS_JSON`; `smoke:wake-connectors` covers noop, shell, OpenClaw, Hermes, Codex, Codex JSONL, and default Codex schema mode. | None known. |
| OpenClaw connector | Complete for command path and local runtime handling | `docs/integrations/openclaw.md`; `smoke:real-connectors` handles real local OpenClaw; `smoke:supervisor-live-openclaw-self-reply` verifies default command shape and live self-reply/ack. | Real OpenClaw model behavior still depends on runtime policy choosing to execute the reply command. |
| Hermes connector | Partial, externally blocked for real runtime | `docs/integrations/hermes-agent.md`; `npm run preflight:hermes` verifies the local Hermes repo, venv Python, `hermes chat --query --quiet --source`, `hermes status`, `hermes auth add`, `hermes config set`, Codex CLI login state, Hermes-owned Codex auth state, and package inclusion; `smoke:supervisor-live-hermes-self-reply` verifies default command shape and live self-reply/ack with a fake Hermes repo; `smoke:hermes-status` and `smoke:real-connectors` clearly detect missing credentials. | Configure Hermes with a Hermes-owned OAuth session or provider API key, then rerun `npm run preflight:hermes` and `AGENTTALK_RUN_REAL_CONNECTOR_TESTS=1 npm run smoke:real-connectors` and require Hermes to handle. |
| Codex connector | Complete for command path and local runtime handling | `docs/integrations/codex.md`; default `codex exec --json --output-schema` path is schema-constrained; `smoke:real-connectors` handles real local Codex; `smoke:supervisor-live-codex-self-reply` verifies live self-reply/ack. | Real model behavior still depends on Codex choosing to execute the reply command. |
| Consumer setup flow | Complete | `agenttalk setup --agents`; `agenttalk supervisor init --wizard`; setup smoke covers OpenClaw auto-detection, Hermes skip-by-default without credentials, and `--allow-unconfigured-hermes`; README and supervisor docs show minimal setup path. | Real Hermes readiness still depends on credentials. |
| Service installation | Complete within platform scope | `agenttalk supervisor install-service` supports LaunchAgent, systemd user service, and Windows start script; `smoke:supervisor` validates dry-run service install on Windows. | Actual service start/install was not performed in this workspace. |
| Hosted MCP service code | Complete for private beta | `Agent-Talk-MCP` exposes `/healthz`, `/readyz`, `/auth/status`, `POST /mcp`, `GET /mcp`; `npm run check` passes with private-beta bearer auth and 22 MCP tools. | Full OAuth/account-linking/encrypted session storage remains follow-up before general production claim. |
| Render deploy artifacts | Complete, deploy blocked externally | `Agent-Talk-MCP/Dockerfile`, `render.yaml`, `.github/workflows/publish-image.yml`, `docs/render-deploy.md`, `npm run preflight:render`, and `npm run smoke:deployed`; preflight validates Blueprint, confirms `agent-talk-mcp` is absent while `CrisisTrainingSim` remains untouched, verifies the target workspace/project/environment, verifies `RENDER_API_KEY` against both Render API and Render MCP, and returns `nextActions` plus inert `createCommands` for Git-backed, public-image, and private-image-with-registry-credential deploy paths. Direct Render CLI create retries failed before creation because the private GitHub source is invalid or unfetchable to Render. | Grant Render GitHub integration access, make GHCR public, or add a narrow GHCR read credential; then create free `agent-talk-mcp` with the preflight-reported command and run `npm run smoke:deployed` against the deployed URL. |
| Validation matrix | Strong but not final | `npm run check`; `npm run audit:goal`; `npm run preflight:hermes`; `npm run smoke:mcp`; `npm run smoke:wake-connectors`; `AGENTTALK_RUN_REAL_CONNECTOR_TESTS=1 npm run smoke:real-connectors`; `npm run smoke:supervisor-live-self-replies`; `Agent-Talk-MCP npm run check`; `Agent-Talk-MCP npm run preflight:render`; Agent-Talk-MCP local `npm run smoke:deployed` harness in auth-boundary and token tool-list modes; Render CLI service inventory after create retries. | Run deployed Render endpoint validation after service creation. |

## Latest Validation Snapshot

The goal log records these validated checkpoints:

- Local package check passed: build, CLI surface, supervisor smoke, Hermes status parser, wake connectors, setup smoke, and package dry-run.
- Hermes preflight passed the local repo/entrypoint/venv/chat/status/auth-setup checks, detected Codex CLI login separately from Hermes-owned Codex auth, included `scripts/hermes-readiness-preflight.mjs` in the package dry-run, and reported the remaining credential gate without printing secrets.
- Hermes OAuth approval was retested with a fresh `hermes auth add openai-codex --type oauth` device-code flow. The browser URL was opened, the process remained waiting for user approval, the login poller was stopped cleanly, and `npm run preflight:hermes` / `hermes status` still report Hermes-owned OpenAI Codex as logged out with no configured model/provider credentials.
- Live backend self-reply matrix passed:
  - shell/custom: conversation 78, reply sequence 2, claimed 1, acked 1, failed 0
  - Codex: conversation 79, reply sequence 2, claimed 1, acked 1, failed 0
  - OpenClaw: conversation 80, reply sequence 2, claimed 1, acked 1, failed 0
  - Hermes: conversation 81, reply sequence 2, claimed 1, acked 1, failed 0
- Real connector smoke passed for OpenClaw and Codex; Hermes skipped with the explicit reason that non-interactive credentials are not configured. Local investigation found no provider API-key env vars in the current process and no reachable LM Studio/Ollama no-key local endpoint; Codex CLI is logged in, but Hermes intentionally keeps Codex OAuth separate and should use `hermes auth add openai-codex --type oauth` instead of importing Codex CLI tokens.
- Hosted MCP smoke passed with private-beta bearer auth and 22 MCP tools.
- Render MCP auth was configured by copying the existing Render CLI token into the Windows user `RENDER_API_KEY` env var without printing it; redacted probes returned HTTP 200 from both Render API and Render MCP. The token expires on 2026-06-01 and should be replaced by a non-expiring Dashboard API key for durable use.
- Render CLI skill setup was retested after the plugin install request: `render skills install --tool codex --scope user --confirm -o text` completed with `Installed 21 skill(s) to 1 tool(s)`, `render login` reported the CLI was already authenticated, `render services -o json` listed only `CrisisTrainingSim`, `codex mcp list` / `codex mcp get render` show the Render MCP registration enabled with `RENDER_API_KEY`, and a redacted Render MCP initialize probe returned HTTP 200.
- Agent-Talk-MCP `npm run preflight:render` now verifies `RENDER_API_KEY` against Render API and Render MCP directly, and verifies the target Render workspace/project/environment before any create attempt. When run with the user env value injected into the current shell, it reports `render:api_key_auth` and `render:mcp_api_key_auth` as pass, `renderMcpAuth: ready`, and `targetProjectEnvironment: ready`; it also returns `nextActions` for the current account-side unblock steps, and still reports:
  - GHCR branch image anonymous manifest returns HTTP 401
  - Git-backed creation still needs Render GitHub access to the private repo
- Agent-Talk-MCP `npm run preflight:render` now also reports inert `createCommands.gitBacked`, `createCommands.imageBacked`, and `createCommands.imageBackedWithRegistryCredential`; the current run marks them blocked by source/image-access gates but keeps the exact commands available after the account-side fix.
- Agent-Talk-MCP adds `npm run smoke:deployed` for the post-Render completion gate. Local validation against `dist/index.js` passed both without a token, verifying unauthenticated `/mcp` returns 401, and with a fake bearer token, verifying MCP tool listing returns 22 tools including `agenttalk_whoami`.
- `agenttalk mcp config --client all` now prints setup material for Codex, Claude Code, and Cursor in local stdio mode; `--client cursor --url ... --json` prints the remote Render MCP Cursor JSON with a `<AGENTTALK_MCP_TOKEN>` placeholder, not a token value. `npm run smoke:cli-surface` and `npm run check` validate the command.
- `npm run audit:goal` now performs the conservative final-gate audit in one command: it checks source-of-truth docs, repo heads/worktrees, Agent-Talk-MCP `preflight:render`, optional deployed smoke with `AGENTTALK_MCP_BASE_URL`, Hermes `preflight:hermes`, and real Hermes connector smoke when Hermes is ready. Non-strict mode reports JSON without failing; `npm run audit:goal -- --strict` exits nonzero until the Render and Hermes gates are actually satisfied.
- Render CLI direct Git-backed creation was retried with both accepted URL shapes and failed before creating a service because the private repository remains invalid or unfetchable to Render.
- Post-retry Render inventory still lists only `CrisisTrainingSim`; `agent-talk-mcp` is absent and the existing service remains untouched.

## Required Completion Gates

Do not mark the overall goal complete until all of these are true:

1. Render source access is resolved.
2. A new free Render service named `agent-talk-mcp` is created in Connor's workspace under My project.
3. `CrisisTrainingSim` remains untouched after service creation.
4. Deployed checks pass for `/healthz`, `/auth/status`, `/readyz`, and `/mcp` using `Agent-Talk-MCP npm run smoke:deployed`.
5. Hermes has non-interactive inference credentials and the real Hermes connector smoke handles a wake.
6. `npm run audit:goal -- --strict` passes after rerunning the objective checklist against current repo state and deployed service evidence.
