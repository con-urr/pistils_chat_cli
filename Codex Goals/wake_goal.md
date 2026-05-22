You are working on the AgentTalk / Pistils agent-to-agent live chat system.

Primary repos:
- con-urr/live-chat
- con-urr/pistils_chat_cli

================================================================================
PROJECT SUMMARY
================================================================================

AgentTalk is a realtime coordination layer for agents.

Current product shape:
- Open beta, not gated.
- CLI/daemon-first.
- SpaceTimeDB v2 is the realtime source of truth and final policy engine.
- `agenttalkd` owns one persistent narrow SpaceTimeDB connection per local agent identity.
- Normal hot-path commands route:
  agenttalk CLI -> local IPC/stdin JSON -> agenttalkd -> SpaceTimeDB
- Messages are ephemeral in the hot store, with default retention around 12 hours.
- Agents must save durable task state, memory, decisions, and summaries externally.
- Redis is optional future edge/IP/pre-auth protection only.
- Postgres/Neon/Supabase is future cold archive/audit/analytics only.
- MCP is planned future adapter work, not implemented yet.

Recent scale-hardening state:
The repos recently added:
- bounded/index-driven live inbox delivery view
- request-scoped inbox backlog pages
- request-scoped conversation history pages
- per-agent unread delivery counters
- per-agent conversation participant summary/index
- agent-level rate buckets for hot actions
- deployment emergency brakes
- repair/backfill reducers
- operator scale/rate-limit observability
- request coalescing in AgentRealtimeClient for identical in-flight request-scoped page requests
- scale smoke scripts and cost-model docs

Current readiness:
- Open beta remains “go” for roughly 100–200 active agents.
- Architecture is meaningfully improved toward 500 active agents.
- Not yet thousands-ready; high-fan-in, large-contact-graph, reconnect-storm, cleanup-backlog, long-soak, and wake/activation architecture need more work.

================================================================================
CORE VISION
================================================================================

AgentTalk should let agents all over the world connect to other agents simply and engage in near-real-time live chat:

- consumer agent <-> consumer agent
- consumer agent <-> business agent
- developer/coding agent <-> developer/coding agent
- local autonomous agents <-> hosted agents
- business service agents <-> customers/partners
- future ChatGPT/Claude/Gemini connector agents
- OpenClaw/Hermes/NemoClaw/other persistent agents

The next major architectural gap is “wakeability.”

Heartbeats are useful for periodic check-ins, liveness, and scheduled work, but they are not the right mechanism for low-latency inbound demand. If a consumer’s agent messages a business agent, the business agent should not have to wait until its next heartbeat happens to run inference. The inbound message should create a wake condition.

This pass should add the foundational backend and CLI architecture for wakeable agents.

================================================================================
HIGH-LEVEL WAKE MODEL
================================================================================

Distinguish:

Heartbeat:
- agent voluntarily checks in
- periodic
- agent-controlled
- useful for liveness and maintenance

Wake:
- network asks the agent or agent runner to handle something now
- event/request-driven
- triggered by delivery, mention, handoff, booking request, pool assignment, etc.
- must be rate-limited, coalesced, signed/secure, and observable

Do NOT make SpaceTimeDB reducers call external webhooks or execute commands.
Reducers must remain deterministic and side-effect safe.

Correct architecture:
1. Message send inserts `conversation_message`.
2. Message send inserts per-recipient `conversation_delivery`.
3. Backend decides whether recipient is wakeable.
4. Backend creates/coalesces a `wake_request`.
5. A separate dispatcher/listener observes `wake_request`.
6. Dispatcher wakes local daemon / webhook / cloud runner / future hosted connector.
7. Agent fetches inbox/history normally through AgentTalk and replies normally.

SpaceTimeDB remains source of truth.
Wake dispatcher performs external side effects.

================================================================================
DOCS / FILES TO INSPECT FIRST
================================================================================

In live-chat:
- docs/agenttalk-open-beta-architecture.md
- docs/agenttalk-open-beta-readiness.md
- docs/agenttalk-cost-model.md
- docs/agenttalk-operator-runbook.md
- docs/agenttalk-mcp-architecture.md
- spacetimedb/src/index.ts
- scripts/agent-client.ts
- scripts/agenttalk.ts
- scripts/agenttalkd.ts
- scripts/load-test-persistent.ts
- scripts/smoke-alpha.ts
- scripts/smoke-backlog.ts
- scripts/smoke-hot-rate-limits.ts
- scripts/smoke-scale-indexes.ts
- packages/agenttalk/src/*

In pistils_chat_cli:
- README.md
- docs/agenttalk-open-beta-architecture.md
- src/agent-client.ts
- src/agenttalk.ts
- src/agenttalkd.ts
- package.json
- scripts/smoke-cli-surface.mjs
- scripts/smoke-daemon-routing.mjs

================================================================================
OBJECTIVE OF THIS PASS
================================================================================

Implement the first production-shaped AgentTalk Wake Layer for the backend and CLI.

This pass should add:
- public wakeability/availability flags
- private wake registration
- wake policies
- wake request queue
- wake coalescing/suppression
- wake status/attempt tracking
- CLI commands to configure and inspect wakeability
- daemon/local listener hooks for wake notifications
- dispatcher-facing views/reducers
- tests and docs

This pass should NOT:
- implement full hosted MCP
- implement ChatGPT/Claude/Gemini connector
- implement Redis Edge Guard
- implement Postgres archive
- make reducers call external services
- put wake dispatcher/operator views into the default `daemon-direct` hot profile
- expose private webhook URLs/secrets publicly
- push full message text in wake payloads by default

================================================================================
ARCHITECTURE PRINCIPLES TO PRESERVE
================================================================================

1. SpaceTimeDB authoritative:
Wake eligibility, wake request records, wake policies, and final state live in SpaceTimeDB.

2. Side effects outside reducers:
External webhook/local-exec/cloud-runner wake delivery happens outside reducers through a dispatcher/listener.

3. Wake payloads are pointers:
Wake payloads should contain conversationId, sequence range, wakeId, reason, etc. Agents then fetch message context normally. Do not push full message text by default.

4. Wake is costlier than delivery:
Wake may trigger model inference. It must have stronger rate limits, coalescing, cooldowns, and suppression.

5. Public/private split:
Public profiles expose “wakeable,” “availability,” “expected latency,” etc. Private registrations store endpoint refs/secrets/policies.

6. Use existing scale primitives:
Reuse `conversation_delivery`, `agent_delivery_counter`, `conversation_participant_index`, receipts, deployment policy, agent-level rate buckets, and operator views where possible.

7. Do not widen hot subscriptions unnecessarily:
Wake-specific dispatcher/operator views should have dedicated profiles, not default daemon-direct.

================================================================================
TASK CATEGORIES
================================================================================

A. Backend public wakeability and availability profile
B. Backend private wake registration and policy
C. Wake request queue, coalescing, and suppression
D. Dispatcher-facing claim/attempt/ack reducers
E. CLI and daemon commands
F. Local wake listener / adapter skeleton
G. Business/service-agent pool support
H. Wake rate limits, safety, and abuse controls
I. Observability, tests, and load/smoke coverage
J. Docs and runbooks
K. Future integration guidance for OpenClaw/Hermes/NemoClaw/MCP

For each task:
- state the problem solved
- explain the rationale
- explain relation to the global agent-network vision
- update tests/docs
- preserve source-of-truth sync between live-chat and pistils_chat_cli

================================================================================
A. BACKEND PUBLIC WAKEABILITY AND AVAILABILITY PROFILE
================================================================================

Task A1 — Add public wakeability fields to agent profile surface.

Problem:
The current profile has online/offline semantics, but that is not enough. An agent can be offline but wakeable through a cloud runner/local daemon, or online but not accepting new work.

Rationale:
Other agents need to know whether messaging this agent is likely to produce a timely response. For business use cases, “wakeable on message” is more important than “currently online.”

Action:
Add public wake/availability fields to the agent profile surface.

Potential fields:
- wakeable: bool
- availability: "online" | "wakeable" | "sleeping" | "offline" | "unavailable"
- acceptsNewConversations: bool
- expectedWakeLatencyMs: u64 optional
- wakeLatencyClass: "instant" | "fast" | "standard" | "slow" optional
- supportedWakeReasonsJson or supportedWakeReasons string
- statusText optional
- updatedAt

Implementation options:
- add columns to `agent_profile`, or
- add a separate `agent_wake_profile` table/view keyed by agentId

Prefer separate `agent_wake_profile` if it avoids client-breaking changes to existing public profile row shapes.

Public view:
- visible_agent_wake_profile
- visible_requested_account_directory may include wake summary only if safe/compatible
- direct search/find output should show wakeable/availability if available

Acceptance criteria:
- agents can discover whether another agent is online/wakeable/unavailable
- no private endpoint/secrets are exposed
- default values are safe:
  - online true if actively connected
  - wakeable false unless configured
  - availability derived from online/wakeable/unavailable
- docs explain semantics

Relation to vision:
Consumers/businesses need service agents to advertise whether they can respond promptly, even when not actively running inference.

-------------------------------------------------------------------------------

Task A2 — Add availability calculation helpers.

Problem:
Availability should be consistent and not hand-coded in many places.

Action:
Implement helpers:
- effectiveAgentAvailability(ctx, agentId)
- agentWakeable(ctx, agentId)
- agentAcceptsNewConversations(ctx, agentId)
- agentExpectedWakeLatency(ctx, agentId)

Logic:
- if disabled/unavailable -> unavailable
- else if active connection online -> online
- else if wake registration enabled -> wakeable or sleeping
- else offline

Acceptance criteria:
- profile view and account search use consistent availability.
- tests cover online, wakeable offline, unavailable, and non-wakeable offline states.

Relation to vision:
Agents need predictable discovery semantics before initiating service conversations.

================================================================================
B. BACKEND PRIVATE WAKE REGISTRATION AND POLICY
================================================================================

Task B1 — Add private wake registration table.

Problem:
Public wakeable flags are not enough. The system needs private registration records that tell a dispatcher how to wake an agent/runner.

Action:
Add table:

agent_wake_registration
  registrationId: string primaryKey
  agentId: string
  ownerIdentity: Identity
  kind: string // webhook | local_daemon | cloud_runner | mcp_session | push_gateway | noop
  endpointRef: string optional // private ref or encrypted endpoint; do not expose publicly
  secretHash: string optional
  enabled: bool
  createdAt: timestamp
  updatedAt: timestamp
  lastSuccessAt?: timestamp
  lastFailureAt?: timestamp
  failureCount: u64
  metadataJson?: string

Indexes:
- agentId
- ownerIdentity
- enabled

Views:
- visible_own_wake_registration
  - current agent sees own registrations
  - operator sees all if needed
- no public endpointRef/secret exposure

Rationale:
Wakeability needs a private, auditable, configurable runner endpoint/handler. This should be separate from the public agent profile.

Acceptance criteria:
- agent can register/disable/list its own wake registrations
- operator can inspect registrations if appropriate
- private endpoint refs/secrets are never exposed through public profile views
- generated bindings updated in both repos/packages

Relation to vision:
Businesses and persistent agents need stable “where to send a wake” configuration without leaking operational secrets.

-------------------------------------------------------------------------------

Task B2 — Add wake policy table.

Problem:
Wake is more expensive than delivery. Agents need fine-grained policy: wake on direct messages, group mentions, business inquiries, handoffs, etc.

Action:
Add table:

agent_wake_policy
  agentId: string primaryKey
  wakeOnDirectMessage: bool
  wakeOnMention: bool
  wakeOnGroupMessage: bool
  wakeOnHandoff: bool
  wakeOnBusinessInquiry: bool
  acceptsNewConversations: bool
  minWakeIntervalMs: u64
  coalesceWindowMs: u64
  maxWakesPerMinute: u64
  maxConcurrentWakeJobs: u64
  expectedWakeLatencyMs?: u64
  availabilityOverride?: string
  statusText?: string
  updatedAt: timestamp
  updatedBy: Identity

Defaults:
- wakeOnDirectMessage true when first wake registration is enabled
- wakeOnGroupMessage false unless configured
- wakeOnMention true
- coalesceWindowMs around 15–60 seconds
- maxWakesPerMinute conservative
- acceptsNewConversations true unless disabled

Reducers:
- set_wake_policy(...)
- reset_wake_policy(...)

Views:
- visible_own_wake_policy
- public wake profile view gets only public fields

Acceptance criteria:
- agent can configure wake policy
- direct message wake policy works
- group/message policy can be conservative
- public profile updates accordingly

Relation to vision:
Not all agents should wake for all events. A business booking agent may wake for direct inquiries; a background analysis agent may only wake on mentions or assigned tasks.

-------------------------------------------------------------------------------

Task B3 — Add deployment wake defaults.

Problem:
Operators need global defaults and brakes for wake behavior.

Action:
Extend deployment policy or add deployment_wake_policy:
- disableWakeDispatch: bool
- defaultWakeCoalesceWindowMs
- defaultMinWakeIntervalMs
- defaultMaxWakesPerMinute
- defaultWakeRequestTtlSeconds
- maxWakeAttempts
- maxWakePayloadBytes
- maintenanceModeMessage

Acceptance criteria:
- operator can disable wake requests globally
- wake creation respects deployment wake policy
- docs include wake emergency brake

Relation to vision:
Wake can trigger inference cost. Operators need kill switches before broad rollout.

================================================================================
C. WAKE REQUEST QUEUE, COALESCING, AND SUPPRESSION
================================================================================

Task C1 — Add wake_request table.

Problem:
Inbound delivery needs to create a durable, observable wake condition that a dispatcher can claim and process.

Action:
Add table:

wake_request
  wakeId: string primaryKey
  wakeKey: string // coalescing key
  recipientAgentId: string
  conversationId: u64
  minSequence: u64
  maxSequence: u64
  reason: string // direct_message | mention | group_message | handoff | business_inquiry | manual
  status: string // pending | leased | dispatched | acked | failed | expired | suppressed
  priority: string // low | normal | high | urgent
  attemptCount: u64
  nextAttemptAt: timestamp
  leaseUntil?: timestamp
  createdAt: timestamp
  updatedAt: timestamp
  expiresAt: timestamp
  suppressedReason?: string
  metadataJson?: string

Indexes:
- recipientAgentId
- status + nextAttemptAt
- recipientAgentId + conversationId
- expiresAt
- wakeKey

Rationale:
Wake requests are queue items. They should be visible, claimable, retryable, suppressible, and auditable.

Acceptance criteria:
- wake_request rows are created for eligible deliveries
- rows are coalesced by agent/conversation/window
- rows expire
- status transitions are explicit
- wake rows are not created when deployment wake is disabled
- wake rows are not created when recipient is not wakeable

Relation to vision:
A global agent network needs an inbox-driven wake queue, not random polling.

-------------------------------------------------------------------------------

Task C2 — Create wake requests from delivery insertion.

Problem:
Messages currently create delivery rows but do not create wake conditions.

Action:
Modify send/delivery path:
- after delivery row insert for recipient, call maybeCreateWakeRequest(...)
- use wake policy and registration state
- if recipient is online and live connected, wake may be skipped or lower priority depending policy
- if recipient is wakeable and not online, create/coalesce wake
- if recipient unavailable or not wakeable, do not wake, just deliver
- for sender-same-agent/multi-identity, do not wake self
- for group messages, wake only when policy allows or mention/handoff reason applies

Helper:
maybeCreateWakeRequest(ctx, {
  recipientAgentId,
  conversationId,
  sequence,
  reason,
  priority,
  senderAgentId,
  metadataJson?
})

Rationale:
Delivery is the natural point to decide whether inbound work should wake the recipient.

Acceptance criteria:
- direct message to wakeable offline agent creates wake_request
- direct message to non-wakeable offline agent does not create wake_request
- direct message to online agent either does not wake or follows configured policy
- group message does not wake by default unless policy/mention
- tests cover all cases

Relation to vision:
A consumer agent messaging a business agent should trigger prompt service response without waiting for a heartbeat.

-------------------------------------------------------------------------------

Task C3 — Wake coalescing.

Problem:
A burst of messages should not create one expensive wake per message.

Action:
Implement coalescing:
- wakeKey could be:
  wake:<recipientAgentId>:<conversationId>:<reason>:<coalesceWindowBucket>
- if a pending/leased wake exists for same key, update maxSequence and updatedAt
- do not create new wake until coalesce window expires
- preserve minSequence for first message in window

Acceptance criteria:
- multiple messages in coalesce window create/update one wake_request
- maxSequence advances
- wake attempt count not reset incorrectly
- tests send several messages quickly and verify one wake row

Relation to vision:
Business agents may receive bursts. Wake coalescing prevents unnecessary model startups.

-------------------------------------------------------------------------------

Task C4 — Wake suppression and cooldown.

Problem:
Wake can be abused or become expensive if repeated failures occur.

Action:
Implement suppression:
- minWakeIntervalMs per recipient agent
- maxWakesPerMinute per recipient agent
- maxConcurrentWakeJobs
- cooldown after repeated failures
- suppression reason recorded on wake_request or wake_attempt
- message delivery still succeeds even when wake is suppressed

Acceptance criteria:
- suppressed wake does not block message delivery
- suppression status/reason is visible to owner/operator
- rate-limit smoke covers wake suppression
- no global hot row for normal wake limiting

Relation to vision:
Wake protects response latency but must not become an unbounded inference-cost vector.

================================================================================
D. DISPATCHER-FACING CLAIM / ATTEMPT / ACK REDUCERS
================================================================================

Task D1 — Add wake_attempt table.

Problem:
Dispatch attempts need audit/retry state separate from the request.

Action:
Add table:

wake_attempt
  attemptId: string primaryKey
  wakeId: string
  registrationId: string optional
  dispatcherIdentity: Identity
  kind: string
  status: string // leased | sent | acked | failed
  error?: string
  leasedAt: timestamp
  sentAt?: timestamp
  ackedAt?: timestamp
  failedAt?: timestamp
  nextAttemptAt?: timestamp

Indexes:
- wakeId
- status
- dispatcherIdentity

Acceptance criteria:
- every dispatch attempt is tracked
- failures are auditable
- attempts do not leak private endpoint details publicly

Relation to vision:
Operators and businesses need visibility into why agents did or did not wake.

-------------------------------------------------------------------------------

Task D2 — Add dispatcher reducers.

Problem:
External dispatcher/listener must safely claim and update wake jobs.

Action:
Add reducers:
- claim_wake_request({ limit?, kind? })
- mark_wake_dispatched({ wakeId, attemptId, registrationId? })
- ack_wake_request({ wakeId, attemptId })
- fail_wake_attempt({ wakeId, attemptId, error, retryAfterMs? })
- suppress_wake_request({ wakeId, reason })
- expire_wake_requests_now({ limit? }) operator/dispatcher

Rules:
- dispatcher must be operator/service identity or explicitly authorized
- claim sets status=leased and leaseUntil
- expired lease can be reclaimed
- ack transitions wake_request to acked
- fail increments attempt count and schedules retry or marks failed
- TTL expiry marks expired

Views:
- visible_pending_wake_request dispatcher/operator only
- visible_own_wake_status owner/recipient only
- optional visible_wake_status_for_sender with coarse status only

Acceptance criteria:
- dispatcher can claim pending wakes
- failed wake retries with backoff
- max attempts enforced
- ack completes request
- expired leases recover
- tests cover claim/fail/retry/ack

Relation to vision:
Wake needs distributed worker semantics without making SpaceTimeDB call external services.

-------------------------------------------------------------------------------

Task D3 — Add wake dispatcher subscription profile.

Problem:
Wake dispatcher needs a different view set than normal daemon-direct.

Action:
Add AgentSubscriptionProfile:
- wake-dispatcher
or
- ops-wake

Subscriptions:
- visible_pending_wake_request
- visible_own_wake_registration if dispatcher needs it
- visible_deployment_policy
- visible_retention_policy
- visible_scale_repair_stat maybe optional
- no broad message views
- no daemon-direct chat-only views unless needed

Acceptance criteria:
- dispatcher profile is separate from daemon-direct
- normal agents do not subscribe to pending wake queue
- docs list profile

Relation to vision:
Wake dispatch is infrastructure, not every agent’s hot path.

================================================================================
E. CLI AND DAEMON COMMANDS
================================================================================

Task E1 — Add CLI wake configuration commands.

Problem:
Agents need to configure wakeability and inspect their wake state from the CLI.

Action:
Add commands:

agenttalk wake status --json
agenttalk wake enable --kind webhook|local_daemon|cloud_runner|noop [options] --json
agenttalk wake disable [registrationId] --json
agenttalk wake policy set [flags] --json
agenttalk wake policy get --json
agenttalk wake registrations --json
agenttalk wake requests --json
agenttalk wake ack <wakeId> --json

Flags:
- --wake-on-direct-message true|false
- --wake-on-mention true|false
- --wake-on-group-message true|false
- --accepts-new-conversations true|false
- --expected-latency-ms
- --coalesce-window-ms
- --min-interval-ms
- --max-wakes-per-minute
- --status-text
- --endpoint-ref for private registration
- --secret for webhook signature setup, hashed/stored appropriately

Rationale:
Wakeability must be self-service for agent owners/businesses.

Acceptance criteria:
- commands route through daemon where appropriate
- JSON outputs are stable and agent-friendly
- private endpoint values are redacted in output
- docs include examples

Relation to vision:
Businesses can publish “wakeable livechat agent” profiles without custom backend work.

-------------------------------------------------------------------------------

Task E2 — Add daemon wake commands.

Problem:
The daemon is the local persistent gateway and should expose wake operations to CLI/future MCP.

Action:
Add daemon JSON commands:
- wake_status
- wake_register
- wake_disable
- wake_policy_get
- wake_policy_set
- wake_requests
- wake_ack
- wake_listen_once
- wake_listen

Response envelope should match existing daemon responses.

Acceptance criteria:
- CLI uses daemon for wake commands
- `agenttalk run --jsonl` can call wake commands
- future MCP can map tools onto daemon commands

Relation to vision:
Wake commands should be part of the same structured substrate future MCP will wrap.

-------------------------------------------------------------------------------

Task E3 — Add machine-friendly wake outputs.

Problem:
Agents need clear next steps after configuring wake or receiving wake events.

Action:
JSON outputs should include:
- ok
- wakeable
- availability
- registrationId
- wakePolicy
- wakeRequests
- wakeId
- conversationId
- minSequence/maxSequence
- nextActions
- hotRetentionHours
- redacted private fields

Acceptance criteria:
- no scraping human strings
- examples in README/docs

Relation to vision:
Autonomous agents need reliable machine-readable state transitions.

================================================================================
F. LOCAL WAKE LISTENER / ADAPTER SKELETON
================================================================================

Task F1 — Add local wake listener command.

Problem:
For local persistent agents, something must remain running to receive wake events and start the agent process. The agent process itself may not be running.

Action:
Add:

agenttalk wake listen --jsonl
agenttalk wake listen --exec "<command>" --jsonl
agenttalk wake listen --once --json

Behavior:
- subscribes/long-polls own wake requests
- when wake arrives, emits JSONL event
- if --exec provided, runs command with env vars:
  AGENTTALK_WAKE_ID
  AGENTTALK_CONVERSATION_ID
  AGENTTALK_MIN_SEQUENCE
  AGENTTALK_MAX_SEQUENCE
  AGENTTALK_REASON
  AGENTTALK_STATE_DIR
  AGENTTALK_HOST
  AGENTTALK_DB
- command output is not sent to other agents automatically
- agent must fetch context and reply through AgentTalk

Acceptance criteria:
- local daemon can wake a local agent runner process
- wake is acked only when configured/after command starts or completes, depending mode
- failures mark wake attempt failed
- tests cover --once and JSONL output
- docs explain that a listener/supervisor must be running for local wake

Relation to vision:
OpenClaw/NemoClaw/Hermes-style local agents need a simple way to be woken by inbound AgentTalk messages.

-------------------------------------------------------------------------------

Task F2 — Add local noop registration.

Problem:
Developers need to test wake without webhooks or external services.

Action:
Support registration kind `noop` or `local_daemon`.
- noop creates wake requests and lets listener consume them
- no external dispatch
- useful for tests

Acceptance criteria:
- smoke can register noop/local wake
- send message creates wake
- listener receives wake
- ack clears wake

Relation to vision:
A reference local flow makes integrations easier before building cloud/webhook dispatch.

-------------------------------------------------------------------------------

Task F3 — Add wake adapter SDK surface in package exports.

Problem:
External agent repos should not each invent wake semantics.

Action:
Expose a tiny helper API in the published package:

import { AgentTalkWakeClient } from "pistils-chat-cli/client" or "./wake"

Possible methods:
- connectWake(...)
- registerWakeHandler(...)
- fetchWakeContext(wake)
- ackWake(wakeId)
- failWake(wakeId, error)
- replyToWake(...)

Keep it minimal.

Acceptance criteria:
- TypeScript build passes
- docs show OpenClaw-style usage
- no MCP implementation required

Relation to vision:
Once AgentTalk has a stable adapter, PRs to OpenClaw/Hermes/NemoClaw become simple and consistent.

================================================================================
G. BUSINESS / SERVICE-AGENT POOL SUPPORT
================================================================================

Task G1 — Add service/pool concept if minimal and practical.

Problem:
A business may have 10 persistent agents, only 2 assigned to live chat. Consumers should not need to pick a specific worker. They should message a service profile like `@acme-livechat`.

Action:
Add minimal pool support if feasible in this pass.

Tables:
agent_pool
  poolId: string primaryKey
  handle: string
  displayName: string
  ownerIdentity: Identity
  wakeable: bool
  acceptsNewConversations: bool
  routingPolicy: string // first_available | round_robin | least_unread | manual
  createdAt
  updatedAt

agent_pool_member
  key: string primaryKey // poolId:agentId
  poolId
  agentId
  enabled
  priority
  maxConcurrentConversations
  joinedAt
  updatedAt

Views:
- public_agent_pool_directory or visible_requested_agent_pool_directory
- visible_own_agent_pools
- visible_agent_pool_wake_profile

Reducers:
- create_agent_pool
- add_agent_pool_member
- remove_agent_pool_member
- set_agent_pool_policy
- set_agent_pool_member_enabled

If this is too large, document as future and implement only public wake profile fields for individual agents now.

Rationale:
For business live chat, service identity/pool routing is the right model. It decouples consumer agents from individual worker agents.

Acceptance criteria if implemented:
- consumer can discover pool wakeability
- pool can mark wakeable/accepting
- wake request can target pool or assigned member
- no large group/channel semantics added
- tests cover minimal pool creation and member listing

Relation to vision:
Business agents need reliable service endpoints, not random per-worker identity selection.

-------------------------------------------------------------------------------

Task G2 — Wake assignment for pools.

Problem:
If a wake targets a pool, one worker should claim/handle it.

Action if pool support is implemented:
Add wake_assignment:
  assignmentId
  wakeId
  poolId
  assignedAgentId
  status
  claimedAt
  completedAt?

Reducers:
- claim_pool_wake
- complete_pool_wake
- reassign_pool_wake

Keep simple for now.

Acceptance criteria:
- one pool member can claim wake
- duplicate claims prevented
- wake remains observable

Relation to vision:
A business livechat service needs queue/claim semantics for worker agents.

================================================================================
H. WAKE RATE LIMITS, SAFETY, AND ABUSE CONTROLS
================================================================================

Task H1 — Add wake-specific rate limits.

Problem:
Wake may trigger inference and external compute. It needs limits separate from message sends.

Action:
Use agent-level SpaceTimeDB buckets:
- wake:create:<recipientAgentId> or subject-specific helper
- wake:sender:<senderAgentId>
- wake:dispatch:<registrationId or recipientAgentId>
- wake:manual

Avoid global hot rows.

Policy:
- per-sender wake rate
- per-recipient wake rate
- per-conversation coalesce cooldown
- max pending wake requests per recipient
- max attempts per wake

Acceptance criteria:
- message delivery can succeed while wake is suppressed
- wake suppression reason is recorded
- tests cover sender and recipient wake limits

Relation to vision:
Wake must improve latency without becoming a cost-amplification attack.

-------------------------------------------------------------------------------

Task H2 — Secure wake payloads.

Problem:
Webhook/cloud wakes must be signed and replay-resistant. Private endpoint data must not leak.

Action:
For registrations with secrets:
- store secret hash, not raw secret, if possible
- dispatcher signs payload with secret or uses registered secret securely
- include wakeId and timestamp
- include expiry
- include version
- do not include full message text by default

Payload shape:
{
  type: "agenttalk.wake",
  version: "1",
  wakeId,
  recipientAgentId,
  conversationId,
  minSequence,
  maxSequence,
  reason,
  createdAt,
  expiresAt,
  signature
}

Acceptance criteria:
- docs define payload
- CLI redacts private fields
- dispatcher skeleton can produce payload shape
- tests cover signature helper if implemented

Relation to vision:
Persistent agents have powerful access. Wake conditions must be trusted and scoped.

-------------------------------------------------------------------------------

Task H3 — Add blocked/allowed wake sender controls if lightweight.

Problem:
Some agents/businesses may not want to be woken by every sender.

Action:
Add optional policy fields or tables:
- allowedWakeSenderAgentIdsJson
- blockedWakeSenderAgentIdsJson
or tables:
agent_wake_allow
agent_wake_block

Keep this lightweight. Do not overbuild full ACLs unless needed.

Acceptance criteria:
- blocked sender delivery still succeeds but wake is suppressed
- allowed-list mode can restrict wakes
- docs explain optional use

Relation to vision:
Business/service agents need abuse control without shutting down message delivery entirely.

================================================================================
I. OBSERVABILITY, TESTS, AND LOAD/SMOKE COVERAGE
================================================================================

Task I1 — Add wake smoke test.

Action:
Create script:
scripts/smoke-wake.ts

Test cases:
1. create sender and recipient
2. recipient registers noop/local wake
3. recipient sets wakeOnDirectMessage true
4. recipient disconnects or simulates offline
5. sender sends direct message
6. wake_request created
7. listener/dispatcher claims wake
8. ack wake
9. verify wake status acked
10. verify message still available through inbox/history

Acceptance criteria:
- npm script added: agenttalk:smoke-wake
- passes locally
- docs/readiness updated

Relation to vision:
This is the first proof that inbound messages can wake an agent instead of waiting for heartbeat.

-------------------------------------------------------------------------------

Task I2 — Add wake coalescing smoke.

Action:
Test:
- send 5 messages quickly to same wakeable agent/conversation
- verify 1 wake_request created/updated
- maxSequence equals last message sequence
- minSequence equals first message sequence
- after coalesce window expires, new wake creates new request

Acceptance criteria:
- coalescing works
- no extra wake spam

Relation to vision:
High fan-in business use cases need coalesced wake costs.

-------------------------------------------------------------------------------

Task I3 — Add wake suppression/rate-limit smoke.

Action:
Test:
- set maxWakesPerMinute low
- send enough messages to exceed it
- delivery succeeds
- wake requests beyond limit suppressed
- suppression reason visible to recipient/operator

Acceptance criteria:
- suppression does not block chat
- suppression recorded

Relation to vision:
Wake cannot become a denial-of-wallet vector.

-------------------------------------------------------------------------------

Task I4 — Add wake visibility to load harness optionally.

Action:
Extend load harness with flags:
- --wakeable-recipients
- --wake-ratio
- --wake-coalesce-window-ms
- --recipient-mode single
- --measure-wake-latency

Do not require this for normal load tests.

Metrics:
- wakeRequestsCreated
- wakeRequestsCoalesced
- wakeRequestsSuppressed
- wakeClaimLatencyMs
- wakeAckLatencyMs

Acceptance criteria:
- load harness can simulate wake pressure
- wake metrics appear when enabled

Relation to vision:
Before scaling to businesses, wake cost/latency must be measurable.

================================================================================
J. DOCS AND RUNBOOKS
================================================================================

Task J1 — Add AgentTalk Wake Protocol doc.

Create:
docs/agenttalk-wake-protocol.md

Include:
- conceptual model
- heartbeat vs wake
- public wakeability fields
- private wake registration
- wake policies
- wake request state machine
- dispatcher architecture
- local daemon/listener architecture
- webhook payload
- security considerations
- rate limits/coalescing
- business pool model
- future MCP/connector implications

Acceptance criteria:
- doc is enough for a future agent repo integration PR
- clearly states what is implemented vs future

Relation to vision:
External agents need a stable protocol, not ad hoc wake hacks.

-------------------------------------------------------------------------------

Task J2 — Update open-beta architecture/readiness docs.

Action:
Update:
- docs/agenttalk-open-beta-architecture.md
- docs/agenttalk-open-beta-readiness.md
- docs/agenttalk-cost-model.md
- docs/agenttalk-operator-runbook.md
- pistils README/docs

Add:
- wake is new beta/experimental primitive
- wake dispatcher/listener is required for non-heartbeat activation
- wake does not guarantee response, but creates a request/notification
- local agents need a running daemon/listener/supervisor
- hosted connectors need hosted runner/session backend
- ChatGPT/Claude/Gemini UI sessions cannot be assumed wakeable unless a hosted connector/runner exists

Acceptance criteria:
- docs are clear and honest
- no claim that wake magically starts absent machines/processes
- cost model includes wake request/dispatch unit cost

Relation to vision:
Wake is central to global agent service, but expectations must be precise.

-------------------------------------------------------------------------------

Task J3 — Update operator runbook.

Action:
Add wake operations:
- enable/disable global wake
- inspect pending wakes
- inspect failed wakes
- run wake dispatcher
- recover expired leases
- tune wake limits
- diagnose business agent not waking
- safe webhook secret rotation
- wake smoke tests

Acceptance criteria:
- operator can diagnose wake failures without chat history

Relation to vision:
A real business-facing agent network needs operational wake support.

================================================================================
K. FUTURE INTEGRATION GUIDANCE
================================================================================

Task K1 — Draft integration guide for OpenClaw/Hermes/NemoClaw-style agents.

Action:
Add docs section:
“How to make your agent wakeable.”

Include:
- install package
- register wake handler
- run `agenttalk wake listen --exec`
- fetch wake context
- ack/fail wake
- reply through AgentTalk
- security warnings
- durable memory recommendation

Example pseudo-code:
registerAgentTalkWakeHandler({
  onWake: async wake => {
    const context = await agenttalk.fetchWakeContext(wake)
    const response = await agent.run({ trigger: "agenttalk.wake", context })
    await agenttalk.reply(wake.conversationId, response)
    await agenttalk.ackWake(wake.wakeId)
  }
})

Acceptance criteria:
- guide is practical enough for future PRs
- no repo-specific PRs required in this pass

Relation to vision:
External persistent agents become wakeable through one shared protocol.

-------------------------------------------------------------------------------

Task K2 — MCP/hosted connector guidance.

Problem:
ChatGPT/Claude/Gemini web UI sessions may not be directly wakeable if the user session is closed. Wakeability requires a hosted runner/connector backend.

Action:
Update MCP doc:
- local MCP can wrap daemon/listener
- hosted MCP connector can receive wake through server backend
- browser/UI-only sessions should be treated as not reliably wakeable
- wake payload should trigger hosted runner or queue notification

Acceptance criteria:
- docs avoid misleading claims
- future connector work has correct architecture

Relation to vision:
Hosted assistants need wake semantics, but platform constraints matter.

================================================================================
PRIORITY ORDER
================================================================================

P0 — Core wake backend and CLI foundation:
1. A1 public wakeability fields/view
2. A2 availability helpers
3. B1 private wake registration
4. B2 wake policy
5. C1 wake_request table
6. C2 create wake requests from delivery insertion
7. C3 coalescing
8. D1 wake_attempt table
9. D2 claim/dispatch/ack/fail reducers
10. E1 CLI wake commands
11. E2 daemon wake commands
12. I1 basic wake smoke

P1 — Cost/safety and local activation:
13. C4 suppression/cooldown
14. H1 wake-specific rate limits
15. F1 local wake listen / --exec
16. F2 noop/local test registration
17. I2 coalescing smoke
18. I3 suppression/rate-limit smoke
19. J1 wake protocol doc
20. J2 docs/readiness updates

P2 — Business/service and integrations:
21. G1 minimal service/pool model, if feasible
22. G2 pool wake assignment, if G1 implemented
23. F3 wake adapter SDK surface
24. H2 signed wake payload helpers/docs
25. H3 optional sender allow/block controls
26. I4 wake load harness support
27. J3 operator runbook wake section
28. K1 external agent integration guide
29. K2 MCP/hosted connector guidance

================================================================================
EXPECTED FINAL OUTPUT
================================================================================

At the end of the Codex session, produce:

1. Summary of implemented wake architecture.
2. Files changed.
3. Backend tables/reducers/views added.
4. CLI/daemon commands added.
5. How wake creation integrates with delivery rows.
6. How wakeability appears in public profile/search.
7. How private endpoint data is protected.
8. How local wake listen works.
9. Tests run and exact results.
10. Docs updated.
11. What remains future:
   - full dispatcher service
   - hosted MCP connector
   - business pool routing if not implemented
   - external agent repo PRs

Readiness language:
- “Wake alpha ready” if direct message to wakeable offline agent creates/coalesces wake_request, listener/dispatcher can claim/ack, and CLI can configure wakeability.
- “Wake beta ready” only if suppression, retries, attempts, local listener, docs, and smoke/load tests pass.
- Do not claim ChatGPT/Claude/Gemini UI wakeability unless a hosted runner/connector backend exists.

================================================================================
TESTING EXPECTATIONS
================================================================================

Build/package:
- npm run build in live-chat
- npm run agenttalk:pkg:build
- npm run agenttalk:pkg:check
- npm run build in pistils_chat_cli
- npm run check in pistils_chat_cli
- npm run agenttalk:sync:check if sibling repo available

Backend:
- spacetime build --module-path spacetimedb --debug
- npm run spacetime:generate
- local publish if available

Existing smoke:
- npm run agenttalk:smoke-alpha -- --profile daemon-direct --json
- npm run agenttalk:smoke-backlog -- --messages 260 --page-size 100 --profile daemon-direct --json
- npm run agenttalk:smoke-hot-rate-limits -- --profile daemon-direct --json
- npm run agenttalk:smoke-scale-indexes -- --profile daemon-direct --json
- npm run agenttalk:smoke-deployment-policy -- --profile daemon-direct --json
- npm run smoke:daemon-routing in pistils_chat_cli
- npm run smoke:cli-surface in pistils_chat_cli

New wake smoke:
- npm run agenttalk:smoke-wake -- --profile daemon-direct --json
- npm run agenttalk:smoke-wake-coalesce -- --profile daemon-direct --json
- npm run agenttalk:smoke-wake-rate-limit -- --profile daemon-direct --json

Optional load:
- npm run agenttalk:load -- --scale-profile high-fanin --wakeable-recipients --wake-ratio 1 --json