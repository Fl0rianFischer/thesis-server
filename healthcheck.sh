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

EXPECT_TZ="${TZ:-Asia/Jakarta}"
FAILED=0

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$*"; }
warn() { printf '  \033[33mWARN\033[0m  %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; FAILED=1; }

echo "morning-briefing health — $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo

# 1. The briefing itself. This is the check that matters: everything below only
#    explains a failure here. Cron runs Mon-Fri, so on a Monday the newest file
#    is legitimately Friday's — three days old.
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

# 2. Schedule. A missing entry is the usual reason for a missing briefing.
if crontab -l 2>/dev/null | grep -q '# morning-briefing$'; then
  pass "cron: $(crontab -l | grep '# morning-briefing$' | sed 's| cd /opt.*||')"
else
  fail "no cron entry — redeploy to reinstall it"
fi

# 3. Timezone. Host cron uses the host zone, not the container's; a mismatch
#    means the briefing arrives hours late rather than not at all, which is
#    much harder to notice.
HOST_TZ="$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo unknown)"
CRON_TZ_SET="$(crontab -l 2>/dev/null | grep '^CRON_TZ=' | cut -d= -f2)"
if [ "$HOST_TZ" = "$EXPECT_TZ" ]; then
  pass "timezone: host $HOST_TZ"
elif [ "$CRON_TZ_SET" = "$EXPECT_TZ" ]; then
  warn "host TZ is $HOST_TZ, not $EXPECT_TZ — relying on CRON_TZ=$CRON_TZ_SET"
else
  fail "host TZ $HOST_TZ != $EXPECT_TZ and no CRON_TZ — schedule will fire at the wrong hour"
fi

# 4. Last run's own verdict.
if [ -f data/logs/cron.log ]; then
  LAST_RUN="$(grep -E 'starting briefing|FAILED|emailed' data/logs/cron.log | tail -3)"
  if grep -q 'FAILED' <<< "$(tail -40 data/logs/cron.log)"; then
    fail "last run logged FAILED:"
    sed 's/^/        /' <<< "$LAST_RUN"
  else
    pass "cron.log tail clean"
    sed 's/^/        /' <<< "$LAST_RUN"
  fi
else
  warn "no data/logs/cron.log yet — cron has never run"
fi

# 5. Image. Catches a deploy that built but never pulled.
if docker info >/dev/null 2>&1; then
  RUNNING_IMG="$(docker compose --profile cron config 2>/dev/null | awk '/image:/{print $2; exit}')"
  if docker image inspect "$RUNNING_IMG" >/dev/null 2>&1; then
    pass "image present: ${RUNNING_IMG##*/}"
  else
    fail "image $RUNNING_IMG not pulled — check GHCR auth"
  fi
else
  fail "docker daemon not responding"
fi

# 6. Token expiry. It dies silently after a year; see run.sh for why.
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

# 7. Disk. Old images are the thing that actually fills a small box.
DISK_PCT="$(df -P . | awk 'NR==2{gsub(/%/,"",$5); print $5}')"
if [ "$DISK_PCT" -lt 85 ]; then pass "disk ${DISK_PCT}% used"
elif [ "$DISK_PCT" -lt 95 ]; then warn "disk ${DISK_PCT}% used — try 'docker image prune -a'"
else fail "disk ${DISK_PCT}% used"
fi

# 8. Optional live auth probe.
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
