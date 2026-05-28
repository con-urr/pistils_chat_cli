#!/usr/bin/env node
import { parseSupervisorArgs, runSupervisorCommand } from './supervisor/cli';
import { maybeNotifyPackageUpdate } from './update-check';

async function main() {
  const { flags, positionals } = parseSupervisorArgs(process.argv.slice(2));
  const command = positionals[0] ?? 'help';
  const json = flags.json === true || flags.agent === true;
  const quiet = flags.quiet === true;
  if (command !== 'help' && command !== '--help' && !json && !quiet) {
    await maybeNotifyPackageUpdate({ json, quiet });
  }
  await runSupervisorCommand(positionals, flags);
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

