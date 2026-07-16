# AI Operator Guide — WorkLog CLI

This document tells an AI assistant everything it needs to run the **WorkLog CLI** on the user's behalf. Read it fully before executing any command. Human-oriented docs live in `README.md`; this file is about *operating* the tool correctly and safely.

## 1. What This Tool Is

WorkLog automates the user's Git workflow for a legacy web application whose source of truth is a server reachable **only via SFTP** (no Git remote, `git pull` is impossible). It wraps the repetitive Git commands and generates daily work reports.

**The user's repository model — memorize this:**

- **`main`** = a local timeline of *server snapshots*. Every file the user downloads from SFTP gets committed here with the message prefix `SFTP sync:`. It is NOT a deployment branch and NOT where development happens. Newer downloads overwrite the working copy; Git history keeps every prior version.
- **`work`** = the user's development branch. ALL of the user's own commits live here. It must never lose commits. Server snapshots flow into it via `git merge main` (which `worklog sync` performs automatically).

Branch names and the commit prefix are configurable per-repo via `worklog.config.json` (see §6) — check for that file before assuming defaults.

## 2. How to Invoke the Tool

The tool lives at `C:\Users\brayan.martinez\Documents\brayann\worklog`.

Preferred invocation (works if `npm link` was run there):

```
worklog <command> [args]
```

If `worklog` is not on PATH, invoke the build directly:

```
node C:\Users\brayan.martinez\Documents\brayann\worklog\dist\index.js <command> [args]
```

If `dist/` is missing or stale (source newer than build), rebuild first:

```
cd C:\Users\brayan.martinez\Documents\brayann\worklog
npm install        # only if node_modules is missing
npm run build
```

**Always run worklog commands from inside the target repository** (any subdirectory is fine — the repo root is auto-detected). Running it inside the WorkLog source folder itself is almost never what the user wants.

Exit codes: `0` success, `1` failure (an error line starting with `x` plus a hint is printed). Non-interactive: no command ever prompts; safe to run unattended.

## 3. Mapping User Requests to Commands

| The user says… | Run |
| --- | --- |
| "I downloaded `account.cgi` from the server" / "another dev changed X, I pulled it via SFTP" / "import this file" | `worklog sync <path>` — after confirming the downloaded file has been copied over the local path |
| "commit my changes" / "commit these files as *message*" | `worklog commit <files...> -m "<message>"` |
| "commit everything" | `worklog commit --all -m "<message>"` |
| "what did I do today" / "generate my report" | `worklog report` |
| "give me the report as markdown / save it to a file" | `worklog report --markdown` or `worklog report -o <file.md>` |
| "what did I do on <date>" | `worklog report -d YYYY-MM-DD` |
| "where am I / what's my status / anything pending?" | `worklog today` (quick) or `worklog status` (detailed) |

Commit message style the user prefers (imperative, concise, no prefix):
`Fix brand URL generation`, `Add crawlers for vendors 24, 489 and 106`, `Fix generic pre-dispatch image matching`.

## 4. Command Contracts

### `worklog sync <files...>` — import SFTP downloads

Precondition: the downloaded file content is already sitting at the given path in the working tree (the user overwrites their local copy with the SFTP download *before* sync runs). If the user only tells you a file arrived but hasn't placed it, help them place it first — sync reads the file from disk.

What it does (in order): reads content into memory → removes the downloaded copy from the working tree → auto-stashes any other uncommitted changes → checks out `main` → writes + stages + commits each file as `SFTP sync: update|add <basename>` (full path in commit body) → checks out `work` → merges `main` → restores the original branch → pops the stash.

- One commit **per file**; pass multiple files in one call freely.
- A file identical to `main`'s latest version prints a `!` warning and is skipped — this is normal, not an error. Report it to the user as "already up to date".
- `--no-restore` leaves the repo on `work` instead of the starting branch.
- **Never replicate sync's steps manually with raw git commands.** The ordering exists to protect uncommitted work; use the tool.

**On merge conflict** (exit 1, "Merge produced conflicts"): the repo is left on `work` mid-merge with conflict markers. Do NOT run `git merge --abort` unless the user asks. Correct recovery: open the conflicted files, resolve (server version = incoming from `main`, user's version = current on `work`), then `git add <files>` and `git commit`. If output warned that changes are stashed, finish with `git stash pop`.

### `worklog commit [files...] -m "message"` — development commit

- Refuses on any branch except `work` (exit 1). Fix: `git checkout work`, rerun. Only use `--any-branch` if the user explicitly wants a commit elsewhere — never to push development work onto `main`.
- File args → stages exactly those; `--all` → stages everything incl. new/deleted; no args and no `--all` → commits whatever is already staged.
- "Nothing staged to commit." → stage something or pass `--all`.

### `worklog report [-d date] [--markdown] [-o file]` — day report

Read-only; always safe. Development commits are computed as `main..work` (commits on `work` not on `main`) for the given date, excluding merges and `SFTP sync:` commits, so imports never inflate the user's work. Production imports come from that day's sync commits on `main`. When the user wants to *send* the report somewhere, generate with `--markdown` or `-o`.

### `worklog today` / `worklog status` — read-only dashboards

Always safe to run. Run `worklog today` proactively before risky operations and after finishing a task for the user — it surfaces: dirty working tree, stash count, and whether `main` has snapshots not yet merged into `work` ("Pending merge" line). If pending merges exist, offer to merge (`git merge main` on `work`) or just run a no-op `worklog sync` scenario is NOT the fix — the fix is checking out `work` and merging.

## 5. Safety Rules for the AI

1. **Never commit development work on `main`.** `main` is exclusively for `SFTP sync:` snapshot commits created by `worklog sync`.
2. **Never rebase, force-push, reset --hard, or rewrite history** on either branch. The whole system depends on append-only history. There is no remote, so a lost commit is lost forever.
3. **Never delete or drop stashes.** If a sync run leaves a stash behind (its output says so), recover it with `git stash pop`, resolving conflicts if needed.
4. **Don't "clean up" the working tree** (checkout/restore/clean) without asking — an uncommitted modified file may be an SFTP download the user hasn't synced yet. If you find unexplained modifications, ask whether they're server downloads (→ `worklog sync`) or the user's work (→ `worklog commit`).
5. Verify outcomes after acting: after a sync, `git log --oneline -3 main` should show the new `SFTP sync:` commit and `worklog today` should show "up to date with main"; after a commit, `git log --oneline -1 work` should show the new message.
6. If a command fails, read the printed hint — every WorkLog error includes its own recovery instruction.

## 6. Configuration

Optional `worklog.config.json` in the **target repository root** (not in the WorkLog source folder):

```json
{
  "mainBranch": "main",
  "workBranch": "work",
  "syncCommitPrefix": "SFTP sync:"
}
```

All keys optional; these are the defaults. Before working in an unfamiliar repo, check for this file — every rule in this guide that says `main`/`work` means the configured names.

## 7. Codebase Map (for modifying the tool itself)

TypeScript, Node ≥ 18, ESM (`"type": "module"`, NodeNext resolution — **relative imports need `.js` extensions**). Build with `npm run build`; run from source with `npm run dev -- <command>`; no test suite yet.

```
src/index.ts             commander program; registers the five commands
src/commands/*.ts        one module per command; each exports register<Name>Command(program)
src/git/repo.ts          GitService — the ONLY place that touches simple-git/git
src/report/generator.ts  buildReport (data) + renderTerminal/renderMarkdown (presentation)
src/config/config.ts     loadConfig + DEFAULT_CONFIG
src/utils/logger.ts      log helpers + runAction error wrapper
src/utils/errors.ts      WorklogError(message, hint)
src/utils/dates.ts       todayISO, validateDate, dayRange
src/types/index.ts       CommitInfo, FileChange, ReportData
```

Conventions when extending:

- New commands: create `src/commands/<name>.ts`, export a `register…Command(program)` function, wire it in `index.ts`, wrap the action in `runAction`.
- All Git access goes through `GitService` — never call simple-git or shell out to git from a command module.
- Expected failures: `throw new WorklogError(message, hint)` — never `process.exit` inside command logic.
- New report formats: add a renderer in `src/report/` that takes `ReportData`; do not touch `buildReport`.
- **Gotcha:** simple-git does NOT raise errors for git commands that exit non-zero with empty stderr (e.g. `git diff --quiet`). Detect state from command *output*, not exit codes (see `hasStagedChanges`).
- Git log parsing uses `\x1f` (ASCII unit separator) as the field delimiter with `--numstat` for per-file stats; the parser is `parseLog` in `src/git/repo.ts`.

## 8. Quick Self-Test

To verify the tool works without touching the user's real repo: create a throwaway repo with `main` + `work` branches and a committed file, modify the file, run `worklog sync <file>`, and confirm `main` gains an `SFTP sync:` commit and `work` contains it via a merge. Delete the throwaway repo afterwards.
