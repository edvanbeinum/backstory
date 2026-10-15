# Backstory

Stop reading diffs. Backstory shows what a change did to your system, on a C4
map, as sequence diagrams and in the data model, so you can review an agent's
work without reading every line.

An agent can write a change faster than you can read it, and you're still
answerable for what ships. Reading the diff line by line is slow, and it doesn't
answer the questions that matter most: what parts of the system does this touch,
what does each user action do now, and what happens to the data?

For a branch, a commit or your uncommitted work, Backstory draws:

- **The map**: a C4 component view of the repo, with the components the change
  touched, added or removed.
- **Flows**: a sequence diagram of each user action the change touches, before
  and after.
- **The data model**: the entities, fields and relationships the change touched.

The diff is a click away from any component or step. Notes on what needs fixing
go back to the agent that wrote the change. The PR's review comments appear on
the lines they refer to, as a checklist you tick off.

Backstory is a Mac app that runs on your machine, over your own checkouts. More
at [stopreadingdiffs.com](https://stopreadingdiffs.com).

## Install

You need:

- A Mac with Apple silicon, on macOS 14.6 or later.
- **git**.
- [Claude Code](https://claude.com/claude-code), installed and signed in, to
  trace flows and draft a map or data model.
- A GitHub connection, to bring in the PR and its review comments. Press
  **Connect GitHub** on the setup checklist and approve the code it shows on
  github.com. If [gh](https://cli.github.com) is already signed in with
  `gh auth login`, the setup checklist shows GitHub as ready and Backstory
  reads through `gh`. On GitHub Enterprise, sign in with `gh`.

1. Download `Backstory-<version>.dmg` from the
   [latest release](https://github.com/edvanbeinum/backstory/releases/latest).
2. Open the disk image and drag Backstory to Applications.
3. Open Backstory. The inbox opens with **Set up Backstory**: a row each for
   git, GitHub, Claude Code and notes to your agent, with a button for anything
   missing.

## Review your first change

1. Choose **File → Open Repo…** and pick a checkout. You can also drop its
   folder on the window. The workspace opens on its branch.
2. In the header, pick the change to review: the whole branch, your uncommitted
   work, or one commit.
3. Press **Trace this change**. Claude Code reads the change through your own
   `claude` login, the same way it does when you use Claude Code in that repo.
   It takes about a minute and usually costs $0.10–0.40 on your Claude account.
   When it finishes, the view leads with the map, the data model and the flows.
4. Check the map for the components the change touched. If the repo has no C4
   model, press **Draft a model** and Claude Code writes one for you to correct,
   outside the repo.
5. Open a flow and step through it. Press **Show in diff** on a step to see the
   code behind it.
6. To ask the agent for a fix, hover a line in the diff, press **+** and write a
   note. Then press **Send … to agent**, or **Copy** to paste the notes into the
   agent's session yourself.

[Using Backstory](docs/using-backstory.md) covers the rest, including how notes
reach an agent that's busy.

## Troubleshooting

**Trace this change says it needs Claude Code.** Install
[Claude Code](https://claude.com/claude-code) and sign in, then press **Look
again**.

**A banner sits where the PR's review comments should be.** GitHub isn't
connected. Press **Connect GitHub** in the banner and approve the code on
github.com, or run `gh auth login` and refresh the window.

**The map strip names a line instead of drawing the map.** The repo's
`architecture/workspace.dsl` uses something Backstory doesn't read, such as
`group` or `!include`.
[The map, flows and the data model](docs/using-backstory.md#the-map-flows-and-the-data-model)
lists what it reads.

**Notes stay queued and never reach the agent.** The agent's Stop hook isn't set
up. Choose **Backstory → Set Up Backstory…**, then press **Set Up** on the
**Notes to your agent** row.

**Anything else.** The server logs to `~/.backstory/server.log`.

## Documentation

- [Using Backstory](docs/using-backstory.md): the inbox and the workspace, the
  map, flows and data model, reviewing an agent's work, review comments, updates
  and uninstalling.
- [How Backstory works](docs/how-it-works.md): the reasoning behind its
  behaviour.
- [Working on Backstory](docs/contributing.md): run it from a checkout, build
  the Mac app and run the tests.
- [Packaging Backstory](packaging/README.md): sign, notarize and release the Mac
  app.

## License

[MIT](LICENSE)
