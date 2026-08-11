#!/usr/bin/env bash
#
# Read-only health check for both agents. Run it on the box:
#
#   /opt/briefing/healthcheck.sh
#
# or from your laptop:
#
#   ssh USER@HOST '/opt/briefing/healthcheck.sh'
#
# There is no HTTP endpoint to poll — these are scheduled jobs, not services —
# so the real signal is whether each brief appeared when it should have.
# Everything else here explains a missing one.
#
# Exits non-zero if any check FAILs, so it can drive an uptime monitor.
#
# --probe additionally spends one cheap model call to prove the OAuth token is
# still good. Left out of the default run so this stays free to poll.

set -uo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
cd "$APP_DIR" || exit 1

[ -f .env ] && { set -a; . ./.env; set +a; }

# Every date below is evaluated in the reader's zone, because that is the only
# zone the schedules, the filenames and the mail subjects are expressed in. The
# host's own timezone is deliberately not consulted anywhere in this file.
TZ_SET=1
if [ -z "${TZ:-}" ]; then TZ_SET=0; TZ=UTC; fi
export TZ

TODAY="$(date +%F)"
FAILED=0

AGENTS=(morning-briefing opportunities freelance-scout)

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$*"; }
warn() { printf '  \033[33mWARN\033[0m  %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; FAILED=1; }
head2() { printf '\n\033[1m%s\033[0m\n' "$*"; }

env_or() { local v="$1"; echo "${!v:-$2}"; }

# A YYYY-MM-DD to epoch seconds, on either date(1). GNU is what runs on the
# box; BSD is what runs when this is invoked from a laptop. Prints nothing if
# neither can parse it — callers must treat empty as "unknown" rather than
# substituting a zero, which is how a 20-day-old file once reported as 20675
# days old and turned a WARN into a FAIL.
to_epoch() {
  date -d "$1" +%s 2>/dev/null || date -j -f "%Y-%m-%d" "$1" +%s 2>/dev/null
}

# One year after a YYYY-MM-DD, same two-dialect problem.
plus_one_year() {
  date -d "$1 +1 year" +%F 2>/dev/null || date -j -v+1y -f "%Y-%m-%d" "$1" +%F 2>/dev/null
}

# Owning uid of a path — GNU stat on the box, BSD stat on a laptop. Prints
# nothing if the path does not exist, so callers must treat empty as missing
# rather than defaulting to a number: a bare `|| echo -1` here silently turned
# the host-owned checks below into a PASS against a uid that never existed.
uid_of() {
  stat -c %u "$1" 2>/dev/null || stat -f %u "$1" 2>/dev/null
}

# Per-agent config, matching tick.sh. The defaults have to match tick.sh's or
# this reports a schedule the box is not actually keeping.
agent_cfg() {
  case "$1" in
    morning-briefing)
      PREFIX=BRIEFING; ENABLED_DEFAULT=1
      HOUR_DEFAULT=5; DAYS_DEFAULT="1-5"; ATTEMPTS_DEFAULT=3
      # Runs weekdays, so on a Monday the newest file is legitimately Friday's.
      STALE_WARN=3; STALE_FAIL=5 ;;
    opportunities)
      PREFIX=OPPS; ENABLED_DEFAULT=0
      HOUR_DEFAULT=7; DAYS_DEFAULT="1,4"; ATTEMPTS_DEFAULT=2
      # Runs Mon and Thu, so the longest healthy gap is Thursday read on
      # Monday — four days. Anything past a week means it has stopped.
      STALE_WARN=4; STALE_FAIL=7 ;;
    freelance-scout)
      # On by default, and these defaults are what runs: this agent adds no
      # GitHub Variables, so nothing sets SCOUT_* in .env.
      PREFIX=SCOUT; ENABLED_DEFAULT=1
      HOUR_DEFAULT=7; DAYS_DEFAULT="1-5"; ATTEMPTS_DEFAULT=2
      # Weekdays, like the morning briefing: Friday's digest read on Monday is
      # three days and healthy. A digest is written even on a morning with no
      # matching projects, so a genuine gap here means the run is failing, not
      # that the market is quiet.
      STALE_WARN=3; STALE_FAIL=5 ;;
  esac
  ENABLED="$(env_or "${PREFIX}_ENABLED" "$ENABLED_DEFAULT")"
  MAX_ATTEMPTS="$(env_or "${PREFIX}_MAX_ATTEMPTS" "$ATTEMPTS_DEFAULT")"
  HOUR="$(env_or "${PREFIX}_HOUR" "$HOUR_DEFAULT")"
  DAYS="$(env_or "${PREFIX}_DAYS" "$DAYS_DEFAULT")"
}

echo "briefing agents health — $(date '+%Y-%m-%d %H:%M:%S %Z')"

# ---------------------------------------------------------------- shared ----

head2 "Shared"

# The timezone, which is the single input every schedule derives from. Empty
# does not fail loudly at run time — it silently means UTC, which at 05:00 in a
# UTC+7 zone files a brief under yesterday's date.
if [ "$TZ_SET" -eq 0 ]; then
  fail "TZ is empty in .env — set the TZ repository variable and redeploy"
else
  pass "timezone: $TZ (host zone is not consulted, and there is only one)"
fi

# Token expiry. It dies silently after a year; see lib/run.sh for why. One
# token serves both agents, so this is a shared check.
if [ -n "${CLAUDE_TOKEN_ISSUED:-}" ]; then
  EXPIRES="$(plus_one_year "$CLAUDE_TOKEN_ISSUED")"
  EXPIRES_AT="$([ -n "$EXPIRES" ] && to_epoch "$EXPIRES")"
  if [ -n "$EXPIRES_AT" ]; then
    DAYS_LEFT=$(( ( EXPIRES_AT - $(date +%s) ) / 86400 ))
    if   [ "$DAYS_LEFT" -lt 0 ];  then fail "OAuth token expired $EXPIRES — run 'claude setup-token'"
    elif [ "$DAYS_LEFT" -lt 30 ]; then warn "OAuth token expires $EXPIRES (${DAYS_LEFT}d)"
    else pass "OAuth token valid until $EXPIRES (${DAYS_LEFT}d)"
    fi
  else
    warn "CLAUDE_TOKEN_ISSUED='$CLAUDE_TOKEN_ISSUED' is not a YYYY-MM-DD date"
  fi
else
  warn "CLAUDE_TOKEN_ISSUED unset — no expiry warning possible"
fi

# Mail. Empty here means a brief is written and then silently not delivered,
# which looks identical to the job never running.
if [ -z "${MAIL_FROM:-}" ]; then
  fail "MAIL_FROM empty — briefs will be written but not emailed"
else
  pass "mail from: $MAIL_FROM"
fi

# cron: one line per agent, both tagged. A missing line is a redeploy.
CRON_LINES="$(crontab -l 2>/dev/null | grep '# briefing-agent$' || true)"
if [ -n "$CRON_LINES" ]; then
  COUNT="$(wc -l <<< "$CRON_LINES" | tr -d ' ')"
  if [ "$COUNT" -eq "${#AGENTS[@]}" ]; then
    pass "cron: $COUNT entries, one per agent, every 15 min"
  else
    fail "cron: $COUNT entries but ${#AGENTS[@]} agents — redeploy to reinstall"
  fi
  if crontab -l 2>/dev/null | grep -q '# morning-briefing$'; then
    fail "a legacy '# morning-briefing' cron entry is still installed — it calls"
    fail "  tick.sh with no agent argument and will fail every 15 minutes. Redeploy."
  fi
else
  fail "no cron entries — redeploy to reinstall them"
fi

if [ ! -x tick.sh ]; then
  fail "tick.sh missing or not executable — redeploy"
fi

# Disk. Old images are the thing that actually fills a small box.
DISK_PCT="$(df -P . | awk 'NR==2{gsub(/%/,"",$5); print $5}')"
if [ "$DISK_PCT" -lt 85 ]; then pass "disk ${DISK_PCT}% used"
elif [ "$DISK_PCT" -lt 95 ]; then warn "disk ${DISK_PCT}% used — try 'docker image prune -a'"
else fail "disk ${DISK_PCT}% used"
fi

# ------------------------------------------------------- image and mounts ----

head2 "Image and mounts"

# A bind mount arrives with the host's ownership no matter what the image
# chowned, so a uid mismatch makes every write inside the container fail — and
# the symptom is an empty log and a run that looks like the model produced
# nothing.
IMG_UID=""
if docker info >/dev/null 2>&1; then
  RUNNING_IMG="$(docker compose --profile cron config 2>/dev/null | awk '/image:/{print $2; exit}')"
  if docker image inspect "$RUNNING_IMG" >/dev/null 2>&1; then
    pass "image present: ${RUNNING_IMG##*/}"
    IMG_UID="$(docker image inspect --format '{{.Config.User}}' "$RUNNING_IMG" 2>/dev/null | cut -d: -f1)"
    if ! [[ "$IMG_UID" =~ ^[0-9]+$ ]]; then
      warn "image user is '${IMG_UID:-unset}', not numeric — falling back to 1000"
      IMG_UID=""
    fi
  else
    fail "image not present locally: $RUNNING_IMG"
    fail "  the deploy pre-pulls this, so either it has not run since the last"
    fail "  push, or the pull failed. A transient GHCR rate limit self-heals —"
    fail "  the next run pulls on demand. An auth failure does not: check with"
    fail "  docker login ghcr.io, or run 'docker compose --profile cron pull'."
  fi
else
  fail "docker daemon not responding"
fi

# Checked even when the image is missing. The Dockerfile pins the uid to 1000,
# so a missing image is no reason to skip the check — and a deploy that failed
# before pulling is exactly when other steps may also have been skipped, which
# makes this the moment you most want it verified rather than silently omitted.
if [ -z "$IMG_UID" ]; then
  IMG_UID=1000
  UID_SOURCE=" (assumed — the Dockerfile pins it)"
else
  UID_SOURCE=""
fi
for a in "${AGENTS[@]}"; do
  d="data/$a"
  DIR_UID="$(stat -c %u "$d" 2>/dev/null || echo -1)"
  if [ "$DIR_UID" = "-1" ]; then
    fail "$d does not exist — redeploy to create it"
  elif [ "$DIR_UID" = "$IMG_UID" ]; then
    pass "$d owned by uid $DIR_UID, matching the container$UID_SOURCE"
  else
    fail "$d is uid $DIR_UID but the container runs as $IMG_UID — writes will be denied"
    fail "  sudo chown -R $IMG_UID:$IMG_UID $APP_DIR/$d"
  fi
done

# The other half of the ownership story, and the one a blanket `chown -R data`
# would break. data/ is a single mount now, but data/state and data/cron.log
# are written by the HOST — tick.sh and cron's own redirect — not by the
# container. If they end up owned by the container's uid, cron silently stops
# being able to append and tick.sh cannot record an attempt.
if [ -n "$IMG_UID" ]; then
  for p in data/state data/cron.log; do
    [ -e "$p" ] || continue
    P_UID="$(stat -c %u "$p" 2>/dev/null || echo -1)"
    if [ "$P_UID" = "$IMG_UID" ]; then
      fail "$p is owned by the container uid $IMG_UID but is written by the host."
      fail "  Something ran 'chown -R' over data/. Restore it:"
      fail "  sudo chown -R \$(id -u):\$(id -g) $APP_DIR/data/state $APP_DIR/data/cron.log"
    else
      pass "$p host-owned (uid $P_UID), as it must be"
    fi
  done
fi

# ------------------------------------------------------------- per agent ----

for a in "${AGENTS[@]}"; do
  agent_cfg "$a"
  head2 "$a"

  if [ "$ENABLED" != "1" ]; then
    warn "disabled (${PREFIX}_ENABLED=$ENABLED) — set it to 1 and redeploy to turn on"
    printf '        no further checks for this agent\n'
    continue
  fi

  # The check that matters: everything else only explains a failure here.
  LATEST="$(ls -1 "data/$a/archive"/*.md 2>/dev/null | sort | tail -1)"
  if [ -z "$LATEST" ]; then
    fail "no briefs in data/$a/archive/ — nothing has ever run successfully"
  else
    LATEST_DATE="$(basename "$LATEST" .md)"
    LATEST_AT="$(to_epoch "$LATEST_DATE")"
    SIZE=$(wc -c < "$LATEST" | tr -d ' ')
    if [ -z "$LATEST_AT" ]; then
      warn "latest brief $LATEST_DATE (${SIZE} bytes) — could not parse its date to age it"
    else
      AGE=$(( ( $(date +%s) - LATEST_AT ) / 86400 ))
      if   [ "$AGE" -le "$STALE_WARN" ]; then pass "latest brief $LATEST_DATE (${AGE}d old, ${SIZE} bytes)"
      elif [ "$AGE" -le "$STALE_FAIL" ]; then warn "latest brief $LATEST_DATE is ${AGE}d old — expected one within ${STALE_WARN}d"
      else fail "latest brief $LATEST_DATE is ${AGE}d old — this agent has stopped"
      fi
    fi
    [ "$SIZE" -lt 500 ] && warn "latest brief is only ${SIZE} bytes — suspiciously short"
  fi

  printf '        schedule: %s:00 on days %s\n' "$HOUR" "$DAYS"
  if [ -x tick.sh ]; then
    printf '        next: %s\n' "$(./tick.sh "$a" --dry-run 2>&1 | tail -1)"
  fi

  # Today's attempts. tick.sh stops retrying after MAX_ATTEMPTS so a broken run
  # cannot burn a month of usage limits in one morning — but that also means a
  # quiet giving-up that nothing else would report. Per agent, so one failing
  # agent never implicates the other.
  ATTEMPTS="$(cat "data/state/$a-$TODAY.attempts" 2>/dev/null || echo 0)"
  [[ "$ATTEMPTS" =~ ^[0-9]+$ ]] || ATTEMPTS=0
  if [ -s "data/$a/archive/$TODAY.md" ]; then
    pass "today's brief written ($TODAY)"
  elif [ "$ATTEMPTS" -ge "$MAX_ATTEMPTS" ]; then
    fail "$ATTEMPTS/$MAX_ATTEMPTS attempts failed today — tick.sh has stopped retrying"
    fail "  see data/$a/logs/$TODAY.json, then: ./tick.sh $a --force"
  elif [ "$ATTEMPTS" -gt 0 ]; then
    warn "$ATTEMPTS/$MAX_ATTEMPTS attempts so far today, no brief yet"
  fi

  # How this agent's last completed run actually ended. Judged on the newest
  # outcome line for THIS agent rather than on a fixed tail of cron.log: two
  # agents share that file, and a fixed tail reaches back days on a quiet
  # weekend, so a long-fixed failure keeps getting reported as current. Lines
  # written before the per-agent restructure carry no [agent] tag and are
  # correctly ignored here.
  LAST_OUTCOME="$(grep -F "[$a]" data/cron.log 2>/dev/null \
                  | grep -E 'FAILED|emailed|not emailed' | tail -1)"
  if [ -n "$LAST_OUTCOME" ]; then
    if grep -q 'FAILED' <<< "$LAST_OUTCOME"; then
      fail "last completed run failed:"
      printf '        %s\n' "$LAST_OUTCOME"
      fail "  see data/$a/logs/, and read the lines above it — Claude's stderr"
      fail "  is written before the FAILED line, not after it"
    else
      pass "last completed run succeeded"
    fi
  fi

  # A per-agent recipient is optional; empty MAIL_TO with no override means the
  # brief is written and silently never sent.
  _to_var="${PREFIX}_MAIL_TO"
  TO="${!_to_var:-${MAIL_TO:-}}"
  if [ -z "$TO" ]; then
    fail "no recipient — set MAIL_TO, or ${PREFIX}_MAIL_TO for this agent only"
  else
    pass "mail to: $TO"
  fi
done

# ------------------------------------------------------------------ tail ----

head2 "Recent activity"

# cron.log lives outside data/<agent>/logs because the host shell writes it
# while the container owns those directories. Both agents write here, and every
# line carries its agent name in brackets.
#
# Informational only — deliberately no pass/fail. Whether a run succeeded is
# decided per agent above, on that agent's newest outcome line. Judging a fixed
# tail of a file two agents share means an old, already-fixed failure keeps
# being reported as current, which is how a health check trains you to ignore
# it.
if [ -f data/cron.log ]; then
  grep -E 'tick: |starting |FAILED|emailed' data/cron.log | tail -6 | sed 's/^/        /'
else
  warn "no data/cron.log yet — cron has never fired tick.sh"
fi

# Optional live auth probe. Overriding the entrypoint means the agent argument
# is not used, so this proves the image and token without running a brief.
if [ "${1:-}" = "--probe" ]; then
  head2 "Auth probe"
  if docker compose --profile cron run --rm --entrypoint claude agent \
       -p "Reply with OK and nothing else." --model haiku 2>/dev/null | grep -qi ok; then
    pass "auth probe: model responded"
  else
    fail "auth probe failed — token or network"
  fi
fi

echo
[ "$FAILED" -eq 0 ] && echo "all checks passed" || echo "one or more checks FAILED"
exit "$FAILED"
