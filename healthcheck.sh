#!/usr/bin/env bash
#
# Read-only health check. Run it on the box:
#
#   /opt/briefing/healthcheck.sh
#
# or from your laptop:
#
#   ssh USER@HOST '/opt/briefing/healthcheck.sh'
#
# There is no HTTP endpoint to poll — this is a scheduled job, not a service —
# so the real signal is whether a briefing file appeared when it should have.
# Everything else here explains a missing one.
#
# Exits non-zero if any check FAILs, so it can drive an uptime monitor.
#
# --probe additionally spends one cheap model call to prove the OAuth token is
# still good. Left out of the default run so this stays free to poll.

set -uo pipefail

BRIEFING_DIR="${BRIEFING_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
cd "$BRIEFING_DIR" || exit 1

[ -f .env ] && { set -a; . ./.env; set +a; }

# Every date below is evaluated in the reader's zone, because that is the only
# zone the schedule, the filenames and the mail subject are expressed in. The
# host's own timezone is deliberately not consulted anywhere in this file.
TZ_SET=1
if [ -z "${TZ:-}" ]; then TZ_SET=0; TZ=UTC; fi
export TZ

TODAY="$(date +%F)"
MAX_ATTEMPTS="${BRIEFING_MAX_ATTEMPTS:-3}"
FAILED=0

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$*"; }
warn() { printf '  \033[33mWARN\033[0m  %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; FAILED=1; }

echo "morning-briefing health — $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo

# 1. The briefing itself. This is the check that matters: everything below only
#    explains a failure here. The job runs on BRIEFING_DAYS, so on a Monday the
#    newest file is legitimately Friday's — three days old.
LATEST="$(ls -1 data/archive/*.md 2>/dev/null | sort | tail -1)"
if [ -z "$LATEST" ]; then
  fail "no briefings in data/archive/ — nothing has ever run successfully"
else
  LATEST_DATE="$(basename "$LATEST" .md)"
  AGE=$(( ( $(date +%s) - $(date -d "$LATEST_DATE" +%s 2>/dev/null || echo 0) ) / 86400 ))
  SIZE=$(wc -c < "$LATEST" | tr -d ' ')
  if [ "$AGE" -le 3 ]; then
    pass "latest briefing $LATEST_DATE (${AGE}d old, ${SIZE} bytes)"
  elif [ "$AGE" -le 5 ]; then
    warn "latest briefing $LATEST_DATE is ${AGE}d old — expected one within 3d"
  else
    fail "latest briefing $LATEST_DATE is ${AGE}d old — the job has stopped"
  fi
  [ "$SIZE" -lt 500 ] && warn "latest briefing is only ${SIZE} bytes — suspiciously short"
fi

# 2. The timezone, which is the single input the whole schedule derives from.
#    Empty does not fail loudly at run time — it silently means UTC, which at
#    05:00 in a UTC+7 zone files the briefing under yesterday's date.
if [ "$TZ_SET" -eq 0 ]; then
  fail "TZ is empty in .env — set the TZ repository variable and redeploy"
else
  pass "timezone: $TZ (host zone is not consulted)"
fi

# 3. Schedule. cron fires tick.sh on a fixed interval and tick.sh decides
#    whether it is briefing time in $TZ, so the crontab itself never changes
#    and carries no timezone of its own.
if crontab -l 2>/dev/null | grep -q '# morning-briefing$'; then
  pass "cron: $(crontab -l | grep '# morning-briefing$' | sed 's| /opt/briefing/tick.sh.*||')"
  if [ -x tick.sh ]; then
    DECISION="$(./tick.sh --dry-run 2>&1 | tail -1)"
    printf '        next: %s\n' "$DECISION"
  else
    fail "tick.sh missing or not executable — redeploy"
  fi
else
  fail "no cron entry — redeploy to reinstall it"
fi

# 4. Mount ownership. A bind mount arrives with the host's ownership no matter
#    what the image chowned, so a uid mismatch makes every write inside the
#    container fail — and the symptom is an empty log and a run that looks like
#    the model produced nothing.
if docker info >/dev/null 2>&1; then
  RUNNING_IMG="$(docker compose --profile cron config 2>/dev/null | awk '/image:/{print $2; exit}')"
  if docker image inspect "$RUNNING_IMG" >/dev/null 2>&1; then
    pass "image present: ${RUNNING_IMG##*/}"
    IMG_UID="$(docker image inspect --format '{{.Config.User}}' "$RUNNING_IMG" 2>/dev/null | cut -d: -f1)"
    if [[ "$IMG_UID" =~ ^[0-9]+$ ]]; then
      for d in data/archive data/logs; do
        DIR_UID="$(stat -c %u "$d" 2>/dev/null || echo -1)"
        if [ "$DIR_UID" = "$IMG_UID" ]; then
          pass "$d owned by uid $DIR_UID, matching the image"
        else
          fail "$d is uid $DIR_UID but the container runs as $IMG_UID — writes will be denied"
          fail "  sudo chown -R $IMG_UID:$IMG_UID $BRIEFING_DIR/data/archive $BRIEFING_DIR/data/logs"
        fi
      done
    else
      warn "image user is '$IMG_UID', not numeric — cannot verify mount ownership"
    fi
  else
    fail "image $RUNNING_IMG not pulled — check GHCR auth"
  fi
else
  fail "docker daemon not responding"
fi

# 5. Last run's own verdict. cron.log lives outside data/logs because the host
#    shell writes it while the container owns that directory.
if [ -f data/cron.log ]; then
  LAST_RUN="$(grep -E 'tick: |starting briefing|FAILED|emailed' data/cron.log | tail -3)"
  if grep -q 'FAILED' <<< "$(tail -40 data/cron.log)"; then
    fail "last run logged FAILED:"
    sed 's/^/        /' <<< "$LAST_RUN"
  else
    pass "cron.log tail clean"
    sed 's/^/        /' <<< "$LAST_RUN"
  fi
else
  warn "no data/cron.log yet — cron has never fired tick.sh"
fi

# 6. Today's attempts. tick.sh stops retrying after BRIEFING_MAX_ATTEMPTS so a
#    broken run cannot burn a month of usage limits in one morning — but that
#    also means a quiet giving-up that nothing else would report.
ATTEMPTS="$(cat "data/state/$TODAY.attempts" 2>/dev/null || echo 0)"
[[ "$ATTEMPTS" =~ ^[0-9]+$ ]] || ATTEMPTS=0
if [ -s "data/archive/$TODAY.md" ]; then
  pass "today's briefing written ($TODAY)"
elif [ "$ATTEMPTS" -ge "$MAX_ATTEMPTS" ]; then
  fail "$ATTEMPTS/$MAX_ATTEMPTS attempts failed today — tick.sh has stopped retrying"
  fail "  see data/logs/$TODAY.json, then: ./tick.sh --force"
elif [ "$ATTEMPTS" -gt 0 ]; then
  warn "$ATTEMPTS/$MAX_ATTEMPTS attempts so far today, no briefing yet"
fi

# 7. Token expiry. It dies silently after a year; see run.sh for why.
if [ -n "${CLAUDE_TOKEN_ISSUED:-}" ]; then
  EXPIRES="$(date -d "$CLAUDE_TOKEN_ISSUED +1 year" +%F 2>/dev/null || echo "")"
  if [ -n "$EXPIRES" ]; then
    DAYS_LEFT=$(( ( $(date -d "$EXPIRES" +%s) - $(date +%s) ) / 86400 ))
    if   [ "$DAYS_LEFT" -lt 0 ];  then fail "OAuth token expired $EXPIRES — run 'claude setup-token'"
    elif [ "$DAYS_LEFT" -lt 30 ]; then warn "OAuth token expires $EXPIRES (${DAYS_LEFT}d)"
    else pass "OAuth token valid until $EXPIRES (${DAYS_LEFT}d)"
    fi
  fi
else
  warn "CLAUDE_TOKEN_ISSUED unset — no expiry warning possible"
fi

# 8. Mail configuration. Empty here means the briefing is written and then
#    silently not delivered, which looks identical to the job never running.
if [ -z "${MAIL_FROM:-}" ] || [ -z "${MAIL_TO:-}" ]; then
  fail "MAIL_FROM/MAIL_TO empty — briefings will be written but not emailed"
else
  pass "mail: $MAIL_FROM -> $MAIL_TO"
fi

# 9. Disk. Old images are the thing that actually fills a small box.
DISK_PCT="$(df -P . | awk 'NR==2{gsub(/%/,"",$5); print $5}')"
if [ "$DISK_PCT" -lt 85 ]; then pass "disk ${DISK_PCT}% used"
elif [ "$DISK_PCT" -lt 95 ]; then warn "disk ${DISK_PCT}% used — try 'docker image prune -a'"
else fail "disk ${DISK_PCT}% used"
fi

# 10. Optional live auth probe.
if [ "${1:-}" = "--probe" ]; then
  if docker compose --profile cron run --rm --entrypoint claude briefing \
       -p "Reply with OK and nothing else." --model haiku 2>/dev/null | grep -qi ok; then
    pass "auth probe: model responded"
  else
    fail "auth probe failed — token or network"
  fi
fi

echo
[ "$FAILED" -eq 0 ] && echo "all checks passed" || echo "one or more checks FAILED"
exit "$FAILED"
