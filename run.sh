#!/usr/bin/env bash
#
# Generate the morning briefing and email it.
#
# In production this is the container entrypoint, fired by host cron:
#
#   docker compose --profile cron run --rm briefing
#
# Compose loads .env via env_file, so the container gets a complete environment
# regardless of how sparse cron's own environment is.
#
# Locally, run it directly (./run.sh) after exporting the vars in .env.example.
# With RESEND_API_KEY unset it writes the briefing and skips the email, which is
# the right loop for tuning prompt.md.

set -euo pipefail

BRIEFING_DIR="${BRIEFING_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
cd "$BRIEFING_DIR"

MODEL="${BRIEFING_MODEL:-sonnet}"
EFFORT="${BRIEFING_EFFORT:-medium}"
MAX_TURNS="${BRIEFING_MAX_TURNS:-40}"
DATE="$(date +%F)"

mkdir -p archive logs

# %Y-%m-%dT%H:%M:%S%z rather than -Is: BSD date (macOS, where you'll test
# locally) has no -Is.
log() { printf '%s %s\n' "$(date +%Y-%m-%dT%H:%M:%S%z)" "$*"; }

# --allowedTools deliberately excludes Bash. This agent reads untrusted web
# content every morning; delivery is handled below by this script instead, so a
# prompt injection in a news article has no shell to reach for.
#
# --bare is deliberately NOT used. It would ignore the subscription OAuth token
# and fall back to ANTHROPIC_API_KEY billing, and it strips WebSearch/WebFetch
# from the toolset, which is the entire job.
log "starting briefing for $DATE (model=$MODEL effort=$EFFORT)"

claude -p "Produce today's briefing." \
  --append-system-prompt-file prompt.md \
  --allowedTools "WebSearch,WebFetch,Read,Write,Glob" \
  --model "$MODEL" \
  --effort "$EFFORT" \
  --max-turns "$MAX_TURNS" \
  --output-format json \
  > "logs/$DATE.json" || log "claude exited non-zero, checking for output anyway"

# Claude Code reports in-run failures — including expired auth — as the result
# on stdout rather than via exit code. The artifact is the reliable signal.
if [ ! -s "archive/$DATE.md" ]; then
  log "FAILED: no briefing at archive/$DATE.md"
  log "last result: $(jq -r '.result // "no result field"' "logs/$DATE.json" 2>/dev/null | head -c 500)"
  exit 1
fi

if command -v jq >/dev/null 2>&1; then
  log "cost: $(jq -r '.total_cost_usd // "n/a"' "logs/$DATE.json") USD"
fi

if [ -z "${RESEND_API_KEY:-}" ]; then
  log "RESEND_API_KEY unset — briefing written to archive/$DATE.md, not emailed"
  exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
  log "jq not installed — briefing written to archive/$DATE.md, not emailed"
  exit 1
fi

jq -n \
  --arg from "$MAIL_FROM" \
  --arg to "$MAIL_TO" \
  --arg subject "Briefing — $DATE" \
  --arg text "$(cat "archive/$DATE.md")" \
  '{from: $from, to: [$to], subject: $subject, text: $text}' \
| curl -fsS https://api.resend.com/emails \
    -H "Authorization: Bearer $RESEND_API_KEY" \
    -H "Content-Type: application/json" \
    --data @- > /dev/null

log "emailed $MAIL_TO"
