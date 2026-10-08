---
description: Have me review your changes in Backstory — commits or uncommitted work — then act on my notes
allowed-tools: Bash(backstory review:*)
---

I want to review the changes you've made — commits and uncommitted work — before
you go further.

Run `backstory review` with the Bash tool **in the background** (`run_in_background: true`).
It opens the changes in Backstory and waits — possibly for a long time — until I
send my notes, then prints them to stdout and exits. Don't poll it or sleep on
it; you'll be woken when it finishes. Until then, stop and wait for me.

When it finishes, its stdout is my review:

- Each `## path:line` section quotes the line I commented on, then my note.
  Find the line by its quoted text if the number has drifted.
- A heading saying a line "has changed since" means the code moved under the
  note — use the quote to find what I meant, and ask if you can't.
- A heading naming a commit — `(in 3f2a1c9 "subject", not yet pushed)` — is a
  note on that commit. Before changing it, tell me how you mean to fix it (a
  fixup folded into that commit, a new commit on top, …) and wait for me to
  agree: it depends on how we're working, and rewriting history is my call.
  `(committed, at HEAD)` is on the branch's code as committed; `(uncommitted)`
  is on work not yet committed.
- `## General` notes are about the change as a whole.
- "No changes requested" means carry on.
- "Dismissed without leaving feedback" means I'm not reviewing right now;
  carry on, and don't run it again unless I ask.

Address every note, then summarise what you changed for each one.
