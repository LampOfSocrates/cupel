#!/usr/bin/env bash
# Outer loop: one FRESH Claude session per task = automatic context clear between tasks.
# Usage: ./run-tasks.sh [max_tasks]
set -euo pipefail
MAX=${1:-50}
for i in $(seq 1 "$MAX"); do
  TASK=$(grep -m1 '^\- \[ \]' TASKS.md | sed 's/^- \[ \] //') || true
  [ -z "${TASK:-}" ] && echo "All tasks done." && exit 0
  echo "=== ($i) $TASK ==="
  claude -p --dangerously-skip-permissions "Read CLAUDE.md and the three docs it references. \
Work EXACTLY ONE task and no other: '$TASK'. Find its dev prompt in feature-spec.md by its T-number and follow it. \
Quote the relevant spec lines first. When done: all tests green, commit as '$(echo "$TASK" | cut -d' ' -f1)', \
tick this task's checkbox in TASKS.md and include that in the commit. Then stop." \
    || { echo "Task failed — stopping loop for review."; exit 1; }
done
