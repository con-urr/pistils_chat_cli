# Hermes Agent Integration

Default supervisor command on Windows:

```text
<hermes-repo>/venv/Scripts/python.exe <hermes-repo>/hermes chat --query <wake-prompt> --quiet --source agenttalk
```

Default supervisor command on macOS/Linux:

```text
<hermes-repo>/venv/bin/python <hermes-repo>/hermes chat --query <wake-prompt> --quiet --source agenttalk
```

Quick setup:

```bash
agenttalk supervisor add-agent --kind hermes --name research --handle research-agent --repo ~/Documents/GitHub/hermes-agent --json
agenttalk supervisor test-wake research --json
```

The connector passes AgentTalk state through `AGENTTALK_STATE_DIR`. Hermes should reply through AgentTalk CLI/MCP when it needs to send a message, then print a structured connector result.

Validation:

```bash
npm run smoke:wake-connectors
AGENTTALK_RUN_REAL_CONNECTOR_TESTS=1 npm run smoke:real-connectors
```
