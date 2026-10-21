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

Backstory draws your code with Claude Code. Until Claude Code is installed and
signed in, Backstory shows only a card that says so, with **Get Claude Code** or
**Copy: claude auth login**, and checks again when you come back to the window.

The first time, the inbox opens with **Set up Backstory**: a row each for git,
Claude Code, GitHub and notes to your agent, saying what each one adds, with a
button for whatever is missing. Git and Claude Code are marked needed. It checks
again when you come back to the window. **Backstory → Set Up Backstory…** brings
it back.

**Open Repo…** picks a checkout, and so does a folder dropped on the window or
its Dock icon. Or use **Browse**, which finds them for you, or type a path. From
then on `/` is the inbox: every worktree of every repo you've opened.

Browse leads with the **sibling worktrees** of whatever repo is open, listed
with the branch each one has checked out. Below that is a directory navigator
that marks which folders are git checkouts.

## The inbox and the workspace

**The inbox** is the home screen: every worktree you've got checked out, across
every repo you've opened, with how many of each pull request's review comments
GitHub still calls unresolved. A comment counts until someone presses
**Resolve conversation** on GitHub.

```text
10 unresolved comments
across 5 branches · 21 worktrees checked out

ACME-APP ──────────────────────────────────────────────────────────
 ●  feature/offline-sync-1203       #40 open     5 unresolved
    Queue edits made offline and replay them
 ○  fix/login-timeout-36            #38 merged
 ○  feature/release-script          no PR yet
```

Under each repo, **On GitHub** lists the open pull requests and branches on
GitHub that this clone has no local branch for. Click one to fetch it into a
local branch and review it; your checkouts stay as they are. While you review a
branch that isn't checked out, **Fetch** beside its name brings in the newest
push. A local branch with commits of its own, or one checked out in a worktree,
is left as it is, and Fetch says so.

**The workspace** is one branch. Its header picks the change: the whole branch,
your uncommitted work, or any one commit on it. It opens on your uncommitted
work when there is some, and on the whole branch otherwise. Under the header are
three tabs, as on a pull request, and every change opens on the first:

- **Story** shows the map at full width, a line under it saying what it shows,
  then each flow as a card. Before a change is traced, one card in place of the
  flows offers **Trace this change**. Click a step to open its code under it;
  click it again or press `Esc` to close it, and **Show in Files changed** opens
  the diff at the same lines.
- **Files changed** is the diff.
- **Comments** lists the pull request's review comments, when it has any.

The tab is in the address bar, so a link opens on the tab it was copied from.

In **Files changed**, files are grouped by the map's components, each group
with an **On the map** link that outlines its component on Story; **By path**
lists them by path instead. Once the change is traced, each file says which
flows it is on, or **read yourself** when it is app code no flow explains. The
filters above the files show only the hunks to read yourself, or the files on
one flow; **read these yourself** beside the flows on Story opens the first.
Marks in the gutter beside a line open what is there: `⇄ 1·7` opens flow 1, step
7 in the story, and `💬 2` opens review comment 2 in Comments.

**View file** — every file header has a _View file_ toggle that swaps the hunks
for the entire file at that commit, change still highlighted in place, for when
three lines of context isn't enough to judge the change. It scrolls you to the
first change, and review threads keep anchoring to the same lines.

Files over 5,000 lines render in full but without syntax highlighting — the
footer says so.

## The map, flows and the data model

Backstory draws what a change did to the system, so you can see its effect
before reading its lines:

- **The map** is a C4 component view of the repo, with the components and
  arrows the change touched, added or removed. It reads
  `architecture/workspace.dsl`, a [Structurizr](https://docs.structurizr.com)
  model, from the repo at the change's base and head.
  - A repo that doesn't commit a model can have one written by hand at
    `~/.backstory/models/<folder>-<hash>/workspace.dsl`, where `<folder>` is
    the main checkout's folder and `<hash>` is 8 characters that tell apart
    repos with the same folder name. Every worktree of the repo reads it, and
    the line under the map on Story shows its path, or where it goes when
    there isn't one yet. The hash comes from where the checkout is on disk, so
    after you move or rename the checkout, rename its folder under
    `~/.backstory/models/` to the one that line shows. It's the same model for
    every commit, so the map shows which components a change touched, but not
    what it added or removed.
  - Any other repo can have its map drafted by Claude Code, the same way as
    the data model. It reads main's map in full once per repo, a minute or two
    on a small repo and more on a large one. Every other commit's map is worked
    out from the nearest map already read, by reading only the patch between
    them, well under a minute. The map marks
    the components and arrows a branch added or removed, is marked as a draft,
    and is kept in `~/.backstory/maps/`, a cache you can delete. Nothing is
    written into the repo, or to `~/.backstory/models/`.
  - Opening a repo starts the read of main's map, and opening a view on Story
    starts the view's read, with its progress where the map goes. For a repo
    you turned off (see **Turn off** below), **Draft a model** reads one view,
    and **Read automatically** beside it turns reading back on for the repo's
    maps and data models.
  - The map opens by itself when the change touches a component. When it
    touches none, the line under the map says so and has **Show map**, which
    opens the whole system at the level of its containers: every container,
    person and external system, with the arrows between them. A component's
    arrow is drawn from or to its container. **Hide map** closes it.
  - Under a drafted map, the line has **Turn off**, which stops reading this
    repo's maps and data models as it opens, and **Redraft**, which reads
    main's map in full again and removes every map worked out from the old
    one. Once the repo is turned off, **Read automatically** takes the place of
    **Turn off** and turns reading back on.
- **The data model** shows the entities the change touched: new fields,
  relationships and rules. It reads `db/schema.rb` and the models (Rails), the
  `.xcdatamodeld` (Core Data), or SQL schema files: the `CREATE TABLE`
  statements in a `schema.sql`, a `structure.sql` or a `schema/` folder, outside
  migrations and tests. Any other repo can have its data model drafted by
  Claude Code. It reads main's data model in full once per repo, a few minutes
  on a large repo. Every other commit's model is worked out from the nearest
  model already read, by reading only the patch between them, well under a
  minute. A view's base is
  worked out from main's model, and its head from its base, so a second branch
  from the same point, or a branch rebased onto main, reads only its own
  change. The result is marked as a draft and kept in `~/.backstory/data/`.
  - Reads start as a repo and a view open: opening a repo starts the reads of
    main's data model and map, and opening a view on Story starts the view's
    reads, with the data model's progress on the Data line. **Turn off**, under
    each drafted map and data model, stops new reads of either kind for that
    repo and all its worktrees; a read already running finishes. For a repo
    you turned off, **Draft the data model** under the map on Story reads one
    view, and **Read automatically** beside it turns reading back on and starts
    this view's read.
  - On a drafted view, the Data line has **Turn off**, or **Read automatically**
    for a repo you turned off, and **Redraft**. **Show
    data** opens the whole model when the change touches none of it.
  - The Data line's graph opens by itself when the change touches the data
    model; **Hide data** closes it.
  - Main's data model moves forward when a view's base is on main and past it:
    the read that view's base needed is main's change since, and the base
    becomes main's model. Main is read in full again only when the patch from
    its model to a commit on main is too large to send, which reads that
    commit in full, or when you press **Redraft**. Redraft reads main in full
    again and removes every model worked out from the old one, since a mistake
    in main's model is copied into each of them.
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
`deploymentEnvironment` or `!include`, for example. The line under the map on
Story names what it met and its line.

Flows are traced by **Claude Code**, through your own `claude` login: Backstory
runs `claude -p` over a copy of the commit, with read-only tools. That means:

- **Your code is read by Claude** the same way it is when you use Claude Code in
  that repo. Its map and data model are read as the repo opens, so think about
  that before opening a repo you couldn't use Claude Code on.
- **It runs on a click.** Tracing a change takes about a minute, and only
  happens when you press "Trace this change". The result is kept in
  `~/.backstory/flows/`, so a view is traced once.
- **The model** is Sonnet. On a server you run yourself (`npm run dev`),
  `BACKSTORY_FLOWS_MODEL` picks another (`opus`, or a full model id). Every step
  Claude cites is checked against its line; the ones that don't match are shown
  dashed, as unverified.

### Cost

Every read runs through your own Claude Code login:

- With an API key, you pay per read. Main's map or data model is about a dollar
  on a large repo and cents on a small one, and each change after it is cents. A
  trace usually costs $0.10–0.40.
- On a Claude subscription, reads count toward Claude's usage limits.
- Each repo has **Turn off**, under its drafted map and data model, to stop
  reading it as it opens.

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
in Files changed, hover a line of **Uncommitted**, **All changes**, or any one
commit, and press
**+**; **Add a general note** covers the work as a whole. When you review a
stack of commits one at a time, the notes on each commit are kept to send
together, and the bar lists the ones on other changes.

A note on a commit is sent naming the commit, and whether it's been pushed.
Notes remember the text of their line, so they follow it when the agent's next
edit moves it. When they can't be sure where it went, they say so.

**Send to agent** sends them as one markdown message, each note under the
`path:line` it refers to with the line quoted. If the agent is busy, the round
is queued in `~/.backstory/backstory.db` and the agent's Claude Code Stop hook
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

When a branch has a PR with review comments, Backstory shows them as they are on
GitHub, numbered oldest first. To reply or resolve one, open it on GitHub. In
**Files changed**, each sits on its line as `💬` and its number.

**Comments** shows every comment as a card, oldest first: its file and line, its
component, the lines it was written against, the comment and its replies, and
**Open on GitHub**. A comment on a line a flow passes through says which step,
with **open in the story**. On the Comments tab `j`/`k` move between comments.

## Shareable URLs

The repo, the selected commit and the open tab live in the address bar, so a
view can be bookmarked, reopened after a restart, or pasted to another machine
with the same checkout. A copy button in the header copies the current one.

```text
/?repo=/Users/you/code/your-repo
/?repo=/Users/you/code/your-repo&rev=1e61946e49974e250cf688eda4c158132e12be83
/?repo=/Users/you/code/your-repo&rev=1e61946&tab=files
```

`rev` is optional and accepts a short sha, which is normalised to the full one.
If a URL points at a commit that's since been pushed, Backstory falls back to
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

Its own state lives under `~/.backstory`. Notes to your agent and the outbox are
in one database, `backstory.db`. Traced flows, drafted maps and
data models, and hand-written models are files beside it. Nothing Backstory writes is inside your repos.

If you connected GitHub, its token is in your login Keychain, under
`dev.backstory.github`.

## Uninstalling

1. If you set up notes to your agent, choose **Backstory → Set Up Backstory…**
   and press **Remove…** on the **Notes to your agent** row. It takes the Stop
   hook and `/backstory-review` out of `~/.claude`. If you installed the command
   line tool, choose **Backstory → Install Command Line Tool…** and press
   **Remove**. If you connected GitHub, choose **Backstory → Disconnect
   GitHub**. It deletes Backstory's GitHub token from your Keychain.
2. Turn off **Open at Login**, quit Backstory, and delete `Backstory.app`.
3. Delete Backstory's data: notes, the outbox, traced flows, drafted
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

5. Optionally, to remove Backstory from your GitHub account too, open
   github.com → Settings → Applications → Authorized OAuth Apps, choose
   Backstory and press **Revoke**.
