import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig } from '../config/config.js';
import { GitService } from '../git/repo.js';
import { areaKey } from '../report/group.js';
import type { PathFacts } from '../types/index.js';
import { log, runAction } from '../utils/logger.js';

interface ReviewOptions {
  dir?: string;
  json?: boolean;
}

/**
 * Describe what is sitting in the working tree, grouped and ready to act on.
 *
 * It reports STATE and never guesses provenance. Whether a changed file is an
 * SFTP download or your own editing is not recoverable from the repository:
 * measurement on the real history showed the tempting signals are unreliable
 * (a genuine download produced 107 scattered hunks while a hand-edit produced
 * 9, and every file's mtime is just the last checkout). So both commands are
 * offered for every group, and the choice stays with the person who knows.
 */
export function registerReviewCommand(program: Command): void {
  program
    .command('review')
    .description('Show what changed in the working tree, grouped, with the command for each case')
    .option('--dir <path>', 'only look under this directory')
    .option('--json', 'machine-readable output')
    .action(runAction(reviewAction));
}

async function reviewAction(options: ReviewOptions): Promise<void> {
  const git = new GitService();
  git.setReadOnly(true);
  const root = await git.ensureRepo();
  const config = await loadConfig(root);

  const merge = await git.mergeState();
  if (merge.inProgress) {
    log.warn('A merge is in progress — finish it before importing or committing anything.');
    for (const file of merge.conflicted) log.plain(`    ${chalk.red('•')} ${file}`);
    log.plain('');
  }

  const pathspec = options.dir
    ? path.relative(root, path.resolve(process.cwd(), options.dir)).split(path.sep).join('/')
    : undefined;

  const entries = await git.statusEntries(pathspec || undefined);
  if (entries.length === 0) {
    if (options.json) log.plain(JSON.stringify({ schemaVersion: 1, files: [] }, null, 2));
    else log.info('Working tree is clean — nothing to review.');
    return;
  }

  const stats = new Map(
    (await git.numstatAgainst('HEAD')).map((f) => [f.path, f]),
  );
  const history = await git.pathHistoryMap(config.workBranch, config.syncCommitPrefix);

  const facts: PathFacts[] = [];
  for (const entry of entries) {
    const stat = stats.get(entry.path);
    const seen = history.get(entry.path) ?? { own: 0, sync: 0 };

    let matchesServerSnapshot: boolean | null = null;
    if (entry.state !== 'deleted' && entry.state !== 'untracked') {
      const worktree = await git.hashObjectWorktree(entry.path);
      const snapshot = await git.blobHashInRef(config.mainBranch, entry.path);
      matchesServerSnapshot = worktree !== null && snapshot !== null ? worktree === snapshot : null;
    }

    facts.push({
      path: entry.path,
      state: entry.state,
      insertions: stat?.insertions ?? null,
      deletions: stat?.deletions ?? null,
      binary: Boolean(stat?.binary),
      matchesServerSnapshot,
      byteExact: await isByteExact(root, entry),
      yourCommits: seen.own,
      snapshotCommits: seen.sync,
    });
  }

  if (options.json) {
    log.plain(JSON.stringify({ schemaVersion: 1, files: facts }, null, 2));
    return;
  }

  renderReview(facts);
}

/** False when the file holds a CR byte, which must never reach the server. */
async function isByteExact(
  root: string,
  entry: { path: string; state: string },
): Promise<boolean | null> {
  if (entry.state === 'deleted') return null;
  try {
    const buf = await readFile(path.join(root, entry.path));
    return !buf.includes(0x0d);
  } catch {
    return null;
  }
}

function renderReview(facts: PathFacts[]): void {
  const groups = new Map<string, PathFacts[]>();
  for (const fact of facts) {
    const { key } = areaKey(fact.path);
    const list = groups.get(key) ?? [];
    list.push(fact);
    groups.set(key, list);
  }

  log.heading(`Working tree — ${facts.length} file${facts.length === 1 ? '' : 's'}`);

  for (const [key, list] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    log.plain('');
    log.plain(`  ${chalk.cyan(key)}  ${chalk.dim(`${list.length} file(s)`)}`);
    for (const fact of list) {
      const name = fact.path.split('/').pop() ?? fact.path;
      const state = fact.state.padEnd(9);
      const lines =
        fact.insertions === null && fact.deletions === null
          ? ''
          : chalk.dim(` +${fact.insertions ?? 0}/-${fact.deletions ?? 0}`);
      const seen = chalk.dim(
        ` yours: ${fact.yourCommits}  snapshots: ${fact.snapshotCommits}`,
      );
      log.plain(`    ${chalk.dim('•')} ${name.padEnd(36)} ${state}${lines}${seen}`);
      if (fact.byteExact === false) {
        log.plain(`      ${chalk.red('CRLF present — this would deploy broken')}`);
      }
    }

    const dir = list[0]!.path.split('/').slice(0, -1).join('/');
    log.plain('');
    log.plain(`    ${chalk.dim('If you downloaded these:')}  worklog sync ${dir}/<file> …`);
    log.plain(`    ${chalk.dim('If this is your work:   ')}  worklog commit --dir ${dir} -m "<message>"`);
  }

  // One advisory line, deliberately not a machine-readable verdict: a file the
  // user has never committed which the server keeps sending tends to be a
  // download, but "tends to" is the whole truth and the tool should say so.
  const likelyImports = facts.filter((f) => f.yourCommits === 0 && f.snapshotCommits > 0);
  if (likelyImports.length > 0) {
    log.plain('');
    log.plain(chalk.bold('  Worth a look'));
    for (const fact of likelyImports.slice(0, 5)) {
      log.plain(
        `    ${fact.path} — you have never committed it, and ${fact.snapshotCommits} server snapshot(s) carry it.`,
      );
    }
    log.dim('    Downloads often look like this. Confirm with: git diff -- <path>');
  }

  log.plain('');
  log.dim('  worklog reports what changed. Which of these is a download, only you know.');
}
