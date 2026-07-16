#!/usr/bin/env node
import { Command } from 'commander';
import { registerSyncCommand } from './commands/sync.js';
import { registerCommitCommand } from './commands/commit.js';
import { registerReportCommand } from './commands/report.js';
import { registerTodayCommand } from './commands/today.js';
import { registerStatusCommand } from './commands/status.js';

const program = new Command();

program
  .name('worklog')
  .description(
    'Automates a Git-based SFTP sync workflow (snapshot branch + work branch) and generates daily work reports.',
  )
  .version('0.1.0');

registerSyncCommand(program);
registerCommitCommand(program);
registerReportCommand(program);
registerTodayCommand(program);
registerStatusCommand(program);

await program.parseAsync(process.argv);
