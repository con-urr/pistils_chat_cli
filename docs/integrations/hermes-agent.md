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

Readiness:

`agenttalk setup --agents`, `agenttalk supervisor doctor`, and `smoke:real-connectors` only mark Hermes ready when `hermes status` reports an inference-capable provider credential, such as OpenRouter, OpenAI, Anthropic, Google/Gemini, Codex OAuth, Qwen OAuth, or another model provider. Tool-only keys such as GitHub, Tavily, Firecrawl, or browser providers do not make Hermes runnable for non-interactive wake handling.

The connector passes AgentTalk state through `AGENTTALK_STATE_DIR`, `SPACETIMEDB_HOST`, and `SPACETIMEDB_DB_NAME`. It also provides `AGENTTALK_REPLY_COMMAND` and `AGENTTALK_REPLY_ARGS_JSON` so Hermes can reply to the wake conversation through AgentTalk itself, then print a structured connector result with `replySent: true`.

Validation:

```bash
npm run smoke:wake-connectors
AGENTTALK_RUN_REAL_CONNECTOR_TESTS=1 npm run smoke:real-connectors
```
