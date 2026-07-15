#!/usr/bin/env node
import { Command } from 'commander';
import { runDoctor } from '../commands/doctor.js';
import { runPlanCommand } from '../commands/plan.js';
import { exitCodeFor, type CommandResult } from '../commands/result.js';
import { runStatusCommand } from '../commands/status.js';
import { runSyncCommand } from '../commands/sync.js';
import { runVerifyCommand } from '../commands/verify.js';

type Handler = (
  options: Record<string, unknown>,
) => CommandResult | Promise<CommandResult>;

interface ProgramHandlers {
  doctor: Handler;
  plan: Handler;
  sync: Handler;
  status: Handler;
  verify: Handler;
}

interface ProgramOptions {
  handlers?: Partial<ProgramHandlers>;
  write?: (output: string) => void;
}

function pretty(result: CommandResult): string {
  if (Array.isArray(result.actions)) {
    return result.actions.map((action) => JSON.stringify(action)).join('\n');
  }
  return JSON.stringify(result, null, 2);
}

export function createProgram(options: ProgramOptions = {}): Command {
  const write = options.write ?? ((output) => process.stdout.write(output));
  const handlers: ProgramHandlers = {
    doctor:
      options.handlers?.doctor ??
      ((value) =>
        runDoctor({ configPath: value.configPath as string }).then(
          (result) => result as unknown as CommandResult,
        )),
    plan:
      options.handlers?.plan ??
      ((value) =>
        runPlanCommand(
          value as unknown as Parameters<typeof runPlanCommand>[0],
        )),
    sync:
      options.handlers?.sync ??
      ((value) =>
        runSyncCommand(
          value as unknown as Parameters<typeof runSyncCommand>[0],
        )),
    status:
      options.handlers?.status ??
      ((value) =>
        runStatusCommand(
          value as unknown as Parameters<typeof runStatusCommand>[0],
        )),
    verify:
      options.handlers?.verify ??
      ((value) =>
        runVerifyCommand(
          value as unknown as Parameters<typeof runVerifyCommand>[0],
        )),
  };
  const execute =
    (handler: Handler) => async (value: Record<string, unknown>) => {
      const commandOptions = {
        ...value,
        ...(typeof value.config === 'string'
          ? { configPath: value.config }
          : {}),
        ...(typeof value.root === 'string' ? { rootId: value.root } : {}),
      };
      try {
        const result = await handler(commandOptions);
        write(`${value.json ? JSON.stringify(result) : pretty(result)}\n`);
        const code = exitCodeFor(result);
        if (code !== 0) process.exitCode = code;
      } catch (error) {
        const code = exitCodeFor(undefined, error);
        write(
          `${value.json ? JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'Unknown error', exitCode: code }) : `ERROR ${error instanceof Error ? error.message : 'Unknown error'}`}\n`,
        );
        process.exitCode = code;
      }
    };
  const program = new Command()
    .name('notion-to-obsidian')
    .description('Mirror Notion content to Obsidian')
    .version('0.1.0');
  const common = (command: Command) =>
    command
      .option('-c, --config <path>', 'configuration file', 'config.yaml')
      .option('--json', 'print JSON');
  common(program.command('doctor').description('Check prerequisites')).action(
    execute(handlers.doctor),
  );
  common(program.command('plan').description('Show planned actions')).action(
    execute(handlers.plan),
  );
  common(program.command('sync').description('Synchronize content'))
    .option('--dry-run', 'do not persist changes')
    .option('--full', 'reprocess all pages')
    .option('--page-id <id>', 'synchronize one page')
    .option('--root <id>', 'synchronize one root')
    .option('--verbose', 'enable verbose logging')
    .option('--strict', 'treat warnings as partial failures')
    .option('--allow-large-trash', 'allow trash safety limit override')
    .action(execute(handlers.sync));
  common(
    program.command('status').description('Show synchronization status'),
  ).action(execute(handlers.status));
  common(program.command('verify').description('Verify managed files')).action(
    execute(handlers.verify),
  );
  return program;
}

if (import.meta.url === `file://${process.argv[1]}`)
  await createProgram().parseAsync();
