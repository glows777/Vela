#!/usr/bin/env bash
# Verification harness for the Vela CLI/TUI: isolated tmux session + disposable VELA_DIR + mock model.
# Usage: vela-verify.sh <launch|doctor|send|keys|wait|snap|grab|print|pipe|cleanup> <run-id> [args...]
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

# Explicit allowlist for child Vela processes. Uses env -i so FEISHU_*, VELA_RECORD,
# and any other inherited channel creds / secrets never reach the child.
# Prints a single line: env -i KEY=val KEY=val ... (values shell-quoted).
vela_env() {
  local out
  out="env -i PATH=$(printf '%q' "$PATH")"
  out+=" TERM=$(printf '%q' "${TERM:-xterm-256color}")"
  out+=" LANG=$(printf '%q' "${LANG:-C.UTF-8}")"
  [[ -n "${LC_ALL:-}" ]] && out+=" LC_ALL=$(printf '%q' "$LC_ALL")"
  [[ -n "${LC_CTYPE:-}" ]] && out+=" LC_CTYPE=$(printf '%q' "$LC_CTYPE")"
  [[ -n "${LC_MESSAGES:-}" ]] && out+=" LC_MESSAGES=$(printf '%q' "$LC_MESSAGES")"
  out+=" VELA_DIR=$(printf '%q' "$STATE/home")"
  out+=" VELA_MODEL=mock"
  out+=" VELA_OFFLINE=1"
  out+=" HOME=$(printf '%q' "$STATE/userhome")"
  # Deliberately omit VELA_RECORD and FEISHU_* even if set in the parent.
  printf '%s' "$out"
}

# Run a command under the isolated allowlist (array-safe; no eval).
# Usage: run_isolated [--stdin-null] cmd [args...]
run_isolated() {
  local stdin_null=0
  if [[ "${1:-}" == --stdin-null ]]; then stdin_null=1; shift; fi
  local -a e=(
    env -i
    "PATH=$PATH"
    "TERM=${TERM:-xterm-256color}"
    "LANG=${LANG:-C.UTF-8}"
  )
  [[ -n "${LC_ALL:-}" ]] && e+=("LC_ALL=$LC_ALL")
  [[ -n "${LC_CTYPE:-}" ]] && e+=("LC_CTYPE=$LC_CTYPE")
  [[ -n "${LC_MESSAGES:-}" ]] && e+=("LC_MESSAGES=$LC_MESSAGES")
  e+=(
    "VELA_DIR=$STATE/home"
    "VELA_MODEL=mock"
    "VELA_OFFLINE=1"
    "HOME=$STATE/userhome"
  )
  if [[ $stdin_null -eq 1 ]]; then
    "${e[@]}" "$@" </dev/null
  else
    "${e[@]}" "$@"
  fi
}

# Ensure tmux is available for interactive TUI verification.
# If missing, best-effort non-interactive install (no prompts). Soft-fails when
# root/sudo is required but unavailable, or no known package manager exists.
# Print/pipe/SDK paths never call this.
ensure_tmux() {
  if command -v tmux >/dev/null 2>&1; then
    return 0
  fi
  echo "tmux not found; attempting non-interactive install for interactive TUI verification..." >&2

  local rc=1
  if command -v apt-get >/dev/null 2>&1; then
    if [[ "$(id -u)" -eq 0 ]]; then
      DEBIAN_FRONTEND=noninteractive apt-get install -y tmux </dev/null && rc=0 || rc=$?
    elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
      sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y tmux </dev/null && rc=0 || rc=$?
    else
      echo "tmux: apt-get present but install needs root/sudo without a password prompt (unavailable)" >&2
      return 1
    fi
  elif command -v brew >/dev/null 2>&1; then
    HOMEBREW_NO_AUTO_UPDATE=1 NONINTERACTIVE=1 brew install tmux </dev/null && rc=0 || rc=$?
  elif command -v dnf >/dev/null 2>&1; then
    if [[ "$(id -u)" -eq 0 ]]; then
      dnf install -y tmux </dev/null && rc=0 || rc=$?
    elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
      sudo -n dnf install -y tmux </dev/null && rc=0 || rc=$?
    else
      echo "tmux: dnf present but install needs root/sudo without a password prompt (unavailable)" >&2
      return 1
    fi
  elif command -v yum >/dev/null 2>&1; then
    if [[ "$(id -u)" -eq 0 ]]; then
      yum install -y tmux </dev/null && rc=0 || rc=$?
    elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
      sudo -n yum install -y tmux </dev/null && rc=0 || rc=$?
    else
      echo "tmux: yum present but install needs root/sudo without a password prompt (unavailable)" >&2
      return 1
    fi
  elif command -v pacman >/dev/null 2>&1; then
    if [[ "$(id -u)" -eq 0 ]]; then
      pacman -Sy --noconfirm tmux </dev/null && rc=0 || rc=$?
    elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
      sudo -n pacman -Sy --noconfirm tmux </dev/null && rc=0 || rc=$?
    else
      echo "tmux: pacman present but install needs root/sudo without a password prompt (unavailable)" >&2
      return 1
    fi
  elif command -v apk >/dev/null 2>&1; then
    if [[ "$(id -u)" -eq 0 ]]; then
      apk add --no-cache tmux </dev/null && rc=0 || rc=$?
    elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
      sudo -n apk add --no-cache tmux </dev/null && rc=0 || rc=$?
    else
      echo "tmux: apk present but install needs root/sudo without a password prompt (unavailable)" >&2
      return 1
    fi
  else
    echo "tmux: no supported package manager (apt-get/brew/dnf/yum/pacman/apk)" >&2
    return 1
  fi

  hash -r 2>/dev/null || true
  if command -v tmux >/dev/null 2>&1; then
    echo "tmux: installed at $(command -v tmux)" >&2
    return 0
  fi
  echo "tmux: install attempted (exit $rc) but still not on PATH; use print/pipe/SDK or install tmux manually" >&2
  return 1
}

seed() {
  mkdir -p "$STATE/home" "$STATE/userhome" "$STATE/work" "$EVID"
  printf '1. Tool registration\n2. Agent loop\n3. Sessions\n' > "$STATE/work/sample-data.txt"
  echo "hello from the verify-vela fixture" > "$STATE/work/a.txt"
}

pane() { T capture-pane -p -t vela -S -200; }

# Find bun/vela PIDs under the tmux pane shell (for environ checks).
child_vela_pids() {
  local pane_pid bun_pids=""
  [[ -f "$STATE/pane.pid" ]] || return 0
  pane_pid="$(cat "$STATE/pane.pid")"
  # Descendants of the pane shell that look like bun running main.ts
  bun_pids="$(pgrep -P "$pane_pid" -a 2>/dev/null | awk '/bun/ {print $1}')"
  # Also check grandchildren (env may be the direct child if shell runs env -i bun)
  local c
  for c in $(pgrep -P "$pane_pid" 2>/dev/null || true); do
    bun_pids+=" $(pgrep -P "$c" -a 2>/dev/null | awk '/bun/ {print $1}')"
  done
  echo "$bun_pids" | tr ' ' '\n' | awk 'NF' | sort -u
}

# Refuse if a live child still has FEISHU_* or an out-of-tree VELA_RECORD.
check_child_env_isolation() {
  local pid environ leaked=0
  for pid in $(child_vela_pids); do
    [[ -r "/proc/$pid/environ" ]] || continue
    environ="$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null || true)"
    if grep -qE '^FEISHU_' <<<"$environ"; then
      echo "env leak: FEISHU_* present in child pid $pid" >&2
      leaked=1
    fi
    local rec
    rec="$(grep -E '^VELA_RECORD=' <<<"$environ" | head -1 | cut -d= -f2- || true)"
    if [[ -n "$rec" ]]; then
      case "$rec" in
        "$STATE"/*|"$EVID"/*) ;;
        *)
          echo "env leak: VELA_RECORD=$rec is outside \$STATE/\$EVID (pid $pid)" >&2
          leaked=1
          ;;
      esac
    fi
  done
  return $leaked
}

case "$CMD" in
  launch)
    if ! ensure_tmux; then
      echo "tmux is required for interactive TUI journeys; install failed — skip interactive paths and use print/pipe/SDK (see SKILL.md)" >&2
      exit 1
    fi
    if T has-session -t vela 2>/dev/null; then echo "run $RUN already live; cleanup first" >&2; exit 1; fi
    seed
    # shellcheck disable=SC2046,SC2086
    T new-session -d -s vela -x 120 -y 40 -c "$STATE/work" \
      "$(vela_env) bun $REPO/src/cli/main.ts $*; echo '[vela exited]' \$?; sleep 600"
    T display -p -t vela '#{pane_pid}' > "$STATE/pane.pid"
    for _ in $(seq 1 60); do
      if pane | grep -q 'mock/mock-model'; then echo "READY run=$RUN state=$STATE evidence=$EVID"; exit 0; fi
      sleep 0.5
    done
    echo "NOT READY after 30s; pane:" >&2; pane >&2; exit 1 ;;
  doctor)
    ok=1
    if ! ensure_tmux; then
      echo "tmux: MISSING (install failed; interactive paths unavailable; print/pipe/SDK still ok)"
      ok=0
    else
      echo "tmux: $(command -v tmux) ($(tmux -V 2>/dev/null || echo ok))"
      T has-session -t vela 2>/dev/null && echo "tmux session: up (socket $SOCK)" || { echo "tmux session: MISSING"; ok=0; }
    fi
    [[ -f "$STATE/pane.pid" ]] && kill -0 "$(cat "$STATE/pane.pid")" 2>/dev/null && echo "pane pid: $(cat "$STATE/pane.pid") alive" || { echo "pane pid: dead"; ok=0; }
    echo "bun: $(bun --version 2>/dev/null || echo missing)  vela: $(cd "$STATE/work" 2>/dev/null && run_isolated --stdin-null bun "$REPO/src/cli/main.ts" --version 2>/dev/null || echo '?')  git: $(git -C "$REPO" rev-parse --short HEAD)"
    if [[ $ok == 1 ]]; then
      p="$(pane)"
      grep -q 'mock/mock-model' <<<"$p" && echo "model: mock/mock-model" || { echo "model: NOT mock (refuse to drive)"; ok=0; }
      grep -q "$STATE/work" <<<"$p" && echo "cwd: $STATE/work" || { echo "cwd: not the run's work dir"; ok=0; }
      grep -q '\[vela exited\]' <<<"$p" && { echo "vela: EXITED"; ok=0; } || true
      if ! check_child_env_isolation; then
        echo "env isolation: LEAK (FEISHU_* or out-of-tree VELA_RECORD in child)"
        ok=0
      else
        echo "env isolation: ok (no FEISHU_*/out-of-tree VELA_RECORD in child)"
      fi
    fi
    # Warn if the parent shell currently has values that older helpers would have leaked
    if env | grep -qE '^FEISHU_'; then
      echo "note: parent has FEISHU_*; child spawn uses env -i allowlist so they are not passed"
    fi
    if [[ -n "${VELA_RECORD:-}" ]]; then
      case "$VELA_RECORD" in
        "$STATE"/*|"$EVID"/*)
          echo "note: parent VELA_RECORD=$VELA_RECORD is under STATE/EVID but is still NOT passed to children"
          ;;
        *)
          echo "note: parent VELA_RECORD=$VELA_RECORD is out-of-tree; children do not inherit it (env -i allowlist)"
          ;;
      esac
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
    (cd "$STATE/work" && run_isolated --stdin-null bun "$REPO/src/cli/main.ts" "$@" >"$EVID/$name.stdout" 2>"$EVID/$name.stderr")
    code=$?; set -e
    echo "$code" > "$EVID/$name.exit"; printf '%q ' "$@" > "$EVID/$name.cmd"
    echo "exit=$code stdout=$EVID/$name.stdout"; exit "$code" ;;
  pipe)   # pipe <name> [vela args...]: feed helper stdin to vela under isolated env; capture like print
    name="$1"; shift; seed
    set +e
    (cd "$STATE/work" && run_isolated bun "$REPO/src/cli/main.ts" "$@" >"$EVID/$name.stdout" 2>"$EVID/$name.stderr")
    code=$?; set -e
    echo "$code" > "$EVID/$name.exit"; printf '%q ' "$@" > "$EVID/$name.cmd"
    echo "exit=$code stdout=$EVID/$name.stdout"; exit "$code" ;;
  cleanup)
    T kill-server 2>/dev/null || true   # kills only this run's private tmux server and its children
    if [[ -d "$STATE" ]]; then
      mkdir -p "$EVID/sessions"
      if [[ -d "$STATE/home" ]]; then
        # Preserve relative paths so nested tool-history.jsonl files do not collide
        (cd "$STATE/home" && find . -path '*sessions*' -name '*.jsonl' -exec cp --parents {} "$EVID/sessions/" \;) 2>/dev/null || true
      fi
      rm -rf "$STATE"
    fi
    echo "cleaned $STATE; evidence kept at $EVID"; ls -1R "$EVID" 2>/dev/null || true ;;
  *) echo "unknown command $CMD" >&2; exit 2 ;;
esac
