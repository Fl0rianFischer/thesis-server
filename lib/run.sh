#!/usr/bin/env bash
#
# Generate one agent's brief and email it.
#
#   ./lib/run.sh morning-briefing
#   ./lib/run.sh opportunities
#
# In production this is the container entrypoint, so the agent name arrives as
# the Compose command:
#
#   docker compose --profile cron run --rm agent morning-briefing
#
# Compose loads .env via env_file, so the container gets a complete environment
# regardless of how sparse cron's own environment is.
#
# Locally, run it directly after exporting the vars in .env.example. With
# RESEND_API_KEY unset it writes the brief and skips the email, which is the
# right loop for tuning a prompt.
#
# One script serves both agents on purpose. The uid check, the token-expiry
# warning, the auth-precedence guard and the artifact-not-exit-code failure
# detection below are subtle enough that a second copy would guarantee they get
# fixed in one place and not the other. Everything that legitimately differs
# between agents is a variable, resolved in the block just below.

set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$APP_DIR"

AGENT="${1:-}"
if [ -z "$AGENT" ]; then
  echo "usage: run.sh <agent>   (morning-briefing | opportunities)" >&2
  exit 2
fi

# Each agent's env prefix and mail label. BRIEFING_ is kept for the morning
# briefing rather than renamed to something symmetrical: those GitHub Variables
# are already configured on a running system, and a rename would be a silent
# reset to defaults on the next deploy — the schedule would quietly move.
#
# The turn budgets differ in the defaults, not just in .env: an unset GitHub
# Variable is written to .env as an empty value, so whatever is defaulted here
# is what an unconfigured deploy actually runs. The opportunities brief is
# cheaper on purpose — both agents draw on the same subscription, and its
# horizon rewards a shallower search far more than the morning briefing's does.
case "$AGENT" in
  morning-briefing) PREFIX=BRIEFING; LABEL="Briefing";      DEFAULT_MAX_TURNS=40 ;;
  opportunities)    PREFIX=OPPS;     LABEL="Opportunities"; DEFAULT_MAX_TURNS=25 ;;
  *) echo "run.sh: unknown agent '$AGENT'" >&2; exit 2 ;;
esac

PROMPT_FILE="agents/$AGENT/prompt.md"
AGENT_CONTEXT="agents/$AGENT/context.mjs"
ARCHIVE_DIR="data/$AGENT/archive"
LOG_DIR="data/$AGENT/logs"

if [ ! -f "$PROMPT_FILE" ]; then
  echo "run.sh: no prompt at $PROMPT_FILE" >&2
  exit 2
fi

# ${!name} indirection so one script reads BRIEFING_MODEL for one agent and
# OPPS_MODEL for the other, with the same line.
env_or() { local n="$1"; local v="${PREFIX}_$1"; echo "${!v:-$2}"; }

MODEL="$(env_or MODEL sonnet)"
EFFORT="$(env_or EFFORT medium)"
MAX_TURNS="$(env_or MAX_TURNS "$DEFAULT_MAX_TURNS")"
STREAM="$(env_or STREAM 0)"

# A per-agent recipient is optional and falls back to the shared one, so the
# common case needs no extra configuration. It exists so a brief can be pointed
# somewhere else — or nowhere — while it is being tuned.
_mail_to_var="${PREFIX}_MAIL_TO"
MAIL_TO="${!_mail_to_var:-${MAIL_TO:-}}"

# TZ decides the filename, the mail subject and the agent's sense of "today",
# so an empty one does not fail — it quietly files the brief under the wrong
# date. At 05:00 in a UTC+7 zone that is yesterday.
TZ_MISSING=0
if [ -z "${TZ:-}" ]; then TZ_MISSING=1; export TZ=UTC; fi
DATE="$(date +%F)"

mkdir -p "$ARCHIVE_DIR" "$LOG_DIR"

# %Y-%m-%dT%H:%M:%S%z rather than -Is: BSD date (macOS, where you'll test
# locally) has no -Is. The agent name is in every line because both agents
# write to the same cron.log on the box.
log() { printf '%s [%s] %s\n' "$(date +%Y-%m-%dT%H:%M:%S%z)" "$AGENT" "$*"; }

# An `[ ... ] && log ...` one-liner would abort the whole run under `set -e`
# whenever the condition is false, which here is the healthy case.
if [ "$TZ_MISSING" -eq 1 ]; then
  log "WARNING: TZ is empty — using UTC. Set the TZ variable and redeploy."
fi

# data/ is a bind mount, and a bind mount arrives with the host's ownership
# regardless of what the Dockerfile chowned. When those uids do not line up,
# the first symptom is `> $LOG_DIR/$DATE.json: Permission denied` and a run
# that appears to have produced nothing — which reads exactly like a model
# failure. Name the real cause instead.
for dir in "$ARCHIVE_DIR" "$LOG_DIR"; do
  if ! touch "$dir/.write-test" 2>/dev/null; then
    log "FAILED: $dir/ is not writable by uid $(id -u):$(id -g) inside the container."
    log "FAILED: the bind mount is owned by another uid. On the host, run:"
    log "FAILED:   sudo chown -R 1000:1000 /opt/briefing/$dir"
    exit 1
  fi
  rm -f "$dir/.write-test"
done

# A setup-token is valid for one year and expires with no warning: Claude Code's
# "login expires in 3 days" notice fires only for an interactive /login, not for
# CLAUDE_CODE_OAUTH_TOKEN. Without this the first symptom is a brief that
# silently stops arriving. Set CLAUDE_TOKEN_ISSUED=YYYY-MM-DD to get a month's
# notice; leave it unset to skip the check. One token serves both agents, so
# this warning covers both.
if [ -n "${CLAUDE_TOKEN_ISSUED:-}" ]; then
  IFS=- read -r _ty _tm _td <<< "$CLAUDE_TOKEN_ISSUED"
  _wy=$((10#$_ty + 1)); _wm=$((10#$_tm - 1))
  # if/fi, not `[ ... ] && { ... }`: under `set -e` the one-liner form aborts
  # the entire run for the eleven months of the year when the test is false.
  if [ "$_wm" -eq 0 ]; then _wm=12; _wy=$((_wy - 1)); fi
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

log "starting $AGENT for $DATE (model=$MODEL effort=$EFFORT turns=$MAX_TURNS tz=$TZ)"

# The system prompt is three parts: the agent's prompt.md, the shared time
# facts derived from TZ, and the agent's own framing on top. That last part is
# why context is split — the morning briefing gets a session-close countdown
# and this one deliberately does not. See agents/*/context.mjs.
#
# Fatal on failure rather than falling back to prompt.md alone: without these
# blocks the agent has no date at all, and would date the brief by guess.
SYSTEM_PROMPT="$(mktemp)"
trap 'rm -f "$SYSTEM_PROMPT"' EXIT
cat "$PROMPT_FILE" > "$SYSTEM_PROMPT"
if ! AGENT="$AGENT" node lib/context.mjs >> "$SYSTEM_PROMPT"; then
  log "FAILED: could not build the shared time context (node lib/context.mjs)"
  exit 1
fi
if [ -f "$AGENT_CONTEXT" ]; then
  if ! AGENT="$AGENT" AGENT_ARCHIVE="$ARCHIVE_DIR" node "$AGENT_CONTEXT" >> "$SYSTEM_PROMPT"; then
    log "FAILED: could not build the agent time context (node $AGENT_CONTEXT)"
    exit 1
  fi
fi

# --allowedTools deliberately excludes Bash. These agents read untrusted web
# content; delivery is handled below by this script instead, so a prompt
# injection in a news article has no shell to reach for.
#
# --bare is deliberately NOT used. It would ignore the subscription OAuth token
# and fall back to ANTHROPIC_API_KEY billing, and it strips WebSearch/WebFetch
# from the toolset, which is the entire job.
CLAUDE_ARGS=(
  -p "Produce today's brief."
  --append-system-prompt-file "$SYSTEM_PROMPT"
  --allowedTools "WebSearch,WebFetch,Read,Write,Glob"
  --model "$MODEL"
  --effort "$EFFORT"
  --max-turns "$MAX_TURNS"
)

LOG_FILE="$LOG_DIR/$DATE.json"

if [ "$STREAM" = "1" ]; then
  # Local tuning: show the run as it happens so you can see which searches it
  # runs and kill it early if it goes down a rabbit hole. The log file gets the
  # same content as a normal run, one JSON object per line instead of one blob.
  log "streaming (${PREFIX}_STREAM=1)"
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

if [ ! -s "$ARCHIVE_DIR/$DATE.md" ]; then
  log "FAILED: no brief at $ARCHIVE_DIR/$DATE.md"
  log "last result: $(log_field result | head -c 500)"
  exit 1
fi

if command -v jq >/dev/null 2>&1; then
  log "cost: $(log_field total_cost_usd) USD (subscription runs bill no tokens)"
fi

if [ -z "${RESEND_API_KEY:-}" ]; then
  log "RESEND_API_KEY unset — brief written to $ARCHIVE_DIR/$DATE.md, not emailed"
  exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
  log "jq not installed — brief written to $ARCHIVE_DIR/$DATE.md, not emailed"
  exit 1
fi

# Checked here rather than left to curl: Resend rejects an empty `from` with a
# 422 that -fsS reduces to a bare non-zero exit, so an unset GitHub Variable
# would look like a delivery outage rather than a missing config value.
if [ -z "${MAIL_FROM:-}" ] || [ -z "$MAIL_TO" ]; then
  log "FAILED: brief written to $ARCHIVE_DIR/$DATE.md but not emailed —"
  log "FAILED: MAIL_FROM/${PREFIX}_MAIL_TO/MAIL_TO is empty. Set the GitHub Variables and redeploy."
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
if ! HTML_BODY="$(node lib/to_html.mjs "$ARCHIVE_DIR/$DATE.md")"; then
  HTML_BODY=""
  log "WARNING: HTML render failed — sending plain text only (npm ci?)"
fi

jq -n \
  --arg from "$MAIL_FROM" \
  --arg to "$MAIL_TO" \
  --arg subject "$LABEL — $DATE" \
  --arg text "$(cat "$ARCHIVE_DIR/$DATE.md")" \
  --arg html "$HTML_BODY" \
  '{from: $from, to: [$to], subject: $subject, text: $text}
   + (if $html == "" then {} else {html: $html} end)' \
| curl -fsS https://api.resend.com/emails \
    -H "Authorization: Bearer $RESEND_API_KEY" \
    -H "Content-Type: application/json" \
    --data @- > /dev/null

log "emailed $MAIL_TO"
