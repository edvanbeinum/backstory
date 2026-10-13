# Backstory

Review your diff **before** you push it.

The problem this solves: you only really engage with a change once it's on
GitHub — and by then, fixing anything costs another commit and another push.
The review comments live in GitHub's UI; the code that answers them lives on
your machine. Nothing shows you both at once.

Backstory is a local web app that puts them side by side: a TODO tracker built
from your PR's review comments, and a drafting tool for the responses. It
lists every worktree you have checked out with how far through each review
you are, renders the diffs in a GitHub-style UI, drops the review threads onto
the exact lines they refer to, and drafts the `Addressed in <commit-link>`
reply for you to paste back.

Whether a comment is handled is your call and nobody else's — you tick it.

## Install

Download `Backstory-<version>.dmg` from the
[latest release](https://github.com/edvanbeinum/backstory/releases/latest),
drag Backstory to Applications, and open it.

It needs a Mac with Apple silicon on macOS 14.6 or later, **git**, and
**[gh](https://cli.github.com)** authenticated (`gh auth login`) for the
GitHub half. Without `gh` the commits and diffs still work — you just get a
banner where the PR comments would be.
[Claude Code](https://claude.com/claude-code), installed and signed in, is
needed for **Draft a model**, **Draft the data model** and flows. Without it,
diffs and review comments still work. The app carries its own server and the
Node it runs on, so you don't need Node.

The app gives Backstory its own Dock icon and Cmd-Tab entry, and runs the
server itself: it starts the server when you open the app, restarts it if it
stops, and stops it when you quit, so the window never shows a dead page. One
server handles all your checkouts (default port 4460).

### Adding a repo

The first time, the inbox opens with **Set up Backstory**: a row each for
git, GitHub, Claude Code and notes to your agent, saying what each one adds, with
a button for whatever is missing. It checks again when you come back to the
window. **Backstory → Set Up Backstory…** brings it back.

**Open Repo…** picks a checkout, and so does a folder dropped on the window or
its Dock icon. Or use **Browse**, which finds them for you, or type a path.
From then on `/` is the inbox: every worktree of every repo you've opened, so
you never type a path again.

Browse leads with the **sibling worktrees** of whatever repo is open, listed
with the branch each one holds, straight from `git worktree list`. Below that
is a directory navigator that marks which folders are git checkouts. (It has
to be server-side: a browser's native folder picker only ever yields relative
paths, never the absolute one Backstory needs.)

### Login, updates and logs

**Open at Login** in the app menu starts Backstory with your Mac, for live
updates with no window open.

**Check for Updates…** in the same menu offers the latest GitHub release.

The server logs to `~/.backstory/server.log`.

### Uninstalling

1. If you set up notes to your agent, choose **Backstory → Set Up Backstory…** and
   press **Remove…** on the **Notes to your agent** row. It takes the Stop hook and
   `/backstory-review` out of `~/.claude`.
2. Turn off **Open at Login**, quit Backstory, and delete `Backstory.app`.
3. Delete Backstory's data: notes, ticks, the outbox, traced flows, drafted
   models and data models, and the log.

   ```bash
   rm -rf ~/.backstory
   ```

4. Optionally, remove the app's settings, its update state and the window's
   storage, which holds your recent repos:

   ```bash
   defaults delete dev.backstory.app
   rm -rf ~/Library/Caches/dev.backstory.app ~/Library/HTTPStorages/dev.backstory.app ~/Library/WebKit/dev.backstory.app
   ```

Nothing Backstory writes is inside your repos.

## What Backstory keeps

Its own state lives under `~/.backstory`: drafts, ticks, and traced flows.

## Diagrams: the map, the data model and flows

Beside the diff, or in place of it, Backstory draws what a change did to the
system, so you can see where it landed before reading its lines:

- **The map** is a C4 component view of the repo, with the components the
  change touched, added or removed. It reads `architecture/workspace.dsl`, a
  [Structurizr](https://docs.structurizr.com) model, from the repo at the
  change's base and head. A repo that doesn't commit a model can keep one at
  `~/.backstory/models/<repo>/workspace.dsl`; it shows where a change landed,
  but not what it added or removed. With no model at all, **Draft a model**
  in the map strip has Claude Code read the code at HEAD and write one
  there, never into the repo: a draft, marked as one, for you to correct.
- **The data model** shows the entities the change touched: new fields,
  relationships and rules. It reads `db/schema.rb` and the models (Rails),
  the `.xcdatamodeld` (Core Data), or SQL schema files: the `CREATE TABLE`
  statements in a `schema.sql`, a `structure.sql` or a `schema/` folder,
  outside migrations and tests. Nothing is run. Any other repo can have
  its data model drafted on demand: **Draft the data model** in the data strip
  has Claude Code read the code at the head, and work out the base from the
  change. The result is marked as a draft and kept in `~/.backstory/data/`,
  so a view is read once. A head read costs about $0.15 on a small repo and
  over $1 and a few minutes on a large one.
- **Flows** are sequence diagrams of what the code does for each user action
  the change touches, before and after, beside the code they come from.

Backstory reads the DSL itself, so nothing needs exporting. It reads the
part of the DSL that describes elements and arrows:

- `workspace`, `!identifiers hierarchical` (or the default `flat`), `model`,
  and `properties` at the top and inside elements. `code.globs` on an element
  says which files belong to it; `code.tests` and `code.ignore` on the
  workspace say which files are tests or not code at all. `data.files` on
  the workspace says which files hold the data model, for a Rails app in a
  folder or SQL files off the usual paths, and `data.format` (`rails`,
  `core data` or `sql`) says which reader reads them.
- `person`, `softwareSystem`, `container` and `component`, nested, named
  (`id = container "…"`) or not, with `tags`, `technology`, `url`,
  `description` and `perspectives` inside them.
- Arrows, `a -> b "…"` in the model or `-> b "…"` inside an element, with
  ids written in full or relative to the block they're in.
- Comments (`//`, `#`, `/* … */`), `\"` in strings, and `\` at a line's end to
  carry on to the next.

`views`, `styles`, `configuration` and other blocks at the workspace's top
level are skipped. Anything else in the model, any `!` directive other than
`!identifiers`, and `workspace extends` stop the map: `group`,
`deploymentEnvironment` or `!include`, say. The strip names what it met and
its line, rather than drawing a model with pieces missing.

Flows are traced by **Claude Code**, through your own `claude` login:
Backstory runs `claude -p` over a copy of the commit, with read-only tools. That means:

- **Your code is read by Claude** the same way it is when you use Claude Code
  in that repo. Think about that before tracing a repo you couldn't use Claude
  Code on.
- **It costs.** Tracing a change takes about a minute and usually $0.10–0.40
  on your Claude account. It only happens when you press "Trace this change",
  and the result is kept in `~/.backstory/flows/`, so a view is traced once.
- **The model** is Sonnet. On a server you run yourself (`npm run dev`),
  `BACKSTORY_FLOWS_MODEL` picks another (`opus`, or a full model id). Every
  step Claude cites is checked against its line; the ones that don't hold are
  shown dashed, as unverified.

Without Claude Code installed, Backstory works as before, with no flows.

## Reviewing an agent's work

### The `backstory` command

The agent's side of a review goes through the `backstory` command:
`backstory review` and the Claude Code Stop hook below both run it. It comes
inside the app, which runs it with its own Node.

To hand it to Claude Code, choose **Backstory → Set Up Backstory…**, then
press **Set Up** on the **Notes to your agent** row. It shows what it will change,
then adds the Stop hook to `~/.claude/settings.json` and `/backstory-review`
to `~/.claude/commands/`, both naming the command by its place in the app.
Your other hooks and settings stay as they are. Set it up with Backstory in
Applications; if you move the app afterwards, press the row's button again to
point the hook at its new place.

### Sending notes

When an agent is making the change, you review what it made — uncommitted
work, or the commits it made on its own if you let it run. Notes go on any
change: hover a line of **Uncommitted**, **All changes**, or any one commit,
and press **+**; **Add a general note** covers the work as a whole. Review a
stack of commits one at a time and the notes collect as you go — the bar lists
the ones on other changes — to send together.

A note on a commit is sent naming the commit, and whether it's been pushed.
Not how to fix it: a fixup for work that's still local, a new commit for work
that's out, or whatever else suits — that's for you and the agent to settle,
and Backstory can't see how you're working. Notes remember the text of their line, so they follow it when the
agent's next edit moves it — and when they can't be sure where it went, they
say so rather than guess.

**Send to agent** hands them over as one markdown message, each note under
the `path:line` it refers to with the line quoted. The agent doesn't have to
be waiting: if it's busy, the round is queued in `~/.backstory/outbox.json` and
the agent's Claude Code Stop hook collects it the next time it finishes a
turn, then carries on with your notes. **Copy** puts the same message on the
clipboard instead.

A queued round is aimed at the session last seen stopping in that checkout,
and says so — "Queued for the session active here 5m ago" — so a second
session there can't walk off with it. Until one has been seen, it goes to
whichever stops first. Once collected it reads "Delivered 2m ago". While it
waits you can **Cancel** it, which returns its notes to drafts, or, if the
session it was aimed at has ended, **Send to the next session instead**.

The hook is installed once, globally, in `~/.claude/settings.json`, and runs
for every session. It stays silent until a checkout has notes queued, and
never gets in the agent's way: with Backstory not running, unreachable or
erroring, or in a directory that isn't a checkout, it prints nothing within
about two seconds and the agent stops as usual. **Set Up** on the setup
checklist's Notes to your agent row adds it (see [The `backstory`
command](#the-backstory-command)).

Or let the agent ask. `backstory review` opens the uncommitted changes and waits;
the window says an agent is waiting and offers **Send to agent** (or **Looks
good**). While it waits, Send goes straight to it rather than into the queue:
your notes are printed to the command's stdout and it exits — so an agent that
runs it reads your review as the command's output. That works for any agent,
not only Claude Code. In Claude Code, the same **Set Up** adds it as a slash
command: type `/backstory-review` in a session. The agent runs `backstory review` in the
background and picks up where it left off once you send.

Sent notes don't vanish. Whichever way they left — sent, queued or copied —
they become a **round**: fixed, since that's what the agent read, each with a tick.
When the agent's edits land, check each note against the diff and tick it
yourself; nothing else marks a note handled, not even the agent touching its
line. The bar keeps every round's count ("2 of 3 handled"), so an open note
can't slip away just because its line moved, and **Clear handled** forgets the
ones you've ticked.

If Backstory isn't running, `backstory review` opens the Mac app and waits for
its server to come up before asking for the review. The app keeps the server,
so the window you answered in stays up after the command exits.

## Live updates

The window follows the repo without reloading: the server watches the
filesystem (the working tree, plus the git dir — resolved separately, so
linked worktrees work) and pushes a debounced event over SSE whenever
something changes. Commit in a terminal, Cmd-Tab over, and the commit is
already in the change picker. The green dot in the header shows the watch stream is
connected.

Local events (saves, commits, branch switches) refresh from git only; the
GitHub API is consulted at most every 30s unless a push lands
(refs/remotes moved) or you hit refresh, which both bypass the cache.

The one thing that does reload the window is Backstory itself changing. After a
rebuild, a window left open would keep running the old code
against the new server; it notices the server's build has changed when it
reconnects or regains focus, and reloads.

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
to the full one. If a link points at a commit that's since been pushed, Backstory
falls back to the latest and tells you rather than silently showing something
else. A bare `/` is the inbox — it used to reopen your last checkout, which
hides the home screen behind a branch you may well be done with.

## Three levels

**The inbox** is the home screen: every worktree you've got checked out,
across every repo you've opened, with how far through each one's review you
are.

```
10 comments need a response
across 5 branches · 21 worktrees checked out

ACME-APP ──────────────────────────────────────────────────────────
 ●  feature/offline-sync-1203       #40 merged   ▓▓░░░░░  2 of 7 handled
    Queue edits made offline and replay them
 ✓  fix/login-timeout-36            #38 merged   ▓▓▓▓     all handled
 ○  feature/release-script          no PR yet
```

The branch leads, because the branch is the identity — folder names drift, and
one of these directories is named after a branch it stopped holding two
renames ago, so the folder is a footnote shown only when it disagrees.
Progress sits in a fixed right-hand column so the counts line up down the page.

This costs **one `gh` call per repository**, not per worktree: a single
aliased GraphQL query asks for every branch at once. Three repos and
twenty-one worktrees resolve in about half a second. GitHub only decorates the
list — without `gh`, or without a remote, every worktree still appears with a
note saying the counts are missing.

**The workspace** is one branch, three columns:

```
┌────┬──────────────────────┬───────────────────────────┐
│2/7 │ COMMENT 3 OF 7  ‹ ›  │ Showing (⧉)(◍)(a commit…) │
│    │                      │                           │
│ ☑  │ [ ✓ Mark handled  x] │ ┌ OutboxQueue.swift ─────  │
│ ☑  │                      │ │  29 + guard let target  │
│ ▣  │ 🧑 sam-hollister     │ │  30 + queue.replay(…)   │
│ ☐  │ Keying off pending…  │ │     💬 the comment,     │
│ ☐  │                      │ │        anchored inline  │
│ ☐  │ YOUR RESPONSE        │ └───────────────────────── │
│ ☐  │ [chips] [reply box]  │                           │
│    │ [Copy reply] [Link…] │                           │
└────┴──────────────────────┴───────────────────────────┘
 spine     the response              the change
```

The **spine** is the checklist: one square per comment, filled when handled.
It used to be a 300px rail restating in text what the column beside it already
showed. What a standing list is actually for is knowing how far through you
are and jumping to any comment in one click, and both fit in 48px — the diff
gets the rest. A square selects; `j`/`k` move; `x` ticks. Below `lg` it
becomes a horizontal strip under the header.

**The response** is what you're doing about the comment on screen: the tick,
a drafted reply, and optionally the commit that answers it. All three are
independent.

**The change** keeps its full column. `Showing` offers the whole branch diff,
your uncommitted work, the linked commit, and a picker for any commit on the
branch — the pre-push self-review Backstory was originally built for. Whatever is
selected says how many comments land in it, which is the reverse lookup:
given a commit, which review comments does it answer? Threads anchor inline on
the line they were written against, so "did this change actually answer the
review?" is a glance rather than a memory test.

## Handling a comment is deliberate

Backstory does **not** decide when a comment is handled. It used to guess which
commit answered one — the newest commit touching the file — and the guess
always found _something_, so no comment ever read as outstanding and the list
couldn't work as a checklist. On a six-comment PR, all six showed a plausible
link and none showed as open.

So there is exactly one thing that means handled: **you tick it.** Not linking
a commit, not drafting a reply, not a reply spotted on GitHub. The point of a
checklist is working down it and checking things off, and a flag something
else can set isn't one.

Which makes the tick the moment Backstory earns itself, so it is built rather
than assumed: a spring on the box, the check drawn on rather than snapped in,
one expanding ring. One ring, not confetti — confetti on every comment stops
being a reward by the third. The big effect is spent only on the last comment
of a PR, where the panel becomes the payoff: nothing left, and every drafted
reply on the clipboard in one go. Unticking is quiet; undoing a mis-tick
shouldn't feel like a second event. All of it is skipped under
`prefers-reduced-motion`, where the state still lands, just instantly.

A comment answered without any code change is simply one you tick without
linking a commit — the reply templates drop `Addressed in <commit>` and offer
a plain 👍 or "No change needed".

## Links survive rebases

Rebasing a stack rewrites every sha, which would break every linked commit. So
a link stores the commit's **patch-id** — a hash of its diff alone — alongside
the sha. A rebased commit keeps its patch-id, so a stale link is re-matched to
the rewritten commit automatically and marked _re-matched after a rebase_.

| you did                                              | result                              |
| ---------------------------------------------------- | ----------------------------------- |
| rebase / restack (clean)                             | heals silently                      |
| reword a commit message                              | heals — same diff, same patch-id    |
| squash, amend the content, rebase through a conflict | `26ef8f7 gone`, asks for a new link |

**A rebase never unticks anything.** Healing writes the link and only the
link. The work was done; it's the pointer that rotted, so the comment stays
handled, the count doesn't move, and re-linking is offered rather than
demanded.

The last row is deliberate: those genuinely change the diff, so attaching your
reply to a guessed commit would be worse than admitting the link broke. Same
when two commits share a patch-id (revert-then-reapply) — ambiguous never
auto-resolves.

Note that "still on the branch" means _reachable from HEAD_, not "the object
exists": rebased-away commits linger in the object database and would
otherwise look healthy.

**View file** — every file header has a _View file_ toggle that swaps the
hunks for the entire file at that commit, change still highlighted in place,
for when three lines of context isn't enough to judge the change. It scrolls
you to the first change rather than dumping you at line 1, and review threads
keep anchoring to the same lines. Under the hood it's the same patch with
`-U1000000`, so the parser, highlighter and anchoring are all shared.

Files over 5,000 lines render in full but without syntax highlighting — the
footer says so. Dual-theme highlighting emits two CSS variables per token, and
past that size the payload and DOM cost stop being worth it.

A thread that doesn't land on a line in the current change isn't repeated as a
card — the spine already lists every comment, always visible — just counted,
so you know it's there.

## How "not yet pushed" is decided

Branches don't always have an upstream — a `git worktree add -b` branch usually
doesn't, and neither does one you've never pushed. Backstory falls through:

1. `@{upstream}` if it's set
2. else `origin/<branch>` if that ref exists
3. else `merge-base` with the default branch from `origin/HEAD`
4. else the local default branch

Whichever it lands on is spelled out in the header (`3 commits ahead of
origin/main`), so the commit list is never a mystery.

## Layout

The building blocks, with their code and what to read before changing each, are in `architecture/language.yaml`.
The capabilities to build new work from are in `architecture/primitives.yaml`.

| Path                | What's in it                                               |
| ------------------- | ---------------------------------------------------------- |
| `app/api/inbox`     | every worktree of every known repo, with its PR and counts |
| `app/api/session`   | one branch: repo state, commits, PR, review threads        |
| `app/api/responses` | the tick, the draft reply, the linked commit               |
| `app/api/diff`      | one commit's parsed and highlighted diff                   |
| `app/api/file`      | one file at full context, for _View file_                  |
| `lib/git.ts`        | base resolution, commits, patches, working tree            |
| `lib/github.ts`     | `gh` PR lookup and GraphQL threads, with soft failure      |
| `lib/inbox.ts`      | the batched per-repo query behind the inbox                |
| `lib/responses.ts`  | `~/.backstory/responses.json`, and the one-way migration   |
| `lib/progress.ts`   | the single definition of "3 of 7 handled"                  |
| `lib/diff.ts`       | unified diff parser                                        |
| `lib/anchor.ts`     | which thread belongs on which line                         |
| `lib/highlight.ts`  | Shiki, both themes, per line                               |
| `components/`       | the GitHub-style UI                                        |

Diffs are parsed and highlighted server-side. Each file is highlighted as two
contiguous blocks (old side and new side) rather than line by line, so
multi-line strings and block comments don't fall apart.

## Working on Backstory

To run it from a checkout:

```bash
npm install
npm run dev
```

and open http://127.0.0.1:3000.

### The Mac app

With Xcode installed:

```bash
npm run mac:build
```

Drag `mac/build/Backstory.app` to Applications and open it.
`npm run mac:dmg` packs it into a disk image; `packaging/README.md` says how to
sign, notarize and release it.

`npm run mac:smoke` checks the built app end to end on spare ports. To work on
the app against a dev server, pass it the address; it shows that server
instead of starting its own:

```bash
open mac/build/Backstory.app --args -serverURL http://127.0.0.1:3000
```

`backstory --port 3000` opens a repo on a dev server in the browser.

### Tests

```bash
npm test
```

Covers the diff parser (added / deleted / renamed / binary files, quoted
unicode paths, no-newline markers, single-line hunk ranges) and the thread
anchoring rules — including the one that matters most: a comment whose line
isn't in the current diff must fall through to "unanchored" and still be shown,
never silently dropped.

`npm test` points `BACKSTORY_HOME` at a fresh temp directory, so tests never
read or write your real `~/.backstory`.

```bash
npm run check    # typecheck, lint, format check, tests
npm run verify   # all of check, plus the build
```

GitHub Actions runs `npm run verify` on every pull request and on pushes to
`main`. To catch failures before they leave your machine, opt in to the
pre-push hook, which runs `npm run check` and refuses the push if it fails:

```bash
git config core.hooksPath .githooks
```

This sets the hooks path for this repo only, so it overrides any global
`core.hooksPath` you have here. `git push --no-verify` skips the hook once.

## Notes

- The server binds to `127.0.0.1` — it runs git against whatever path you give
  it, so it should not be reachable from your network.
- `git` and `gh` are always invoked with an argv array, never a shell string.
- Merge commits are diffed against their first parent, since `git show` prints
  nothing for them by default.
