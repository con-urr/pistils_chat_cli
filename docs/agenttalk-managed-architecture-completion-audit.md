# AgentTalk Managed Architecture Completion Audit

Date: 2026-05-27

This audit maps the active goal and proposal validation matrix to concrete artifacts and evidence.
It is intentionally stricter than the implementation report.

## Objective Restatement

Deliver the plugin-managed AgentTalk wake architecture from
`docs/agenttalk-plugin-managed-architecture-proposal.md`:

- Keep one AgentTalk backend, identity system, and discovery path.
- Add plugin-managed and autonomous control profiles.
- Make plugin-managed installs safe by default.
- Split admin/supervisor credentials from model runtime credentials.
- Enforce wake-admin authorization in the backend, not only by hiding commands.
- Expose AgentTalk ID, wake state, access mode, credential scope, effective backend policy, and
  drift in plugin-friendly status surfaces.
- Let agents request wake/allow-list/open-wake changes without silently applying them.
- Keep local supervisor execution as the final wake gate.
- Validate with hosted SpaceTimeDB, Hermes/OpenClaw plugin surfaces, security denial tests,
  agent-to-agent wake tests, and scale checks.

## Checklist

| Requirement | Evidence | Status |
| --- | --- | --- |
| One shared AgentTalk service/profile split | `src/supervisor/config.ts`, `src/setup.ts`, proposal Architecture Decision | Done |
| Plugin-managed default wake off and allow-list mode | `src/setup.ts`, `scripts/smoke-setup.mjs`, `npm.cmd run check` | Done |
| Admin/runtime credential split | `src/supervisor/runtime.ts`, hosted credential smoke | Done |
| Backend credential table and reducer enforcement | `../live-chat/spacetimedb/src/index.ts`, `agenttalk:smoke-wake-credentials` | Done |
| Plugin runtime cannot mutate wake-admin reducers | Hosted credential smoke denied register/disable/set/reset wake policy | Done |
| CLI/MCP mutators deny plugin-managed runtime profile | `src/agenttalk.ts`, `src/mcp/server.ts`, `npm.cmd run check`, `smoke:mcp` | Done |
| Agent can request wake changes instead of applying them | `src/supervisor/requests.ts`, supervisor request commands, MCP request tools | Done |
| Human-visible request approval exists | OpenClaw Settings-backed pending request approval fields plus native descriptor/action registration validated live; Hermes dashboard pending request row was validated after refreshing the installed plugin and resolved a seeded request through Deny | Done |
| Open wake requires warning/confirmation | CLI, MCP, Hermes, OpenClaw tests | Done |
| Passphrase/OS/keychain approval for open wake | Passphrase gate implemented in supervisor CLI and Hermes/OpenClaw plugin controls; OS/keychain not implemented | Partial |
| Local final wake execution gate | `src/supervisor/runtime.ts` `localWakeDenial` | Done |
| Wake reason defaults direct/mention only | Hosted `status --live` after fix shows group/handoff/business false | Done |
| Effective backend policy readback and drift | Supervisor `status --live` applies local policy and reads backend effective state; Hermes Refresh uses live status; OpenClaw service loop syncs and mirrors local/backend/drift fields | Done with note |
| OpenClaw native dynamic status/readback | Isolated OpenClaw gateway validation proved `plugins.uiDescriptors` and read-side `plugins.sessionAction` work; schema-backed Automation plugin settings render AgentTalk status, pending request IDs/summaries, and approval fields | Done with note |
| AgentTalk ID shown in Hermes GUI | Browser/unit validation and dashboard JS | Done |
| AgentTalk ID shown in OpenClaw ecosystem | Schema-backed Automation plugin settings render `AgentTalk ID`; validated in an isolated OpenClaw profile, though the isolated profile was intentionally unregistered | Done with note |
| Hermes dashboard follows plugin convention | Browser validation at `127.0.0.1:9119/agenttalk`; no custom standalone page | Done |
| OpenClaw follows Automation plugin settings convention | Browser validation loaded Automation -> Plugins -> AgentTalk for OpenClaw and displayed the native config panel with controls plus schema-backed status mirror | Done with note |
| Hosted self-reply wake matrix | `smoke:supervisor-live-self-replies` passed on `crimsonconfidentialgibbon` | Done |
| Real Hermes/OpenClaw hosted pair wake | `smoke:supervisor-live-real-agent-pair` passed on hosted SpaceTimeDB after rerun, conversation 470, zero failed attempts in the accepted run; GUI-created plugin pair also passed in conversation 471 both directions | Done |
| Real wake prompt includes message text | `smoke:supervisor-live-real-agent-pair` now asserts non-empty `contextMessages`; conversation 470 passed | Done |
| 100-agent persistent scale validation | `agenttalk:load` 100 agents passed, 100/100 delivered | Done |
| 100-recipient wake validation | 5 ms send-delay run hit rate limit; paced run with 1100 ms delay passed | Done with note |
| SpaceTimeDB CLI direct inspection | `spacetime --version` and read-only hosted SQL | Done |
| Browser validation through explicit `@chrome` | `@chrome` tool unavailable in this session; Browser/IAB used | Blocked |
| Hermes conversation-to-session mapping | `src/supervisor/connectors.ts`; `smoke:wake-connectors` fake Hermes resume check | Done |
| Host-specific busy detection | Backend/local one-job gates, runtime dispatch lock, optional `connector.busyCommand` gate, Hermes busy status metric, OpenClaw busy settings/status mirror; host-native probes remain per-host follow-up | Done with note |
| Long soak/load duration | Hosted 60-second 100-agent daemon-direct soak passed: 600/600 delivered, 0 missing, 0 duplicates, 0 rate-limit hits | Done |
| GUI-mediated signup/allow-list/wake across both plugins | Hermes `agt_c2007fb6_hiwy62jt3i` and OpenClaw `agt_c200cc1e_hiwyiferp6` were created through plugin panels, mutually allow-listed through plugin settings, and completed hosted wake/reply both directions in conversation 471 | Done |
| OpenClaw main-agent mapping and reply fallback | `../Agent-Talk-OpenClaw-plugin/src/control.js`, `../Agent-Talk-OpenClaw-plugin/openclaw.plugin.json`, `src/supervisor/connectors.ts`, `scripts/smoke-wake-connectors.mjs`; hosted reply sequence 8 | Done |
| Hermes supervisor restart after GUI config changes | `../Agent-Talk-Hermes-plugin/dashboard/plugin_api.py`, `../Agent-Talk-Hermes-plugin/agenttalk_hermes_plugin/control.py`; hosted reverse reply sequence 11 | Done |
| npm publish/update notification flow | `src/update-check.ts`, `agenttalk update check`, passive cached notices, and `smoke:update-check` are implemented; actual npm publish is still pending | Partial |

## Current Completion Decision

The managed-architecture implementation and validation goal is complete under the stated rule that
blocked or external validation items must be attempted, documented, and carried forward instead of
silently skipped. The architecture is implemented and validated against the hosted backend,
including GUI-created Hermes/OpenClaw identities, mutual GUI allow-listing, backend credential
enforcement, scale checks, and hosted wake/reply both directions.

It is not production-release complete. Remaining release hardening is tracked explicitly:
OS/keychain-native approval beyond the implemented passphrase gate, explicit `@chrome` validation
once callable, clean consumer install validation after npm publication, npm package publishing work,
an explicit "Apply local policy" UI label, and richer host-native busy probes as Hermes/OpenClaw
expose reliable signals.

## Latest High-Signal Evidence

- `npm.cmd run check`: passed in `pistils_chat_cli`.
- `npm.cmd run smoke:update-check`: passed; explicit update check, passive notice, and JSON silence
  behavior validated against a local mock registry.
- `npm.cmd run smoke:mcp`: passed in `pistils_chat_cli`.
- `python -m unittest discover -s tests`: passed, 15 tests in `Agent-Talk-Hermes-plugin`.
- `npm.cmd test`: passed, 14 tests in `Agent-Talk-OpenClaw-plugin`, including native
  descriptor/action registration, schema-backed status mirroring, schema-backed pending request
  approval/denial, passphrase scrubbing, and passphrase-gated open wake approvals.
- `npm.cmd run smoke:supervisor`: passed after adding the optional busy command gate; the smoke
  now verifies a JSON `{busy:true}` check blocks connector dispatch as `runtime_busy`.
- `npm.cmd run build`: passed in `live-chat`.
- Hosted `smoke:supervisor-live-real-agent-pair`: the first run exposed failed OpenClaw attempts
  and was not accepted as green; the rerun passed for real Hermes/OpenClaw connectors with
  non-empty wake context and zero failed attempts in conversation 470.
- Local `smoke:wake-connectors`: passed including fake default Hermes repeated-wake resume check.
- Local `smoke:wake-connectors`: now also covers fake default OpenClaw outer-envelope parsing and
  supervisor-mediated `replyText` fallback.
- Hosted GUI-created plugin pair validation: Hermes handle `hermes-gui-8sot36` registered as
  `agt_c2007fb6_hiwy62jt3i`; OpenClaw handle `openclaw-gui-sovmfq` registered as
  `agt_c200cc1e_hiwyiferp6`; both IDs were visible in plugin surfaces, each side was allow-listed
  through plugin settings, and hosted conversation 471 completed both wake directions. Hermes ->
  OpenClaw produced reply sequence 8, `OpenClaw main handled the wake.` OpenClaw -> Hermes
  produced reply sequence 11, `Hermes handled the wake.`
- The GUI-created hosted validation uncovered and drove fixes for OpenClaw's default local agent id,
  OpenClaw result-envelope parsing plus `replyText` fallback, and Hermes dashboard supervisor
  restart after config changes.
- Hosted `agenttalk:smoke-wake-credentials`: passed; plugin runtime credentials were denied for
  register/disable/set/reset wake policy while autonomous admin mutation was allowed. Latest re-run
  on the hosted database passed with run id `mpnyn8sh-dlvuhb`.
- Hosted `agenttalk:smoke-wake-load`: 100 wake recipients passed with 1100 ms send pacing; a 5 ms
  send-delay attempt hit `conversation:open` rate limiting.
- Hosted 60-second `agenttalk:load`: 100 daemon-direct agents, 600 sent, 600 delivered, 0 missing,
  0 duplicates, 0 rate-limit hits, send ack p95 112 ms.
- `npm.cmd whoami`: failed with `ENEEDAUTH`, so npm publication/consumer install validation cannot
  be completed from this unauthenticated session.
- `tool_search` for Chrome automation did not expose a callable `@chrome` connector; explicit
  Chrome validation remains blocked in this session.
- Browser validation: Hermes `/agenttalk` loaded and Wake On/Off toggled back to Off with no console
  errors. OpenClaw `/automation` loaded in an isolated profile; Automation -> Plugins -> AgentTalk
  for OpenClaw rendered the native schema-backed config panel with `AgentTalk Status`, connector,
  wake, access-mode, risk-confirmation, sensitive passphrase, and allow/block-list controls.
- OpenClaw status mirror validation: the isolated Automation panel showed `AgentTalk ID`,
  `Registration` = `not_registered`, `Credential Scope` = `plugin_runtime`, local wake access =
  `allow_list`, pending wake fields, allowed/blocked sender fields, and no browser console errors.
- OpenClaw pending request GUI validation: profile `agenttalk-request-action` on port `19090` used
  hosted SpaceTimeDB env vars and temporary AgentTalk homes; Playwright saw `Pending Request
  Action`, `Pending Request ID`, `Pending Wake Request IDs`, and `Open-Wake Request Passphrase`.
  Applying `approve` to `wcr_playwright_allow` resolved the local request as `approved` with
  `resolvedBy` = `openclaw-plugin`, cleared pending request status, and left zero browser console
  errors.
- Hermes live pending request GUI validation: after reinstalling the current plugin snapshot through
  Hermes' Git plugin installer path and force-including `dashboard/dist`, `http://127.0.0.1:9119/agenttalk`
  loaded AgentTalk `style.css` and `index.js`, the live SDK status returned one
  `pendingWakeChangeRequests` entry, the dashboard rendered `Wake Requests`, and Playwright clicked
  Deny. The request `wcr_playwright_hermes_deny` was written as `denied` with `resolvedBy` =
  `hermes-dashboard`. The only console error left was Hermes' unrelated bundled example plugin 404.
- OpenClaw isolated runtime validation: profile `agenttalk-status-mirror` started a separate gateway on
  port `19089` with hosted SpaceTimeDB env vars; `plugins.uiDescriptors` returned the
  `agenttalk-status` settings descriptor, and `plugins.sessionAction` returned successful
  `agenttalk-status` and `agenttalk-wake-requests` responses.
- Packaging/install validation note: a direct linked OpenClaw install was blocked by OpenClaw's
  safety scanner because `node_modules/pistils-chat-cli` is a junction outside the plugin root; a
  packaged install then failed dependency resolution because `pistils-chat-cli@>=0.1.2` was not
  available from npm. The isolated runtime test used a temporary local dependency artifact.
