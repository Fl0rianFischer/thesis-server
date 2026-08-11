#!/usr/bin/env bash
#
# Schedule gate, one agent per invocation. Cron runs these every 15 minutes,
# unconditionally:
#
#   */15 * * * * /opt/briefing/tick.sh morning-briefing >> /opt/briefing/data/cron.log 2>&1
#   */15 * * * * /opt/briefing/tick.sh opportunities    >> /opt/briefing/data/cron.log 2>&1
#
# and this script decides whether it is actually that agent's time, in the
# reader's timezone. That indirection exists because cron cannot be trusted
# with a timezone: CRON_TZ is a vendor extension this box's cron silently
# ignores, so the schedule was being interpreted in the host's zone with
# nothing to show for it except a briefing arriving five hours late.
#
# So the host's timezone is now irrelevant. TZ from .env is the only timezone
# in this project, and it decides every agent's schedule, file dates, mail
# subject, and sense of what time it is.
#
# Deciding here rather than inside the container also means the no-op ticks
# cost one bash process each instead of one container start.
#
#   tick.sh <agent>             run if it is time
#   tick.sh <agent> --dry-run   explain the decision and exit, changing nothing
#   tick.sh <agent> --force     run now regardless of day, hour, or attempts
#
set -uo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
cd "$APP_DIR" || exit 1

usage() { echo "usage: tick.sh <morning-briefing|opportunities|freelance-scout> [--dry-run|--force]" >&2; exit 2; }

AGENT="${1:-}"
[ -n "$AGENT" ] || usage

# Each agent's env prefix and its default enabled state. BRIEFING_ is kept
# rather than renamed to something symmetrical: those GitHub Variables are
# already configured on a running system, and renaming them would silently
# reset the schedule to defaults on the next deploy.
#
# These defaults are load-bearing: an unset GitHub Variable is written to .env
# as an empty value, so what is defaulted here is what an unconfigured deploy
# actually runs.
case "$AGENT" in
  morning-briefing)
    PREFIX=BRIEFING; DEFAULT_ENABLED=1
    DEFAULT_DAYS="1-5"; DEFAULT_HOUR=5; DEFAULT_MAX_ATTEMPTS=3 ;;
  opportunities)
    PREFIX=OPPS;     DEFAULT_ENABLED=1
    DEFAULT_DAYS="1,4"; DEFAULT_HOUR=7; DEFAULT_MAX_ATTEMPTS=2 ;;
  # Weekdays only: projects are posted during business hours and applying at
  # 07:00 on a Sunday to something posted on Friday is both late and visibly
  # automated.
  #
  # On by default, unlike the opportunities agent, and these are the values that
  # actually run — this agent adds no GitHub Variables, so nothing sets SCOUT_*
  # in .env and env_or falls through to exactly what is written here. Moving the
  # hour means editing this line.
  #
  # Being enabled does not mean anything gets sent: DRY_RUN in
  # agents/freelance-scout/config.mjs ships true, so an enabled scout with an
  # unfinished cv.md costs a digest to read and nothing more.
  freelance-scout)
    PREFIX=SCOUT;    DEFAULT_ENABLED=1
    DEFAULT_DAYS="1-5"; DEFAULT_HOUR=7; DEFAULT_MAX_ATTEMPTS=2 ;;
  *) echo "tick.sh: unknown agent '$AGENT'" >&2; usage ;;
esac

MODE="${2:-}"
DRY_RUN=0; FORCE=0
case "$MODE" in
  --dry-run) DRY_RUN=1 ;;
  --force)   FORCE=1 ;;
  "")        ;;
  *) usage ;;
esac

if [ ! -f .env ]; then
  echo "$(date +%Y-%m-%dT%H:%M:%S%z) [$AGENT] tick: no .env — has the deploy run?" >&2
  exit 1
fi
set -a; . ./.env; set +a

# Exported so every `date` below, and the container the deploy starts, agree on
# what "now" is. An empty TZ in .env would silently mean UTC, which is how a
# brief would end up filed under yesterday's date.
export TZ="${TZ:-UTC}"

env_or() { local v="${PREFIX}_$1"; echo "${!v:-$2}"; }
HOUR="$(env_or HOUR "$DEFAULT_HOUR")"
DAYS="$(env_or DAYS "$DEFAULT_DAYS")"
MAX_ATTEMPTS="$(env_or MAX_ATTEMPTS "$DEFAULT_MAX_ATTEMPTS")"
ENABLED="$(env_or ENABLED "$DEFAULT_ENABLED")"
DOCKER="${DOCKER_BIN:-$(command -v docker 2>/dev/null || echo /usr/bin/docker)}"

ARTIFACT="data/$AGENT/archive"
TODAY="$(date +%F)"
DOW="$(date +%u)"
NOW_HOUR="$((10#$(date +%H)))"

log()    { printf '%s [%s] %s\n' "$(date +%Y-%m-%dT%H:%M:%S%z)" "$AGENT" "$*"; }
# Only --dry-run explains a decision not to run. A silent no-op is the whole
# point: two agents fire 192 times a day between them and cron.log has to stay
# readable.
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

mkdir -p data/state "$ARTIFACT"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "agent        $AGENT"
  echo "enabled      $ENABLED (${PREFIX}_ENABLED)"
  echo "timezone     $TZ"
  echo "now          $TODAY $(date +%H:%M) (day $DOW)"
  echo "schedule     ${HOUR}:00 on days $DAYS"
  echo "artifact     $ARTIFACT/$TODAY.md"
fi

ATTEMPTS_FILE="data/state/$AGENT-$TODAY.attempts"
ATTEMPTS="$(cat "$ATTEMPTS_FILE" 2>/dev/null || echo 0)"
[[ "$ATTEMPTS" =~ ^[0-9]+$ ]] || ATTEMPTS=0

if [ "$FORCE" -eq 0 ]; then
  # Checked before the schedule so a disabled agent explains itself in
  # --dry-run rather than looking like a day/hour mismatch. This is what lets
  # the restructure deploy and the new agent go live as two separate events.
  [ "$ENABLED" = "1" ] || reason "${PREFIX}_ENABLED is not 1"

  day_matches "$DOW" "$DAYS" || reason "day $DOW is not in $DAYS"
  [ "$NOW_HOUR" -lt "$((10#$HOUR))" ] && reason "local hour $NOW_HOUR is before $HOUR"

  # The artifact is the idempotency key, the same signal run.sh uses to decide
  # whether a run succeeded. If today's brief exists, today is done — no
  # separate "have I run yet" state to drift out of sync with reality. Each
  # agent has its own, so neither can mark the other's day complete.
  [ -s "$ARTIFACT/$TODAY.md" ] && reason "$ARTIFACT/$TODAY.md already written"

  # Without a cap, a failing run (expired token, say) retries every 15 minutes
  # until midnight and empties a month of usage limits into the void. The
  # counter is per agent, so one agent failing all morning cannot exhaust the
  # other's budget.
  if [ "$ATTEMPTS" -ge "$MAX_ATTEMPTS" ]; then
    if [ "$ATTEMPTS" -eq "$MAX_ATTEMPTS" ] && [ "$DRY_RUN" -eq 0 ]; then
      log "tick: giving up for $TODAY after $ATTEMPTS failed attempts — see data/$AGENT/logs/$TODAY.json"
      echo "$((ATTEMPTS + 1))" > "$ATTEMPTS_FILE"   # so this logs once, not 96 times
    fi
    reason "$ATTEMPTS attempts already failed today (max $MAX_ATTEMPTS)"
  fi
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "would run    attempt $((ATTEMPTS + 1)) of $MAX_ATTEMPTS"
  exit 0
fi

# Two locks, doing two different jobs.
#
# The per-agent lock is the original one: a run takes minutes and the tick is
# every 15, so a slow run would otherwise have a second container started on
# top of it, both writing the same archive file.
if command -v flock >/dev/null 2>&1; then
  exec 9> "data/state/$AGENT.lock" || exit 1
  if ! flock -n 9; then
    log "tick: a run is already in progress, skipping"
    exit 0
  fi

  # The shared lock protects the one resource both agents genuinely compete
  # for: the subscription's usage limits. Two concurrent research runs on one
  # subscription is the thing to avoid, not two containers.
  #
  # Being blocked here is not a failure, so it must not touch the attempts
  # counter — otherwise a healthy system that merely overlapped would spend its
  # own retry budget and give up for the day. The next tick is 15 minutes away
  # and a run takes about eight, so waiting costs nothing.
  exec 8> data/state/claude.lock || exit 1
  if ! flock -n 8; then
    log "tick: another agent is running, deferring to the next tick"
    exit 0
  fi
else
  # util-linux ships flock on any Linux box; this is the macOS path, where
  # tick.sh only ever runs by hand.
  log "tick: WARNING flock unavailable — not guarding against concurrent runs"
fi

echo "$((ATTEMPTS + 1))" > "$ATTEMPTS_FILE"
log "tick: starting run for $TODAY (attempt $((ATTEMPTS + 1))/$MAX_ATTEMPTS, TZ=$TZ)"

# Both fds above survive the exec, so the locks are held for the whole run.
exec "$DOCKER" compose --profile cron run --rm agent "$AGENT"
