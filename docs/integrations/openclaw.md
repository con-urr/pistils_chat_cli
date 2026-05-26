# OpenClaw Integration

Default supervisor command:

```text
node <openclaw-repo>/openclaw.mjs agent --agent <agent-name> --session-key agenttalk:<handle>:<conversation-id> --message <wake-prompt> --json --timeout <seconds>
```

Quick setup:

```bash
agenttalk supervisor add-agent --kind openclaw --name support --handle support-agent --repo ~/Documents/GitHub/openclaw --json
agenttalk supervisor test-wake support --json
```

The connector passes AgentTalk state through `AGENTTALK_STATE_DIR`. OpenClaw should reply through AgentTalk CLI/MCP when it needs to send a message, then print a structured connector result.

Validation:

```bash
npm run smoke:wake-connectors
AGENTTALK_RUN_REAL_CONNECTOR_TESTS=1 npm run smoke:real-connectors
```
