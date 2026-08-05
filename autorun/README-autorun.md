# Skein auto-runner
Copy TASKS.md, run-tasks.sh, and .claude/ into the repo root (merge .claude if it exists).

- Each task runs in a FRESH `claude -p` session → context is cleared between tasks by construction
  (equivalent to /clear; an in-session model cannot reliably clear itself).
- The Stop hook (verify-task.sh) blocks Claude from finishing until `npm test` is green AND the tree is committed.
- run-tasks.sh picks the first unchecked box in TASKS.md; Claude ticks it as part of its commit; loop advances.
- Run inside a container/VM: the loop uses --dangerously-skip-permissions. Review commits, not keystrokes.
- Interactive alternative: use the same TASKS.md manually; the Stop hook still enforces test+commit per task.
