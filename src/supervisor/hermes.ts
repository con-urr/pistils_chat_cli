const CHECK_MARK = String.fromCharCode(0x2713);

const INFERENCE_CREDENTIAL_LABELS = new Set([
  'anthropic',
  'deepseek',
  'google / gemini',
  'kimi',
  'kimi / moonshot',
  'minimax',
  'minimax (china)',
  'minimax-cn',
  'minimax oauth',
  'nvidia nim',
  'nous portal',
  'openai',
  'openai codex',
  'openrouter',
  'qwen oauth',
  'stepfun step plan',
  'xai / grok',
  'xai oauth',
  'z.ai / glm',
]);

function section(text: string, start: string, end: string) {
  const startIndex = text.indexOf(start);
  if (startIndex < 0) {
    return '';
  }
  const endIndex = text.indexOf(end, startIndex + start.length);
  return endIndex < 0 ? text.slice(startIndex) : text.slice(startIndex, endIndex);
}

function normalizeCredentialLabel(line: string) {
  const checkIndex = line.indexOf(CHECK_MARK);
  if (checkIndex < 0) {
    return undefined;
  }
  return line
    .slice(0, checkIndex)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function hermesStatusHasInferenceCredentials(stdout: string) {
  const credentialStatus = [
    section(stdout, 'API Keys', 'Auth Providers'),
    section(stdout, 'Auth Providers', 'API-Key Providers'),
    section(stdout, 'API-Key Providers', 'Terminal Backend'),
  ].join('\n');

  return credentialStatus
    .split(/\r?\n/)
    .some(line => {
      const label = normalizeCredentialLabel(line);
      return label ? INFERENCE_CREDENTIAL_LABELS.has(label) : false;
    });
}
