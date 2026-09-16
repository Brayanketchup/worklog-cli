#!/usr/bin/env node
import { Command } from 'commander';
import { registerSyncCommand } from './commands/sync.js';
import { registerCommitCommand } from './commands/commit.js';
import { registerReportCommand } from './commands/report.js';
import { registerFilesCommand } from './commands/files.js';
import { registerLogCommand } from './commands/log.js';
import { registerTodayCommand } from './commands/today.js';
import { registerStatusCommand } from './commands/status.js';
import { registerDiscardCommand } from './commands/discard.js';
import { registerReviewCommand } from './commands/review.js';
import { registerDoctorCommand } from './commands/doctor.js';

const program = new Command();

program
  .name('worklog')
  .description(
    'Automates a Git-based SFTP sync workflow (snapshot branch + work branch) and generates daily work reports.',
  )
  .version('0.3.0');

registerSyncCommand(program);
registerCommitCommand(program);
registerDiscardCommand(program);
registerReviewCommand(program);
registerReportCommand(program);
registerFilesCommand(program);
registerLogCommand(program);
registerTodayCommand(program);
registerStatusCommand(program);
registerDoctorCommand(program);

await program.parseAsync(process.argv);
