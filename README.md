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
  - [worklog report](#worklog-report)
  - [worklog today](#worklog-today)
  - [worklog status](#worklog-status)
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

When a teammate changes a file on the server, you download it via SFTP, overwrite your local copy, and run one command. WorkLog commits the snapshot to `main` and merges it into `work` so you keep developing against the newest server version.

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
worklog sync file1.cgi file2.cgi          # multiple files → one commit each
```

**What it does, in order:**

1. Detects the repository and remembers your current branch.
2. Reads the downloaded file content into memory, then resets the file in the working tree (the content is safe in memory; this keeps the stash clean).
3. Stashes any other uncommitted changes (restored automatically at the end).
4. Switches to `main`, writes the file, stages it, and commits it as `SFTP sync: update <file>` — or `SFTP sync: add <file>` if the file is new to `main`. The commit body records the full repo-relative path.
5. Switches to `work` and merges `main` into it.
6. Restores the branch you started on, then pops the stash.

**Behaviors to know:**

- A file identical to what `main` already has is **skipped** with a warning (no empty commits).
- Each file gets its **own commit**, so `main` stays a clean per-file timeline.
- On a **merge conflict**, WorkLog stops on `work` with the conflict in place and prints exactly what to do (`git add <files> && git commit`, then `git stash pop` if it stashed). It never guesses at a resolution.
- Files outside the repository, or paths that can't be read, abort before anything is touched.

| Option | Effect |
| --- | --- |
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
| `--any-branch` | Allow committing on a branch other than `work`. |

---

### `worklog report`

Generate a report of one day's work: development commits, files modified with line stats, production imports, and a summary.

```bash
worklog report                    # today, colored terminal output
worklog report --markdown         # Markdown to stdout
worklog report -o report.md       # write Markdown to a file
worklog report -d 2026-07-15      # a specific day
```

**How the numbers are computed:**

- **Development commits** — commits reachable from `work` but not `main` (`main..work`), authored on the report date, excluding merges and anything with the sync prefix. Merged-in snapshots never count as your work.
- **Files Modified** — the union of files touched by those commits, with summed `+added / -removed` line counts (binary files shown as `binary`).
- **Production Imports** — files named by that day's `SFTP sync:` commits on `main`.
- **Summary** — commit counts, files touched, total lines added/removed.

| Option | Effect |
| --- | --- |
| `-d, --date <date>` | Report date as `YYYY-MM-DD` (defaults to today). |
| `--markdown` | Print Markdown instead of colored terminal text. |
| `-o, --output <file>` | Write the Markdown report to a file. |

---

### `worklog today`

A quick dashboard for "where am I right now":

```
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

Any key may be omitted; missing keys fall back to defaults. A malformed file is reported as an error rather than silently ignored.

## A Typical Day

```bash
# Morning: a teammate changed account.cgi on the server.
# Download it via SFTP over your local copy, then:
worklog sync up/lib/modules/catalog/account.cgi

# Work on a fix:
vim up/lib/modules/catalog/brands.cgi
worklog commit up/lib/modules/catalog/brands.cgi -m "Fix brand URL generation"

# Check where things stand:
worklog today

# End of day:
worklog report -o "reports/$(date +%F).md"
```

## How Sync Works Internally

The order of operations is designed so nothing is ever lost:

1. **Content first.** The downloaded file bytes are read into memory before any Git operation.
2. **Clean tree.** The downloaded copy is removed from the working tree (tracked files are reset to HEAD, new files deleted) — it lives in memory now. This guarantees the auto-stash never contains the synced file, which would otherwise make `git stash pop` fail after the merge reintroduces it.
3. **Stash.** If anything else is uncommitted, it is stashed (including untracked files).
4. **Snapshot.** On `main`: write bytes, stage, commit with the standardized message. Identical content → skip.
5. **Merge.** On `work`: `git merge main`. Conflicts stop the process with instructions; your stash is preserved and you are told so.
6. **Restore.** Original branch checked out (unless `--no-restore`), stash popped.

If anything fails mid-flight while changes are stashed, WorkLog tells you the stash exists and how to recover it (`git stash pop`).

## Troubleshooting

| Symptom | Cause / Fix |
| --- | --- |
| `Not inside a Git repository.` | Run the command from within the repo you manage. |
| `Branch "main" does not exist…` | Create the two branches, or point `worklog.config.json` at the names you use. |
| `…is identical to the version already on main — skipped` | The downloaded file matches the latest snapshot; nothing to import. Not an error. |
| `Merge produced conflicts` | Resolve the listed files, `git add` them, `git commit`. If WorkLog stashed changes, `git stash pop` afterwards. |
| `You are on "X" but development commits belong on "work".` | `git checkout work` first, or pass `--any-branch` if you really mean it. |
| `Nothing staged to commit.` | Pass file paths, use `--all`, or `git add` something first. |
| Stash didn't pop automatically | Run `git stash list` then `git stash pop` and resolve any conflicts; nothing is lost — the stash stays until popped successfully. |

## Architecture

```
src/
  index.ts        CLI entry point (commander)
  commands/       One module per command (sync, commit, report, today, status)
  git/            GitService — all Git access isolated behind one class (simple-git)
  report/         Report data collection + terminal/Markdown renderers
  config/         Config file loading with defaults
  utils/          Logger, error type, date helpers
  types/          Shared interfaces (CommitInfo, FileChange, ReportData)
```

Design rules:

- Commands never call Git directly — everything goes through `GitService`, so swapping the Git backend or adding commands stays cheap.
- Report **data** (`buildReport`) is built separately from report **rendering** (`renderTerminal`, `renderMarkdown`), so new output formats (HTML, PDF, AI summaries) plug in as renderers without touching collection logic.
- Expected failures raise `WorklogError` with a message and a recovery hint; the shared `runAction` wrapper renders them cleanly and sets the exit code.

## Development

```bash
npm install
npm run dev -- report        # run from source via tsx
npm run typecheck            # tsc --noEmit
npm run build                # compile to dist/
```

An `AI_GUIDE.md` in this repository documents the tool for AI assistants that operate it on the user's behalf.

## Roadmap

- [ ] Exact diffs per commit in reports
- [ ] AI-generated summaries of the day's work
- [ ] HTML / PDF export
- [ ] Jira-friendly report format
- [ ] Automatic changelog generation
- [ ] Searchable history and file history explorer
- [ ] Web dashboard, commit analytics, productivity metrics

## License

MIT
