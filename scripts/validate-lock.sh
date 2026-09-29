#!/usr/bin/env bash
# Machine-wide semaphore for heavy pools-info validation.
# Usage: scripts/validate-lock.sh <command> [args...]
set -u

LOCK=/tmp/pools-info-validate.lock
SLOTS=${POOLS_VALIDATE_SLOTS:-3}
WAIT_SECONDS=5
TIMEOUT_SECONDS=3600
if [ "${POOLS_VALIDATE_TEST_MODE:-}" = 1 ]; then
  LOCK=${POOLS_VALIDATE_TEST_LOCK:?}
  WAIT_SECONDS=${POOLS_VALIDATE_TEST_WAIT:-1}
  TIMEOUT_SECONDS=${POOLS_VALIDATE_TEST_TIMEOUT:-10}
fi
[ "$#" -gt 0 ] || { echo "usage: $0 <command> [args...]" >&2; exit 2; }
case $SLOTS in ''|*[!0-9]*) echo "pools-info-validate: POOLS_VALIDATE_SLOTS must be a positive integer" >&2; exit 2;; esac
[ "$SLOTS" -gt 0 ] || { echo "pools-info-validate: POOLS_VALIDATE_SLOTS must be positive" >&2; exit 2; }
me=$$
start=$(date +%s)
my_slot=

alive() {
  case $1 in ''|*[!0-9]*) return 1;; esac
  kill -0 "$1" 2>/dev/null || [ -n "$(ps -p "$1" -o pid= 2>/dev/null)" ]
}

# Only new copies use this mutex. An old copy owns the root through root/pid.
mutex() {
  mkdir -p "$LOCK" 2>/dev/null || true
  while ! mkdir "$LOCK/.mutex" 2>/dev/null; do
    [ -d "$LOCK" ] || { mkdir -p "$LOCK" 2>/dev/null || true; continue; }
    owner=$(cat "$LOCK/.mutex/pid" 2>/dev/null || true)
    if [ -n "$owner" ] && ! alive "$owner" && [ "$(cat "$LOCK/.mutex/pid" 2>/dev/null || true)" = "$owner" ]; then
      rm -f "$LOCK/.mutex/pid"
      rmdir "$LOCK/.mutex" 2>/dev/null || true
    fi
    sleep 0.2
  done
  printf '%s\n' "$me" > "$LOCK/.mutex/pid"
}

unlock() {
  if [ "$(cat "$LOCK/.mutex/pid" 2>/dev/null || true)" = "$me" ]; then
    rm -f "$LOCK/.mutex/pid"
    rmdir "$LOCK/.mutex" 2>/dev/null || true
  fi
}

load_and_cores() {
  if [ "${POOLS_VALIDATE_TEST_MODE:-}" = 1 ]; then
    load=${POOLS_VALIDATE_TEST_LOAD:?}
    cores=${POOLS_VALIDATE_TEST_CORES:?}
  elif [ -r /proc/loadavg ]; then
    read -r load _ < /proc/loadavg
    cores=$(nproc)
  else
    load=$(sysctl -n vm.loadavg | awk '{print $2}')
    cores=$(sysctl -n hw.ncpu)
  fi
  case $load in *[!0-9.]*|'') echo "pools-info-validate: cannot read load" >&2; return 1;; esac
  case $cores in ''|*[!0-9]*) echo "pools-info-validate: cannot read core count" >&2; return 1;; esac
  limit=$SLOTS
  if awk -v l="$load" -v c="$cores" 'BEGIN { exit !(l > c) }'; then limit=1; fi
}

# Called with the mutex. The root pid keeps old scripts from removing our root.
inspect() {
  occupied=0
  if [ ! -e "$LOCK/.semaphore" ]; then
    legacy=$(cat "$LOCK/pid" 2>/dev/null || true)
    : > "$LOCK/.semaphore"
    if [ -n "$legacy" ]; then printf '%s\n' "$legacy" > "$LOCK/legacy.pid"; fi
  fi
  legacy=$(cat "$LOCK/legacy.pid" 2>/dev/null || true)
  if [ -n "$legacy" ]; then
    # A new holder may replace root/pid while the old command still runs.
    if ! alive "$legacy"; then
      rm -f "$LOCK/legacy.pid"
    else
      occupied=$((occupied + 1))
      representative=$legacy
    fi
  fi
  for slot in "$LOCK"/slot.*; do
    [ -d "$slot" ] || continue
    owner=$(cat "$slot/pid" 2>/dev/null || true)
    if [ -n "$owner" ] && ! alive "$owner" && [ "$(cat "$slot/pid" 2>/dev/null || true)" = "$owner" ]; then
      rm -f "$slot/pid" "$slot/start"
      rmdir "$slot" 2>/dev/null || true
      echo "pools-info-validate: removed stale slot of dead pid $owner" >&2
      continue
    fi
    occupied=$((occupied + 1))
    [ -n "$owner" ] && representative=$owner
  done
  if [ "$occupied" -gt 0 ] && [ -n "${representative:-}" ]; then
    printf '%s\n' "$representative" > "$LOCK/.pid.$me"
    mv -f "$LOCK/.pid.$me" "$LOCK/pid"
  fi
}

cleanup_root() {
  [ "$occupied" -eq 0 ] || return 0
  rm -f "$LOCK/pid" "$LOCK/.semaphore" "$LOCK/legacy.pid"
  unlock
  rmdir "$LOCK" 2>/dev/null || true
}

acquire() {
  last_log=0
  while :; do
    load_and_cores || return 2
    mutex
    representative=
    inspect
    if [ "$occupied" -lt "$limit" ]; then
      my_slot="$LOCK/slot.$me.$start.$RANDOM"
      if mkdir "$my_slot" 2>/dev/null; then
        printf '%s\n' "$me" > "$my_slot/pid"
        printf '%s\n' "$start" > "$my_slot/start"
        printf '%s\n' "$me" > "$LOCK/.pid.$me"
        mv -f "$LOCK/.pid.$me" "$LOCK/pid"
        unlock
        return 0
      fi
    fi
    now=$(date +%s)
    if [ "$now" -ge "$((last_log + WAIT_SECONDS))" ]; then
      echo "pools-info-validate: waiting; $occupied/$limit slots occupied (configured $SLOTS), load $load, cores $cores" >&2
      last_log=$now
    fi
    unlock
    if [ "$((now - start))" -ge "$TIMEOUT_SECONDS" ]; then
      echo "pools-info-validate: timed out after ${TIMEOUT_SECONDS}s waiting for a slot" >&2
      return 124
    fi
    sleep "$WAIT_SECONDS"
  done
}

release() {
  [ -n "$my_slot" ] || return 0
  mutex
  if [ "$(cat "$my_slot/pid" 2>/dev/null || true)" = "$me" ]; then
    rm -f "$my_slot/pid" "$my_slot/start"
    rmdir "$my_slot" 2>/dev/null || true
  fi
  representative=
  inspect
  if [ "$occupied" -eq 0 ]; then cleanup_root; else unlock; fi
}

acquire || exit $?
trap release EXIT
trap 'exit 130' INT TERM HUP
"$@"
