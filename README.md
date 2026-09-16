# WorkLog CLI

A standalone CLI that automates a Git-based workflow for codebases that live on a server you can only reach through **SFTP** — no `git pull`, no remote. It also generates daily work reports from your Git history.

Built with **TypeScript** and **Node.js**, designed to work with **any Git repository**.

## Table of Contents

- [The Problem](#the-problem)
- [The Workflow It Automates](#the-workflow-it-automates)
- [Requirements](#requirements)
- [Installation](#installation)
- [Command Reference](#command-reference)
  - [worklog sync](#worklog-sync-files)
  - [worklog commit](#worklog-commit-files--m-message)
  - [worklog discard](#worklog-discard-files)
  - [worklog review](#worklog-review)
  - [worklog report](#worklog-report)
  - [worklog files](#worklog-files)
  - [worklog log](#worklog-log)
  - [worklog today](#worklog-today)
  - [worklog status](#worklog-status)
  - [worklog doctor](#worklog-doctor)
- [Never Losing Work](#never-losing-work)
- [Configuration](#configuration)
- [A Typical Day](#a-typical-day)
- [How Sync Works Internally](#how-sync-works-internally)
- [Troubleshooting](#troubleshooting)
- [Architecture](#architecture)
- [Development](#development)
- [Roadmap](#roadmap)

## The Problem

You work on a codebase that lives on a server accessed only through SFTP. There is no Git remote, so `git pull` is impossible. When another developer changes a file on the server, you download it and overwrite your local copy — and without tooling you lose track of which files came from the server, which changes are yours, and what you actually did each day.

## The Workflow It Automates

The tool assumes two local branches:

| Branch | Purpose |
| --- | --- |
| `main` | A mirror of the server state. Every file downloaded from SFTP is committed here as a production snapshot (`SFTP sync: update account.cgi`). It is a *timeline of server versions*, not a deployment branch. Newer downloads overwrite older working copies; Git history preserves every previous version. |
| `work` | Your development branch. Every feature, fix, and enhancement lives here. It never loses your commits — server snapshots arrive via normal Git merges. |

When a teammate changes a file on the server, you download it via SFTP and overwrite your local copy.

- Use `worklog sync` for a normal server import. It records the snapshot on `main` and merges it into `work`, preserving your development changes.
- Use `worklog discard` when the file is already tracked, your committed changes are no longer wanted, and the newly downloaded server copy must replace the current version on `work`.

## Requirements

- Node.js **≥ 18**
- Git available on `PATH`
- A local Git repository with the two branches described above (default names `main` and `work`; both configurable)

## Installation

```bash
git clone <this-repo>
cd worklog
npm install
npm run build
npm link        # makes the `worklog` command available globally
```

To uninstall the global command: `npm unlink -g worklog`.

To run without linking:

```bash
node /path/to/worklog/dist/index.js <command>
```

For development without building:

```bash
npm run dev -- <command>
```

## Command Reference

Every command must be run from inside the target Git repository (any subdirectory works — the repo root is auto-detected). All commands exit with code `0` on success and `1` on failure, printing a human-readable error plus a recovery hint.

---

### `worklog sync <files...>`

Import newly downloaded SFTP file(s) into `main` and merge them into `work`.

**Usage:** copy the downloaded file over your local copy first, then:

```bash
worklog sync path/to/account.cgi
worklog sync file1.cgi file2.cgi file3.cgi   # all three → ONE snapshot commit
worklog sync --from ~/sftp-downloads         # import a whole drop folder
worklog sync file1.cgi --dry-run             # show the plan, change nothing
```

**What it does, in order:**

1. Refuses to start if a merge is already underway or files are already staged — sync needs sole control of the index.
2. Captures the downloaded bytes into memory *and* into `.git/worklog/incoming/`, then writes a safepoint pinning every branch tip.
3. Removes the download from the working tree (the bytes are safe) so it cannot collide with the stash.
4. Stashes any other uncommitted changes.
5. Switches to `main`, writes each file, verifies the bytes landed intact, stages them, and proves the index holds exactly those paths before committing.
6. Switches to `work`, **pops the stash**, then merges `main` in.
7. Restores the branch you started on.

**Behaviors to know:**

- **All the files you name become one commit**, with every path listed as a bullet in the body. Earlier versions made one commit per file, which turned a single import day into hundreds of commits. Use `--per-file` for the old behavior.
- **Directories and globs are refused.** Expanding them would sweep in your own uncommitted edits, wipe them from the working tree, and publish them on `main` as if the server had sent them. Use `--from <folder>` — everything in a drop folder is a download by definition.
- A file identical to what `main` already has is **skipped** with a warning (no empty commits).
- The stash is popped **before** the merge. Git will not let you leave a conflicted merge, so a stash popped afterwards would be stranded with its untracked files invisible.
- On a **merge conflict**, WorkLog stops on `work` and prints one recovery block: the conflicted files, the resolve sequence, and the stash contents including untracked files. It never guesses at a resolution.

| Option | Effect |
| --- | --- |
| `--from <dir>` | Import every file under a drop folder, mirroring its paths into the repo. |
| `-m, --message <subject>` | Override the generated snapshot subject. |
| `--per-file` | One commit per file instead of one batched commit. |
| `-n, --dry-run` | Print the exact plan and exit without changing anything. |
| `--yes` | Allow a batch larger than 50 files. |
| `--no-restore` | Stay on `work` after the merge instead of returning to the branch you started on. |

---

### `worklog commit [files...] -m "message"`

Stage files and create a development commit on `work`.

```bash
worklog commit lib/modules/catalog/brands.cgi -m "Fix brand URL generation"
worklog commit --all -m "Add crawlers for vendors 24, 489 and 106"
worklog commit -m "Commit whatever is already staged"
```

**Behaviors to know:**

- Refuses to run on any branch other than `work` (guard against polluting `main`).
- With file arguments: stages exactly those files.
- With `--all`: stages everything, including new and deleted files.
- With neither: commits whatever you already staged with `git add`.
- Fails with a clear message when nothing is staged or the message is empty.

| Option | Effect |
| --- | --- |
| `-m, --message <message>` | Commit message (**required**). |
| `-a, --all` | Stage all changes, including new and deleted files. |
| `--dir <path>` | Stage every changed file under a directory. |
| `--include-untracked` | With `--dir`, also stage new files. |
| `-n, --dry-run` | List what would be committed and exit. |
| `--any-branch` | Allow committing on a branch other than `work`. |

It refuses to run mid-merge, and warns (without blocking) when a file you are committing is byte-identical to the server snapshot — usually a sign it is a download that belongs in `sync`.

---

### `worklog discard <files...>`

Accept newly downloaded SFTP file(s) as authoritative and replace their existing versions on `work`.

Use this when:

1. The file is already tracked by WorkLog.
2. You previously committed changes to it on `work`.
3. Those changes are no longer needed.
4. You downloaded a fresh server copy over the local file.
5. The downloaded copy must replace your previous development version exactly.

```bash
# First, download the current server copy over the local file.
worklog discard uniprouniforms.com/up/catalog.cgi

# Multiple already-tracked files are supported.
worklog discard up/catalog.cgi up/account.cgi
```

**What it does, in order:**

1. Requires the command to run from `work`.
2. Reads all downloaded file contents into memory and validates every path before changing anything.
3. Refuses files that are untracked or missing from `main`; new files must use `worklog sync`.
4. Removes the downloaded target files from the working tree while their bytes remain safe in memory.
5. Stashes any unrelated uncommitted work.
6. Switches to `main` and records each downloaded file as the latest `SFTP sync: update <file>` snapshot.
7. Switches to `work` and restores each target file from the new `main` snapshot.
8. Creates a replacement commit on `work` when its previous content differed.
9. Merges `main` into `work` and restores unrelated stashed changes.

The previous development commits remain in Git history. Their code is no longer present in the current file, but the history is not rewritten or deleted.

| Option | Effect |
| --- | --- |
| `-m, --message <message>` | Override the replacement commit message on `work`. The default is `Accept server version of <file>`. |

**Important:** download the server copy first. `discard` treats the file currently on disk as the authoritative server version.

Use `worklog sync` instead when importing a new file or when normal merging should preserve your development changes.

---

### `worklog review`

Read-only. Shows what is sitting in your working tree right now, grouped by directory, with the facts about each file: its state, line counts, whether it matches the server snapshot, whether it contains CRLF, and how many of your commits versus snapshot commits have touched it.

```bash
worklog review
worklog review --dir up/web/html/catalog
worklog review --json
```

It reports **state**, and deliberately never guesses **provenance**. Whether a changed file is an SFTP download or your own editing simply is not recoverable from the repository — measured against real history, the tempting signals are wrong (a genuine download produced 107 scattered hunks while a hand-edit produced 9; every file's mtime is just the last checkout). So it prints both the `sync` command and the `commit` command for each group and leaves the call to you.

---

### `worklog report`

Report a day's, a range's, or a single commit's work: development commits, the files changed, the actual lines changed, production imports, and a summary.

```bash
worklog report                     # today
worklog report --stats             # ...with per-file line counts
worklog report --code              # ...with the actual changed lines
worklog report --last 7            # the past week
worklog report --since 2026-09-01 --until 2026-09-15
worklog report --commit 3e518f4    # one specific commit
worklog report --format standup    # a block to paste into standup
worklog report -o ~/report.md      # write Markdown to a file
```

**How the numbers are computed:**

- **Development commits** — commits reachable from `work` but not `main` (`main..work`), in range, excluding merges and anything carrying the sync prefix (snapshot commits reach `work` through the merge, so they are filtered on both branches). Merged-in snapshots never count as your work.
- **Files Modified** — the union of files touched by those commits, rendered as **bullet points grouped by their real directory**.
- **Production Imports** — files named by that range's `SFTP sync:` commits on `main`.
- **Summary** — commit counts, files touched, total lines, and a footer stating exactly what was excluded.

**Line counts are hidden by default** and revealed with `--stats`; every output format says so rather than leaving you to wonder. `--code` prints the real diff hunks under a line budget, truncating only at hunk boundaries, with binary files collapsed to a note.

The header summarizes bursts of activity as plain facts — first commit, last commit, how many bursts. It does **not** estimate hours worked: a commit timestamp records when work was saved, not how long it took, and a number invented here would end up in someone's timesheet.

| Option | Effect |
| --- | --- |
| `-d, --date <date>` | A single day, `YYYY-MM-DD` (defaults to today). |
| `--since` / `--until` | A range of days. |
| `--last <n>` | The last N days, ending today. |
| `--commit <ref>` | One specific commit. |
| `--stats` | Show the `+N -M` counts next to each file. |
| `--code` | Show the actual changed lines. |
| `--context <n>` | Context lines around each change (default 3). |
| `--max-lines <n>` | Total diff lines to print (default 400). |
| `--max-file-lines <n>` | Diff lines per file (default 80). |
| `--only <text>` | With `--code`, only files whose path contains this text. |
| `--group <mode>` | `dir` (default) or `none`. |
| `--format <fmt>` | `terminal`, `markdown`, `json` or `standup`. |
| `--markdown` | Alias for `--format markdown`. |
| `-o, --output <file>` | Write the report to a file. |
| `--force` | Allow `-o` to overwrite, or to write inside the repository. |

**Output guards.** `-o` accepts only `.md`, `.txt` and `.json`; it refuses a **tracked file outright with no override**, because this working tree is the deploy payload and a report written over a `.cgi` would be uploaded to the server. A path inside the repo needs `--force`.

---

### `worklog files`

Just the list of files that changed — the fastest way back into a past day's work. Shows which commits touched each file.

```bash
worklog files                      # today
worklog files -d 2026-09-10        # a past day
worklog files --last 7 --stats     # a week, with line counts
worklog files --paths              # bare paths, one per line (pipe-friendly)
```

---

### `worklog log`

An index of the recent days that actually have work, newest first, each with its commit and import counts and a headline. This is the way back: it tells you which dates are worth passing to `report -d` or `files -d`.

```bash
worklog log
worklog log --last 60
```

---

### `worklog today`

A quick dashboard for "where am I right now":

```text
Today — 2026-07-16
  Branch:        work
  Working tree:  1 modified
  Modified:      up/lib/modules/catalog/brands.cgi
  Stashes:       0
  Pending merge: work is up to date with main
  Last sync:     SFTP sync: add ufrm_file_edit.cgi (2 hours ago)
  Today so far:  3 dev commits, 2 imports
```

Shows: current branch, modified/staged/conflicted files, stash count, whether `main` has snapshots not yet merged into `work`, the most recent production sync, and today's commit counts.

---

### `worklog status`

A richer `git status` tailored to the snapshot workflow:

- Repository root and current branch
- Working tree breakdown (staged / new / modified / deleted / untracked / conflicted)
- Branch relationship in both directions — snapshots waiting to merge into `work`, and how many commits `work` is ahead of `main`
- Last production sync
- The five most recent commits on the current branch

### `worklog doctor`

Checks the repository for the states that strand work, and repairs only what cannot possibly be lost by repairing it.

```bash
worklog doctor              # diagnose (read-only)
worklog doctor --fix        # apply only the strictly safe repairs
worklog doctor --pop-stash  # restore a stash worklog left behind
worklog doctor --lost       # commits pinned by worklog that no branch can reach
```

It detects: a stuck or resolved-but-uncommitted merge, a rebase in progress, stashes worklog left behind (**listing their untracked files**, which are otherwise invisible in `git stash list`), a detached HEAD, being on the wrong branch, `main` ahead of `work`, stale locks, interrupted runs, and CRLF damage. It exits 1 only when something is critical.

`--fix` will clear a provably stale lock and perform a **fast-forward-only** merge when `work` is strictly behind and the tree is clean. It will never run `merge --abort`, `reset --hard`, `stash drop`, `clean`, or `checkout -f` — each of those can destroy work that has no remote to restore it from.

## Never Losing Work

There is no remote. A commit that falls off a branch tip and gets garbage-collected is gone permanently, so every mutating command (`sync`, `discard`, `commit`) does three things before touching anything:

1. **Takes an advisory lock** at `.git/worklog/lock`, so two sessions sharing one working tree cannot interleave their checkouts and stashes. A lock counts as stale only when its process is gone *and* it is over an hour old.
2. **Writes a safepoint** — real refs under `refs/worklog/undo/<id>/` pinning the tips of `main`, `work`, `HEAD`, and any stash. Refs are used rather than the reflog because the reflog expires (30 days for unreachable commits) and `git gc --auto` runs implicitly. A ref never expires, stays invisible to `git branch` and `git log --all`, and pins a stash along with all three of its parents — including the third one, which is where `--include-untracked` hides files that vanished from your working tree.
3. **Journals the run** to `.git/worklog/journal/<id>.json`, so a run killed halfway is detectable afterwards instead of looking like an ordinary dirty tree.

Nothing ever deletes a `refs/worklog/` ref. `worklog doctor --lost` reads them and prints a `git cherry-pick` line for anything no branch can reach.

Sync additionally copies the captured bytes into `.git/worklog/incoming/<id>/` before disturbing the working tree, and verifies after writing that the file on disk is exactly the size it captured before staging it onto `main` — a truncated write must never become the authoritative server snapshot.

## Configuration

Defaults work out of the box. To override, drop a `worklog.config.json` in the **repository root** (of the repo you manage, not of WorkLog itself):

```json
{
  "mainBranch": "main",
  "workBranch": "work",
  "syncCommitPrefix": "SFTP sync:"
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `mainBranch` | `main` | Branch that mirrors the server (snapshot timeline). |
| `workBranch` | `work` | Your development branch. |
| `syncCommitPrefix` | `SFTP sync:` | Subject prefix that marks a commit as a production import. Reports use it to separate imports from development work. |
| `syncBatchLimit` | `50` | Refuse a batch larger than this unless `--yes` is passed. |
| `syncIncomingDir` | `.worklog/incoming` | Default drop folder suggested for `sync --from`. |
| `sessionGapMinutes` | `90` | Silence that separates two bursts of commits in a report. |
| `diffContext` | `3` | Context lines around each change under `--code`. |
| `diffMaxFileLines` | `80` | Diff lines printed per file under `--code`. |
| `diffMaxLines` | `400` | Total diff lines printed under `--code`. |

Any key may be omitted; missing keys fall back to defaults. A malformed file is reported as an error rather than silently ignored.

## A Typical Day

```bash
# Morning: a teammate changed six templates on the server.
# Download them via SFTP over your local copies, then import them as ONE snapshot:
worklog sync up/web/html/modules/system/*.html --dry-run   # look first
worklog sync up/web/html/modules/system/cron_scheduler.html              up/web/html/modules/system/employee_store.html              up/web/html/modules/system/feeds_monitor.html

# Not sure what is in your tree and what came from the server?
worklog review

# Work on a fix:
vim up/lib/modules/catalog/brands.cgi
worklog commit up/lib/modules/catalog/brands.cgi -m "Fix brand URL generation"

# Or commit a whole subtree at once:
worklog commit --dir up/web/html/catalog -m "Add pagination to the results grid"

# Later, your committed catalog.cgi changes are no longer needed.
# Download the newest server copy over the local file, then:
worklog discard up/catalog.cgi

# Check where things stand:
worklog today

# End of day:
worklog report                 # bullets, no line-count noise
worklog report --code          # the actual lines you changed
worklog report --format standup

# Looking back:
worklog log                    # which days had work
worklog files -d 2026-09-10    # what changed that day
```

## How Sync Works Internally

The order of operations is designed so nothing is ever lost:

1. **Refuse a broken start.** An in-progress merge or an already-staged index aborts the run — sync needs sole control of the index, and you cannot switch branches mid-merge anyway.
2. **Content first.** The downloaded bytes are read into memory *and* copied into `.git/worklog/incoming/` before any Git operation, so a killed process still leaves them on disk.
3. **Pin everything.** A safepoint writes refs under `refs/worklog/` for every branch tip and stash.
4. **Clean tree.** The downloaded copy is removed from the working tree (tracked files reset to HEAD, new files deleted) — it lives in memory now. This guarantees the auto-stash never contains the synced file, which would otherwise make `git stash pop` fail after the merge reintroduces it.
5. **Stash.** If anything else is uncommitted, it is stashed (including untracked files), and the stash commit is pinned too.
6. **Snapshot.** On `main`: write bytes, verify the file on disk is the size that was captured, stage, prove the index holds exactly the expected paths, then commit. Identical content → skip.
7. **Pop, then merge.** On `work`: the stash is popped **first**, then `main` is merged in. That order matters — git refuses to leave a conflicted merge, so a stash popped afterwards would be stranded and its untracked files invisible.
8. **Restore.** Original branch checked out (unless `--no-restore`).

A conflict prints one recovery block — the conflicted files, the resolve sequence, and the stash contents including untracked files — and exits 1. The snapshot on `main` stands and is never rolled back.

Why `git commit -- <paths>` is never used anywhere in the tool: that form commits the **working tree** for those paths rather than the index, and refuses outright during a merge. Every commit here stages explicitly, asserts the index, and then commits the index.

## Troubleshooting

| Symptom | Cause / Fix |
| --- | --- |
| `Not inside a Git repository.` | Run the command from within the repo you manage. |
| `Branch "main" does not exist…` | Create the two branches, or point `worklog.config.json` at the names you use. |
| `…is identical to the version already on main — skipped` | The downloaded file matches the latest snapshot; nothing to import. Not an error. |
| `Merge produced conflicts` | Resolve the listed files, `git add` them, `git commit`. If WorkLog stashed changes, `git stash pop` afterwards. |
| `You are on "X" but development commits belong on "work".` | `git checkout work` first, or pass `--any-branch` if you really mean it. |
| `Nothing staged to commit.` | Pass file paths, use `--all`, or `git add` something first. |
| `…is not already tracked on work.` | This command only replaces existing tracked files. Use `worklog sync <path>` for a new file. |
| `…does not exist on main.` | There is no existing server snapshot for that file. Import it first with `worklog sync <path>`. |
| `You are on "X" but discard must run from "work".` | Run `git checkout work`, then run `worklog discard` again. |
| Stash didn't pop automatically | Run `worklog doctor` to see exactly what it holds (including untracked files), then `worklog doctor --pop-stash`. Nothing is lost — the stash stays until popped successfully. |
| `A merge is already in progress.` | Finish it (`git add <files> && git commit`) or abort it (`git merge --abort`), then re-run. `worklog doctor` shows the state. |
| `Files are already staged: …` | Sync needs sole control of the index. Commit them, or `git restore --staged <file>`. |
| `… is a directory.` | `sync` takes explicit file paths. Put the downloads in a folder and use `worklog sync --from <folder>`. |
| `That is N files, above the limit of 50.` | Inspect it with `--dry-run`, then confirm with `--yes`. |
| `Refusing to write a report to …` | Reports may only be written to `.md`, `.txt` or `.json`, and never over a tracked file. Write it outside the repository. |
| `Another worklog command is running` | Another session holds the lock. `worklog doctor` shows who; a lock is stale only when its process is gone and it is over an hour old. |
| Something is wrong and you are not sure what | `worklog doctor`. If you think a commit went missing, `worklog doctor --lost`. |

## Architecture

```text
src/
  index.ts        CLI entry point (commander)
  commands/       One module per command (sync, commit, discard, review, report,
                  files, log, today, status, doctor)
  git/            GitService — all Git access isolated behind one class (simple-git)
  safety/         safepoint.ts (undo refs + journal), lock.ts, conflict.ts
  sync/           resolve.ts (path resolution, drop folder), message.ts (subject + body)
  report/         generator.ts (data), spec.ts (ranges), group.ts, bursts.ts, diff.ts
  report/render/  terminal.ts, markdown.ts, json.ts, standup.ts — pure (data, opts) => string
  config/         Config file loading with defaults
  utils/          Logger, error type, date helpers, repo-relative path helper
  types/          Shared interfaces (CommitInfo, FileChange, ReportData, PathFacts)
```

Design rules:

- Commands never call Git directly — everything goes through `GitService`, so swapping the Git backend or adding commands stays cheap.
- Report **data** (`buildReport`) is built separately from report **rendering**, so new output formats plug in as renderers without touching collection logic.
- Expected failures raise `WorklogError` with a message and a recovery hint; the shared `runAction` wrapper renders them cleanly and sets the exit code.
- Every mutating command takes a lock and writes a safepoint before its first mutation.
- Read-only commands call `git.setReadOnly(true)`, which makes every mutating method on `GitService` throw — so a reporting path that accidentally tried to change the repo fails loudly instead of quietly succeeding.

**Traps, all verified by experiment:**

- `git commit -- <paths>` commits the **working tree** for those paths, not the index, and refuses during a merge. Use `GitService.addAndCommit`.
- `commitPaths(msg, [])` with an empty array degrades to a bare `git commit` and commits everything staged. Both helpers throw on an empty list.
- simple-git does not raise on git commands that exit non-zero with empty stderr (`git diff --quiet`, `rev-parse -q --verify`) — detect state from output, not exit codes.
- You cannot `git checkout` out of a conflicted merge, so never plan cleanup that requires it.
- `git stash list --format=%gs` renders as `On <branch>: <message>`; never assume `stash@{0}` is yours.
- Filenames with spaces exist in real repos, so diffs are fetched per file with an explicit pathspec rather than parsed out of `diff --git` headers.

## Development

```bash
npm install
npm run dev -- report        # run from source via tsx
npm run typecheck            # tsc --noEmit
npm run build                # compile to dist/
```

An `AI_GUIDE.md` in this repository documents the tool for AI assistants that operate it on the user's behalf.

## Roadmap

Shipped in v0.3: batched snapshots, drop-folder imports, `--dry-run`, exact diffs in reports (`--code`),
range reports, `worklog files` / `log` / `review` / `doctor`, and the safepoint/undo-ref safety net.

- [ ] `worklog undo <id>` — restore a safepoint (the pins already exist; only the restore step is missing)
- [ ] HTML / PDF export
- [ ] Jira-friendly report format
- [ ] Automatic changelog generation
- [ ] Searchable file-history explorer
- [ ] Web dashboard, commit analytics

## License

MIT
