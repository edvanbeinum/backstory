# How Backstory works

The reasoning behind how Backstory behaves, for anyone changing it or curious
why it works the way it does. For what it does, see
[Using Backstory](using-backstory.md).

## The inbox

Each inbox row leads with the branch, because the branch is the identity. Folder
names go out of date: a worktree's folder can be named after a branch it last
had checked out two renames ago. So the folder name is shown only when it
differs from the branch. What the branch changes sits in a fixed right-hand
column so the counts line up down the page.

A branch has **changed since you last looked** when its tip isn't the one it
had when you last opened it, and it has at least one commit past its base.
Opening a branch from the inbox, a `backstory://` link, Open Repo… or the
address bar records its tip; a background refresh of a branch that's already
open doesn't, so commits your agent makes while the branch is open still count
as new. A merged or closed pull request never counts, and nor does the
repo's own checkout on its default branch, which has no base to compare with.
The tip is your local branch's: a fetch that only moves `origin/<branch>`
doesn't count until you update the branch.

The counts are local git: commits, files and lines from where the branch left
its base. The base is the branch its pull request targets, so a stacked branch
counts only its own work, or the default branch when it has no pull request.
Each uses `origin/<base>` when there is one, else the local branch.

Pull requests cost **one GitHub call per repository**, not per worktree: a
single aliased GraphQL query asks for every branch at once. Three repos and
twenty-one worktrees resolve in about half a second. Without GitHub connected,
or without a remote, every worktree still appears, with its counts, and a note
saying its pull requests are missing.

The same call lists the repo's 50 most recently updated open pull requests and its first 100
branches by name, for **On GitHub**: the ones this clone has no local branch for, minus
pull requests from forks and the default branch.

## Browse

Browse's directory navigator runs on the server, because a browser's native
folder picker only ever yields relative paths, never the absolute one Backstory
needs.

## Live updates

The window follows the repo without reloading: the server watches the filesystem
(the working tree, plus the git dir — resolved separately, so linked worktrees
work) and pushes a debounced event over SSE whenever something changes. A commit
made in a terminal appears in the change picker straight away.

Local events (saves, commits, branch switches) refresh from git only; the GitHub
API is consulted at most every 30s unless a push lands (refs/remotes moved) or
you press refresh, which both bypass the cache.

The one thing that does reload the window is Backstory itself changing. After a
rebuild, a window left open would keep running the old code against the new
server; it notices the server's build has changed when it reconnects or regains
focus, and reloads.

## How "not yet pushed" is decided

Branches don't always have an upstream — a `git worktree add -b` branch usually
doesn't, and neither does one you've never pushed. Backstory tries these in
order:

1. `@{upstream}` if it's set
2. else `origin/<branch>` if that ref exists
3. else `merge-base` with the default branch from `origin/HEAD`
4. else the local default branch

The change picker's **A commit…** lists the commits after it. **All changes**
names in its header what the whole branch is diffed against
(`Everything vs origin/main`): the branch its pull request targets, else where
it left the default branch.

## Diffs and highlighting

Diffs are parsed and highlighted server-side. Each file is highlighted as two
contiguous blocks (old side and new side) rather than line by line, so
multi-line strings and block comments highlight correctly.

_View file_ asks git for the same patch with `-U1000000`, so the parser,
highlighter and anchoring are all shared.

Files over 5,000 lines skip highlighting because dual-theme highlighting emits
two CSS variables per token, and past that size the payload and DOM cost stop
being worth it.

Merge commits are diffed against their first parent, since `git show` prints
nothing for them by default.

## Safety

- The server binds to `127.0.0.1` — it runs git against whatever path you give
  it, so it should not be reachable from your network.
- `git` and `gh` are always invoked with an argv array, never a shell string.
- Backstory writes to a repo only when you open a branch from **On GitHub** or
  press **Fetch**. It updates origin's remote-tracking refs for that branch and
  its base, and creates or moves the local branch of the same name. It never
  changes what a worktree has checked out, and never moves a branch that has
  commits origin doesn't have. A github.com https remote signs in with Connect
  GitHub's token, passed to that one `git fetch` in its environment, then with
  git's own credentials.
