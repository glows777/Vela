#!/usr/bin/env bash
# Drive the real Vela CLI/TUI offline: private tmux server, disposable VELA_DIR/HOME/cwd, mock or faux model.
# Usage: vela-verify.sh <launch|doctor|send|keys|wait|snap|grab|run|exec|cleanup> <run-id> [args...]
#   model: VERIFY_MODEL=mock (default) | faux:/abs/scenario.json
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
CMD="${1:-}"; RUN="${2:-}"
[[ -n "$CMD" && -n "$RUN" ]] || { sed -n '2,4p' "$0"; exit 2; }
[[ "$RUN" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]] || { echo "run-id must be [A-Za-z0-9][A-Za-z0-9_-]*" >&2; exit 2; }
shift 2

STATE="/tmp/vela-verify/$RUN"                         # scratch: removed by cleanup
EVID="${VELA_EVIDENCE_ROOT:-/tmp/vela-evidence}/$RUN" # proof: survives cleanup
T() { tmux -L "vela-verify-$RUN" "$@"; }             # private tmux server per run
pane() { T capture-pane -p -t vela -S -; }           # screen + all scrollback

MODEL="${VERIFY_MODEL:-mock}"

# Everything runs under env -i with this allowlist only: no API keys, FEISHU_* or the user's ~/.vela.
ENV=(env -i "PATH=$PATH" "TERM=${TERM:-xterm-256color}" "LANG=${LANG:-C.UTF-8}"
  "HOME=$STATE/userhome" "VELA_DIR=$STATE/home" "VELA_OFFLINE=1" "VELA_MODEL=$MODEL")
VELA=(bun "$REPO/src/cli/main.ts")

# Fixture, created once per run (later run/launch calls keep edits and sessions)
seed() {
  mkdir -p "$EVID"
  [[ -d "$STATE/work" ]] && return
  mkdir -p "$STATE/home" "$STATE/userhome" "$STATE/work"
  printf '1. Tool registration\n2. Agent loop\n3. Sessions\n' > "$STATE/work/sample-data.txt"
  echo "hello from the verify-vela fixture" > "$STATE/work/a.txt"
}

case "$CMD" in
  launch)   # launch [vela args]: start the TUI in tmux (120x40), wait until it shows the footer or a question
    command -v tmux >/dev/null || { echo "tmux not on PATH: install it, or verify through run/SDK only" >&2; exit 1; }
    T has-session -t vela 2>/dev/null && { echo "run $RUN already live; cleanup first" >&2; exit 1; }
    seed
    T new-session -d -s vela -x 120 -y 40 -c "$STATE/work" \
      "$(printf '%q ' "${ENV[@]}" "${VELA[@]}" "$@"); echo '[vela exited]' \$?; sleep 600"
    for _ in $(seq 1 60); do
      # The footer ("<cwd> · <session>"), the project trust question (send y) or a picker such as -r's (keys Enter)
      grep -Eq "$STATE/work · |\(y/N\)|Esc cancel" <<<"$(T capture-pane -p -t vela)" && { echo "READY run=$RUN state=$STATE evidence=$EVID"; exit 0; }
      sleep 0.5
    done
    echo "NOT READY after 30s; pane:" >&2; pane >&2; exit 1 ;;
  doctor)   # versions, and whether the TUI is still up
    T has-session -t vela 2>/dev/null || { echo "DOCTOR FAIL: no TUI for run $RUN (launch first)"; exit 1; }
    echo "bun $(bun --version)  vela $("${ENV[@]}" "${VELA[@]}" --version </dev/null)  git $(git -C "$REPO" rev-parse --short HEAD)  model $MODEL"
    grep -q '\[vela exited\]' <<<"$(pane)" && { echo "DOCTOR FAIL: vela exited"; pane | tail -20; exit 1; }
    echo "DOCTOR OK" ;;
  send)     # send <text>: type a line literally and press Enter (wait counts matches from the typed screen on)
    T send-keys -t vela -l "$*"; sleep 0.2; pane > "$STATE/before.txt"; T send-keys -t vela Enter ;;
  keys)     # keys <tmux key names>: Escape, C-c, C-d, M-Enter, Up, Tab…
    pane > "$STATE/before.txt"; T send-keys -t vela "$@"; sleep 0.3 ;;  # pause: Escape followed at once by a key reads as Alt+key
  wait)     # wait <regex> [timeout_s]: regex matches more lines than before the last send/keys, and nothing is running
            # (match newly printed lines: a line redrawn in place, like the footer, never adds a match)
    re="$1"; to="${2:-20}"
    base=$(grep -Ec -- "$re" "$STATE/before.txt" 2>/dev/null || true)
    for _ in $(seq 1 $((to*4))); do
      p="$(pane)"
      if (( $(grep -Ec -- "$re" <<<"$p" || true) > ${base:-0} )) && ! grep -Eq 'Esc to (interrupt|cancel)\)' <<<"$p"; then
        echo "MATCHED: $re"; exit 0
      fi
      sleep 0.25
    done
    echo "TIMEOUT waiting for: $re" >&2; pane | tail -40 >&2; exit 1 ;;
  snap)     # snap <name>: screen + scrollback → evidence/<name>.txt
    mkdir -p "$EVID"; pane > "$EVID/$1.txt"; echo "$EVID/$1.txt" ;;
  grab)     # grab <path in work/>: copy a side-effect file → evidence/work-<path>
    mkdir -p "$EVID"; out="$EVID/work-${1//\//_}"; cp "$STATE/work/$1" "$out"; echo "$out" ;;
  run|exec) # run [--stdin] <name> [vela args] | exec [--stdin] <name> <command…>: one run in work/, captured
            # to evidence/<name>.{cmd,stdout,stderr,exit}; stdin is closed unless --stdin
    if [[ "${1:-}" == --stdin ]]; then shift; else exec </dev/null; fi
    name="$1"; shift; seed
    [[ "$CMD" == run ]] && set -- "${VELA[@]}" "$@"
    printf '%q ' "$@" > "$EVID/$name.cmd"
    set +e; (cd "$STATE/work" && "${ENV[@]}" "$@" >"$EVID/$name.stdout" 2>"$EVID/$name.stderr"); code=$?; set -e
    echo "$code" > "$EVID/$name.exit"
    echo "exit=$code stdout=$EVID/$name.stdout"; exit "$code" ;;
  cleanup)  # kill this run's tmux server, keep session files as evidence, delete the scratch dir
    T kill-server 2>/dev/null || true
    if [[ -d "$STATE/home" ]]; then
      mkdir -p "$EVID/vela-dir"; cp -r "$STATE/home/." "$EVID/vela-dir/"
    fi
    rm -rf "$STATE"
    echo "cleaned $STATE; evidence at $EVID:"; ls -1 "$EVID" ;;
  *) echo "unknown command $CMD" >&2; exit 2 ;;
esac
