import chalk from 'chalk';
import { WorklogError } from './errors.js';

export const log = {
  info(message: string): void {
    console.log(chalk.cyan('i'), message);
  },
  success(message: string): void {
    console.log(chalk.green('+'), message);
  },
  warn(message: string): void {
    console.log(chalk.yellow('!'), message);
  },
  error(message: string): void {
    console.error(chalk.red('x'), message);
  },
  plain(message = ''): void {
    console.log(message);
  },
  heading(message: string): void {
    console.log();
    console.log(chalk.bold.underline(message));
  },
  item(message: string): void {
    console.log(`  ${chalk.dim('•')} ${message}`);
  },
  dim(message: string): void {
    console.log(chalk.dim(message));
  },
};

/**
 * Wrap a commander action: WorklogErrors print cleanly, anything else
 * prints its message plus a note to re-run with --verbose semantics later.
 */
export function runAction<A extends unknown[]>(
  fn: (...args: A) => Promise<void>,
): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (err) {
      if (err instanceof WorklogError) {
        log.error(err.message);
        if (err.hint) log.dim(`  ${err.hint}`);
      } else {
        log.error(err instanceof Error ? err.message : String(err));
      }
      process.exitCode = 1;
    }
  };
}
