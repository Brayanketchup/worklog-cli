import type { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig } from '../config/config.js';
import { GitService } from '../git/repo.js';
import { clearLock, readLock } from '../safety/lock.js';
import { readJournal, REF_ROOT } from '../safety/safepoint.js';
import { log, runAction } from '../utils/logger.js';

interface DoctorOptions {
  fix?: boolean;
  popStash?: boolean;
  lost?: boolean;
}

type Severity = 'critical' | 'warning' | 'info';

interface Finding {
  severity: Severity;
  title: string;
  detail: string[];
  /** A command the user can run. Printed, never executed on its own. */
  suggestion?: string;
}

/**
 * Diagnose the repository and, only where it is provably safe, repair it.
 *
 * Everything here is conservative by construction: it never runs
 * `merge --abort`, `reset --hard`, `stash drop`, `clean` or `checkout -f`,
 * because each of those can destroy work that has no remote to restore from.
 */
export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check the repository for stuck merges, stranded stashes and pending merges')
    .option('--fix', 'apply only the repairs that cannot lose anything')
    .option('--pop-stash', 'restore a stash worklog left behind (shows its contents first)')
    .option('--lost', 'list commits pinned by worklog that no branch can reach')
    .action(runAction(doctorAction));
}

async function doctorAction(options: DoctorOptions): Promise<void> {
  const git = new GitService();
  if (!options.fix && !options.popStash) git.setReadOnly(true);
  const root = await git.ensureRepo();
  const config = await loadConfig(root);

  if (options.lost) {
    await reportLost(git);
    return;
  }

  const findings: Finding[] = [];

  const merge = await git.mergeState();
  if (merge.inProgress) {
    findings.push({
      severity: 'critical',
      title: merge.conflicted.length > 0 ? 'A merge is stuck on conflicts' : 'A merge is resolved but not committed',
      detail:
        merge.conflicted.length > 0
          ? ['Conflicted files:', ...merge.conflicted.map((f) => `  • ${f}`)]
          : ['All conflicts are resolved; the merge just needs to be committed.'],
      suggestion:
        merge.conflicted.length > 0
          ? 'Edit each file, then: git add <files> && git commit'
          : 'git commit',
    });
  }

  if (await git.isRebasing()) {
    findings.push({
      severity: 'critical',
      title: 'A rebase is in progress',
      detail: ['worklog will not touch the repository while a rebase is underway.'],
      suggestion: 'git rebase --continue (or --abort if you want to give it up)',
    });
  }

  const stashes = await git.stashListDetailed();
  const mine = stashes.filter((s) => s.subject.includes('worklog: auto-stash'));
  for (const stash of mine) {
    const contents = await git.stashContents(stash.hash);
    const detail = [`${stash.selector} — taken on ${stash.branch ?? 'an unknown branch'}`];
    for (const file of contents.tracked) detail.push(`  modified  ${file}`);
    for (const file of contents.untracked) detail.push(`  untracked ${file}`);
    if (contents.untracked.length > 0) {
      detail.push('');
      detail.push('The untracked files above are invisible in your working tree until this is restored.');
    }
    findings.push({
      severity: 'warning',
      title: 'worklog left a stash behind',
      detail,
      suggestion: 'worklog doctor --pop-stash',
    });
  }

  const branch = await git.currentBranchOrNull();
  if (branch === null) {
    const head = await git.resolve('HEAD');
    const containing = head ? await git.branchesContaining(head) : [];
    findings.push({
      severity: containing.length > 0 ? 'warning' : 'critical',
      title: 'HEAD is detached',
      detail:
        containing.length > 0
          ? [`This commit is still on: ${containing.join(', ')} — nothing is lost.`]
          : ['This commit is on no branch. Leaving it would make it unreachable.'],
      suggestion:
        containing.length > 0
          ? `git checkout ${config.workBranch}`
          : `git branch rescue-work ${head?.slice(0, 12) ?? 'HEAD'}`,
    });
  } else if (branch !== config.workBranch && !merge.inProgress) {
    findings.push({
      severity: 'info',
      title: `You are on "${branch}", not "${config.workBranch}"`,
      detail: ['Development commits belong on the work branch.'],
      suggestion: `git checkout ${config.workBranch}`,
    });
  }

  const hasBoth =
    (await git.branchExists(config.mainBranch)) && (await git.branchExists(config.workBranch));
  let pending = 0;
  if (hasBoth) {
    pending = await git.commitsAhead(config.workBranch, config.mainBranch);
    if (pending > 0) {
      findings.push({
        severity: 'warning',
        title: `${config.mainBranch} has ${pending} commit${pending === 1 ? '' : 's'} not in ${config.workBranch}`,
        detail: ['Server snapshots are waiting to be merged into your work.'],
        suggestion: `git checkout ${config.workBranch} && git merge ${config.mainBranch}`,
      });
    }
  }

  const lock = await readLock(git);
  if (lock) {
    findings.push({
      severity: lock.stale ? 'warning' : 'info',
      title: lock.stale ? 'A stale worklog lock is present' : 'A worklog command is running',
      detail: [`pid ${lock.file.pid}, started ${lock.file.startedAt || 'unknown'} (${lock.file.command})`],
      suggestion: lock.stale ? 'worklog doctor --fix' : undefined,
    });
  }

  const journal = await readJournal(git);
  const interrupted = journal.filter((e) => e.status === 'running' && e.pid !== process.pid);
  for (const entry of interrupted) {
    findings.push({
      severity: 'warning',
      title: `A "${entry.command}" run never finished`,
      detail: [
        `Started ${entry.startedAt}.`,
        `Everything from before it is pinned at ${REF_ROOT}/undo/${entry.id}/`,
        ...(entry.incoming.length > 0
          ? [`${entry.incoming.length} captured file(s) are kept in .git/worklog/incoming/${entry.id}/`]
          : []),
      ],
    });
  }

  const eol = await git.eolAudit();
  if (eol.length > 0) {
    findings.push({
      severity: 'warning',
      title: `${eol.length} file(s) carry CRLF line endings`,
      detail: [
        ...eol.slice(0, 8).map((e) => `  • ${e.path}`),
        ...(eol.length > 8 ? [`  … and ${eol.length - 8} more`] : []),
        'These deploy over SFTP as-is; a CR on a CGI shebang stops the server running it.',
      ],
      suggestion: 'Check .gitattributes has "* text=auto eol=lf", then re-checkout the files.',
    });
  }

  if (options.popStash) {
    await popStash(git, mine);
    return;
  }

  if (options.fix) {
    await applyFixes(git, config, { pending, staleLock: Boolean(lock?.stale), merge });
    return;
  }

  render(findings);
  if (findings.some((f) => f.severity === 'critical')) process.exitCode = 1;
}

function render(findings: Finding[]): void {
  log.heading('Repository check');

  if (findings.length === 0) {
    log.plain(chalk.green('  Everything looks healthy.'));
    return;
  }

  const order: Severity[] = ['critical', 'warning', 'info'];
  for (const severity of order) {
    for (const finding of findings.filter((f) => f.severity === severity)) {
      const badge =
        severity === 'critical'
          ? chalk.red('CRITICAL')
          : severity === 'warning'
            ? chalk.yellow('WARNING ')
            : chalk.cyan('INFO    ');
      log.plain('');
      log.plain(`  ${badge} ${chalk.bold(finding.title)}`);
      for (const line of finding.detail) log.plain(`           ${line}`);
      if (finding.suggestion) log.plain(`           ${chalk.dim(`-> ${finding.suggestion}`)}`);
    }
  }
}

async function popStash(
  git: GitService,
  stashes: Array<{ selector: string; hash: string; subject: string; branch: string | null }>,
): Promise<void> {
  const stash = stashes[0];
  if (!stash) {
    log.info('No worklog stash to restore.');
    return;
  }
  const contents = await git.stashContents(stash.hash);
  log.heading(`Restoring ${stash.selector}`);
  for (const file of contents.tracked) log.plain(`  modified  ${file}`);
  for (const file of contents.untracked) log.plain(`  untracked ${file}`);

  const merge = await git.mergeState();
  if (merge.inProgress) {
    log.plain('');
    log.error('A merge is in progress — finish it before restoring the stash.');
    process.exitCode = 1;
    return;
  }

  try {
    await git.stashPop();
    log.plain('');
    log.success('Stash restored.');
  } catch (err) {
    log.plain('');
    log.error(`Could not pop the stash: ${(err as Error).message}`);
    log.dim(`  The stash is still there. Take one file at a time with:`);
    log.dim(`    git checkout ${stash.selector} -- <path>`);
    process.exitCode = 1;
  }
}

async function applyFixes(
  git: GitService,
  config: { mainBranch: string; workBranch: string },
  state: { pending: number; staleLock: boolean; merge: { inProgress: boolean } },
): Promise<void> {
  log.heading('Applying safe repairs');
  let did = 0;

  if (state.staleLock) {
    await clearLock(git);
    log.success('Cleared a stale lock.');
    did += 1;
  }

  if (state.merge.inProgress) {
    log.warn('A merge is in progress — that is yours to finish; doctor will not touch it.');
  } else if (state.pending > 0) {
    const branch = await git.currentBranchOrNull();
    if (branch !== config.workBranch) {
      log.warn(`Not on ${config.workBranch}; skipping the merge. Run: git checkout ${config.workBranch}`);
    } else if (await git.isDirty()) {
      log.warn('Working tree is dirty; skipping the merge so nothing of yours moves.');
    } else if (await git.mergeFastForwardOnly(config.mainBranch)) {
      log.success(`Fast-forwarded ${config.workBranch} to ${config.mainBranch}.`);
      did += 1;
    } else {
      log.warn('That merge is not a fast-forward, so it could conflict — doing it is your call.');
      log.dim(`  git merge ${config.mainBranch}`);
    }
  }

  if (did === 0) log.info('Nothing was safe to fix automatically.');
}

async function reportLost(git: GitService): Promise<void> {
  const refs = await git.listRefs(REF_ROOT);
  log.heading('Commits pinned by worklog but not on any branch');

  if (refs.length === 0) {
    log.plain(chalk.dim('  nothing pinned'));
    return;
  }

  const lost = await git.commitsNotOnAnyBranch(refs.map((r) => r.ref));
  if (lost.length === 0) {
    log.plain(chalk.green(`  None — all ${refs.length} pinned object(s) are still on a branch.`));
    return;
  }

  for (const commit of lost) {
    log.plain('');
    log.plain(`  ${chalk.yellow(commit.shortHash)} ${commit.message}`);
    log.plain(`    ${chalk.dim(`${commit.day} ${commit.time}`)}`);
    log.plain(`    ${chalk.dim(`git cherry-pick ${commit.shortHash}`)}`);
  }
  log.plain('');
  log.dim('  These are safe from garbage collection for as long as the pins exist.');
}
