#!/usr/bin/env bash
# Fleet-wide serializer for heavy pools-info validation (pnpm check/build,
# Playwright or browser suites, database suites). One holder at a time across
# every home, via an mkdir lock with the holder's pid inside.
# Usage: scripts/validate-lock.sh <command> [args...]
# Properties: a stale lock is removed only when its recorded pid is dead and
# never touches a live holder; the release trap is armed only after this
# instance owns the lock, and release refuses to remove a lock it does not own.
set -u
LOCK=/tmp/pools-info-validate.lock
[ "$#" -gt 0 ] || { echo "usage: $0 <command> [args...]" >&2; exit 2; }
me=$$
acquire() {
  while :; do
    if mkdir "$LOCK" 2>/dev/null; then
      echo "$me" > "$LOCK/pid"
      return 0
    fi
    holder=$(cat "$LOCK/pid" 2>/dev/null || true)
    if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
      # Holder is dead: remove only if the pid file still names that dead pid.
      if [ "$(cat "$LOCK/pid" 2>/dev/null || true)" = "$holder" ]; then
        rm -f "$LOCK/pid" && rmdir "$LOCK" 2>/dev/null || true
        echo "pools-info-validate: removed stale lock of dead pid $holder" >&2
      fi
      continue
    fi
    sleep 5
  done
}
release() {
  if [ "$(cat "$LOCK/pid" 2>/dev/null || true)" = "$me" ]; then
    rm -f "$LOCK/pid" && rmdir "$LOCK" 2>/dev/null || true
  fi
}
acquire
trap release EXIT
trap 'exit 130' INT TERM HUP
"$@"
