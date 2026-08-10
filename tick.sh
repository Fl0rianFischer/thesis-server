#!/usr/bin/env bash
#
# Schedule gate. Cron runs this every 15 minutes, unconditionally:
#
#   */15 * * * * /opt/briefing/tick.sh >> /opt/briefing/data/cron.log 2>&1
#
# and this script decides whether it is actually briefing time, in the reader's
# timezone. That indirection exists because cron cannot be trusted with a
# timezone: CRON_TZ is a vendor extension this box's cron silently ignores, so
# the schedule was being interpreted in the host's zone with nothing to show
# for it except a briefing arriving five hours late.
#
# So the host's timezone is now irrelevant. TZ from .env is the only timezone
# in this project, and it decides the schedule, the file dates, the mail
# subject and the agent's own sense of what time it is.
#
# Deciding here rather than inside the container also means the 95 daily
# no-op ticks cost one bash process each instead of one container start.
#
#   tick.sh --dry-run   explain the decision and exit, changing nothing
#   tick.sh --force     run now regardless of day, hour, or prior attempts
#
set -uo pipefail

BRIEFING_DIR="${BRIEFING_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
cd "$BRIEFING_DIR" || exit 1

MODE="${1:-}"
DRY_RUN=0; FORCE=0
case "$MODE" in
  --dry-run) DRY_RUN=1 ;;
  --force)   FORCE=1 ;;
  "")        ;;
  *) echo "usage: tick.sh [--dry-run|--force]" >&2; exit 2 ;;
esac

if [ ! -f .env ]; then
  echo "$(date +%Y-%m-%dT%H:%M:%S%z) tick: no .env — has the deploy run?" >&2
  exit 1
fi
set -a; . ./.env; set +a

# Exported so every `date` below, and the container the deploy starts, agree on
# what "now" is. An empty TZ in .env would silently mean UTC, which is how the
# briefing would end up filed under yesterday's date.
export TZ="${TZ:-UTC}"
HOUR="${BRIEFING_HOUR:-5}"
DAYS="${BRIEFING_DAYS:-1-5}"
MAX_ATTEMPTS="${BRIEFING_MAX_ATTEMPTS:-3}"
DOCKER="${DOCKER_BIN:-$(command -v docker 2>/dev/null || echo /usr/bin/docker)}"

TODAY="$(date +%F)"
DOW="$(date +%u)"
NOW_HOUR="$((10#$(date +%H)))"

log()    { printf '%s %s\n' "$(date +%Y-%m-%dT%H:%M:%S%z)" "$*"; }
# Only --dry-run explains a decision not to run. A silent no-op is the whole
# point: this fires 96 times a day and cron.log has to stay readable.
reason() { [ "$DRY_RUN" -eq 1 ] && echo "would not run: $*"; exit 0; }

# Accepts cron-style day lists: "1-5", "1,3,5", "1-3,6". Day 1 is Monday, to
# match date +%u.
day_matches() {
  local want="$1" spec="$2" part lo hi
  local -a parts
  IFS=, read -ra parts <<< "$spec"
  for part in "${parts[@]}"; do
    if [[ "$part" == *-* ]]; then
      lo="${part%%-*}"; hi="${part##*-}"
      [ "$want" -ge "$((10#$lo))" ] && [ "$want" -le "$((10#$hi))" ] && return 0
    else
      [ "$want" -eq "$((10#$part))" ] && return 0
    fi
  done
  return 1
}

mkdir -p data/state data/archive

if [ "$DRY_RUN" -eq 1 ]; then
  echo "timezone     $TZ"
  echo "now          $TODAY $(date +%H:%M) (day $DOW)"
  echo "schedule     ${HOUR}:00 on days $DAYS"
  echo "artifact     data/archive/$TODAY.md"
fi

ATTEMPTS_FILE="data/state/$TODAY.attempts"
ATTEMPTS="$(cat "$ATTEMPTS_FILE" 2>/dev/null || echo 0)"
[[ "$ATTEMPTS" =~ ^[0-9]+$ ]] || ATTEMPTS=0

if [ "$FORCE" -eq 0 ]; then
  day_matches "$DOW" "$DAYS" || reason "day $DOW is not in $DAYS"
  [ "$NOW_HOUR" -lt "$((10#$HOUR))" ] && reason "local hour $NOW_HOUR is before $HOUR"

  # The artifact is the idempotency key, the same signal run.sh uses to decide
  # whether a run succeeded. If today's briefing exists, today is done — no
  # separate "have I run yet" state to drift out of sync with reality.
  [ -s "data/archive/$TODAY.md" ] && reason "data/archive/$TODAY.md already written"

  # Without a cap, a failing run (expired token, say) retries every 15 minutes
  # until midnight and empties a month of usage limits into the void.
  if [ "$ATTEMPTS" -ge "$MAX_ATTEMPTS" ]; then
    if [ "$ATTEMPTS" -eq "$MAX_ATTEMPTS" ] && [ "$DRY_RUN" -eq 0 ]; then
      log "tick: giving up for $TODAY after $ATTEMPTS failed attempts — see data/logs/$TODAY.json"
      echo "$((ATTEMPTS + 1))" > "$ATTEMPTS_FILE"   # so this logs once, not 96 times
    fi
    reason "$ATTEMPTS attempts already failed today (max $MAX_ATTEMPTS)"
  fi
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "would run    attempt $((ATTEMPTS + 1)) of $MAX_ATTEMPTS"
  exit 0
fi

# A briefing takes minutes and the tick is every 15, so a slow run would
# otherwise have a second container started on top of it, both writing the same
# archive file. The lock is held across the exec below — the fd survives it.
if command -v flock >/dev/null 2>&1; then
  exec 9> data/state/tick.lock || exit 1
  if ! flock -n 9; then
    log "tick: a run is already in progress, skipping"
    exit 0
  fi
else
  # util-linux ships flock on any Linux box; this is the macOS path, where
  # tick.sh only ever runs by hand.
  log "tick: WARNING flock unavailable — not guarding against concurrent runs"
fi

echo "$((ATTEMPTS + 1))" > "$ATTEMPTS_FILE"
log "tick: starting run for $TODAY (attempt $((ATTEMPTS + 1))/$MAX_ATTEMPTS, TZ=$TZ)"

exec "$DOCKER" compose --profile cron run --rm briefing
