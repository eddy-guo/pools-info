#!/usr/bin/env bash
set -eu
script=$(cd "$(dirname "$0")" && pwd)/validate-lock.sh
work=$(mktemp -d "${TMPDIR:-/tmp}/pools-validate-test.XXXXXX")
release_all() {
  touch "$work/release" 2>/dev/null || true
  wait 2>/dev/null || true
  rm -rf "$work"
}
trap release_all EXIT
export POOLS_VALIDATE_TEST_MODE=1 POOLS_VALIDATE_TEST_CORES=12 POOLS_VALIDATE_TEST_LOAD=0
export POOLS_VALIDATE_TEST_WAIT=1 POOLS_VALIDATE_TEST_TIMEOUT=3
export POOLS_VALIDATE_TEST_LOCK="$work/lock"
export POOLS_VALIDATE_SLOTS=3

holder() {
  # shellcheck disable=SC2016
  "$script" bash -c 'touch "$1"; while [ ! -e "$2" ]; do sleep 0.1; done' _ "$work/$1" "$work/release" &
}
await_file() {
  i=0
  until [ -e "$work/$1" ]; do
    [ "$i" -lt 50 ] || { echo "missing $1" >&2; exit 1; }
    sleep 0.1
    i=$((i + 1))
  done
}

holder one; holder two; holder three
await_file one; await_file two; await_file three
holder four
sleep 0.5
[ ! -e "$work/four" ] || { echo 'fourth holder entered early' >&2; exit 1; }
touch "$work/release"
await_file four
wait
rm -f "$work/release" "$work"/one "$work"/two "$work"/three "$work"/four

# A dead slot is reclaimed, including its pid/start metadata.
mkdir -p "$POOLS_VALIDATE_TEST_LOCK/slot.999999.dead"
printf '999999\n' > "$POOLS_VALIDATE_TEST_LOCK/slot.999999.dead/pid"
printf '1\n' > "$POOLS_VALIDATE_TEST_LOCK/slot.999999.dead/start"
POOLS_VALIDATE_SLOTS=1 "$script" bash -c 'true'
[ ! -d "$POOLS_VALIDATE_TEST_LOCK/slot.999999.dead" ]

# A live slot cannot be reclaimed, and a waiter exits on its deadline.
export POOLS_VALIDATE_SLOTS=1 POOLS_VALIDATE_TEST_TIMEOUT=1
holder live
await_file live
if "$script" bash -c 'true' 2> "$work/wait.log"; then echo 'live holder was bypassed' >&2; exit 1; else rc=$?; fi
[ "$rc" -eq 124 ]
[ -d "$POOLS_VALIDATE_TEST_LOCK" ]
touch "$work/release"
wait
rm -f "$work/release"

# High load reduces admission to one even when three slots are configured.
export POOLS_VALIDATE_SLOTS=3 POOLS_VALIDATE_TEST_LOAD=13
holder loaded
await_file loaded
if "$script" bash -c 'true' 2> "$work/load.log"; then echo 'load gate was bypassed' >&2; exit 1; else rc=$?; fi
[ "$rc" -eq 124 ]
grep '1/1 slots occupied.*load 13, cores 12' "$work/load.log" >/dev/null
touch "$work/release"
wait
rm -f "$work/release"
export POOLS_VALIDATE_TEST_LOAD=0

# The original root/pid layout occupies the single slot.
export POOLS_VALIDATE_SLOTS=1
mkdir "$POOLS_VALIDATE_TEST_LOCK"
printf '%s\n' "$$" > "$POOLS_VALIDATE_TEST_LOCK/pid"
if "$script" bash -c 'true' 2> "$work/legacy.log"; then echo 'legacy holder was bypassed' >&2; exit 1; else rc=$?; fi
[ "$rc" -eq 124 ]
[ "$(cat "$POOLS_VALIDATE_TEST_LOCK/pid")" = "$$" ]
# Adding a new holder must keep counting the live old holder after root/pid moves.
export POOLS_VALIDATE_SLOTS=2
holder mixed
await_file mixed
if "$script" bash -c 'true' 2> "$work/mixed.log"; then echo 'mixed holders exceeded capacity' >&2; exit 1; else rc=$?; fi
[ "$rc" -eq 124 ]
touch "$work/release"
wait
rm -f "$work/release"
# The simulated old copy has no release trap, so remove only its own metadata.
rm -f "$POOLS_VALIDATE_TEST_LOCK/pid" "$POOLS_VALIDATE_TEST_LOCK/.semaphore" "$POOLS_VALIDATE_TEST_LOCK/legacy.pid"
rmdir "$POOLS_VALIDATE_TEST_LOCK"
echo 'validate-lock semaphore tests passed'
