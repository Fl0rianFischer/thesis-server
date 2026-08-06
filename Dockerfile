# syntax=docker/dockerfile:1

# Debian slim rather than alpine (which thesis-backend used): Claude Code ships
# native helpers, notably ripgrep, that expect glibc. Alpine's musl is a fight
# not worth having for an image that runs once a day.
FROM node:22-bookworm-slim AS production

ENV NODE_ENV=production \
    HOME=/home/briefing \
    TZ=Europe/Berlin

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ca-certificates \
       curl \
       jq \
       tzdata \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code \
  && npm cache clean --force

RUN groupadd -r briefing \
  && useradd -r -g briefing -d /home/briefing -m briefing

WORKDIR /app

# Config lives in the image, so changing the watchlist is a deploy — versioned,
# reviewable, and rolled back the same way as anything else. State (archive/,
# logs/) is mounted in at runtime; see docker-compose.yml.
COPY prompt.md watchlist.md ./
COPY run.sh ./run.sh

RUN chmod +x /app/run.sh \
  && mkdir -p /app/archive /app/logs \
  && chown -R briefing:briefing /app /home/briefing

USER briefing

ENTRYPOINT ["/app/run.sh"]
