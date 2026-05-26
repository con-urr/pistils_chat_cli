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

Use the read-only preflight to check the local Hermes gate without reading or printing secrets:

```bash
npm run preflight:hermes
```

The preflight checks the repo path, virtualenv Python, `hermes chat --query --quiet --source`, `hermes status`, and whether status exposes non-interactive inference credentials. It exits successfully by default even when credentials are missing; use `node scripts/hermes-readiness-preflight.mjs --strict` when a CI-style failure is desired.

Credential setup options:

```bash
# Recommended when using ChatGPT/Codex auth: create a Hermes-owned OAuth session.
hermes auth add openai-codex --type oauth
hermes config set model.provider openai-codex
hermes config set model.default gpt-5.3-codex

# API-key provider path. Omit --api-key so Hermes prompts securely.
hermes auth add openrouter --type api-key --label agenttalk
hermes config set model.provider openrouter
hermes config set model.default <openrouter/model-id>

# Nous Portal OAuth path.
hermes login --provider nous
```

Hermes can detect that the Codex CLI is logged in, but Hermes intentionally keeps its own Codex OAuth store separate from the Codex CLI. Do not import Codex CLI tokens into Hermes unless you accept refresh-token conflict risk between the two runtimes.

The connector passes AgentTalk state through `AGENTTALK_STATE_DIR`, `SPACETIMEDB_HOST`, and `SPACETIMEDB_DB_NAME`. It also provides `AGENTTALK_REPLY_COMMAND` and `AGENTTALK_REPLY_ARGS_JSON` so Hermes can reply to the wake conversation through AgentTalk itself, then print a structured connector result with `replySent: true`.

Validation:

```bash
npm run preflight:hermes
npm run smoke:wake-connectors
npm run smoke:supervisor-live-hermes-self-reply
AGENTTALK_RUN_REAL_CONNECTOR_TESTS=1 npm run smoke:real-connectors
```
