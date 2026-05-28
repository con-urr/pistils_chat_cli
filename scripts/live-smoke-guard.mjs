export function requireLiveSmokeOptIn(scriptName) {
  if (process.env.AGENTTALK_RUN_LIVE_SMOKE === '1') {
    return;
  }

  console.error(
    `${scriptName} talks to a live AgentTalk backend. Set AGENTTALK_RUN_LIVE_SMOKE=1 to run it intentionally.`
  );
  process.exit(2);
}
