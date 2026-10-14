#!/usr/bin/env bash
# Verification harness for the Vela CLI/TUI: isolated tmux session + disposable VELA_DIR + mock model.
# Usage: vela-verify.sh <launch|doctor|send|keys|wait|snap|grab|print|cleanup> <run-id> [args...]
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
CMD="${1:-}"; RUN="${2:-}"
[[ -n "$CMD" && -n "$RUN" ]] || { sed -n '2,3p' "$0"; exit 2; }
[[ "$RUN" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "run-id must be [A-Za-z0-9_-]+" >&2; exit 2; }
shift 2

STATE="/tmp/vela-verify/$RUN"                       # scratch: removed by cleanup
EVID="${VELA_EVIDENCE_ROOT:-/tmp/vela-evidence}/$RUN" # proof: survives cleanup
SOCK="vela-verify-$RUN"                             # private tmux server per run
T() { tmux -L "$SOCK" "$@"; }
export PATH="$HOME/.local/bin:$PATH"

vela_env() {
  echo "VELA_DIR=$STATE/home VELA_MODEL=mock VELA_OFFLINE=1 HOME=$STATE/userhome"
}

seed() {
  mkdir -p "$STATE/home" "$STATE/userhome" "$STATE/work" "$EVID"
  printf '1. Tool registration\n2. Agent loop\n3. Sessions\n' > "$STATE/work/sample-data.txt"
  echo "hello from the verify-vela fixture" > "$STATE/work/a.txt"
}

pane() { T capture-pane -p -t vela -S -200; }

case "$CMD" in
  launch)
    if T has-session -t vela 2>/dev/null; then echo "run $RUN already live; cleanup first" >&2; exit 1; fi
    seed
    # shellcheck disable=SC2046
    T new-session -d -s vela -x 120 -y 40 -c "$STATE/work" \
      "env $(vela_env) bun $REPO/src/cli/main.ts $*; echo '[vela exited]' \$?; sleep 600"
    T display -p -t vela '#{pane_pid}' > "$STATE/pane.pid"
    for _ in $(seq 1 60); do
      if pane | grep -q 'mock/mock-model'; then echo "READY run=$RUN state=$STATE evidence=$EVID"; exit 0; fi
      sleep 0.5
    done
    echo "NOT READY after 30s; pane:" >&2; pane >&2; exit 1 ;;
  doctor)
    ok=1
    T has-session -t vela 2>/dev/null && echo "tmux session: up (socket $SOCK)" || { echo "tmux session: MISSING"; ok=0; }
    [[ -f "$STATE/pane.pid" ]] && kill -0 "$(cat "$STATE/pane.pid")" 2>/dev/null && echo "pane pid: $(cat "$STATE/pane.pid") alive" || { echo "pane pid: dead"; ok=0; }
    echo "bun: $(bun --version 2>/dev/null || echo missing)  vela: $(cd "$STATE/work" 2>/dev/null && bun "$REPO/src/cli/main.ts" --version </dev/null 2>/dev/null || echo '?')  git: $(git -C "$REPO" rev-parse --short HEAD)"
    if [[ $ok == 1 ]]; then
      p="$(pane)"
      grep -q 'mock/mock-model' <<<"$p" && echo "model: mock/mock-model" || { echo "model: NOT mock (refuse to drive)"; ok=0; }
      grep -q "$STATE/work" <<<"$p" && echo "cwd: $STATE/work" || { echo "cwd: not the run's work dir"; ok=0; }
      grep -q '\[vela exited\]' <<<"$p" && { echo "vela: EXITED"; ok=0; } || true
    fi
    [[ $ok == 1 ]] && echo "DOCTOR OK" || { echo "DOCTOR FAIL"; exit 1; } ;;
  send)   # type a line and submit it
    T send-keys -t vela -l "$*"; T send-keys -t vela Enter ;;
  keys)   # raw tmux key names, e.g. Escape C-c C-d
    T send-keys -t vela "$@" ;;
  wait)   # wait <regex> [timeout_s]: until regex is on screen and the agent is idle
    re="$1"; to="${2:-20}"
    for _ in $(seq 1 $((to*4))); do
      p="$(pane)"
      if grep -Eq "$re" <<<"$p" && ! grep -q 'Answering…' <<<"$p"; then echo "MATCHED: $re"; exit 0; fi
      sleep 0.25
    done
    echo "TIMEOUT waiting for: $re" >&2; pane >&2; exit 1 ;;
  snap)   # snap <name>: save the visible pane + scrollback to evidence
    mkdir -p "$EVID"; pane > "$EVID/$1.txt"; echo "$EVID/$1.txt" ;;
  grab)   # grab <path-relative-to-work-dir>: copy a side-effect file into evidence
    mkdir -p "$EVID"; cp "$STATE/work/$1" "$EVID/work-$(echo "$1" | tr / _)"; echo "$EVID/work-$(echo "$1" | tr / _)" ;;
  print)  # print <name> <vela args...>: one-shot non-interactive run, stdin closed
    name="$1"; shift; seed
    set +e
    (cd "$STATE/work" && env $(vela_env) bun "$REPO/src/cli/main.ts" "$@" </dev/null >"$EVID/$name.stdout" 2>"$EVID/$name.stderr")
    code=$?; set -e
    echo "$code" > "$EVID/$name.exit"; printf '%q ' "$@" > "$EVID/$name.cmd"
    echo "exit=$code stdout=$EVID/$name.stdout"; exit "$code" ;;
  cleanup)
    T kill-server 2>/dev/null || true   # kills only this run's private tmux server and its children
    if [[ -d "$STATE" ]]; then
      mkdir -p "$EVID"
      find "$STATE/home" -name '*.jsonl' -path '*sessions*' -exec cp {} "$EVID/" \; 2>/dev/null || true
      rm -rf "$STATE"
    fi
    echo "cleaned $STATE; evidence kept at $EVID"; ls -1 "$EVID" 2>/dev/null || true ;;
  *) echo "unknown command $CMD" >&2; exit 2 ;;
esac
