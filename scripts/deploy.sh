#!/usr/bin/env bash
#
# Install a new build on the box. Runs ON THE BOX, over SSH, from
# /opt/briefing, after the workflow has already done `git pull` — which is what
# puts the current version of this script there in the first place. See the
# bootstrap in .github/workflows/deploy.yml.
#
#   ./scripts/deploy.sh
#
# Everything it needs arrives in the environment, forwarded by the workflow:
#
#   IMAGE_TAG TZ CLAUDE_TOKEN_ISSUED MAIL_FROM MAIL_TO
#   CLAUDE_CODE_OAUTH_TOKEN RESEND_API_KEY FM_EMAIL FM_PASSWORD
#
# That list is the whole configuration surface of this project now. Anything an
# agent does — its hour, its days, whether it is enabled at all — is a default
# in tick.sh and lib/run.sh, shipped with the code and changed by editing it.
# There is no longer a settings page that has to agree with a variable list
# that has to agree with the heredoc below; a name can no longer go missing
# from one of the three and be silently empty on the box.
#
# `set -e` is deliberately NOT used. Several steps here are best-effort by
# design — the archive migration, the image pre-pull, the chown — and each one
# explains itself and continues. Aborting halfway through would leave the code
# pulled but the crontab still pointing at the previous version's interface,
# which is a worse state than any of the failures being tolerated.

set -uo pipefail

cd /opt/briefing || exit 1

chmod +x tick.sh healthcheck.sh lib/run.sh scripts/*.sh 2>/dev/null

# --------------------------------------------------------------------------
# One-time migration into the per-agent layout
# --------------------------------------------------------------------------
#
# data/archive is the morning briefing's memory — each run reads its last few
# briefs so it doesn't repeat itself — so losing it would not fail anything, it
# would just make every morning start cold.
#
# A plain `mv data/archive ...` does NOT work here, and the reason is not
# obvious: renaming a *directory* into a new parent needs write permission on
# the directory being moved, because the kernel has to update its ".." entry.
# data/archive is owned by the container's uid 1000, not by the deploy user, so
# both parents being writable is not enough and mv fails with EACCES. (Moving a
# plain file has no such requirement, which is why the cron.log move below has
# always been fine.) Hence the ladder: rename, rename as root, else copy — copy
# needs only read on the source, and leaves the original untouched.
#
# Guarded on the destination being *empty* rather than absent, so a partial or
# failed migration is retried on the next deploy instead of being silently
# skipped forever.
migrate_dir() {
  src="$1"; dst="$2"
  if [ ! -d "$src" ]; then return 0; fi
  if [ -n "$(ls -A "$dst" 2>/dev/null)" ]; then return 0; fi

  mkdir -p "$(dirname "$dst")"

  if [ ! -e "$dst" ] && mv "$src" "$dst" 2>/dev/null; then
    echo "migrated $src -> $dst"
    return 0
  fi
  if [ ! -e "$dst" ] && sudo -n mv "$src" "$dst" 2>/dev/null; then
    echo "migrated $src -> $dst (as root)"
    return 0
  fi

  mkdir -p "$dst"
  if cp -a "$src/." "$dst/" 2>/dev/null \
     || sudo -n cp -a "$src/." "$dst/" 2>/dev/null; then
    echo "migrated $src -> $dst by copy"
    echo "  $src is still there as a backup — delete it once a brief has run"
    return 0
  fi

  echo "::warning::could not migrate $src to $dst — that agent starts with no history"
  echo "WARNING: could not migrate $src to $dst. Deploy continued anyway."
  echo "WARNING: the agent will run, but with no memory of past briefs. Fix by hand:"
  echo "WARNING:   sudo mv /opt/briefing/$src /opt/briefing/$dst"
  return 0
}

migrate_dir data/archive data/morning-briefing/archive
migrate_dir data/logs    data/morning-briefing/logs

# inbox/ and outbox/ are the scout's working files rather than its memory:
# today's collected projects, and today's queue with the outcome of each.
# archive/ is the memory, as for every agent.
mkdir -p data/morning-briefing/archive data/morning-briefing/logs \
         data/opportunities/archive data/opportunities/logs \
         data/freelance-scout/archive data/freelance-scout/logs \
         data/freelance-scout/inbox data/freelance-scout/outbox \
         data/state

# --------------------------------------------------------------------------
# .env
# --------------------------------------------------------------------------
#
# Nine values, and every one of them is either environment-specific (the
# timezone, the mail addresses) or a credential. Nothing here describes what an
# agent does.
cat > .env <<ENVEOF
IMAGE_TAG=$IMAGE_TAG
TZ=$TZ
CLAUDE_TOKEN_ISSUED=${CLAUDE_TOKEN_ISSUED:-}
MAIL_FROM=$MAIL_FROM
MAIL_TO=$MAIL_TO
CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN
RESEND_API_KEY=$RESEND_API_KEY
FM_EMAIL=${FM_EMAIL:-}
FM_PASSWORD=${FM_PASSWORD:-}
ENVEOF
chmod 600 .env

# --------------------------------------------------------------------------
# Image
# --------------------------------------------------------------------------
#
# --profile cron is required, not cosmetic: the only service is behind that
# profile, and Compose hides profiled services from every command that does not
# enable it. A plain `docker compose pull` matches zero services and exits 0,
# so the deploy looks clean while nothing is fetched — the image then gets
# pulled lazily by the first `compose run` at 05:00, which is exactly the wrong
# time to discover a GHCR auth problem.
#
# Retried, and non-fatal. GHCR applies a secondary rate limit when several
# deploys land close together — each one pulls a fresh image tag — and answers
# with a 403 whose body says to wait and try again. That is transient and must
# not fail a deploy: pulling here is an optimisation, not a requirement,
# because `compose run` still pulls on demand exactly as it did before this
# step existed. Failing hard would trade a real improvement for a new outage.
PULL_LOG="$(mktemp)"
PULLED=0
for attempt in 1 2 3; do
  if docker compose --profile cron pull > "$PULL_LOG" 2>&1; then
    PULLED=1
    break
  fi
  tail -3 "$PULL_LOG"
  if grep -qi 'rate limit\|secondary rate' "$PULL_LOG"; then
    echo "GHCR secondary rate limit on attempt $attempt/3 — transient, not an auth problem"
  fi
  if [ "$attempt" -lt 3 ]; then
    echo "retrying in $((attempt * 60))s"
    sleep $((attempt * 60))
  fi
done
rm -f "$PULL_LOG"

if [ "$PULLED" -eq 1 ]; then
  echo "image pulled: $IMAGE_TAG"
else
  echo "::warning::could not pre-pull the image — the next scheduled run will pull it on demand"
  echo "WARNING: could not pre-pull ghcr.io/fl0rianfischer/morning-briefing:$IMAGE_TAG"
  echo "WARNING: the deploy is otherwise complete and the schedule is installed."
  echo "WARNING: the next run pulls on demand, so this self-heals if the cause was"
  echo "WARNING: a rate limit. If it was auth, that run fails instead — to settle it"
  echo "WARNING: now, on the box:  docker compose --profile cron pull"
fi

docker image prune -f

# --------------------------------------------------------------------------
# cron
# --------------------------------------------------------------------------
#
# cron.log is written by the host shell (the redirect below) while data/logs
# belongs to the container's uid. Keeping it in there meant one directory two
# different users had to write, and a chown that broke cron outright. Move any
# old one out.
if [ -f data/logs/cron.log ] && [ ! -f data/cron.log ]; then
  mv data/logs/cron.log data/cron.log 2>/dev/null \
    || cp data/logs/cron.log data/cron.log 2>/dev/null || true
fi

# One line per agent, carrying no schedule and no timezone — each just runs
# tick.sh for one agent, and tick.sh reads TZ from .env and that agent's
# hour and days from its own defaults, then decides. CRON_TZ is gone: it is a
# vendor extension this box's cron ignores, which is why "0 5" was firing at
# 05:00 Europe/Berlin and landing at 10:00 in Jakarta. The host's timezone is
# irrelevant to this project.
#
# Every line is always installed, including for agents that are disabled. A
# disabled agent is disabled by its default in tick.sh, not by withholding its
# cron entry — so `tick.sh <agent> --dry-run` can always explain itself, and
# turning one on never requires touching the crontab.
#
# The legacy '# morning-briefing' tag is stripped too: the old single line
# called tick.sh with no agent argument, which the current tick.sh rejects.
AGENTS="morning-briefing opportunities freelance-scout"
{
  crontab -l 2>/dev/null \
    | grep -v '# briefing-agent$' \
    | grep -v '# morning-briefing$' \
    | grep -v '^CRON_TZ=' || true
  for a in $AGENTS; do
    echo "*/15 * * * * /opt/briefing/tick.sh $a >> /opt/briefing/data/cron.log 2>&1 # briefing-agent"
  done
} | crontab -
echo "cron installed:"
crontab -l | grep '# briefing-agent$'

# --------------------------------------------------------------------------
# Mount ownership
# --------------------------------------------------------------------------
#
# Bind mounts arrive with the host's ownership regardless of what the image
# chowned, so a uid mismatch denies every write inside the container — the
# failure that made the agent look like it was producing nothing. Fix it if we
# can, name it exactly if we cannot.
#
# ONLY the per-agent trees. data/ is one mount, but it also holds data/state
# (attempts and locks, written by tick.sh on the host) and data/cron.log
# (written by cron's own redirect). A blanket `chown -R data` would hand those
# to the container's uid and break cron's append — the same shape as the bug
# that had cron.log living in data/logs.
IMG_UID="$(docker image inspect --format '{{.Config.User}}' \
           "ghcr.io/fl0rianfischer/morning-briefing:$IMAGE_TAG" 2>/dev/null | cut -d: -f1)"
case "$IMG_UID" in ''|*[!0-9]*) IMG_UID=1000 ;; esac

NEED_CHOWN=""
for a in $AGENTS; do
  d="data/$a"
  CUR="$(stat -c %u "$d" 2>/dev/null)"
  if [ -n "$CUR" ] && [ "$CUR" != "$IMG_UID" ]; then
    chown -R "$IMG_UID:$IMG_UID" "$d" 2>/dev/null \
      || sudo -n chown -R "$IMG_UID:$IMG_UID" "$d" 2>/dev/null \
      || NEED_CHOWN="$NEED_CHOWN /opt/briefing/$d"
  fi
done
if [ -n "$NEED_CHOWN" ]; then
  echo "WARNING: these are owned by another uid but the container runs as $IMG_UID."
  echo "WARNING: every write inside the container will be denied. Run once:"
  echo "WARNING:   sudo chown -R $IMG_UID:$IMG_UID$NEED_CHOWN"
fi

# --------------------------------------------------------------------------
# Report
# --------------------------------------------------------------------------
#
# The migration above is the one step that can degrade something silently, so
# report what each agent actually has to read. A morning-briefing archive that
# says 0 briefs on a box that has been running for weeks means it did not take.
for a in $AGENTS; do
  echo "$a: $(ls -1 "data/$a/archive"/*.md 2>/dev/null | wc -l | tr -d ' ') past briefs"
done
if [ -d data/archive ]; then
  echo "note: the pre-migration data/archive is still on disk as a backup"
fi

for a in $AGENTS; do
  printf 'next %-17s %s\n' "$a:" "$(./tick.sh "$a" --dry-run 2>/dev/null | tail -1)"
done
