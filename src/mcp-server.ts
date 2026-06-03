#!/usr/bin/env node
import './node-compat';
import { runAgentTalkMcpServer } from './mcp/server';

async function main() {
  const transportIndex = process.argv.findIndex(arg => arg === '--transport');
  const transport = transportIndex >= 0 ? process.argv[transportIndex + 1] : 'stdio';
  if (transport && transport !== 'stdio') {
    throw new Error(`Unsupported MCP transport '${transport}'. Local agenttalk-mcp supports stdio.`);
  }
  await runAgentTalkMcpServer();
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

