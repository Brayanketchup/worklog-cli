# AI Operator Guide — WorkLog CLI v0.3

This document tells an AI assistant everything it needs to run the **WorkLog CLI** on the user's behalf. Read it fully before executing any command. Human-oriented docs live in `README.md`; this file is about *operating* the tool correctly and safely.

## 1. What This Tool Is

WorkLog automates a Git workflow for a legacy web application whose source of truth is a server reachable **only via SFTP** (no Git remote, `git pull` is impossible). It wraps the repetitive Git commands and generates work reports.

**The repository model — memorize this:**

- **`main`** = a local timeline of *server snapshots*. Files downloaded from SFTP get committed here with the subject prefix `SFTP sync:`. It is NOT a deployment branch and NOT where development happens.
- **`work`** = the development branch. ALL of the user's own commits live here. It must never lose commits. Server snapshots flow into it through normal Git merges.

**There is no remote.** A commit that falls off a branch tip and is garbage-collected is gone permanently. This single fact drives every safety decision below.

Branch names and the commit prefix default to `main` / `work` / `SFTP sync:`. They are overridable via `worklog.config.json` at the repo root, but **no such file exists in the user's repository** — assume the defaults and do not go looking for it.

## 2. How to Invoke the Tool

The tool lives at `C:\Users\brayan.martinez\Documents\brayann\worklog` and is `npm link`ed, so the global `worklog` command runs straight from `dist/`:

```text
worklog <command> [args]
```

If `worklog` is not on PATH, invoke the build directly:

```text
node C:\Users\brayan.martinez\Documents\brayann\worklog\dist\index.js <command> [args]
```

After editing the source, rebuild — the global command picks it up immediately because the install is a symlink:

```text
cd C:\Users\brayan.martinez\Documents\brayann\worklog
npm run build
```

**Always run worklog commands from inside the target repository** (any subdirectory is fine — the repo root is auto-detected).

Exit codes: `0` success, `1` failure (an error line starting with `x` plus a hint). Nothing ever prompts; safe to run unattended.

## 3. Mapping User Requests to Commands

| The user says… | Run |
| --- | --- |
| "I downloaded `account.cgi` from the server" | `worklog sync <path>` |
| "I downloaded these six templates" | `worklog sync <a> <b> <c> …` — **one commit for all of them** |
| "I dropped a bunch of downloads in a folder" | `worklog sync --from <folder>` |
| "show me what it would do first" | add `--dry-run` to `sync`, `discard` or `commit` |
| "discard my changes and take the server copy" | `worklog discard <path>` |
| "commit my changes as *message*" | `worklog commit <files...> -m "<message>"` |
| "commit everything under this folder" | `worklog commit --dir <path> -m "<message>"` |
| "commit everything" | `worklog commit --all -m "<message>"` |
| "what's changed in my working tree?" | `worklog review` |
| "what did I do today / generate my report" | `worklog report` |
| "…with the line counts" | `worklog report --stats` |
| "…show me the actual code I changed" | `worklog report --code` |
| "what did I do this week / last N days" | `worklog report --last 7` |
| "what files did I change on <date>" | `worklog files -d YYYY-MM-DD` |
| "what days did I work recently / take me back" | `worklog log` |
| "give me something for standup" | `worklog report --format standup` |
| "save the report to a file" | `worklog report -o <path outside the repo>.md` |
| "where am I / anything pending?" | `worklog today` or `worklog status` |
| "something is broken / I'm stuck mid-merge" | `worklog doctor` |

**Commit message style.** Imperative, sentence case, no trailing period, ~9 words. Name the *behavior*, not the file. Real examples from this repository:

- `Fix SQL syntax error when job-site filter used without permitted sites`
- `Persist and apply the full filter set in scheduled invoice reports`
- `Honor lgiCat on canonical catalog URLs so the sign-in prompt works`
- `Send Adult Signature to OnTrac and clear stale Signature between labels`
- `Vendor Catalog: map vendor categories to ours, select fields on focus`

An optional `Feature:` prefix is used occasionally (`Catalog:`, `Header:`, `Vendor Catalog:`). Compound subjects joined with "and" are common and fine.

## 4. Command Contracts

### `worklog sync <files...>` / `worklog sync --from <dir>`

Import server downloads onto `main`, then merge into `work`.

**Precondition: the downloaded bytes are already sitting at the named path(s)** (or inside the drop folder).

**Batching is the default.** Every file named in one invocation becomes **one** `SFTP sync:` commit whose body lists each path as a bullet. This is the headline change in v0.3: the per-file behavior produced 385 commits in a single day in this repository. Pass `--per-file` to restore the old one-commit-per-file behavior.

**Directories and globs are refused, deliberately.** `worklog sync some/dir/` errors out. Expanding a directory would sweep in the user's *own uncommitted edits*, wipe them from the working tree (they are never stashed, so this is unrecoverable), and then publish them on `main` as though the server had sent them. Use `--from <folder>` instead: everything in a drop folder is a download by construction, so no guessing is involved.

What it does, in order: validates → captures bytes to memory *and* to `.git/worklog/incoming/` → removes the download from the tree → auto-stashes unrelated work → commits on `main` → returns to `work` → **pops the stash** → merges → restores the original branch.

The stash is popped *before* the merge on purpose. Git will not let you leave a conflicted merge, so a stash popped afterwards would be stranded and its untracked files invisible. That was the v0.2 bug.

Options: `-m <subject>` (override the generated subject), `--per-file`, `--dry-run`/`-n`, `--yes` (allow a batch over 50 files), `--no-restore`.

A file identical to the version on `main` prints `!` and is skipped — report that as "already up to date", not an error.

### `worklog discard <files...>`

Accept the downloaded server copy as authoritative, replacing the `work` version.

Preconditions: run from `work`; each file already tracked on `work`; each file already exists on `main`; the downloaded bytes already on disk.

Refuses untracked files and files absent from `main` → those need `sync`.

**When every named file already matches the server copy, this is a success** (exit 0): it still merges, still pops the stash, and says "Nothing to do". In v0.2 that case exited 1 and skipped both, which left the repository half-finished.

The superseded content stays in history and is pinned by a safepoint; nothing is rewritten.

### `worklog commit [files...] -m "msg"`

Development commit on `work`. Refuses off `work` (fix: `git checkout work`, or `--any-branch`). Refuses mid-merge.

- File arguments stage exactly those paths.
- `--dir <path>` stages every changed file under a directory; add `--include-untracked` for new files.
- `--all` stages everything including new and deleted.
- No arguments and no flags commits whatever is already staged.
- `--dry-run` lists what would be committed and exits.

Warns (does not block) when a file being committed is byte-identical to the server snapshot — usually a sign it is a download that belongs in `sync`.

### `worklog review`

Read-only. Lists what is dirty in the working tree, grouped by directory, with per-file facts: state, line counts, whether it matches the server snapshot, whether it contains CRLF, how many of your own commits and how many snapshot commits have touched it.

**It reports state; it never decides provenance.** Whether a changed file is an SFTP download or the user's own editing is not recoverable from the repository — measurement on this repo's real history showed the tempting signals are unreliable (a genuine download produced 107 scattered hunks while a hand-edit produced 9; every file's mtime is just the last checkout). So it prints *both* the `sync` command and the `commit` command for each group and leaves the choice to the user.

**Never chain `review` output into `sync` or `discard` automatically.** Ask the user which files are downloads.

`--dir <path>` narrows it; `--json` is machine-readable.

### `worklog report`

Read-only. Development commits are `main..work`, excluding merges and excluding any subject starting with `SFTP sync:` (snapshot commits reach `work` through the merge, so they are filtered on both branches). Imports never inflate the user's numbers, and the footer always states what was excluded.

Range selectors, mutually exclusive: `-d <date>` (default: today), `--since`/`--until`, `--last <n>`, `--commit <ref>`.

Display:
- Files are rendered as **bullet points**, grouped by their real directory.
- **Per-file line counts are hidden by default.** `--stats` shows them. Every renderer states that they are hidden.
- `--code` prints the **actual changed lines**, budgeted by `--context` (3), `--max-file-lines` (80) and `--max-lines` (400), truncating only at hunk boundaries. Binary files render as `(binary file)`. `--only <text>` narrows it to matching paths.
- `--format terminal|markdown|json|standup`, with `--markdown` kept as an alias.

`-o <file>` writes the report out, with guards: the extension must be `.md`, `.txt` or `.json`; a **tracked file is refused outright with no override** (the working tree is the deploy payload — a report written over a `.cgi` would be uploaded to the server); a path inside the repo needs `--force`; an existing file needs `--force`. Prefer writing outside the repository.

The header reports bursts of activity as plain facts — first commit, last commit, how many bursts. It deliberately does **not** estimate hours worked; a commit timestamp says when work was saved, not how long it took.

### `worklog files`

Just the list of files changed, for any day, range or commit — the quickest way back into a past day's work. Shows which commits touched each file. `--stats` for line counts, `--paths` for bare paths one per line (pipe-friendly), `--group none` to flatten.

### `worklog log`

An index of recent days that have activity, newest first, each with its commit and import counts and a headline. This is the navigation hub: it tells the user which dates are worth passing to `report -d` or `files -d`. `--last <n>` sets how far back to scan (default 30).

### `worklog today` / `worklog status`

Read-only overviews. `today` now also warns when a merge is unfinished or a worklog stash is outstanding, and points at `worklog doctor`.

### `worklog doctor`

Diagnoses the repository: stuck merges, resolved-but-uncommitted merges, rebases, stashes worklog left behind (**listing their untracked files**, which are otherwise invisible), detached HEAD, being on the wrong branch, `main` ahead of `work`, stale locks, interrupted runs, and CRLF damage. Exit 1 only when something is critical.

- `--fix` applies only repairs that cannot lose anything: clearing a provably stale lock, and a **fast-forward-only** merge when `work` is strictly behind and the tree is clean. It never runs `merge --abort`, `reset --hard`, `stash drop`, `clean` or `checkout -f`.
- `--pop-stash` restores a worklog stash, printing its contents first.
- `--lost` lists commits pinned under `refs/worklog/` that no branch can reach, with the `git cherry-pick` line to recover each.

## 5. Safety Model

Every mutating command (`sync`, `discard`, `commit`) does three things before touching anything:

1. **Takes an advisory lock** at `.git/worklog/lock`, so two sessions sharing one working tree cannot interleave checkouts and stashes. A lock is treated as stale only when its process is gone *and* it is over an hour old.
2. **Writes a safepoint**: real refs under `refs/worklog/undo/<id>/` pinning the tips of `main`, `work`, `HEAD` and any stash. Refs are used rather than the reflog because the reflog expires (30 days for unreachable commits) and `git gc --auto` runs implicitly — with no remote, that is permanent loss. A ref never expires, is invisible to `git branch`, and pins a stash together with all three of its parents, including the third one that holds untracked files.
3. **Journals the run** to `.git/worklog/journal/<id>.json` with status `running`, so an interrupted run is detectable afterwards.

Nothing deletes a `refs/worklog/` ref. `worklog doctor --lost` reads them.

### Rules for you, the assistant

1. **Never commit development work on `main`.** It is exclusively for `SFTP sync:` snapshots.
2. **Never rebase, force-push, `reset --hard`, or rewrite history.** There is no remote.
3. **Never delete or drop a stash.** Recover with `worklog doctor --pop-stash` or `git stash pop`.
4. **Never clean/checkout/restore the working tree without asking.** A modified file may be a download (→ `sync`), an authoritative copy (→ `discard`), or the user's own work (→ `commit`). Run `worklog review` and ask.
5. **Never guess whether a file is a download.** The tool refuses to; so should you.
6. **Line endings must stay LF.** `sync` writes captured `Buffer`s with no encoding conversion, so bytes survive exactly — keep it that way. `.gitattributes` in the user's repo enforces `* text=auto eol=lf`, and a CR on a CGI shebang stops the server running it. `worklog doctor` flags CRLF damage.
7. **Reports must never be written over tracked files.** The working tree is the deploy payload.
8. Use `--dry-run` when the user is unsure, and show them the plan before running for real.

### After acting, verify

- post-`sync`: `git log --oneline -3 main` shows the new `SFTP sync:` commit; `worklog today` shows "up to date with main".
- post-`discard`: `git diff main work -- <path>` is empty for that file, and the superseded commit still appears in `git log --all`.
- post-`commit`: `git log --oneline -1 work` shows the message.
- After anything unexpected: `worklog doctor`.

### On a merge conflict

The repo is left on `work`, mid-merge, with the snapshot safe on `main`. The tool prints one recovery block: the conflicted files, the fact that branches cannot be switched until it is resolved, the resolve sequence, and — if a stash is outstanding — its contents including untracked files. Exit code is 1.

Do **not** `git merge --abort` unless asked. Resolve the files (incoming = server version), `git add`, `git commit`. Then `worklog doctor` to confirm nothing is outstanding.

## 6. Modifying the Tool Itself

TypeScript, Node ≥ 18, ESM (NodeNext — **relative imports need `.js` extensions**). `npm run build` compiles, `npm run dev -- <cmd>` runs from source, `npm run typecheck`. No test suite; test against a throwaway repo built with `mktemp -d`.

```
src/index.ts                 commander wiring
src/commands/*.ts            one file per command, each exporting register<Name>Command(program)
src/git/repo.ts              GitService — the ONLY place that touches git
src/safety/                  safepoint.ts (refs + journal), lock.ts, conflict.ts (the recovery report)
src/sync/                    resolve.ts (path resolution, drop folder), message.ts (subject + body)
src/report/                  generator.ts (data), spec.ts (ranges), group.ts, bursts.ts, diff.ts
src/report/render/           terminal.ts, markdown.ts, json.ts, standup.ts — pure (data, opts) => string
src/config/, src/utils/, src/types/
```

Conventions: new command → `src/commands/<name>.ts` + wire in `index.ts`, action wrapped in `runAction`. Expected failures → `throw new WorklogError(message, hint)`; never `process.exit` in command logic. New output format → a new renderer taking `ReportData`; don't touch `buildReport`.

**Traps, all verified by experiment:**

- `git commit -- <paths>` commits the **working tree** for those paths, not the index, and **refuses during a merge**. Use `GitService.addAndCommit`, which stages, asserts the index holds exactly the expected paths, and then commits the index.
- `commitPaths(msg, [])` with an empty array degrades to a bare `git commit` and commits **everything staged**. Both commit helpers throw on an empty list.
- simple-git does not raise on git commands that exit non-zero with empty stderr (e.g. `git diff --quiet`, `rev-parse -q --verify`) — detect state from output, not exit codes.
- You cannot `git checkout` out of a conflicted merge, so never plan cleanup that requires it.
- `git stash list --format=%gs` renders as `On <branch>: <message>`; never assume `stash@{0}` is yours.
- Filenames with spaces exist in the user's repo, so diffs are fetched per-file with an explicit pathspec rather than parsed out of `diff --git` headers.
