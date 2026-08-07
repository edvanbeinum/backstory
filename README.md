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

Open http://127.0.0.1:3000 and pick a checkout — **Browse** finds them for
you, or paste a path. The path is remembered, and recent repos are one click
away in the input's dropdown.

Browse leads with the **sibling worktrees** of whatever repo is open, listed
with the branch each one holds, straight from `git worktree list`. Below that
is a directory navigator that marks which folders are git checkouts. (It has
to be server-side: a browser's native folder picker only ever yields relative
paths, never the absolute one differ needs.)

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
┌──────────────────┬────────────────────┬───────────────────────────┐
│ [Comments][Commits]                   │                           │
│ 6 comments       │ COMMENT 2 of 6 ‹ › │ Showing (◍) (fc6ff8f) (⧉) │
│ AudioEngine.swift│ ┌────────────────┐ │ 💬 1 comment lands here   │
│ ● The pending…   │ │ julianrubisch  │ │ ┌ FakePlaybackEngine.swift│
│   → 888c79c      │ │ Keying off     │ │ │  49   func complete() { │
│ ● Nit: the guard…│ │ pendingSeek…   │ │ │  51 + assert(target)    │
│   → 888c79c      │ │                │ │ │     💬 the comment,     │
│ FakePlayback…    │ │ [Addressed in  │ │ │        anchored inline  │
│ ● Keying off…    │ │  fc6ff8f] ⧉    │ │ └─────────────────────────│
│   → fc6ff8f      │ └────────────────┘ │                           │
└──────────────────┴────────────────────┴───────────────────────────┘
     the rail          the comment              the change
```

**Comments and commits are separate axes.** The main pane is two columns: the
comment you're working on stays pinned on the left while you browse changes on
the right. Selecting a comment moves the right column to whatever answers it;
selecting a commit leaves the comment alone. The comment column has its own
‹ › stepper, so you can step through comments whichever list the rail happens
to be showing. Below `xl` the columns stack, where side by side would squeeze
the diff too hard.

**The rail has two modes** and drives only itself.

*Comments* is the default: a checklist of the PR's review comments, each
showing what currently answers it — a pinned commit, an inferred one,
uncommitted work, or nothing yet.

*Commits* is the pre-push self-review list: every commit between your branch
tip and what's on the remote, with uncommitted work pinned at the top as a
pseudo-commit and **All changes vs main** above that — the whole branch as one
diff, GitHub's "Files changed" tab before the push. The push boundary line
marks what GitHub has; below it, the last 30 already-pushed commits continue
the timeline, dimmed but selectable. `j`/`k` move through whichever list is
showing.

**The change column** picks what to show automatically, with chips to
override:

```
Showing  ( ◍ Uncommitted )  ( fc6ff8f )  ( ⧉ All changes )
```

Uncommitted leads when your working tree touches the comment's file — that's
where you are when you check a comment mid-fix, before committing. Otherwise
the pinned or inferred commit, otherwise the whole branch diff. Whatever is
selected says how many comments land in it, which is the reverse lookup: given
a commit, which review comments does it answer?

Review threads anchor **inline, on the line they were written against**, so
"did this change actually answer the review?" is a glance rather than a memory
test. Nothing is ever hidden: a thread that doesn't land on a line in the
current change still appears, either under its file or in *Other comments on
this PR*.

## Handling a comment is deliberate

differ does **not** guess which commit answers a comment. It used to — the
newest commit touching the file — and the guess always found *something*, so
no comment ever read as outstanding and the list couldn't work as a checklist.
On a six-comment PR, all six showed a plausible link and none showed as open.

Now every comment starts **unanswered**, and you handle it one of two ways:

- **This addresses it** — links the comment to the commit on screen. You had
  to read the diff to get there, which is the point: the act of linking is
  the moment you actually check.
- **No change needed** — some review comments only want a reply. Acknowledging
  one counts as handled and switches the reply templates from
  `Addressed in <commit>` to a plain 👍 or "Noted — no change needed".

The rail header reads `3 of 6 addressed`, and the change column tells you how
many comments land in whatever you're looking at — the reverse lookup.

## Pins survive rebases

Rebasing a stack rewrites every sha, which would break every pin. So a pin
stores the commit's **patch-id** — a hash of its diff alone — alongside the
sha. A rebased commit keeps its patch-id, so a stale pin is re-matched to the
rewritten commit automatically and marked *re-matched after a rebase*.

| you did | result |
|---|---|
| rebase / restack (clean) | heals silently |
| reword a commit message | heals — same diff, same patch-id |
| squash, amend the content, rebase through a conflict | `26ef8f7 gone`, asks for a re-pin |

The last row is deliberate: those genuinely change the diff, so attaching your
reply to a guessed commit would be worse than admitting the link broke. Same
when two commits share a patch-id (revert-then-reapply) — ambiguous never
auto-resolves.

Note that "still on the branch" means *reachable from HEAD*, not "the object
exists": rebased-away commits linger in the object database and would
otherwise look healthy.

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
