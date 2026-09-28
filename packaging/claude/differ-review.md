---
description: Have me review your uncommitted changes in differ, then act on my notes
allowed-tools: Bash(differ review:*)
---

I want to review the uncommitted changes you've made before you go further.

Run `differ review` with the Bash tool **in the background** (`run_in_background: true`).
It opens the changes in differ and waits — possibly for a long time — until I
send my notes, then prints them to stdout and exits. Don't poll it or sleep on
it; you'll be woken when it finishes. Until then, stop and wait for me.

When it finishes, its stdout is my review:

- Each `## path:line` section quotes the line I commented on, then my note.
  Find the line by its quoted text if the number has drifted.
- A heading saying a line "has changed since" means the code moved under the
  note — use the quote to find what I meant, and ask if you can't.
- `## General` notes are about the change as a whole.
- "No changes requested" means carry on.
- "Dismissed without leaving feedback" means I'm not reviewing right now;
  carry on, and don't run it again unless I ask.

Address every note, then summarise what you changed for each one.
