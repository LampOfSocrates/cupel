#!/usr/bin/env bash
# skein-run.sh — one self-contained task runner for Skein. (Git Bash / macOS / Linux)
# Loop: pick first unchecked task in TASKS.md → fresh headless Claude session for that ONE
# task → session must end with tests green + a commit → runner verifies independently →
# prints progress + tokens/cost → next task.
#
# Usage: ./skein-run.sh [max_tasks]     DRY=1 ./skein-run.sh  (preview only)

set -euo pipefail
MAX="${1:-999}"
command -v claude >/dev/null || { echo "claude CLI not found (npm i -g @anthropic-ai/claude-code)"; exit 1; }

# Python for JSON parsing (jq optional). Git Bash usually has 'python', not 'python3'.
PY=$(command -v python3 || command -v python || true)
[ -z "$PY" ] && { echo "python or python3 required"; exit 1; }
jget() { # jget '<json>' key.path default
  "$PY" - "$2" "$3" <<'PYEOF' 2>/dev/null || echo "$3"
import sys, json
path, default = sys.argv[1], sys.argv[2]
try:
    d = json.load(sys.stdin)
    for k in path.split("."):
        d = d[k] if isinstance(d, dict) else None
    print(d if d is not None else default)
except Exception:
    print(default)
PYEOF
}

for f in TASKS.md feature-spec.md skein-phases.md react-migration.md CLAUDE.md; do
  [ -f "$f" ] || { echo "Missing $f in $(pwd) — run from the repo root"; exit 1; }
done

TOTAL_IN=0; TOTAL_OUT=0; TOTAL_COST=0; START_TS=$(date +%s)
progress() {
  local d t
  d=$(grep -c $'^- \[x\]' TASKS.md 2>/dev/null || echo 0)
  t=$(grep -c $'^- \[' TASKS.md 2>/dev/null || echo 0)
  echo "── progress: $d/$t tasks · tokens in=$TOTAL_IN out=$TOTAL_OUT · cost \$$TOTAL_COST · $((($(date +%s)-START_TS)/60))m elapsed"
}

for i in $(seq 1 "$MAX"); do
  # tr -d '\r' → CRLF-safe on Windows checkouts
  TASK=$(grep -m1 $'^- \[ \]' TASKS.md | tr -d '\r' | sed 's/^- \[ \] //' || true)
  if [ -z "${TASK:-}" ]; then echo "✅ All tasks complete."; progress; exit 0; fi
  TID=$(echo "$TASK" | awk '{print $1}')

  echo ""; echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "▶ Task $i: $TASK"; progress

  PROMPT="Read CLAUDE.md, react-migration.md, skein-phases.md, and feature-spec.md.
Execute TASKS.md task '$TID' and NOTHING else: $TASK
Steps, in order:
1. Find this task's numbered development prompt in feature-spec.md (match the T-number) and the relevant feature sections + sketches; QUOTE the spec lines you implement before coding.
2. Obey every invariant in CLAUDE.md and every rule in react-migration.md (cite file:line about existing code; check lockfile versions).
3. Implement only this task; stub cross-task joints and note them in the commit body.
4. Run npm test until green (plus smoke check if this task has UI).
5. Commit all work as '$TID: <one-line summary>' with spec lines + stubs in the body.
6. In TASKS.md change this task's '- [ ]' to '- [x]' and amend into the same commit.
7. Stop. Do not start the next task."

  [ "${DRY:-0}" = "1" ] && { echo "$PROMPT"; exit 0; }

  HEAD_BEFORE=$(git rev-parse HEAD 2>/dev/null || echo none)
  set +e
  RESULT=$(claude -p --dangerously-skip-permissions --output-format json "$PROMPT" 2>&1)
  RC=$?
  set -e

  IN=$(  echo "$RESULT" | jget "$RESULT" usage.input_tokens 0)
  OUT=$( echo "$RESULT" | jget "$RESULT" usage.output_tokens 0)
  COST=$(echo "$RESULT" | jget "$RESULT" total_cost_usd 0)
  TOTAL_IN=$((TOTAL_IN+${IN%%.*})); TOTAL_OUT=$((TOTAL_OUT+${OUT%%.*}))
  TOTAL_COST=$("$PY" -c "print(round($TOTAL_COST+$COST,4))")
  echo "  tokens: in=$IN out=$OUT · cost \$$COST"

  FAIL=""
  [ $RC -ne 0 ] && FAIL="claude exited rc=$RC"
  [ -z "$FAIL" ] && [ "$(git rev-parse HEAD 2>/dev/null || echo none)" = "$HEAD_BEFORE" ] && FAIL="no commit was made"
  [ -z "$FAIL" ] && [ -n "$(git status --porcelain)" ] && FAIL="uncommitted changes left"
  [ -z "$FAIL" ] && ! npm test --silent >/dev/null 2>&1 && FAIL="tests failing post-commit"
  [ -z "$FAIL" ] && grep -qF -- "- [ ] $TASK" TASKS.md && FAIL="task not ticked in TASKS.md"

  if [ -n "$FAIL" ]; then
    echo "✖ $TID FAILED verification: $FAIL"
    echo "$RESULT" | tail -c 600; echo ""
    echo "Stopping for review. Fix, then re-run ./skein-run.sh"
    exit 1
  fi
  echo "✔ $TID verified: $(git log -1 --format=%h) · tests green · ticked"
done
echo ""; echo "Reached max ($MAX)."; progress
