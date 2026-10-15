# Working on Backstory

How to run Backstory from a checkout, build the Mac app and run the tests.

## Run it from a checkout

You need Node and npm. To build the Mac app you also need Xcode.

1. Install the dependencies:

   ```bash
   npm install
   ```

2. Start the dev server:

   ```bash
   npm run dev
   ```

3. Open http://127.0.0.1:3000. You should see the inbox.

## Build the Mac app

With Xcode installed:

```bash
npm run mac:build
```

Drag `mac/build/Backstory.app` to Applications and open it. `npm run mac:dmg`
packs it into a disk image; `packaging/README.md` says how to sign, notarize and
release it.

`npm run mac:smoke` checks the built app end to end on spare ports. To work on
the app against a dev server, pass it the address; it shows that server instead
of starting its own:

```bash
open mac/build/Backstory.app --args -serverURL http://127.0.0.1:3000
```

`backstory --port 3000` opens a repo on a dev server in the browser.

## Run the tests

```bash
npm test
```

Covers the diff parser (added / deleted / renamed / binary files, quoted unicode
paths, no-newline markers, single-line hunk ranges) and the thread anchoring
rules — including the one that matters most: a comment whose line isn't in the
current diff must fall through to "unanchored" and still be shown, never
silently dropped.

`npm test` points `BACKSTORY_HOME` at a fresh temp directory, so tests never
read or write your real `~/.backstory`.

`npm run check` runs the typecheck, lint, format check and tests.
`npm run verify` runs all of those, plus the build.

```bash
npm run check
npm run verify
```

GitHub Actions runs `npm run verify` on every pull request and on pushes to
`main`. To catch failures before they leave your machine, opt in to the pre-push
hook, which runs `npm run check` and refuses the push if it fails:

```bash
git config core.hooksPath .githooks
```

This sets the hooks path for this repo only, so it overrides any global
`core.hooksPath` you have here. `git push --no-verify` skips the hook once.

## Find your way around the code

`architecture/language.yaml` lists Backstory's building blocks: what each one
does, the files it lives in, and what to read before changing it.
`architecture/primitives.yaml` lists the capabilities to build new work from.
`AGENTS.md` has the house rules for writing code here.
