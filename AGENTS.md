<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# How code is written here

Rules a tool can't check.

- Comment only a non-obvious _why_ (a constraint, a trap, a past bug). No step labels or restatements of the next line. When editing near narrating comments, drop them rather than reword them. When a change removes the reason a comment gives, delete the comment rather than trim it to what's left.
- Lead a comment with what the code does, in the active voice, then the reason. Write "Strip the user's git config and any `GIT_*` a pre-push hook exported, so git sees only the temp directory it's given", not "Git with none of the user's config, and no `GIT_*` left over from a hook that is running these tests, so it only ever sees the temp directory it's given." Keep people's names out of code and comments.

Formatting and lint rules live in `eslint.config.mjs` and Prettier, not here. Run `npm run verify` before you finish; CI runs it too, and the pre-push hook runs `npm run check`.

# Before you plan

- Read `architecture/language.yaml` before planning, and use its terms for names.
- When you add or rename a block or a term, update `architecture/language.yaml` in the same change.
- Read `architecture/primitives.yaml` too. Build from its primitives. If none fits, extend one. Ask before adding a new primitive.
- Say in your plan what the change composes, extends and adds, naming the primitives:
  - **composes**: uses a primitive as it is.
  - **extends**: changes an existing primitive, for example a new option or a new case.
  - **adds**: a new primitive, something meant to be reused from more than one place. Agree it first. A helper private to one file is not an add.
- When you rename or remove a primitive, update `architecture/primitives.yaml` in the same change. The test catches a rename or removal that is missed.
