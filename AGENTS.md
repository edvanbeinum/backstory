<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# How code is written here

Rules a tool can't check.

- Comment only a non-obvious _why_ (a constraint, a trap, a past bug). No step labels or restatements of the next line. When editing near narrating comments, drop them rather than reword them.
- Lead a comment with what the code does, in the active voice, then the reason. Write "Strip the user's git config and any `GIT_*` a pre-push hook exported, so git sees only the temp directory it's given", not "Git with none of the user's config, and no `GIT_*` left over from a hook that is running these tests, so it only ever sees the temp directory it's given." Keep people's names out of code and comments.

Formatting and lint rules live in `eslint.config.mjs` and Prettier, not here. Run `npm run verify` before you finish; CI runs it too, and the pre-push hook runs `npm run check`.

# Before you plan

- Read `architecture/primitives.yaml` before planning, and use its terms for names.
- When you add or rename a block or a term, update `architecture/primitives.yaml` in the same change.
