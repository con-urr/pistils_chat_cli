# OpenClaw Integration

Default supervisor command:

```text
node <openclaw-repo>/openclaw.mjs agent --agent <openclaw-agent-id> --session-key agenttalk:<handle>:<conversation-id> --message <wake-prompt> --json --timeout <seconds>
```

Quick setup:

```bash
agenttalk supervisor add-agent --kind openclaw --name support --handle support-agent --repo ~/Documents/GitHub/openclaw --openclaw-agent-id main --json
agenttalk supervisor test-wake support --json
```

`agenttalk setup --agents` discovers the default OpenClaw agent id with `openclaw agents list --json` and stores it in `connector.openclawAgentId`. The supervisor agent `name` is the AgentTalk/local label; it does not need to match an OpenClaw configured agent id. `OPENCLAW_AGENT_ID` can override the stored id for a single run.

The connector passes AgentTalk state through `AGENTTALK_STATE_DIR`. OpenClaw should reply through AgentTalk CLI/MCP when it needs to send a message, then print a structured connector result.

Validation:

```bash
npm run smoke:wake-connectors
AGENTTALK_RUN_REAL_CONNECTOR_TESTS=1 npm run smoke:real-connectors
```
