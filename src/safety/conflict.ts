import chalk from 'chalk';
import type { GitService } from '../git/repo.js';
import { log } from '../utils/logger.js';

export interface ConflictContext {
  conflicted: string[];
  branch: string;
  /** True when uncommitted work is still sitting in a stash. */
  stashed: boolean;
  safepointId: string;
  error: Error;
}

/**
 * The single place a merge conflict is explained.
 *
 * Previously a conflict printed a warning here, another in the outer catch and
 * a third from the action wrapper, so the one line that mattered — that the
 * user's uncommitted work was invisible inside a stash — scrolled past. It
 * also implied the repository could be left as it was, which git does not
 * allow: a conflicted merge blocks every branch switch until it is resolved.
 */
export async function reportConflict(git: GitService, ctx: ConflictContext): Promise<void> {
  log.plain('');
  log.error(`Merge conflict on ${ctx.branch}. The snapshot on the other branch is safe.`);
  log.plain('');

  if (ctx.conflicted.length > 0) {
    log.plain(chalk.bold('  Conflicted files'));
    for (const file of ctx.conflicted) log.plain(`    ${chalk.red('•')} ${file}`);
    log.plain('');
  }

  log.plain(chalk.bold('  Where you are'));
  log.plain(`    You are on ${chalk.cyan(ctx.branch)}, part-way through a merge.`);
  log.plain('    Git will refuse to switch branches until this is finished.');
  log.plain('');

  log.plain(chalk.bold('  How to finish'));
  log.plain('    1. Edit each file above. The incoming side is the server version.');
  log.plain('    2. git add <files>');
  log.plain('    3. git commit');

  if (ctx.stashed) {
    const stashes = await git.stashListDetailed();
    const mine = stashes.find((s) => s.subject.includes('worklog: auto-stash'));
    log.plain('');
    log.plain(chalk.bold('  Your uncommitted work is stashed'));
    if (mine) {
      log.plain(`    ${mine.selector}  ${chalk.dim(mine.subject)}`);
      const contents = await git.stashContents(mine.hash);
      for (const file of contents.tracked) log.plain(`      ${chalk.dim('modified ')} ${file}`);
      for (const file of contents.untracked) {
        log.plain(`      ${chalk.magenta('untracked')} ${file}`);
      }
      log.plain('');
      log.plain('    4. git stash pop');
      log.plain(
        `    If the pop fails because a file is in the way, take it out of the stash directly:`,
      );
      log.plain(chalk.dim(`      git checkout ${mine.selector} -- <path>`));
    } else {
      log.plain('    4. git stash pop');
    }
  }

  log.plain('');
  log.dim(`  Everything as it was before this run is pinned at refs/worklog/undo/${ctx.safepointId}/`);
  log.dim('  Run "worklog doctor" at any point to see the current state.');
}
