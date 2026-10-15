# How Backstory works

The reasoning behind how Backstory behaves, for anyone changing it or curious
why it works the way it does. For what it does, see
[Using Backstory](using-backstory.md).

## The inbox

Each inbox row leads with the branch, because the branch is the identity. Folder
names go out of date: a worktree's folder can be named after a branch it last
had checked out two renames ago. So the folder name is shown only when it
differs from the branch. Progress sits in a fixed right-hand column so the
counts line up down the page.

This costs **one `gh` call per repository**, not per worktree: a single aliased
GraphQL query asks for every branch at once. Three repos and twenty-one
worktrees resolve in about half a second. The PR and counts come from GitHub:
without `gh`, or without a remote, every worktree still appears with a note
saying the counts are missing.

## Handling a comment is deliberate

Backstory doesn't guess when a comment is handled. A guess, such as the newest
commit touching the file, always finds _something_, so every comment would read
as handled and the list couldn't work as a checklist.

So there is exactly one thing that means handled: **you tick it.** Not linking a
commit, not drafting a reply, not a reply spotted on GitHub. A checklist only
works if you are the one checking things off.

The tick is animated: the box springs, the check mark draws in, and one ring
expands. The animation stays small, because a big effect on every comment stops
feeling like a reward after a few. The last comment on a PR gets the larger
effect: the panel shows that nothing is left, with a button to copy every
drafted reply at once. Unticking isn't animated, so undoing a mistaken tick
doesn't feel like a second event. With `prefers-reduced-motion`, the tick
changes instantly.

## Links survive rebases

A rebase rewrites the link and only the link. The work was done and only the
pointer to it broke, so the comment stays handled, the count doesn't move, and
re-linking is offered rather than demanded.

Squashing, amending the content or rebasing through a conflict asks for a new
link on purpose: those change the diff, so attaching your reply to a guessed
commit would be worse than admitting the link broke. Same when two commits share
a patch-id (revert-then-reapply): an ambiguous match never resolves itself.

Note that "still on the branch" means _reachable from HEAD_, not "the object
exists": rebased-away commits stay in the object database and would otherwise
look valid.

## Browse

Browse's directory navigator runs on the server, because a browser's native
folder picker only ever yields relative paths, never the absolute one Backstory
needs.

## Live updates

The window follows the repo without reloading: the server watches the filesystem
(the working tree, plus the git dir — resolved separately, so linked worktrees
work) and pushes a debounced event over SSE whenever something changes. A commit
made in a terminal appears in the change picker straight away. The green dot in
the header shows the watch stream is connected.

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

The header names the one it used (`3 commits ahead of origin/main`).

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
