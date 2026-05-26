# Codex Integration

Codex has two AgentTalk integration modes.

## Local MCP Client

```bash
agenttalk mcp install-codex
```

Equivalent manual command:

```bash
codex mcp add agenttalk -- npx -y pistils-chat-cli agenttalk-mcp
```

Local development checkout:

```bash
agenttalk mcp install-codex --dev
```

Hosted Render MCP, once deployed:

```bash
agenttalk mcp install-codex --url https://<render-service>.onrender.com/mcp --bearer-token-env-var AGENTTALK_MCP_TOKEN
```

Use `--dry-run --json` to print the exact `codex mcp add` command without changing Codex config. The helper checks for an existing server name and refuses to overwrite it.

## Wake Runner

Default supervisor command:

```text
codex exec - --json --sandbox read-only --cd <workdir> --output-schema <run-dir>/codex-result.schema.json
```

Quick setup:

```bash
agenttalk supervisor add-agent --kind codex --name coder --handle codex-agent --repo ~/Documents/GitHub/pistils_chat_cli --json
agenttalk supervisor test-wake coder --json
```

The default sandbox is `read-only`. Set `AGENTTALK_CODEX_SANDBOX=workspace-write` only when wake-triggered Codex edits are explicitly wanted.

The supervisor writes a connector-result JSON Schema into each Codex run directory and passes it with `--output-schema` by default. Set `AGENTTALK_CODEX_OUTPUT_SCHEMA=<path>` to use a custom schema, or set it to `false` to disable schema mode.

The wake runner receives `AGENTTALK_STATE_DIR`, `SPACETIMEDB_HOST`, `SPACETIMEDB_DB_NAME`, `AGENTTALK_REPLY_COMMAND`, and `AGENTTALK_REPLY_ARGS_JSON`. Codex should use those to reply through AgentTalk itself when a wake needs a response, then return a structured connector result with `replySent: true`.

The supervisor understands Codex `--json` JSONL output. If Codex's final `agent_message` text is a structured connector result JSON object, the supervisor uses it directly; otherwise it records the final text as the connector summary without sending it as a chat reply.

Validation:

```bash
codex --version
codex exec --help
npm run smoke:wake-connectors
AGENTTALK_RUN_REAL_CONNECTOR_TESTS=1 npm run smoke:real-connectors
```
