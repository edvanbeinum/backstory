# Using Backstory

This guide covers everything Backstory does once it's installed. To install it,
see the [README](../README.md).

## Contents

- [Adding a repo](#adding-a-repo)
- [The inbox and the workspace](#the-inbox-and-the-workspace)
- [The map, flows and the data model](#the-map-flows-and-the-data-model)
- [Reviewing an agent's work](#reviewing-an-agents-work)
- [Review comments from GitHub](#review-comments-from-github)
- [Shareable URLs](#shareable-urls)
- [Login, updates and logs](#login-updates-and-logs)
- [What Backstory keeps](#what-backstory-keeps)
- [Uninstalling](#uninstalling)

## Adding a repo

The first time, the inbox opens with **Set up Backstory**: a row each for git,
GitHub, Claude Code and notes to your agent, saying what each one adds, with a
button for whatever is missing. It checks again when you come back to the
window. **Backstory → Set Up Backstory…** brings it back.

**Open Repo…** picks a checkout, and so does a folder dropped on the window or
its Dock icon. Or use **Browse**, which finds them for you, or type a path. From
then on `/` is the inbox: every worktree of every repo you've opened.

Browse leads with the **sibling worktrees** of whatever repo is open, listed
with the branch each one has checked out. Below that is a directory navigator
that marks which folders are git checkouts.

## The inbox and the workspace

**The inbox** is the home screen: every worktree you've got checked out, across
every repo you've opened, with how far through each one's review you are.

```text
10 comments need a response
across 5 branches · 21 worktrees checked out

ACME-APP ──────────────────────────────────────────────────────────
 ●  feature/offline-sync-1203       #40 merged   ▓▓░░░░░  2 of 7 handled
    Queue edits made offline and replay them
 ✓  fix/login-timeout-36            #38 merged   ▓▓▓▓     all handled
 ○  feature/release-script          no PR yet
```

**The workspace** is one branch. Its header picks the change: the whole branch,
your uncommitted work, or any one commit on it. Once a change has been traced,
the **Diagrams** layout leads: the map and the data model, then flows and review
comments as tabs, with the diff a click away from any step. **Code** puts that
column beside the diff instead, and is what you see before anything is traced.
When the PR has review comments, a checklist spine runs down the left edge.

Whatever change is selected says how many review comments are on it, which is
the reverse lookup: given a commit, which review comments does it answer?
Threads anchor inline on the line they were written against.

**View file** — every file header has a _View file_ toggle that swaps the hunks
for the entire file at that commit, change still highlighted in place, for when
three lines of context isn't enough to judge the change. It scrolls you to the
first change, and review threads keep anchoring to the same lines.

Files over 5,000 lines render in full but without syntax highlighting — the
footer says so.

## The map, flows and the data model

Backstory draws what a change did to the system, so you can see its effect
before reading its lines:

- **The map** is a C4 component view of the repo, with the components the change
  touched, added or removed. It reads `architecture/workspace.dsl`, a
  [Structurizr](https://docs.structurizr.com) model, from the repo at the
  change's base and head. A repo that doesn't commit a model can keep one at
  `~/.backstory/models/<repo>/workspace.dsl`; it shows which components a change
  touched, but not what it added or removed. With no model at all, **Draft a
  model** in the map strip has Claude Code read the code at HEAD and write one
  there, never into the repo: a draft, marked as one, for you to correct.
- **The data model** shows the entities the change touched: new fields,
  relationships and rules. It reads `db/schema.rb` and the models (Rails), the
  `.xcdatamodeld` (Core Data), or SQL schema files: the `CREATE TABLE`
  statements in a `schema.sql`, a `structure.sql` or a `schema/` folder, outside
  migrations and tests. Any other repo can have its data model drafted on
  demand: **Draft the data model** in the data strip has Claude Code read the
  code at the head, and work out the base from the change. The result is marked
  as a draft and kept in `~/.backstory/data/`, so a view is read once. A head
  read costs about $0.15 on a small repo and over $1 and a few minutes on a
  large one.
- **Flows** are sequence diagrams of what the code does for each user action the
  change touches, before and after, beside the code they come from.

Backstory reads the part of the DSL that describes elements and arrows:

- `workspace`, `!identifiers hierarchical` (or the default `flat`), `model`, and
  `properties` at the top and inside elements. `code.globs` on an element says
  which files belong to it; `code.tests` and `code.ignore` on the workspace say
  which files are tests or not code at all. `data.files` on the workspace says
  which files contain the data model, for a Rails app in a folder or SQL files
  off the usual paths, and `data.format` (`rails`, `core data` or `sql`) says
  which reader reads them.
- `person`, `softwareSystem`, `container` and `component`, nested, named
  (`id = container "…"`) or not, with `tags`, `technology`, `url`, `description`
  and `perspectives` inside them.
- Arrows, `a -> b "…"` in the model or `-> b "…"` inside an element, with ids
  written in full or relative to the block they're in.
- Comments (`//`, `#`, `/* … */`), `\"` in strings, and `\` at a line's end to
  continue on the next line.

`views`, `styles`, `configuration` and other blocks at the workspace's top level
are skipped. Anything else in the model, any `!` directive other than
`!identifiers`, and `workspace extends` stop the map: `group`,
`deploymentEnvironment` or `!include`, for example. The strip names what it met
and its line.

Flows are traced by **Claude Code**, through your own `claude` login: Backstory
runs `claude -p` over a copy of the commit, with read-only tools. That means:

- **Your code is read by Claude** the same way it is when you use Claude Code in
  that repo. Think about that before tracing a repo you couldn't use Claude Code
  on.
- **It costs.** Tracing a change takes about a minute and usually $0.10–0.40 on
  your Claude account. It only happens when you press "Trace this change", and
  the result is kept in `~/.backstory/flows/`, so a view is traced once.
- **The model** is Sonnet. On a server you run yourself (`npm run dev`),
  `BACKSTORY_FLOWS_MODEL` picks another (`opus`, or a full model id). Every step
  Claude cites is checked against its line; the ones that don't match are shown
  dashed, as unverified.

## Reviewing an agent's work

### The `backstory` command

The agent's side of a review goes through the `backstory` command:
`backstory review` and the Claude Code Stop hook below both run it. It comes
inside the app.

To set it up for Claude Code, choose **Backstory → Set Up Backstory…**, then
press **Set Up** on the **Notes to your agent** row. It shows what it will
change, then adds the Stop hook to `~/.claude/settings.json` and
`/backstory-review` to `~/.claude/commands/`, both naming the command by its
place in the app. Set it up with Backstory in Applications. If you move the app
afterwards, the row offers **Set Up** again, which points the hook at its new
place.

To type `backstory` in a terminal, choose **Backstory → Install Command Line
Tool…**. It links `/usr/local/bin/backstory` to the command in the app, asking
for your password if that folder needs it. After that, `backstory` in a repo
opens it in Backstory. If you move the app, choose it again to fix the link.

### Sending notes

When an agent is making the change, you review what it made — uncommitted work,
or the commits it made on its own if you let it run. Notes go on any change:
hover a line of **Uncommitted**, **All changes**, or any one commit, and press
**+**; **Add a general note** covers the work as a whole. When you review a
stack of commits one at a time, the notes on each commit are kept to send
together, and the bar lists the ones on other changes.

A note on a commit is sent naming the commit, and whether it's been pushed.
Notes remember the text of their line, so they follow it when the agent's next
edit moves it. When they can't be sure where it went, they say so.

**Send to agent** sends them as one markdown message, each note under the
`path:line` it refers to with the line quoted. If the agent is busy, the round
is queued in `~/.backstory/outbox.json` and the agent's Claude Code Stop hook
collects it the next time it finishes a turn, then continues with your notes.
**Copy** puts the same message on the clipboard instead.

A queued round is aimed at the session last seen stopping in that checkout, and
says so — "Queued for the session active here 5m ago" — so a second session
there can't collect it. Until one has been seen, it goes to whichever stops
first. Once collected it reads "Delivered 2m ago". While it waits you can
**Cancel** it, which returns its notes to drafts, or, if the session it was
aimed at has ended, **Send to the next session instead**.

The hook is installed once, globally, in `~/.claude/settings.json`, and runs for
every session. It does nothing until a checkout has notes queued. **Set Up** on
the setup checklist's Notes to your agent row adds it (see
[The `backstory` command](#the-backstory-command)).

Or let the agent ask. `backstory review` opens the uncommitted changes and
waits; the window says an agent is waiting and offers **Send to agent** (or
**Looks good**). While it waits, Send goes directly to it, not into the queue:
your notes are printed to the command's stdout and it exits — so an agent that
runs it reads your review as the command's output. That works for any agent, not
only Claude Code. In Claude Code, the same **Set Up** adds it as a slash
command: type `/backstory-review` in a session. The agent runs
`backstory review` in the background and continues once you send.

Whichever way notes left — sent, queued or copied — they become a **round**:
fixed, since that's what the agent read, each with a tick. After the agent makes
its edits, check each note against the diff and tick it yourself. The bar keeps
every round's count ("2 of 3 handled"), and **Clear handled** removes the ones
you've ticked.

If Backstory isn't running, `backstory review` opens the Mac app and waits for
its server to come up before asking for the review.

## Review comments from GitHub

When a branch has a PR with review comments, Backstory turns them into a
checklist to work through.

The **spine** is the checklist: one square per comment, filled when handled. It
shows how far through you are and jumps to any comment in one click. A square
selects; `j`/`k` move; `x` ticks. In a narrow window it becomes a strip under
the header.

The **response** is what you're doing about the comment on screen: the tick, a
drafted reply, and optionally the commit that answers it. All three are
independent.

A thread that isn't on a line in the current change is counted rather than shown
as a card.

Only you decide when a comment is handled: you tick it. Linking a commit,
drafting a reply or a reply on GitHub never ticks it for you.
[How it works](how-it-works.md#handling-a-comment-is-deliberate) says why.

A comment answered without any code change is one you tick without linking a
commit — the reply templates drop `Addressed in <commit>` and offer a plain 👍
or "No change needed".

### Links survive rebases

Rebasing a stack rewrites every sha, which would break every linked commit. So a
link stores the commit's **patch-id** — a hash of its diff alone — alongside the
sha. A rebased commit keeps its patch-id, so a stale link is re-matched to the
rewritten commit automatically and marked _re-matched after a rebase_.

| you did                                              | result                               |
| ---------------------------------------------------- | ------------------------------------ |
| rebase / restack (clean)                             | re-matched automatically             |
| reword a commit message                              | re-matched: same diff, same patch-id |
| squash, amend the content, rebase through a conflict | `26ef8f7 gone`, asks for a new link  |

**A rebase never unticks anything.** It rewrites the link and only the link, so
the comment stays handled and re-linking is offered.

## Shareable URLs

The repo and the selected commit live in the address bar, so a view can be
bookmarked, reopened after a restart, or pasted to another machine with the same
checkout. A copy button in the header copies the current one.

```text
/?repo=/Users/you/code/your-repo
/?repo=/Users/you/code/your-repo&rev=1e61946e49974e250cf688eda4c158132e12be83
```

`rev` is optional and accepts a short sha, which is normalised to the full one.
If a link points at a commit that's since been pushed, Backstory falls back to
the latest and tells you. A bare `/` is the inbox.

## Login, updates and logs

The app gives Backstory its own Dock icon and Cmd-Tab entry, and runs the server
itself: it starts the server when you open the app, restarts it if it stops, and
stops it when you quit. One server handles all your checkouts (default port
4460).

**Open at Login** in the app menu starts Backstory with your Mac, for live
updates with no window open.

**Check for Updates…** in the same menu offers the latest GitHub release.

The server logs to `~/.backstory/server.log`.

## What Backstory keeps

Its own state lives under `~/.backstory`: traced flows, drafted models and data
models, notes, ticks and drafted replies, and the outbox. Nothing Backstory
writes is inside your repos.

## Uninstalling

1. If you set up notes to your agent, choose **Backstory → Set Up Backstory…**
   and press **Remove…** on the **Notes to your agent** row. It takes the Stop
   hook and `/backstory-review` out of `~/.claude`. If you installed the command
   line tool, choose **Backstory → Install Command Line Tool…** and press
   **Remove**.
2. Turn off **Open at Login**, quit Backstory, and delete `Backstory.app`.
3. Delete Backstory's data: notes, ticks, the outbox, traced flows, drafted
   models and data models, and the log.

   ```bash
   rm -rf ~/.backstory
   ```

4. Optionally, remove the app's settings, its update state and the window's
   storage, which has your recent repos:

   ```bash
   defaults delete dev.backstory.app
   rm -rf ~/Library/Caches/dev.backstory.app ~/Library/HTTPStorages/dev.backstory.app ~/Library/WebKit/dev.backstory.app
   ```
