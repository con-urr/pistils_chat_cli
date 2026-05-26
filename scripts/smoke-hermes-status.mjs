import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { hermesStatusHasInferenceCredentials } = require('../dist/supervisor/hermes.js');

const check = String.fromCharCode(0x2713);
const cross = String.fromCharCode(0x2717);

function status(lines) {
  return [
    'Environment',
    '  Model:        (not set)',
    '  Provider:     Auto',
    '',
    'API Keys',
    ...lines.apiKeys,
    '',
    'Auth Providers',
    ...lines.authProviders,
    '',
    'API-Key Providers',
    ...lines.apiKeyProviders,
    '',
    'Terminal Backend',
  ].join('\n');
}

const cases = [
  {
    name: 'tool-only-keys-do-not-count',
    expected: false,
    stdout: status({
      apiKeys: [
        `  GitHub        ${check} configured`,
        `  Tavily        ${check} configured`,
        `  Firecrawl     ${check} configured`,
      ],
      authProviders: [`  OpenAI Codex  ${cross} not logged in`],
      apiKeyProviders: [`  Kimi / Moonshot  ${cross} not configured`],
    }),
  },
  {
    name: 'openrouter-api-key-counts',
    expected: true,
    stdout: status({
      apiKeys: [`  OpenRouter    ${check} configured`],
      authProviders: [],
      apiKeyProviders: [],
    }),
  },
  {
    name: 'codex-oauth-counts',
    expected: true,
    stdout: status({
      apiKeys: [],
      authProviders: [`  OpenAI Codex  ${check} logged in`],
      apiKeyProviders: [],
    }),
  },
  {
    name: 'api-key-provider-counts',
    expected: true,
    stdout: status({
      apiKeys: [],
      authProviders: [],
      apiKeyProviders: [`  Z.AI / GLM       ${check} configured`],
    }),
  },
];

for (const item of cases) {
  const actual = hermesStatusHasInferenceCredentials(item.stdout);
  if (actual !== item.expected) {
    throw new Error(`${item.name}: expected ${item.expected}, got ${actual}`);
  }
}

console.log(JSON.stringify({ ok: true, cases: cases.length }));
