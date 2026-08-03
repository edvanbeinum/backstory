# differ

Review your diff **before** you push it.

The problem this solves: you only really engage with a change once it's on
GitHub — and by then, fixing anything costs another commit and another push.
The review comments live in GitHub's UI; the code that answers them lives on
your machine. Nothing shows you both at once.

differ is a local web app that puts them side by side. It lists the commits
GitHub hasn't seen yet, renders each one's diff in a GitHub-style UI, and drops
the pull request's review threads onto the exact lines they refer to. When a
commit answers a comment, it drafts the `Addressed in <commit-link>` reply for
you to paste back.

## Read-only, on purpose

differ never writes anything:

- **No git writes.** It never commits, amends, rebases, or pushes. You drive git
  from your terminal exactly as you do now.
- **No GitHub writes.** It never posts a comment, never resolves a thread. It
  generates reply text and puts it on your clipboard; posting it is your call.

## Running it

```bash
npm install
npm run dev
```

Open http://127.0.0.1:3000 and paste in the path to a checkout. The path is
remembered, so you only do that once per repo.

## Running it as an app

differ can live in your dock and app switcher instead of the browser tab
pile:

```bash
npm run build     # assembles the standalone server
npm link          # puts `differ` on PATH
differ            # from any checkout — starts the server, opens a window
```

Then install the window: in Chrome ⋮ → *Cast, save and share* → *Install
page as app…* (Safari: *File → Add to Dock*). From now on differ has its own
dock icon and Cmd-Tab entry.

The flow that makes this worth it: run `differ` in a terminal inside any
repo, Cmd-Tab to the differ window, and it's already showing that repo — the
CLI hands the repo to the running server and the window picks it up on
focus. One server handles all your checkouts (default port 4460).

`packaging/` has the Homebrew formula skeleton for `brew install differ` +
`brew services start differ` (an always-on background server, so the window
works even with no terminal open).

## Live updates

The window follows the repo without reloading: the server watches the
filesystem (the working tree, plus the git dir — resolved separately, so
linked worktrees work) and pushes a debounced event over SSE whenever
something changes. Commit in a terminal, Cmd-Tab over, and the commit is
already in the rail. The green dot in the header shows the watch stream is
connected.

Local events (saves, commits, branch switches) refresh from git only; the
GitHub API is consulted at most every 30s unless a push lands
(refs/remotes moved) or you hit refresh, which both bypass the cache.

## Shareable URLs

The repo and the selected commit live in the address bar, so a view can be
bookmarked, reopened after a restart, or pasted to another machine with the
same checkout. There's a copy button in the header for grabbing the current
one.

```
/?repo=/Users/you/code/your-repo
/?repo=/Users/you/code/your-repo&rev=1e61946e49974e250cf688eda4c158132e12be83
```

Slashes are left unencoded so the path stays readable; `&`, `=` and spaces are
still escaped. `rev` is optional and accepts a short sha, which is normalised
to the full one. If a link points at a commit that's since been pushed, differ
falls back to the latest and tells you rather than silently showing something
else. A URL beats the remembered path; a bare `/` uses the remembered one.

Requirements: **git**, and **[gh](https://cli.github.com)** authenticated
(`gh auth login`) for the GitHub half. Without `gh` the commits and diffs still
work — you just get a banner where the PR comments would be.

## What you see

```
┌────────────────────┬─────────────────────────────────────────────┐
│ NOT YET PUSHED     │  Debounce the search input                  │
│ ◍ Uncommitted (3)  │  ┌ SearchBox.tsx              +3 −0  ─────┐  │
│ ● a23c7cf Debou…   │  │  33   function onQueryChange() {       │  │
│ ● aeaf49f Cache…   │  │  34 + // Debounced by 300ms.           │  │
│ ● 5e99a82 Fix…     │  │     💬 reviewer: Nit: this still       │  │
│ ── origin/main ──  │  │        fires on every keystroke…       │  │
│                    │  │        [Addressed in <link>] ⧉ Copy    │  │
│ REVIEW THREADS     │  └────────────────────────────────────────┘  │
│ ⬤ SearchBox:34     │                                              │
└────────────────────┴─────────────────────────────────────────────┘
```

**All changes vs main** — pinned at the top of the rail: the whole branch as
one diff against the default branch, with commit/file/line totals — GitHub's
"Files changed" tab, before the push. Review threads anchor here too, and
often better than per-commit, since the combined diff shows the final state
of every line.

**Left rail** — every commit between your branch tip and what's on the remote,
with uncommitted work pinned at the top as a pseudo-commit. The push boundary
line marks what GitHub has; below it, the last 30 already-pushed commits
continue the timeline, dimmed but selectable — viewing one shows its diff
with an "already pushed" badge. Below that, the review threads, filtered to
unresolved by default.

**Main pane** — the selected commit's message, then its diff. Review threads
anchor **inline, on the line they were written against**, so "did this change
actually answer the review?" is a glance rather than a memory test. `j`/`k`
move through commits.

## Linking threads to commits

Each thread's reply links to a commit. differ guesses — the newest branch
commit that touched the thread's file — and shows that guess on the thread's
rail row (`→ 26ef8f7`). When the guess is wrong, **pin** the right commit from
the reply box and it sticks: pinned threads always propose that commit, no
matter which one you're viewing.

That link is what makes the two lists navigable together. Commit rows show how
many threads point at them, thread rows show where they point (solid when
pinned, dimmed when inferred, `unlinked` when neither), and clicking a thread
jumps to its commit *and* scrolls to the comment.

When the fix landed in a *different* file from the one commented on — a test
move, a refactor — no file-level guess can reach it, so the reply box has a
**Pin to…** picker listing the branch commits directly.

## Drafts

A reply you're part-way through writing is saved automatically. It survives
reloading, collapsing the thread, switching commits and restarting the server
— which matters because a draft is the only thing differ produces that you
can't regenerate from git. The box says *Draft saved*, and *Discard draft*
clears it.

## Where local state lives

`~/.differ/links.json` (pins) and `~/.differ/drafts.json` (drafts), both keyed
by `owner/repo#pr` — outside your repo, so the read-only promise holds, and
shared by every differ server on the machine.

Plain JSON on purpose: it's a few KB of click-driven writes with no queries,
so a database would buy nothing, and a file you can `cat`, hand-edit or `rm`
is a feature in a local tool. Both go through `lib/store.ts`, so swapping in
SQLite later would be a change there and nowhere else.

A rebase can strip a pinned commit; differ says so (`26ef8f7 gone`) and asks
for a re-pin rather than silently falling back to the guess.

**View file** — every file header has a *View file* toggle that swaps the
hunks for the entire file at that commit, change still highlighted in place,
for when three lines of context isn't enough to judge the change. It scrolls
you to the first change rather than dumping you at line 1, and review threads
keep anchoring to the same lines. Under the hood it's the same patch with
`-U1000000`, so the parser, highlighter and anchoring are all shared.

Files over 5,000 lines render in full but without syntax highlighting — the
footer says so. Dual-theme highlighting emits two CSS variables per token, and
past that size the payload and DOM cost stop being worth it.

Nothing is ever hidden: a thread that doesn't land on a line in the current
commit still appears, either under its file or in *Other comments on this PR*.

## How "not yet pushed" is decided

Branches don't always have an upstream — a `git worktree add -b` branch usually
doesn't, and neither does one you've never pushed. differ falls through:

1. `@{upstream}` if it's set
2. else `origin/<branch>` if that ref exists
3. else `merge-base` with the default branch from `origin/HEAD`
4. else the local default branch

Whichever it lands on is spelled out in the header (`3 commits ahead of
origin/main`), so the commit list is never a mystery.

## Layout

| Path | What's in it |
|---|---|
| `app/api/session` | repo state, commit list, PR, review threads |
| `app/api/diff` | one commit's parsed and highlighted diff |
| `app/api/file` | one file at full context, for *View file* |
| `lib/git.ts` | base resolution, commits, patches, working tree |
| `lib/github.ts` | `gh` PR lookup and GraphQL threads, with soft failure |
| `lib/diff.ts` | unified diff parser |
| `lib/anchor.ts` | which thread belongs on which line |
| `lib/highlight.ts` | Shiki, both themes, per line |
| `components/` | the GitHub-style UI |

Diffs are parsed and highlighted server-side. Each file is highlighted as two
contiguous blocks (old side and new side) rather than line by line, so
multi-line strings and block comments don't fall apart.

## Tests

```bash
npm test
```

Covers the diff parser (added / deleted / renamed / binary files, quoted
unicode paths, no-newline markers, single-line hunk ranges) and the thread
anchoring rules — including the one that matters most: a comment whose line
isn't in the current diff must fall through to "unanchored" and still be shown,
never silently dropped.

## Notes

- The server binds to `127.0.0.1` — it runs git against whatever path you give
  it, so it should not be reachable from your network.
- `git` and `gh` are always invoked with an argv array, never a shell string.
- Merge commits are diffed against their first parent, since `git show` prints
  nothing for them by default.
