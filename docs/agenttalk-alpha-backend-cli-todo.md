# AgentTalk Alpha Backend + CLI Readiness TODO

Last updated by agent: 2026-05-19, current phase: Phase 16 / hardening fixes.

**Working title:** Bring AgentTalk / Pistils Chat CLI + SpaceTimeDB backend to alpha/private-beta readiness before MCP implementation.

**Primary repos:**

```text
con-urr/live-chat
con-urr/pistils_chat_cli
```

**Primary goal:** prepare the backend, generated client, CLI, and daemon foundation so an MCP server can later be built on top of a stable realtime substrate.

**Important non-goal:** do **not** implement the MCP server in this phase.

**Important removed scope:** do **not** build archival sidecar, Neon/Postgres archive integration, archive worker, or archive lookup APIs in this phase. Hot retention is intentionally short. Future archival can be designed later.

---

## How the coding agent should use this file

This file is intended to survive context compaction. Treat it as the project memory and implementation control sheet.

At the start of each work session:

1. Re-open this file.
2. Re-read the **Project North Star**, **Non-goals**, **Target architecture**, and **Current phase** sections.
3. Check which TODOs are marked complete.
4. Continue from the highest-priority incomplete item.

After each meaningful implementation chunk:

1. Mark completed TODOs with `[x]`.
2. Mark in-progress TODOs with `[~]` only if they are partially complete and require follow-up.
3. Add a short note under **Work log / implementation notes** describing what changed, which files changed, and what remains.
4. If a TODO changes because of discovered repo constraints, update this file rather than relying on chat history.

Before compacting context or ending a session:

1. Update this file.
2. Add unresolved questions under **Open questions / follow-ups**.
3. Add test status under **Validation status**.
4. Ensure the next agent can resume by reading this file alone.

Status legend:

```text
[ ] not started
[~] in progress / partial
[x] complete
[!] blocked or needs decision
```

---

## Project North Star

AgentTalk is a realtime-feeling, text-only coordination service for agents. Agents should be able to communicate in 1-on-1 conversations and limited-size group conversations. The backend should support many persistent clients with low-latency message delivery.

The current proof-of-concept is good, but it is not yet shaped for alpha/private-beta scale because normal CLI commands reconnect/resubscribe too often, direct conversations are canonicalized client-side, message/unread views are too broad, hot retention is not bounded enough, and the system does not yet have a daemon layer that future MCP tooling can wrap.

This phase should move the system from proof-of-concept to alpha/private-beta substrate:

```text
agenttalk CLI
   |
   | local IPC / stdio JSON
   v
agenttalkd
   |
   | one persistent narrow SpaceTimeDB connection per local agent identity
   v
SpaceTimeDB backend
   - immutable agentId layer
   - canonical direct conversations
   - minimal send reducers
   - per-recipient delivery rows
   - idempotent receipts
   - narrow subscriptions
   - short hot retention, default around 12 hours
```

MCP should later become a protocol adapter over this substrate, not a separate realtime system.

---

## Product assumptions for this phase

- Text-only communication.
- Message length should be byte-capped, not merely JavaScript string-length capped.
- Hot realtime message retention should default to approximately **12 hours**.
- Agents must be told that realtime chat history is ephemeral.
- Durable knowledge should be saved by agents into their own memory/task/context files, not assumed to live forever in the hot chat store.
- Older-message archival is out of scope for this phase.
- Group chats are limited-size and gated by entitlement/account tier.
- The SpaceTimeDB backend remains the realtime source of truth.
- The CLI and future MCP should use persistent connections wherever possible.

---

## Non-goals for this phase

- [ ] Do not implement MCP server.
- [ ] Do not build hosted ChatGPT/Claude/Gemini connector.
- [ ] Do not build archive worker.
- [ ] Do not build Neon/Postgres archive integration.
- [ ] Do not build permanent transcript search.
- [ ] Do not build Kubernetes/cloud deployment automation.
- [ ] Do not build billing.
- [ ] Do not replace SpaceTimeDB with another realtime backend.
- [ ] Do not create a production HTTP API facade that reconnects to SpaceTimeDB per request.
- [ ] Do not expand group chat without hard server-side member caps.

Leave the checkboxes above unchecked intentionally; they are guardrails, not work items.

---

## Current high-level problems to solve

### Problem A: One-shot CLI is not the realtime/high-throughput path

Current normal CLI commands connect to SpaceTimeDB, subscribe, perform one action, and disconnect. That is fine for demos, but it is not the path for many agents sending messages continuously.

**Fix:** build a daemon foundation, `agenttalkd`, and make CLI commands able to use it.

**Why this helps:** the daemon owns one persistent SpaceTimeDB connection and exposes local command handling. This removes reconnect/resubscribe overhead from the hot path and creates the substrate that MCP can wrap later.

---

### Problem B: Direct conversations are reused client-side and can duplicate

Current direct conversation reuse is found by scanning visible conversations/members on the client. This is expensive and racy. Two clients can create duplicate direct conversations for the same pair.

**Fix:** add server-side canonical direct conversation indexing.

**Why this helps:** one direct pair always maps to one conversation. Future `send_direct_message` and MCP tools become deterministic.

---

### Problem C: Handles are treated too much like durable identity

Friendly handles should be mutable. Conversations, deliveries, entitlements, and future integrations need immutable IDs.

**Fix:** introduce a canonical immutable `agentId` while preserving compatibility with existing account/handle flows.

**Why this helps:** handle changes do not break conversation routing, entitlements, delivery rows, or future auth/session mapping.

---

### Problem D: Unread/message views are too broad for scale

Current unread/message views can walk conversations and messages for the caller. This is not the shape for thousands of messages/sec.

**Fix:** add per-recipient delivery/inbox rows and subscribe to those instead.

**Why this helps:** realtime receive becomes a narrow per-recipient event path rather than broad unread recomputation.

---

### Problem E: Idempotency exists but needs useful receipts

`clientRequestId` and request logging exist, but clients need stable receipts to recover from retries/reconnects without guessing or sleeping.

**Fix:** add sender-visible client request receipts.

**Why this helps:** retries become safe, duplicate sends are avoided, and clients can recover `conversationId`, `messageId`, and `sequence`.

---

### Problem F: Hot retention must be explicit and enforced

The service is a realtime coordination channel, not permanent memory.

**Fix:** enforce short hot retention, default around 12 hours, and document this clearly.

**Why this helps:** hot SpaceTimeDB tables stay bounded and the product expectation matches agent workflows.

---

### Problem G: Presence is inaccurate with multiple active connections

If the same identity has more than one connection, one disconnect can incorrectly mark the account offline.

**Fix:** add active connection tracking and only mark offline when the last connection closes.

**Why this helps:** daemon, CLI, and future hosted sessions can coexist without lying about presence.

---

### Problem H: Group chat fanout needs hard caps

Group messages multiply delivery rows by group size. Without strict caps, a small number of sends can create large fanout.

**Fix:** enforce group size limits by entitlement/account type.

**Why this helps:** private-beta load remains predictable.

---

## Target architecture after this phase

```text
agenttalk CLI
   |
   | local IPC / stdio JSON
   v
agenttalkd
   - persistent SpaceTimeDB connection
   - narrow subscription profile
   - route cache
   - direct conversation cache
   - inbox/delivery cache
   - receipt-based send acknowledgements
   - finite listen/history commands
   |
   v
SpaceTimeDB backend
   - agent_profile / agent_identity
   - direct_conversation_index
   - conversation_message
   - conversation_delivery
   - client_request_receipt
   - conversation_read_cursor
   - retention cleanup
```

---

## Suggested implementation order

Work in this order unless codebase constraints force a small adjustment:

1. **Repo inspection and consolidation plan.** Identify duplicated generated/client/CLI code between repos.
2. **Backend schema additions.** Add agent IDs, direct conversation index, delivery rows, receipts, active connections, retention policy/job tables.
3. **Backend helper functions.** Add identity resolution, byte validation, delivery insertion, receipt handling, canonical direct conversation helpers.
4. **Backend reducers.** Add/refactor direct open/send reducers and message send reducer.
5. **Backend views.** Add narrow views for direct index, inbox delivery, receipts, and retention policy.
6. **Retention cleanup.** Add scheduled or operator-triggered cleanup for expired hot data.
7. **Regenerate bindings.** Update generated SpaceTimeDB bindings in both repos as needed.
8. **Client subscription profiles.** Add `direct-lite` / `daemon-direct` and avoid broad hot-path subscriptions.
9. **Client methods.** Add methods for new reducers/views and receipt-based waits.
10. **CLI hot-path changes.** Use canonical direct conversations, delivery inbox, and receipts.
11. **Daemon foundation.** Add `agenttalkd` / `agenttalk daemon run` with local command handling.
12. **Persistent load test.** Add persistent-client load harness.
13. **Docs and smoke tests.** Update docs, README, and tests.

---

# Phase 0 — Repo inspection and working plan

## TODO

- [x] Inspect both repos and list overlapping files.
  - Likely areas: `src/agent-client.ts`, `src/agenttalk.ts`, generated `module_bindings`, `packages/agenttalk`, and scripts.
- [x] Decide whether `live-chat/packages/agenttalk` or `pistils_chat_cli/src` is the source of truth for shared client/CLI code.
- [x] If code must remain duplicated for now, document exactly which files must be updated in both repos.
- [x] Add this TODO file to the repo, preferably:

```text
docs/agenttalk-alpha-backend-cli-todo.md
```

- [x] Add a short comment near the top of the file after committing it:

```text
Last updated by agent: <date/time>, current phase: <phase number>
```

## Acceptance criteria

- [x] A future coding agent can read this file and know what to do next.
- [x] The repo has one persistent project checklist file that agents update as they work.

---

# Phase 1 — Backend schema: immutable agent identity

## Goal

Add immutable product-level `agentId` support while preserving existing handle/account behavior.

## TODO

- [x] Add `agent_profile` table or equivalent.

Suggested shape:

```ts
agent_profile
  agentId: string primaryKey
  handle: string
  displayName: string
  role: string
  bio?: string
  online: bool
  createdAt: timestamp
  updatedAt: timestamp
  lastSeen: timestamp
```

- [x] Add indexes for:

```text
handle
role
online
```

- [x] Add `agent_identity` table or equivalent.

Suggested shape:

```ts
agent_identity
  identity: Identity primaryKey
  agentId: string
  deviceLabel?: string
  status: string // active | revoked
  createdAt: timestamp
  lastSeen: timestamp
  revokedAt?: timestamp
```

- [x] Add helper functions:

```ts
agentIdForIdentity(ctx, identity)
agentForIdentity(ctx, identity)
agentForHandle(ctx, handle)
requireActiveAgent(ctx)
ensureAgentProfileForAccount(ctx, accountRow)
```

- [x] Update account creation/profile reducers so each account has a stable `agentId`.
- [x] Preserve existing `account` table behavior for old CLI flows.
- [x] Update entitlement logic to either:
  - [ ] migrate entitlements to `agentId`, or
  - [x] store `agentId` alongside existing handle-keyed entitlements.
- [x] Add view:

```ts
visible_agent_profile
```

- [x] Ensure current identity can see its own agent profile.
- [x] Ensure account directory results include enough information for the CLI to resolve handle -> agentId -> identity.

## Why this matters

Handles are friendly names and may change. Conversations, delivery rows, entitlements, receipts, and future MCP identities need immutable IDs.

## Acceptance criteria

- [x] Creating an account creates or links an immutable `agentId`.
- [x] Existing CLI account creation still works.
- [x] An identity can resolve its own `agentId`.
- [x] A handle can be resolved to an `agentId`.
- [x] Existing account search still works.

---

# Phase 2 — Backend schema: canonical direct conversations

## Goal

Ensure one direct pair maps to one direct conversation server-side.

## TODO

- [x] Add `direct_conversation_index` table.

Suggested shape:

```ts
direct_conversation_index
  pairKey: string primaryKey
  leftAgentId: string
  rightAgentId: string
  conversationId: u64
  createdAt: timestamp
```

- [x] Add indexes:

```text
leftAgentId
rightAgentId
conversationId
```

- [x] Add helper:

```ts
canonicalDirectPairKey(agentIdA, agentIdB)
```

Format:

```text
direct:<min(agentIdA, agentIdB)>:<max(agentIdA, agentIdB)>
```

- [x] Add reducer:

```ts
open_direct_conversation({
  targetAgentId?: string,
  targetIdentity?: Identity,
  title?: string,
  clientRequestId?: string
})
```

- [x] Reducer behavior:
  - [x] Resolve sender `agentId`.
  - [x] Resolve target `agentId` from `targetAgentId` or `targetIdentity`.
  - [x] Compute canonical `pairKey`.
  - [x] If direct index exists, return/re-expose existing `conversationId` through receipt/view.
  - [x] If missing, create `conversation`, two `conversation_member` rows, and `direct_conversation_index` atomically.
  - [x] Write a client request receipt with `conversationId`.

- [x] Add view:

```ts
visible_direct_conversation
```

- [x] View behavior:
  - [x] Only exposes rows where caller's `agentId` is `leftAgentId` or `rightAgentId`.

- [x] Update old `create_direct_conversation` to either call the new helper or clearly mark it legacy.

## Why this matters

Client-side scanning for reusable direct conversations is expensive and racy. Canonical server-side direct conversations avoid duplicates and make the future direct-message hot path deterministic.

## Acceptance criteria

- [x] Calling `open_direct_conversation` twice for the same pair returns/reveals the same `conversationId`.
- [x] Calling it concurrently should not create duplicate direct conversations.
- [x] `visible_direct_conversation` only shows direct pairs involving the caller.
- [x] Existing direct chat behavior still works.

---

# Phase 3 — Backend schema: per-recipient delivery/inbox rows

## Goal

Replace broad unread recomputation with narrow per-recipient delivery rows.

## TODO

- [x] Add `conversation_delivery` table.

Suggested shape:

```ts
conversation_delivery
  key: string primaryKey // recipientAgentId:conversationId:sequence
  recipientAgentId: string
  recipientIdentity?: Identity
  conversationId: u64
  messageId: u64
  sequence: u64
  senderAgentId: string
  senderIdentity: Identity
  state: string // unread | delivered | read
  sent: timestamp
  updatedAt: timestamp
  expiresAt: timestamp
```

- [x] Add indexes:

```text
recipientAgentId
recipientAgentId + state
recipientAgentId + conversationId
conversationId + sequence
expiresAt
```

- [x] Add helper:

```ts
deliveryKey(recipientAgentId, conversationId, sequence)
insertConversationDeliveryRows(ctx, conversationId, messageId, sequence, senderAgentId, senderIdentity)
```

- [x] Insert one delivery row for each recipient except sender.
- [x] Add view:

```ts
visible_inbox_delivery
```

- [x] View behavior:
  - [x] Resolve caller `agentId`.
  - [x] Return only caller delivery rows.
  - [x] Cap results to a small fixed number, e.g. 100-500.
  - [x] Prefer unread/delivered states first.

- [x] Modify `mark_conversation_read` to update delivery rows to `read` up to the chosen sequence.
- [x] Preserve `conversation_read_cursor` as the durable cursor.
- [x] Change `visible_unread_conversation_message` to derive from delivery rows, or mark it legacy and remove it from default subscription profiles.

## Why this matters

The receive path should be a tiny per-recipient notification stream. Clients can fetch conversation messages by cursor only when needed.

## Acceptance criteria

- [x] Sending a direct message creates one recipient delivery row.
- [x] Sending a group message creates one delivery row per non-sender recipient.
- [x] The recipient sees the delivery row through `visible_inbox_delivery`.
- [x] The sender does not receive a delivery row for their own message.
- [x] Marking read updates delivery state and read cursor.
- [x] Default clients no longer need broad unread-message scans.

---

# Phase 4 — Backend schema: client request receipts

## Goal

Make retries and reconnects safe and observable.

## TODO

- [x] Add `client_request_receipt` table.

Suggested shape:

```ts
client_request_receipt
  key: string primaryKey // senderAgentId:action:clientRequestId
  senderAgentId: string
  senderIdentity: Identity
  action: string
  clientRequestId: string
  status: string // ok | duplicate | error
  conversationId?: u64
  messageId?: u64
  sequence?: u64
  error?: string
  createdAt: timestamp
  expiresAt: timestamp
```

- [x] Add indexes:

```text
senderAgentId
senderIdentity
clientRequestId
expiresAt
```

- [x] Add helper functions:

```ts
clientReceiptKey(senderAgentId, action, clientRequestId)
findClientReceipt(ctx, action, clientRequestId)
writeClientReceipt(ctx, { action, clientRequestId, status, conversationId, messageId, sequence, error })
```

- [x] Refactor `recordRequest` flow so duplicate `clientRequestId` does not create duplicate work but still lets the client recover the previous receipt.
- [x] Add view:

```ts
visible_client_request_receipt
```

- [x] View behavior:
  - [x] Only expose receipts for the caller's `agentId` or identity.
  - [x] Cap to recent rows.

## Why this matters

Agents will retry after timeouts. The backend must dedupe writes and provide enough ack information for clients to recover without scanning.

## Acceptance criteria

- [x] Duplicate `clientRequestId` does not create a duplicate message.
- [x] Duplicate request can still recover `conversationId`, `messageId`, and `sequence` from receipt.
- [x] Receipts expire according to retention policy.

---

# Phase 5 — Backend reducers: send/open hot path

## Goal

Refactor message sending around canonical conversations, delivery rows, and receipts.

## TODO

- [x] Add byte-length validation helper:

```ts
assertTextBytes(text, maxBytes)
```

- [x] Add default max message bytes:

```text
free/default: 1024–2048 bytes
pro/operator: configurable, perhaps 4096–8192 bytes
```

- [x] Refactor `send_conversation_message` to follow this order:

```text
1. requireActiveAgent
2. ensureConversationMembership
3. validate text byte length
4. check idempotency/receipt
5. enforce rate/quota
6. increment conversation sequence
7. insert conversation_message with expiresAt
8. insert conversation_delivery rows for recipients
9. mark sender read cursor
10. update conversation lastActivity / summary
11. write client request receipt
```

- [x] Add reducer:

```ts
send_direct_message({
  targetAgentId?: string,
  targetIdentity?: Identity,
  text: string,
  kind?: string,
  replyToMessageId?: u64,
  correlationId?: string,
  metadataJson?: string,
  clientRequestId?: string
})
```

- [x] `send_direct_message` behavior:
  - [x] Open/reuse canonical direct conversation.
  - [x] Send message through shared send helper.
  - [x] Write receipt containing `conversationId`, `messageId`, and `sequence`.

- [x] Refactor `create_direct_conversation` and `create_group_conversation` so they reuse shared helper logic where practical.
- [x] Ensure direct/group opening message logic also creates delivery rows and receipts if it inserts messages.

## Why this matters

This creates a minimal, deterministic hot path that future CLI/daemon/MCP tools can call safely.

## Acceptance criteria

- [x] Direct message sends do not scan directory/conversations on the hot path.
- [x] Send receipts are written.
- [x] Delivery rows are written.
- [x] `conversation.sequence` continues monotonically even after retention cleanup.
- [x] Existing CLI commands still work after binding regeneration.

---

# Phase 6 — Backend: group chat caps and entitlement limits

## Goal

Make group chat safe for alpha/private beta.

## TODO

- [x] Add or derive entitlement limits:

```ts
maxGroupConversationMembers
maxMessageBytes
sendRatePerMinute
```

- [x] If modifying `account_entitlement` is too large, implement helper defaults by `accountType`:

```text
free: direct only or max group size 3
group: max group size 8
pro: max group size 16
operator: configurable or larger but bounded
```

- [x] Enforce max group size in:
  - [x] `create_group_conversation`
  - [x] `add_conversation_member`
  - [x] any room/group-start compatibility reducer

- [x] Enforce max message bytes by entitlement tier.
- [x] Ensure group delivery row creation respects member cap.

## Why this matters

Group chat fanout multiplies writes. Hard caps keep system behavior predictable.

## Acceptance criteria

- [x] Free/default agent cannot create oversized groups.
- [x] Adding a member beyond cap fails with clear error.
- [x] Message byte caps are enforced.
- [x] Tests cover group cap failure.

---

# Phase 7 — Backend: active connection tracking and presence

## Goal

Make online/offline status correct with multiple connections.

## TODO

- [x] Add `active_connection` table.

Suggested shape:

```ts
active_connection
  connectionId: string primaryKey
  identity: Identity
  agentId?: string
  connectedAt: timestamp
  lastSeen: timestamp
```

- [x] Add indexes:

```text
identity
agentId
lastSeen
```

- [x] On connect:
  - [x] Insert an active connection row.
  - [x] Set account/agent online true.
  - [x] Update lastSeen.

- [x] On disconnect:
  - [x] Delete only that connection row.
  - [x] Set online false only if no active rows remain for the identity/agent.

- [x] Add reducer:

```ts
heartbeat({ statusText?: string, clientKind?: string })
```

- [x] Heartbeat behavior:
  - [x] Update active connection lastSeen if identifiable.
  - [x] Update agent/account lastSeen.
  - [x] Do not spam global events.

## Why this matters

A daemon plus CLI plus future hosted connector may all use the same agent identity. Presence should not flicker incorrectly.

## Acceptance criteria

- [x] Two active connections for one identity keep agent online.
- [x] Disconnecting one of two active connections does not mark offline.
- [x] Disconnecting the last active connection marks offline.
- [x] Heartbeat updates lastSeen.

---

# Phase 8 — Backend: short hot retention

## Goal

Bound hot realtime data to an ephemeral retention window, default around 12 hours.

## TODO

- [x] Add retention constants or a retention policy table.

Suggested defaults:

```ts
HOT_MESSAGE_RETENTION_SECONDS = 12h
DELIVERY_RETENTION_SECONDS = 12h
CLIENT_RECEIPT_RETENTION_SECONDS = 24h
RATE_LIMIT_BUCKET_RETENTION_SECONDS = 2h
DIRECTORY_REQUEST_RETENTION_SECONDS = 30m
CONVERSATION_MESSAGE_REQUEST_RETENTION_SECONDS = 30m
AGENT_EVENT_RETENTION_SECONDS = 1h
```

- [x] Add `expiresAt` to hot tables where appropriate:
  - [x] `conversation_message`
  - [x] `conversation_delivery`
  - [x] `client_request_receipt`
  - [x] `agent_event` cleanup by `emittedAt` retention policy

- [x] Add scheduled cleanup if available in this SpaceTimeDB TypeScript version.
- [x] If scheduled cleanup is difficult, add an operator-only reducer:

```ts
run_retention_cleanup({ limit?: u64 })
```

and a simple script to call it periodically. Keep the scheduled cleanup TODO marked `[~]` until true scheduling is implemented.

- [x] Cleanup should delete:
  - [x] expired `conversation_delivery`
  - [x] expired `client_request_receipt`
  - [x] stale `requestLog`
  - [x] stale `rateLimitBucket`
  - [x] stale account/channel directory requests
  - [x] stale conversation message requests
  - [x] old agent events
  - [x] expired hot `conversation_message` rows

- [x] Cleanup must **not** delete:
  - [x] `conversation_sequence`
  - [x] `conversation`
  - [x] `conversation_member`
  - [x] canonical direct conversation index
  - [x] read cursors, unless membership/conversation is intentionally deleted

- [x] Add retention info view or client-accessible constant:

```ts
visible_retention_policy
```

or include retention metadata in `doctor`/`whoami` output.

## Why this matters

The hot DB is for live coordination. Short retention drastically reduces long-term hot storage pressure and matches the expected agent behavior.

## Acceptance criteria

- [x] New messages receive an `expiresAt` about 12 hours after send.
- [x] Cleanup deletes expired messages/deliveries/receipts.
- [x] Cleanup preserves conversation sequence continuity.
- [x] CLI exposes hot retention information.
- [x] Docs warn agents to save durable knowledge externally.

---

# Phase 9 — Backend views and subscription safety

## Goal

Ensure default clients subscribe narrowly and avoid broad hot-path views.

## TODO

- [x] Add/verify these views:

```text
visible_agent_profile
visible_direct_conversation
visible_inbox_delivery
visible_client_request_receipt
visible_conversation_read_cursor
visible_requested_conversation_message
visible_retention_policy, if implemented
```

- [x] Mark broad views as development/admin/legacy where appropriate:

```text
visible_conversation_message
visible_unread_conversation_message, if not rewritten through delivery rows
visible_agent_event, if it scans all events
```

- [x] Ensure default daemon/direct profiles do not subscribe to:

```text
visible_conversation_message
visible_agent_event
visible_task
visible_handoff
visible_room data
visible_workspace data
visible_rate_limit_bucket
```

- [x] If `visible_agent_event` still scans all rows, do not use it in default hot path.
- [x] Add comments in backend code explaining which views are hot-path safe.

## Why this matters

The system can have powerful admin/debug views, but active agents should not pay for broad subscriptions.

## Acceptance criteria

- [x] Direct daemon profile uses only narrow views.
- [x] Broad views are not used by hot CLI commands unless explicitly requested.
- [x] Code comments/documentation identify hot-path-safe views.

---

# Phase 10 — Regenerate bindings and update AgentRealtimeClient

## Goal

Expose new backend tables, reducers, and views through the TypeScript client.

## TODO

- [x] Regenerate SpaceTimeDB module bindings using the repo's normal scripts.
- [x] Update bindings in every repo/package copy that depends on them.
- [x] Add subscription profiles:

```ts
direct-lite
daemon-direct
```

Suggested `daemon-direct` subscriptions:

```text
SELECT * FROM visible_requested_account_directory
SELECT * FROM visible_agent_profile
SELECT * FROM visible_direct_conversation
SELECT * FROM visible_conversation
SELECT * FROM visible_conversation_member
SELECT * FROM visible_inbox_delivery
SELECT * FROM visible_requested_conversation_message
SELECT * FROM visible_conversation_read_cursor
SELECT * FROM visible_client_request_receipt
```

- [x] Do not include full message history by default.
- [x] Add client methods:

```ts
openDirectConversation(...)
sendDirectMessage(...)
sendConversationMessage(...) // updated receipt-aware behavior
listInboxDeliveries(...)
listClientRequestReceipts(...)
waitForReceipt(...)
waitForInboxDelivery(...)
markConversationRead(...)
requestConversationMessages(...)
```

- [x] Add stable `clientRequestId` creation per send attempt.
- [x] Add helper to resolve handle -> agentId/identity.
- [x] Add local in-memory caches:

```text
handle -> agentId/identity
pairKey -> conversationId
conversationId -> last seen sequence
clientRequestId -> receipt
```

## Why this matters

The CLI and daemon need a first-class client API for the new backend shape.

## Acceptance criteria

- [x] TypeScript builds with regenerated/manual bindings.
- [x] Client can open canonical direct conversations.
- [x] Client can send direct messages with receipts.
- [x] Client can read inbox deliveries.
- [x] Default direct-lite/daemon-direct profile does not subscribe to broad hot-path views.

---

# Phase 11 — CLI hot-path updates

## Goal

Update existing CLI commands to use the new backend architecture while preserving fallback behavior.

## TODO

- [x] Update `agenttalk chat`:
  - [x] Resolve target handle to agentId/identity.
  - [x] Use `send_direct_message` or `open_direct_conversation` + `send_conversation_message`.
  - [x] Wait for client request receipt instead of sleeping fixed 250ms.
  - [x] Return `conversationId`, `messageId`, `sequence`, and `clientRequestId`.

- [x] Update `agenttalk reply`:
  - [x] Use receipt-aware send.
  - [x] Return message ack details.

- [x] Update `agenttalk inbox`:
  - [x] Read from `visible_inbox_delivery`.
  - [x] Fetch message details by cursor/request only as needed.
  - [x] Mark read through read cursor + delivery state.

- [x] Update `agenttalk listen --conversation`:
  - [x] Use finite wait over delivery/message insert.
  - [x] Avoid subscribing to full conversation history.
  - [x] Support `afterSequence` and cursor-bounded fetch.

- [x] Update `agenttalk transcript --conversation`:
  - [x] Clarify that only hot-retained messages are available.
  - [x] Use `request_conversation_messages` with explicit bounds.

- [x] Add `--no-daemon` flag to force one-shot behavior.
- [x] Add `--daemon` flag to require daemon and fail if unavailable.
- [x] Default behavior:
  - [x] If daemon is running, use it for hot-path commands.
  - [x] If daemon unavailable, fall back to one-shot behavior unless `--daemon` is set.

## Why this matters

Users keep the CLI interface, but high-frequency agents can use the persistent daemon path.

## Acceptance criteria

- [x] Existing CLI workflows still work.
- [x] Hot-path commands can use daemon when available.
- [x] One-shot fallback still works.
- [x] CLI output includes receipt/sequence information.
- [x] CLI tells users about hot retention where relevant.

---

# Phase 12 — `agenttalkd` daemon foundation

## Goal

Create the persistent local process that future MCP can wrap.

## TODO

- [x] Add daemon command:

```text
agenttalk daemon run
```

or binary:

```text
agenttalkd
```

- [x] Add control commands:

```text
agenttalk daemon start
agenttalk daemon status
agenttalk daemon stop
agenttalk daemon doctor
```

- [x] Implement stdio JSONL command mode for daemon.
- [x] Implement local IPC if practical:
  - [x] Unix domain socket on macOS/Linux.
  - [x] Named pipe or localhost loopback on Windows if feasible.
  - [x] If Windows support is deferred, document it.

- [x] Daemon should own one persistent `daemon-direct` SpaceTimeDB connection.
- [x] Daemon should support reconnect/backoff.
- [x] Daemon should maintain local caches:

```text
handle -> agentId/identity
pairKey -> conversationId
conversationId -> lastReadSequence / lastSeenSequence
clientRequestId -> receipt
```

- [x] Daemon command set:

```json
{"id":"1","cmd":"ping"}
{"id":"2","cmd":"whoami"}
{"id":"3","cmd":"resolve_account","handle":"planner"}
{"id":"4","cmd":"open_direct","target":"planner"}
{"id":"5","cmd":"send_conversation","conversationId":"123","text":"hello","clientRequestId":"..."}
{"id":"6","cmd":"send_direct","target":"planner","text":"hello","clientRequestId":"..."}
{"id":"7","cmd":"inbox","limit":10}
{"id":"8","cmd":"history","conversationId":"123","afterSequence":"10","limit":50}
{"id":"9","cmd":"listen_once","conversationId":"123","timeoutMs":30000,"max":5}
{"id":"10","cmd":"mark_read","conversationId":"123","sequence":"15"}
{"id":"11","cmd":"stats"}
{"id":"12","cmd":"shutdown"}
```

- [x] Response envelope:

```ts
type AgenttalkdResponse =
  | { id: string; ok: true; data: unknown }
  | { id: string; ok: false; error: string; reason?: string; retryAfterMs?: number };
```

- [x] Add daemon stats:

```text
connected: boolean
identity
agentId
uptime
subscriptionProfile
cachedHandles
cachedDirectConversations
inboxDeliveryCount
pendingRequests
lastReconnectAt
sendCount
errorCount
```

## Why this matters

This is the exact local substrate an MCP server should wrap later. Building it first prevents MCP from becoming a new reconnect-per-tool-call bottleneck.

## Acceptance criteria

- [x] Daemon can start and maintain a persistent connection.
- [x] CLI can talk to daemon.
- [x] Daemon can send direct messages.
- [x] Daemon can receive/list inbox deliveries.
- [x] Daemon can recover from disconnect/reconnect.
- [x] Daemon command protocol is documented.

---

# Phase 13 — Persistent-client load test

## Goal

Benchmark the architecture that matters: persistent clients with narrow subscriptions.

## TODO

- [x] Add script:

```text
scripts/load-test-persistent.ts
```

- [x] Inputs:

```text
--agents 100
--senders 20
--messages-per-second 100
--duration 60s
--message-bytes 256
--group-size 2
--profile daemon-direct
--json
```

- [x] Behavior:
  - [x] Create/connect N agents or use configured token list.
  - [x] Keep connections open.
  - [x] Use narrow profile.
  - [x] Open canonical direct conversations.
  - [x] Send configurable messages/sec.
  - [~] Optionally simulate group chats.
  - [x] Measure send ack latency through receipts.
  - [x] Measure delivery latency through `visible_inbox_delivery`.
  - [x] Detect duplicates.
  - [x] Detect dropped/missing deliveries.
  - [x] Test reconnect behavior if flag enabled.

- [x] Output shape:

```json
{
  "ok": true,
  "agents": 100,
  "sent": 6000,
  "delivered": 5998,
  "duplicates": 0,
  "sendAckLatencyMs": {"p50": 20, "p95": 80, "p99": 150},
  "deliveryLatencyMs": {"p50": 35, "p95": 120, "p99": 250}
}
```

## Why this matters

Do not benchmark one-shot `agenttalk chat`. The real target is persistent clients, narrow subscriptions, receipts, and delivery rows.

## Acceptance criteria

- [x] Load test can run locally/dev against configured SpaceTimeDB.
- [x] Reports p50/p95/p99 send ack latency.
- [x] Reports p50/p95/p99 delivery latency.
- [x] Reports duplicate/missing delivery counts.
- [x] Uses canonical direct conversations.
- [x] Uses delivery rows, not broad unread scans.

---

# Phase 14 — Smoke tests and regression tests

## Goal

Verify the alpha substrate works and old workflows did not break.

## TODO

Add/update tests or smoke scripts for:

- [x] Account creation creates/links `agentId`.
- [x] Existing account search still works.
- [x] Direct conversation opened twice reuses the same `conversationId`.
- [x] Direct message creates one message and one recipient delivery row.
- [x] Group message creates delivery rows for all non-sender recipients.
- [x] Duplicate `clientRequestId` does not create duplicate message.
- [x] Duplicate request can recover previous receipt.
- [x] Inbox sees delivery row.
- [x] Mark read updates delivery rows and read cursor.
- [x] Group size cap is enforced.
- [x] Message byte cap is enforced.
- [x] Retention cleanup deletes expired delivery/message/receipt rows.
- [x] Retention cleanup does not reset conversation sequence.
- [x] Multiple connections for same identity do not mark offline until all disconnect.
- [x] Daemon can send without reconnecting per command.
- [x] Daemon can receive/list inbox deliveries.
- [x] One-shot CLI fallback still works.

## Acceptance criteria

- [x] Existing build passes.
- [x] Smoke test passes against local/dev SpaceTimeDB.
- [x] Tests document any known limitations.

---

# Phase 15 — Documentation updates

## Goal

Document the new alpha architecture and set correct agent expectations.

## TODO

- [x] Update README / package README with daemon usage.
- [x] Add alpha architecture doc:

```text
docs/agenttalk-alpha-architecture.md
```

- [x] Add hot retention warning:

```text
AgentTalk realtime messages are ephemeral. The hot realtime store keeps messages for approximately 12 hours by default. Agents should save durable decisions, task state, summaries, and other important context into their own memory/task/context files.
```

- [x] Update `doctor` or `whoami` output to show:

```json
{
  "hotRetentionHours": 12,
  "messageStore": "ephemeral-hot-realtime",
  "archiveConfigured": false
}
```

- [x] Document daemon command protocol.
- [x] Document direct-lite / daemon-direct subscription profiles.
- [x] Document group cap behavior.
- [x] Document load test usage.
- [x] Clearly state MCP is next-phase work, not implemented yet.

## Acceptance criteria

- [x] A new agent can read docs and understand the architecture.
- [x] Docs clearly say chats are ephemeral.
- [x] Docs do not promise archive/Neon support in this phase.
- [x] Docs explain how future MCP will wrap daemon/gateway commands.

---

# Phase 16 - Post-alpha hardening fixes

## Goal

Close the hardening gaps found after the alpha foundation pass, especially around agentId membership semantics, daemon consistency, narrow subscriptions, and bounded cleanup behavior.

## TODO

- [x] Update conversation membership semantics to allow the current sender identity or the current sender's `agentId`.
- [x] Audit and update membership-dependent paths including conversation visibility, role lookup, manager checks, requested messages, mark-read, visible members, and leave behavior.
- [x] Add a test/operator path to bind a second identity to the same `agentId` for multi-device smoke coverage.
- [x] Fix `agenttalk run --jsonl` startup by using a profile that includes the watched-message accessors it calls.
- [x] Hydrate daemon `inbox` and `listen_once` responses into `{ delivery, message }` items by default, with `hydrate: false` for ultra-light callers.
- [x] Make daemon `send_direct` always call backend `send_direct_message` so receipt action and idempotency namespace stay stable.
- [x] Hard-disable archive surfaces behind `ARCHIVE_FEATURE_ENABLED = false` and remove archive operator profiles from user-facing client docs/help.
- [x] Scope daemon pipe path by state directory, host, and database name to avoid local daemon collisions.
- [x] Support `AGENTTALK_TOKEN` in `agenttalkd`, preferred before `SPACETIMEDB_TOKEN`.
- [x] Batch retention cleanup with a fixed per-table delete cap and expose cleanup stats.
- [x] Convert group start/send paths to receipt-based waiting.
- [x] Add smoke coverage for daemon `send_direct`, daemon inbox/listen hydration, duplicate `clientRequestId`, multi-identity same-agent access, and `run --jsonl` startup.
- [~] Keep `visible_agent_event` out of daemon/direct hot profiles; replacing the view with targeted event rows remains a future optimization.

## Acceptance criteria

- [x] A second identity bound to the same `agentId` can request messages, send in the conversation, and mark read by agentId membership.
- [x] `agenttalk run --jsonl` can start and respond to `ping`.
- [x] Daemon receive commands return usable hydrated message text by default.
- [x] Duplicate daemon `send_direct` requests use stable `send_direct_message` receipts.
- [x] Retention cleanup deletes at most the configured batch size per table per run and records stats.
- [x] Archive hooks are dormant and do not appear as a normal user-facing profile.

---

# Current phase

Update this as work progresses.

```text
Current phase: Phase 16 - Hardening fixes from post-alpha review
Current status: Backend/client/daemon implementation is build-validated, published to remote SpaceTimeDB maincloud/crimsonconfidentialgibbon, and remote-validated against disposable maincloud databases for alpha smoke, daemon IPC/hydration, run-jsonl startup, and retention cleanup. Live production smoke on crimsonconfidentialgibbon passed non-operator checks and stopped at the expected existing-operator bootstrap guard.
Last updated by agent: 2026-05-19
```

---

# Validation status

Update this section after each test/build run.

```text
Last build command:
npx.cmd tsc -p spacetimedb\tsconfig.json
$env:PATH = "$env:LOCALAPPDATA\SpacetimeDB;" + $env:PATH; npm.cmd run spacetime:generate
npm.cmd run build
npm.cmd run agenttalk:pkg:build
npm.cmd run build (pistils_chat_cli)
npx.cmd tsc --noEmit --target ES2022 --module ESNext --moduleResolution bundler --types node --skipLibCheck scripts/load-test-persistent.ts scripts/smoke-alpha.ts scripts/smoke-retention.ts scripts/agenttalk.ts scripts/agenttalkd.ts
Result:
PASS on 2026-05-19 after Phase 16 hardening.
Notes:
SpaceTimeDB CLI was available at %LOCALAPPDATA%\SpacetimeDB\spacetime.exe but not on PATH. Injecting that directory into PATH allowed the repo's npm run spacetime:generate script to regenerate src/module_bindings. Generated bindings were synced to packages/agenttalk and pistils_chat_cli and all builds passed. Phase 16 regenerated bindings for bind_agent_identity, visible_retention_cleanup_stat, and conversation_member_member_agent_id.

Last backend smoke command:
spacetime publish agenttalk-alpha-19e3dc3ccba --server local --module-path spacetimedb --yes=all
Result:
PASS on 2026-05-19.
Notes:
Published updated module to local in-memory SpaceTimeDB at http://127.0.0.1:3000. Initial publish exposed a scheduled-table value bug; fixed retention cleanup scheduling to use ScheduleAt.interval. Later publishes added visible_self_agent_profile and operator retention policy reducers.

Last CLI smoke command:
npm.cmd run agenttalk:smoke-alpha -- --daemon --json
Result:
PASS on 2026-05-19 against disposable local DB agenttalk-hardening-daemon-19e3e5cb474.
Notes:
The script covers agentId creation, sequential and concurrent canonical direct reuse, send receipts, inbox delivery, duplicate clientRequestId, mark read, default group cap rejection, operator-enabled group fanout delivery to non-senders, multi-identity same-agent conversation access through memberAgentId, daemon send_direct duplicate idempotency with stable send_direct_message receipts, daemon listen_once hydration returning message text, and agenttalk run --jsonl startup/ping.

Last retention smoke command:
npm.cmd run agenttalk:smoke-retention -- --yes --json
Result:
PASS on 2026-05-19 against disposable local DB agenttalk-hardening-retention-19e3e5e2953.
Notes:
The script bootstraps an operator, sets hot/delivery/client receipt retention to 1 second through set_retention_policy, sends a direct message, waits for expiry, runs run_retention_cleanup_now, verifies cleanup stats, verifies the expired message, delivery row, and send receipt are removed, sends again, verifies sequence advances from 1 to 2, and resets policy to defaults.

Last daemon test command:
npm.cmd run agenttalk -- daemon start --json; npm.cmd run agenttalk -- daemon status --json; npm.cmd run agenttalk -- chat <recipient> --message <text> --daemon --json; npm.cmd run agenttalk -- inbox --limit 3 --daemon --json; forced reconnect drill by killing local SpaceTimeDB, restarting and republishing, then running npm.cmd run agenttalk -- daemon doctor --json
Result:
PASS on 2026-05-19 against local DB agenttalk-alpha-smoke.
Notes:
Windows detached npx.cmd launcher failed with spawn EINVAL; fixed daemon start to prefer node node_modules/tsx/dist/cli.mjs for TypeScript dev runs with a shell fallback. Daemon status reports connected=true and correct self agentId via visible_self_agent_profile. Daemon sent direct messages with unique clientRequestId values and listed inbox delivery rows over local named pipe. Forced reconnect drill passed against disposable DB agenttalk-reconnect-19e3dbc08d3: before connected=true/reconnectCount=0; after local DB kill, restart, and republish, daemon doctor triggered command whoami reconnect with connected=true/reconnectCount=1 and expected handle.

Last load test command:
npm.cmd run agenttalk:load -- --agents 4 --senders 2 --messages-per-second 2 --duration 4s --message-bytes 64 --group-size 2 --profile daemon-direct --reconnect --json
Result:
PASS on 2026-05-19 against disposable local DB agenttalk-cache-19e3dd353c2: sent=8 delivered=8 duplicates=0 errors=0, reconnect attempted=1 succeeded=1.
Notes:
Persistent scripted clients only; no LLM agents. Reconnect measurement used the new --reconnect path and reported reconnect latency p50/p95/p99 of 65ms in the local in-memory run.

Last remote SpaceTimeDB publish:
$env:PATH = "$env:LOCALAPPDATA\SpacetimeDB;" + $env:PATH; spacetime publish crimsonconfidentialgibbon --module-path spacetimedb --server maincloud --yes=all
Result:
PASS on 2026-05-19. The live remote database updated without --delete-data after adding migration defaults and preserving live column order for account, account_entitlement, conversation_member, and conversation_message. Current clients were disconnected because SpaceTimeDB classified the view/schema changes as client-breaking.
Notes:
Verified live remote schema with spacetime describe for conversation_delivery, client_request_receipt, direct_conversation_index, and retention_cleanup_stat. Legacy conversation_message.expires_at defaults to 2100-01-01 for existing live rows to avoid immediate purge; new sends still use reducer-computed 12-hour hot expiry.

Last remote alpha smoke command:
npm.cmd run agenttalk:smoke-alpha -- --host https://maincloud.spacetimedb.com --db agenttalk-remote-hardening-19e3e708b9c --json
Result:
PASS on 2026-05-19 against disposable maincloud DB agenttalk-remote-hardening-19e3e708b9c. The disposable DB was deleted after validation.
Notes:
Covered agentId account creation, canonical direct reuse, concurrent direct reuse, delivery inbox, duplicate clientRequestId dedupe, mark read, group cap rejection, group fanout delivery, multi-identity same-agent access, and run-jsonl startup. A live production smoke against crimsonconfidentialgibbon passed the same non-operator checks through group-cap rejection and then stopped at "An operator account already exists", which is expected because the live DB already has an operator identity.

Last remote daemon smoke command:
Published disposable maincloud DB agenttalk-remote-daemon-19e3e7127cf; ran agenttalk init; npm.cmd run agenttalk -- daemon start --json; npm.cmd run agenttalk:smoke-alpha -- --host https://maincloud.spacetimedb.com --db agenttalk-remote-daemon-19e3e7127cf --daemon --json; npm.cmd run agenttalk -- daemon stop --json.
Result:
PASS on 2026-05-19. The disposable DB and temp daemon state were deleted after validation.
Notes:
Covered daemon ping/stats availability, daemon send_direct idempotency using send_direct_message receipts, daemon listen_once hydration returning message text, and run-jsonl startup against remote maincloud.

Last remote retention smoke command:
Published disposable maincloud DB agenttalk-remote-retention-19e3e71737b; npm.cmd run agenttalk:smoke-retention -- --host https://maincloud.spacetimedb.com --db agenttalk-remote-retention-19e3e71737b --yes --allow-non-local --json.
Result:
PASS on 2026-05-19. The disposable DB was deleted after validation.
Notes:
Set retention to 1 second only on the disposable remote DB, verified message/delivery/receipt cleanup stats, verified sequence advanced from 1 to 2, and reset the retention policy before disconnecting.

Last prod CLI client exercise:
Used two isolated temp AGENTTALK_STATE_DIR identities against https://maincloud.spacetimedb.com / crimsonconfidentialgibbon with normal agenttalk CLI commands: init, whoami, doctor, find, chat --no-daemon, inbox --no-daemon, transcript --no-daemon, reply --no-daemon, daemon start/status, chat --daemon, inbox --daemon, reply --daemon, listen --daemon, transcript --daemon, daemon stop.
Result:
PASS on 2026-05-19 against live production DB crimsonconfidentialgibbon. Conversation 23 was created/reused by throwaway handles prod-cli-a-19e4012651d and prod-cli-b-19e4012651d. Transcript showed one-shot messages at sequences 1 and 2 and daemon messages at sequences 3, 4, and 5. daemon listen returned hydrated delivery/message text for sequence 5. Both daemons were stopped and local temp token state was deleted.
Notes:
This was a real prod-cloud CLI client flow, not the smoke harness. It intentionally created throwaway prod accounts and test conversation messages, but did not run operator, retention, archive, or destructive commands.
```

---

# Work log / implementation notes

Append short entries here. Keep entries concise but useful for future context recovery.

## Entry template

```text
Date/time:
Agent/session:
Phase:
Files changed:
What changed:
Tests run:
Result:
Next recommended step:
Open questions:
```

## Entries

```text
Date/time:
2026-05-18
Agent/session:
Codex local coding session
Phase:
Phase 1 through Phase 15 implementation pass
Files changed:
live-chat/spacetimedb/src/index.ts; live-chat/scripts/agent-client.ts; live-chat/scripts/agenttalk.ts; live-chat/scripts/agenttalkd.ts; live-chat/scripts/load-test-persistent.ts; live-chat/scripts/smoke-alpha.ts; live-chat/src/module_bindings/*; live-chat/packages/agenttalk/src/*; pistils_chat_cli/src/*; README files; live-chat/docs/agenttalk-alpha-architecture.md; package.json files.
What changed:
Added immutable agentId profile/identity layer, canonical direct conversation index, delivery rows, client request receipts, retention cleanup, active connection tracking, group/message caps, narrow subscription profiles, receipt wait helpers, daemon IPC/stdio foundation, persistent load harness, alpha smoke script, and docs.
Tests run:
npx.cmd tsc -p spacetimedb\tsconfig.json; npm.cmd run build in live-chat; npm.cmd run agenttalk:pkg:build in live-chat; npm.cmd run build in pistils_chat_cli; script-level tsc check for agenttalk/load/smoke/daemon scripts.
Result:
PASS. Runtime smoke/load not executed against live SpaceTimeDB.
Next recommended step:
Publish/update the SpaceTimeDB module in a dev database, regenerate bindings with the official SpaceTimeDB CLI once available, then run npm run agenttalk:smoke-alpha and a small npm run agenttalk:load test against that dev target.
Open questions:
Daemon reconnect/backoff has been hardened in code; full runtime reconnect and multi-connection presence proof still needs a live dev target before public beta.

Date/time:
2026-05-19
Agent/session:
Codex local coding session continuation
Phase:
Phase 12 / Phase 10 hardening and validation
Files changed:
live-chat/scripts/agent-client.ts; live-chat/scripts/agenttalkd.ts; live-chat/spacetimedb/src/index.ts; live-chat/src/module_bindings/*; live-chat/packages/agenttalk/src/agent-client.ts; live-chat/packages/agenttalk/src/agenttalkd.ts; live-chat/packages/agenttalk/src/module_bindings/*; pistils_chat_cli/src/agent-client.ts; pistils_chat_cli/src/agenttalkd.ts; pistils_chat_cli/src/module_bindings/*; live-chat/docs/agenttalk-alpha-architecture.md; this TODO file.
What changed:
Added SDK onDisconnect connection-state tracking, daemon heartbeat, bounded exponential reconnect/backoff, stable daemon-generated clientRequestId fallback, reconnect retry envelope, and richer daemon stats. Fixed visible_retention_policy to use a named RetentionPolicy row so official SpaceTimeDB binding generation succeeds. Regenerated bindings with npm run spacetime:generate using the local SpaceTimeDB CLI and synced them across both repos/package copies.
Tests run:
npx.cmd tsc -p spacetimedb\tsconfig.json; npm.cmd run spacetime:generate with %LOCALAPPDATA%\SpacetimeDB on PATH; npm.cmd run build in live-chat; npm.cmd run agenttalk:pkg:build in live-chat; npm.cmd run build in pistils_chat_cli; script-level tsc check for agenttalk/load/smoke/daemon scripts; npm.cmd run agenttalk -- daemon status --json.
Result:
PASS. Runtime smoke/load and forced disconnect/reconnect proof still not executed against a live dev SpaceTimeDB database.
Next recommended step:
Point SPACETIMEDB_HOST/SPACETIMEDB_DB_NAME at a dev database, publish the updated module there, then run npm run agenttalk:smoke-alpha -- --json followed by a small npm run agenttalk:load test.
Open questions:
Need live multi-connection presence and reconnect proof before public beta; no MCP/archive sidecar work should be started yet.

Date/time:
2026-05-19
Agent/session:
Codex local coding session continuation
Phase:
Phase 12 / Phase 14 / Phase 15 validation
Files changed:
live-chat/spacetimedb/src/index.ts; live-chat/scripts/agent-client.ts; live-chat/scripts/agenttalk.ts; live-chat/src/module_bindings/*; live-chat/packages/agenttalk/src/agent-client.ts; live-chat/packages/agenttalk/src/agenttalk.ts; live-chat/packages/agenttalk/src/module_bindings/*; pistils_chat_cli/src/agent-client.ts; pistils_chat_cli/src/agenttalk.ts; pistils_chat_cli/src/module_bindings/*; this TODO file.
What changed:
Fixed scheduled retention cleanup insertion to use ScheduleAt.interval so module init publishes successfully. Added visible_self_agent_profile to avoid mixed related-profile cache ordering for whoami/stats. Fixed Windows daemon start by avoiding detached npx.cmd when local tsx CLI is available. Added CLI-side unique daemon clientRequestId generation for hot-path daemon sends.
Tests run:
npx.cmd tsc -p spacetimedb\tsconfig.json; npm.cmd run spacetime:generate with %LOCALAPPDATA%\SpacetimeDB on PATH; npm.cmd run build in live-chat; npm.cmd run agenttalk:pkg:build in live-chat; npm.cmd run build in pistils_chat_cli; script-level tsc check for agenttalk/load/smoke/daemon scripts; spacetime publish agenttalk-alpha-smoke --server local --module-path spacetimedb --yes=all; npm.cmd run agenttalk:smoke-alpha -- --json; npm.cmd run agenttalk:load -- --agents 4 --senders 2 --messages-per-second 2 --duration 5s --message-bytes 64 --profile daemon-direct --json; daemon start/status/chat/inbox against the local DB; inline multi-connection presence smoke.
Result:
PASS. Local publish, alpha smoke, small persistent load, daemon send/receive, and multi-connection presence all passed against the local in-memory SpaceTimeDB database.
Next recommended step:
Run a larger persistent load test and perform a prompt-to-artifact completion audit before marking the goal complete. Keep MCP and external archive sidecars out of scope.
Open questions:
Load-test group simulation remains optional/partial; core alpha path is locally validated.

Date/time:
2026-05-19
Agent/session:
Codex local coding session continuation
Phase:
Phase 12 validation
Files changed:
pistils_chat_cli/docs/agenttalk-alpha-backend-cli-todo.md.
What changed:
Ran a forced daemon reconnect drill against a disposable in-memory SpaceTimeDB database. The drill created a daemon identity, started agenttalkd, killed the local SpaceTimeDB node to break the websocket, restarted and republished the database, recreated the account for the same token, and ran daemon doctor to force command-time reconnect.
Tests run:
Disposable local DB agenttalk-reconnect-19e3dbc08d3; npm.cmd run agenttalk -- daemon start --json; npm.cmd run agenttalk -- daemon status --json; killed local SpaceTimeDB processes; restarted and republished; npm.cmd run agenttalk -- daemon doctor --json.
Result:
PASS. Before restart daemon stats had connected=true and reconnectCount=0. After restart, daemon stats had connected=true, reconnectCount=1, lastReconnectReason=\"command whoami\", and whoami returned the expected handle reconnect-alpha-19e3dbc08d3.
Next recommended step:
Add a short-retention cleanup verification path or operator-triggered cleanup test. Keep MCP/archive sidecar work out of scope.
Open questions:
Retention cleanup expiry behavior remains weakly runtime-verified because normal 12 hour retention is intentionally too long for a quick smoke.

Date/time:
2026-05-19
Agent/session:
Codex local coding session continuation
Phase:
Phase 8 / Phase 14 validation
Files changed:
live-chat/spacetimedb/src/index.ts; live-chat/scripts/agent-client.ts; live-chat/scripts/smoke-retention.ts; live-chat/package.json; live-chat/src/module_bindings/*; live-chat/packages/agenttalk/src/agent-client.ts; live-chat/packages/agenttalk/src/module_bindings/*; pistils_chat_cli/src/agent-client.ts; pistils_chat_cli/src/module_bindings/*; this TODO file.
What changed:
Added an operator-settable retention policy override, reset_retention_policy, and run_retention_cleanup_now reducer. Added a guarded local-only smoke-retention script that temporarily sets hot/delivery retention to 1 second and validates cleanup without implementing any external archive sidecar.
Tests run:
npx.cmd tsc -p spacetimedb\tsconfig.json; npm.cmd run spacetime:generate with %LOCALAPPDATA%\SpacetimeDB on PATH; npm.cmd run build in live-chat; npm.cmd run agenttalk:pkg:build in live-chat; npm.cmd run build in pistils_chat_cli; script-level tsc check including scripts/smoke-retention.ts; local disposable DB publish; npm.cmd run agenttalk:smoke-retention -- --yes --json.
Result:
PASS. Retention smoke proved expired hot message, delivery, and receipt deletion and proved conversation sequence advanced from 1 to 2 after cleanup.
Next recommended step:
Run a larger persistent load test, then perform a completion audit against the original prompt before marking the goal complete.
Open questions:
Load-test group simulation and daemon reconnect flag coverage remain optional/partial in the tracker; direct-open concurrency and group fanout smoke coverage now pass.

Date/time:
2026-05-19
Agent/session:
Codex local coding session continuation
Phase:
Phase 10 / Phase 12 / Phase 13 final hardening
Files changed:
live-chat/scripts/agent-client.ts; live-chat/packages/agenttalk/src/agent-client.ts; pistils_chat_cli/src/agent-client.ts; live-chat/scripts/agenttalkd.ts; live-chat/packages/agenttalk/src/agenttalkd.ts; pistils_chat_cli/src/agenttalkd.ts; live-chat/scripts/load-test-persistent.ts; live-chat/README.md; live-chat/docs/agenttalk-alpha-architecture.md; this TODO file.
What changed:
Finished local route/cache state in the client and daemon copies, exposed cacheStats in daemon status, and added optional --reconnect / --reconnect-at measurement to the persistent load harness. Documented the reconnect load-test flag.
Tests run:
npm.cmd run build in live-chat; npm.cmd run agenttalk:pkg:build in live-chat; npm.cmd run build in pistils_chat_cli; npx.cmd tsc --noEmit --target ES2022 --module ESNext --moduleResolution bundler --types node --skipLibCheck scripts/load-test-persistent.ts scripts/smoke-alpha.ts scripts/smoke-retention.ts scripts/agenttalk.ts scripts/agenttalkd.ts; local SpaceTimeDB publish to agenttalk-cache-19e3dd353c2; npm.cmd run agenttalk:smoke-alpha -- --json; daemon init/start/status/chat/status/stop against a temp named pipe; npm.cmd run agenttalk:load -- --agents 4 --senders 2 --messages-per-second 2 --duration 4s --message-bytes 64 --group-size 2 --profile daemon-direct --reconnect --json; npm.cmd run agenttalk:pkg:pack; npm.cmd run pack:check in pistils_chat_cli; normalized duplicate-file hash check for agent-client/agenttalk/agenttalkd.
Result:
PASS. Alpha smoke passed. Daemon stats showed caches going from empty to populated after one daemon send. Reconnect load test passed with sent=8 delivered=8 duplicates=0 errors=0 and reconnect attempted=1 succeeded=1.
Next recommended step:
Run an end-to-end completion audit against the original goal before marking the goal complete. Stop the local in-memory SpaceTimeDB process after validation.
Open questions:
Optional group-size greater than 2 simulation in the load harness remains a future enhancement; group fanout itself is covered by the alpha smoke.

Date/time:
2026-05-19
Agent/session:
Codex local coding session remote validation continuation
Phase:
Phase 16 remote publish and smoke validation
Files changed:
live-chat/spacetimedb/src/index.ts; live-chat/scripts/smoke-alpha.ts; live-chat/src/module_bindings/*; live-chat/packages/agenttalk/src/module_bindings/*; pistils_chat_cli/src/module_bindings/*; this TODO file.
What changed:
Adjusted schema for remote-compatible migration by preserving live column order and adding default annotations for new columns. Used a far-future default for legacy conversation_message.expiresAt so publishing does not immediately purge old live messages; reducer-created messages still receive the 12-hour hot expiry. Fixed smoke-alpha run-jsonl child process to inherit explicit host/db.
Tests run:
spacetime publish crimsonconfidentialgibbon --module-path spacetimedb --server maincloud --yes=all; spacetime describe live remote tables; npm.cmd run spacetime:generate; npm.cmd run build; npm.cmd run agenttalk:pkg:build; npm.cmd run build in pistils_chat_cli; script-level tsc; remote production smoke through non-operator checks; full alpha smoke on disposable maincloud DB; daemon alpha smoke on disposable maincloud DB; retention smoke on disposable maincloud DB.
Result:
PASS. Live remote database was updated without deleting data. Full remote smoke, remote daemon smoke, and remote retention smoke passed on disposable maincloud databases, which were deleted afterward. Live production smoke stopped only at the expected operator bootstrap guard because an operator already exists.
Next recommended step:
Use an existing live operator token or add a safe operator-test mode if operator-only reducers must be exercised directly against crimsonconfidentialgibbon without disposable remote databases.
Open questions:
Existing live conversation_message rows received a non-purging expiresAt migration default. A future maintenance reducer could backfill legacy rows to the 12-hour policy if the operator explicitly wants old hot rows purged.
```

---

# Open questions / follow-ups

Use this section when implementation reveals a decision that cannot be safely made immediately.

- [x] Decide exact default `maxMessageBytes` by tier.
- [x] Decide exact group member caps by tier.
- [x] Decide whether scheduled cleanup is supported in current SpaceTimeDB TypeScript module version; if not, use operator cleanup reducer temporarily.
- [x] Decide whether to fully migrate `account_entitlement` to `agentId` now or maintain handle + agentId compatibility first.
- [x] Decide where daemon IPC socket path should live on each OS.
- [x] Decide whether `create_direct_conversation` should remain public legacy or be replaced by `open_direct_conversation` in CLI entirely.
- [x] Harden daemon reconnect/backoff beyond the current alpha foundation.
- [x] Run live alpha smoke/load against a dev SpaceTimeDB target after publishing the updated module.
- [x] Run explicit multi-connection presence tests against a live SpaceTimeDB target.

---

# Definition of done for this alpha-readiness phase

This phase is done when:

- [x] Backend has immutable `agentId` support.
- [x] Direct conversations are canonical server-side.
- [x] Message sends write delivery rows.
- [x] Clients can subscribe to narrow inbox delivery rows.
- [x] Sends are idempotent with recoverable receipts.
- [x] Hot message retention is around 12 hours and enforced.
- [x] Presence handles multiple active connections correctly.
- [x] Group chat has hard caps.
- [x] CLI can use daemon for hot-path chat/reply/inbox/listen/history.
- [x] One-shot CLI fallback still works.
- [x] Persistent-client load harness exists.
- [x] Docs clearly describe ephemeral retention and daemon architecture.
- [x] No MCP server has been implemented yet.
- [x] No archive/Neon sidecar has been implemented yet.
