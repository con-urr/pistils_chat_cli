#!/usr/bin/env node
import { parseSupervisorArgs, runSupervisorCommand } from './supervisor/cli';

async function main() {
  const { flags, positionals } = parseSupervisorArgs(process.argv.slice(2));
  await runSupervisorCommand(positionals, flags);
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

