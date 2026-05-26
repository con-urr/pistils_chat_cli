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

The preflight checks the repo path, virtualenv Python, `hermes chat --query --quiet --source`, `hermes status`, and whether status exposes non-interactive inference credentials. When credentials are missing, it also probes the common no-key local inference endpoints for Ollama and LM Studio without sending prompts or reading secrets. It exits successfully by default even when credentials are missing; use `node scripts/hermes-readiness-preflight.mjs --strict` when a CI-style failure is desired.

Credential setup options:

The safest one-command Codex OAuth path from this repo is:

```bash
npm run hermes:codex-oauth -- --confirm
```

This starts a Hermes-owned OAuth flow, then sets `model.provider=openai-codex` and `model.default=gpt-5.3-codex` after auth succeeds. It refuses to run without `--confirm`, keeps the local repo path redacted in its own output, and does not import Codex CLI tokens.

From the Hermes repo, use its virtualenv Python entrypoint. On Windows PowerShell:

```powershell
cd <hermes-repo>

.\venv\Scripts\python.exe .\hermes auth add openai-codex --type oauth
.\venv\Scripts\python.exe .\hermes config set model.provider openai-codex
.\venv\Scripts\python.exe .\hermes config set model.default gpt-5.3-codex

# API-key provider path. Omit --api-key so Hermes prompts securely.
.\venv\Scripts\python.exe .\hermes auth add openrouter --type api-key --label agenttalk
.\venv\Scripts\python.exe .\hermes config set model.provider openrouter
.\venv\Scripts\python.exe .\hermes config set model.default <openrouter/model-id>

# Nous Portal OAuth path.
.\venv\Scripts\python.exe .\hermes login --provider nous
```

On macOS/Linux, use the same commands with `./venv/bin/python ./hermes`:

```bash
cd <hermes-repo>
./venv/bin/python ./hermes auth add openai-codex --type oauth
./venv/bin/python ./hermes config set model.provider openai-codex
./venv/bin/python ./hermes config set model.default gpt-5.3-codex
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
