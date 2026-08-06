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
# A setup-token is valid for one year and expires with no warning: Claude Code's
# "login expires in 3 days" notice fires only for an interactive /login, not for
# CLAUDE_CODE_OAUTH_TOKEN. Without this the first symptom is a briefing that
# silently stops arriving. Set CLAUDE_TOKEN_ISSUED=YYYY-MM-DD to get a month's
# notice; leave it unset to skip the check.
if [ -n "${CLAUDE_TOKEN_ISSUED:-}" ]; then
  IFS=- read -r _ty _tm _td <<< "$CLAUDE_TOKEN_ISSUED"
  _wy=$((10#$_ty + 1)); _wm=$((10#$_tm - 1))
  [ "$_wm" -eq 0 ] && { _wm=12; _wy=$((_wy - 1)); }
  if [[ "$DATE" > "$(printf '%04d-%02d-%02d' "$_wy" "$_wm" "$((10#$_td))")" ]]; then
    log "WARNING: OAuth token issued $CLAUDE_TOKEN_ISSUED expires around $((10#$_ty + 1))-$_tm-$_td."
    log "WARNING: run 'claude setup-token', update the CLAUDE_CODE_OAUTH_TOKEN secret, redeploy."
  fi
fi

# CLAUDE_CODE_OAUTH_TOKEN sits at #5 in Claude Code's auth precedence, below
# both of these. If either leaks into the environment it wins silently and the
# run bills the API instead of the subscription.
if [ -n "${ANTHROPIC_API_KEY:-}" ] || [ -n "${ANTHROPIC_AUTH_TOKEN:-}" ]; then
  log "WARNING: ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN is set and outranks the"
  log "WARNING: subscription token — this run will be billed to the API."
fi

log "starting briefing for $DATE (model=$MODEL effort=$EFFORT)"

CLAUDE_ARGS=(
  -p "Produce today's briefing."
  --append-system-prompt-file prompt.md
  --allowedTools "WebSearch,WebFetch,Read,Write,Glob"
  --model "$MODEL"
  --effort "$EFFORT"
  --max-turns "$MAX_TURNS"
)

LOG_FILE="logs/$DATE.json"

if [ "${BRIEFING_STREAM:-0}" = "1" ]; then
  # Local tuning: show the run as it happens so you can see which searches it
  # runs and kill it early if it goes down a rabbit hole. The log file gets the
  # same content as a normal run, one JSON object per line instead of one blob.
  log "streaming (BRIEFING_STREAM=1)"
  claude "${CLAUDE_ARGS[@]}" \
    --output-format stream-json --verbose --include-partial-messages \
    | tee "$LOG_FILE" \
    | jq -rj --unbuffered 'select(.type == "stream_event" and .event.delta.type? == "text_delta") | .event.delta.text' \
    || log "claude exited non-zero, checking for output anyway"
  echo
else
  claude "${CLAUDE_ARGS[@]}" --output-format json \
    > "$LOG_FILE" || log "claude exited non-zero, checking for output anyway"
fi

# Claude Code reports in-run failures — including expired auth — as the result
# on stdout rather than via exit code. The artifact is the reliable signal.
# jq -s (slurp) so the same expression works against both output formats: a
# single JSON object from --output-format json, or NDJSON from stream mode.
log_field() { jq -rs "[.[] | select(.$1 != null)] | last.$1 // \"n/a\"" "$LOG_FILE" 2>/dev/null; }

if [ ! -s "archive/$DATE.md" ]; then
  log "FAILED: no briefing at archive/$DATE.md"
  log "last result: $(log_field result | head -c 500)"
  exit 1
fi

if command -v jq >/dev/null 2>&1; then
  log "cost: $(log_field total_cost_usd) USD (subscription runs bill no tokens)"
fi

if [ -z "${RESEND_API_KEY:-}" ]; then
  log "RESEND_API_KEY unset — briefing written to archive/$DATE.md, not emailed"
  exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
  log "jq not installed — briefing written to archive/$DATE.md, not emailed"
  exit 1
fi

# Gmail renders the `text` field verbatim, so markdown arrives as literal `##`
# and `[label](url)`. Send `html` as well and mail clients prefer it, falling
# back to `text` where HTML is off.
#
# to_html.mjs stamps a style attribute onto every tag rather than wrapping the
# whole thing in one styled div: font-size and margins do not inherit, so a
# wrapper alone still leaves `##` rendering at the browser's default h2 — huge,
# black, and nothing like the rest of the mail.
HTML_BODY=""
if ! HTML_BODY="$(node to_html.mjs "archive/$DATE.md")"; then
  HTML_BODY=""
  log "WARNING: HTML render failed — sending plain text only (npm ci?)"
fi

jq -n \
  --arg from "$MAIL_FROM" \
  --arg to "$MAIL_TO" \
  --arg subject "Briefing — $DATE" \
  --arg text "$(cat "archive/$DATE.md")" \
  --arg html "$HTML_BODY" \
  '{from: $from, to: [$to], subject: $subject, text: $text}
   + (if $html == "" then {} else {html: $html} end)' \
| curl -fsS https://api.resend.com/emails \
    -H "Authorization: Bearer $RESEND_API_KEY" \
    -H "Content-Type: application/json" \
    --data @- > /dev/null

log "emailed $MAIL_TO"
