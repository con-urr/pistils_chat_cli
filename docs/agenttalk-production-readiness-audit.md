# AgentTalk Production Readiness Audit

Date: 2026-05-26

This audit maps the goal requirements to current artifacts and validation evidence. It is intentionally conservative: blocked external dependencies remain open even when the local code path is implemented and smoke-tested.

## Current Verdict

Not complete.

The local MCP, non-presence wake supervisor, setup flow, connector framework, Codex/OpenClaw/Hermes deterministic live wake/reply paths, hosted MCP code, and Render deploy artifacts are implemented and validated. The remaining hard gates are external:

- Render cannot yet create `agent-talk-mcp` because it cannot fetch the private `con-urr/Agent-Talk-MCP` repo, and anonymous GHCR pulls for the branch image return HTTP 401.
- Render MCP auth inside Codex still needs `RENDER_API_KEY`; the Render CLI browser login token does not populate that environment variable.
- Real Hermes runtime execution is still skipped until Hermes has non-interactive model/provider credentials.

## Repo State Evidence

| Repo | Branch | Evidence |
| --- | --- | --- |
| `pistils_chat_cli` | `codex/agenttalk-mcp-supervisor` | Head `cdc35ff9cae58524f1447dcd51f40a6d393e1ba6`; PR `con-urr/pistils_chat_cli#1`; only unrelated untracked image remains locally. |
| `live-chat` | `codex/agenttalk-wake-presence` | Head `7e0a759935f2856d618f76983c4a4cce0d7adb80`; PR `con-urr/live-chat#1`. |
| `Agent-Talk-MCP` | `codex/render-mcp-service` | Head `76a375883f7695f52a88005e3be2530e1214678d`; PR `con-urr/Agent-Talk-MCP#1`. |

## Checklist

| Requirement | Status | Evidence | Remaining work |
| --- | --- | --- | --- |
| Phase 0 repo inspection and integration notes | Complete | `docs/agenttalk-mcp-wake-supervisor-build-plan.md` records discovered OpenClaw, Hermes, Codex, Render CLI, risks, and implementation plan. | None known. |
| Local stdio MCP server | Complete | `package.json` exposes `agenttalk-mcp`; `docs/agenttalk-mcp.md` documents stdio usage; `src/mcp` implements shared MCP handlers; `npm run smoke:mcp` validates tool listing and representative calls. | None known. |
| MCP result envelope and safe tool surface | Complete | MCP docs list bounded tools and constrained supervisor config updates; README states no generic shell execution; `docs/agenttalk-mcp.md` documents bounded listen and `agenttalk_supervisor_config_set` limits. | None known. |
| Codex MCP setup helper | Complete | `agenttalk mcp install-codex` supports package, local dev, and remote Render URL modes; docs in `docs/integrations/codex.md`; dry-run commands validated in PR. | Actual Codex config mutation is intentionally opt-in. |
| Backend non-presence wake dispatcher model | Complete | `live-chat/spacetimedb/src/index.ts` uses `clientKind`, `isPresenceBearingClientKind`, `wake_dispatcher`, `agenttalk-supervisor`, and `visible_dispatcher_wake_request`; `live-chat` commit `7e0a759` adds non-presence semantics. | None known. |
| Supervisor for multiple local agents | Complete | `agenttalk-supervisor` bin and `agenttalk supervisor` commands exist; `docs/agenttalk-supervisor.md` documents init/add/list/status/doctor/test-wake/run/install-service/uninstall/logs; `smoke:supervisor` covers init, add-agent, status, doctor, dry-run service install, and test-wake. | Windows service support is best-effort via start script, as scoped in the goal. |
| Connector framework | Complete | `docs/agenttalk-wake-connectors.md` documents input files, env contract, result shape, reply ownership, and `AGENTTALK_REPLY_ARGS_JSON`; `smoke:wake-connectors` covers noop, shell, OpenClaw, Hermes, Codex, Codex JSONL, and default Codex schema mode. | None known. |
| OpenClaw connector | Complete for command path and local runtime handling | `docs/integrations/openclaw.md`; `smoke:real-connectors` handles real local OpenClaw; `smoke:supervisor-live-openclaw-self-reply` verifies default command shape and live self-reply/ack. | Real OpenClaw model behavior still depends on runtime policy choosing to execute the reply command. |
| Hermes connector | Partial, externally blocked for real runtime | `docs/integrations/hermes-agent.md`; `smoke:supervisor-live-hermes-self-reply` verifies default command shape and live self-reply/ack with a fake Hermes repo; `smoke:hermes-status` and `smoke:real-connectors` clearly detect missing credentials. | Configure Hermes with non-interactive inference credentials, then rerun `AGENTTALK_RUN_REAL_CONNECTOR_TESTS=1 npm run smoke:real-connectors` and require Hermes to handle. |
| Codex connector | Complete for command path and local runtime handling | `docs/integrations/codex.md`; default `codex exec --json --output-schema` path is schema-constrained; `smoke:real-connectors` handles real local Codex; `smoke:supervisor-live-codex-self-reply` verifies live self-reply/ack. | Real model behavior still depends on Codex choosing to execute the reply command. |
| Consumer setup flow | Complete | `agenttalk setup --agents`; `agenttalk supervisor init --wizard`; setup smoke covers OpenClaw auto-detection, Hermes skip-by-default without credentials, and `--allow-unconfigured-hermes`; README and supervisor docs show minimal setup path. | Real Hermes readiness still depends on credentials. |
| Service installation | Complete within platform scope | `agenttalk supervisor install-service` supports LaunchAgent, systemd user service, and Windows start script; `smoke:supervisor` validates dry-run service install on Windows. | Actual service start/install was not performed in this workspace. |
| Hosted MCP service code | Complete for private beta | `Agent-Talk-MCP` exposes `/healthz`, `/readyz`, `/auth/status`, `POST /mcp`, `GET /mcp`; `npm run check` passes with private-beta bearer auth and 22 MCP tools. | Full OAuth/account-linking/encrypted session storage remains follow-up before general production claim. |
| Render deploy artifacts | Complete, deploy blocked externally | `Agent-Talk-MCP/Dockerfile`, `render.yaml`, `.github/workflows/publish-image.yml`, `docs/render-deploy.md`, and `npm run preflight:render`; preflight validates Blueprint and confirms `agent-talk-mcp` is absent while `CrisisTrainingSim` remains untouched. | Grant Render GitHub integration access, make GHCR public, or add a narrow GHCR read credential; then create free `agent-talk-mcp` and verify deployed endpoints. |
| Validation matrix | Strong but not final | `npm run check`; `npm run smoke:mcp`; `npm run smoke:wake-connectors`; `AGENTTALK_RUN_REAL_CONNECTOR_TESTS=1 npm run smoke:real-connectors`; `npm run smoke:supervisor-live-self-replies`; `Agent-Talk-MCP npm run check`; `Agent-Talk-MCP npm run preflight:render`. | Add deployed Render endpoint validation after service creation. |

## Latest Validation Snapshot

The goal log records these validated checkpoints:

- Local package check passed: build, CLI surface, supervisor smoke, Hermes status parser, wake connectors, setup smoke, and package dry-run.
- Live backend self-reply matrix passed:
  - shell/custom: conversation 78, reply sequence 2, claimed 1, acked 1, failed 0
  - Codex: conversation 79, reply sequence 2, claimed 1, acked 1, failed 0
  - OpenClaw: conversation 80, reply sequence 2, claimed 1, acked 1, failed 0
  - Hermes: conversation 81, reply sequence 2, claimed 1, acked 1, failed 0
- Real connector smoke passed for OpenClaw and Codex; Hermes skipped with the explicit reason that non-interactive credentials are not configured.
- Hosted MCP smoke passed with private-beta bearer auth and 22 MCP tools.
- Render preflight passed local/Render CLI checks but reports:
  - `RENDER_API_KEY` not set
  - GHCR branch image anonymous manifest returns HTTP 401
  - Git-backed creation still needs Render GitHub access to the private repo

## Required Completion Gates

Do not mark the overall goal complete until all of these are true:

1. Render source access is resolved.
2. A new free Render service named `agent-talk-mcp` is created in Connor's workspace under My project.
3. `CrisisTrainingSim` remains untouched after service creation.
4. Deployed checks pass for `/healthz`, `/auth/status`, `/readyz`, and `/mcp`.
5. Hermes has non-interactive inference credentials and the real Hermes connector smoke handles a wake.
6. A final audit reruns the objective checklist against current repo state and deployed service evidence.
