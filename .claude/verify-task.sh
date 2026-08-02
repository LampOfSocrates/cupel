#!/usr/bin/env bash
# Gate: Claude may not stop until tests pass AND the work is committed.
set -u
if ! npm test --silent; then
  echo '{"decision":"block","reason":"Tests failing. Fix them before finishing the task."}'
  exit 0
fi
if [ -n "$(git status --porcelain)" ]; then
  echo '{"decision":"block","reason":"Uncommitted changes. Commit as P{phase}-T{id}: <summary>, then tick the task checkbox in TASKS.md and commit that too."}'
  exit 0
fi
exit 0
