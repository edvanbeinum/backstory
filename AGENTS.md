<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# How code is written here

Rules a tool can't check. Each one names where it came from.

- Comment only a non-obvious _why_ (a constraint, a trap, a past bug). No step labels or restatements of the next line. When editing near narrating comments, drop them rather than reword them. _(Ed, differ review, 2026-09-28.)_

# Before you plan

- Read `architecture/primitives.yaml` before planning, and use its terms for names. _(Ed, #4, 2026-10-04.)_
- When you add or rename a block or a term, update `architecture/primitives.yaml` in the same change. _(Ed, #4, 2026-10-04.)_

Formatting and lint rules live in `eslint.config.mjs` and Prettier, not here.
