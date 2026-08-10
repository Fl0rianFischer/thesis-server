# syntax=docker/dockerfile:1

# Debian slim rather than alpine (which thesis-backend used): Claude Code ships
# native helpers, notably ripgrep, that expect glibc. Alpine's musl is a fight
# not worth having for an image that runs once a day.
FROM node:22-bookworm-slim AS production

# TZ is UTC here only as a last-resort fallback. The real value comes from .env
# at run time and is the single place a timezone is configured in this project
# — it decides the schedule, the briefing's filename and date, the mail
# subject, and the agent's own sense of what time it is. Baking a real zone in
# here would make it a second source of truth that silently disagrees.
ENV NODE_ENV=production \
    HOME=/home/briefing \
    TZ=UTC

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ca-certificates \
       curl \
       jq \
       tzdata \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code \
  && npm cache clean --force

# The uid is pinned to 1000, and that is load-bearing. archive/ and logs/ are
# bind mounts, so they arrive owned by whichever host uid created them and the
# chown below does not apply to them — if the container's uid differs, every
# write fails. `useradd -r` used to pick an arbitrary system uid (999 in
# practice), which silently mismatched the host's 1000 and made the agent look
# like it was producing nothing.
#
# The node base image already owns uid 1000, so clear it first rather than
# assuming either way; `set -eux` puts the outcome in the build log.
RUN set -eux; \
    if getent passwd 1000 >/dev/null; then \
      userdel -r "$(getent passwd 1000 | cut -d: -f1)" || true; \
    fi; \
    if getent group 1000 >/dev/null; then \
      groupdel "$(getent group 1000 | cut -d: -f1)" || true; \
    fi; \
    groupadd -g 1000 briefing; \
    useradd -u 1000 -g briefing -d /home/briefing -m briefing

WORKDIR /app

# marked, for the markdown-to-HTML step at send time: Gmail shows the `text`
# field as-is, so without this the briefing arrives as literal `##` and
# `[label](url)`. Own layer, ahead of the config copies, so editing the
# watchlist does not reinstall it.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && npm cache clean --force

# Config lives in the image, so changing a watchlist or a prompt is a deploy —
# versioned, reviewable, and rolled back the same way as anything else. State
# (data/) is mounted in at runtime; see docker-compose.yml.
#
# Both agents ship in one image. They are the same runtime and differ only in
# the argument they are invoked with, so a second image would double CI time
# and pull bandwidth for no isolation gain — the isolation that matters is
# filesystem, schedule and failure state, and that lives outside the image.
COPY watchlist.md ./watchlist.md
COPY lib ./lib
COPY agents ./agents

RUN chmod +x /app/lib/run.sh \
  && mkdir -p /app/data \
  && chown -R 1000:1000 /app /home/briefing

# Numeric rather than `USER briefing`: this is what the mount-ownership check in
# healthcheck.sh reads out of the image metadata to compare against the host
# directories, and a name would tell it nothing.
USER 1000:1000

# The agent name arrives as the Compose command:
#   docker compose --profile cron run --rm agent opportunities
ENTRYPOINT ["/app/lib/run.sh"]
