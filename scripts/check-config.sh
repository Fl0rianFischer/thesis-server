#!/usr/bin/env bash
#
# Fail the deploy on configuration that would otherwise produce a green build
# and a silent outage. Runs on the GitHub runner, before anything reaches the
# box.
#
#   ./scripts/check-config.sh
#
# Reads its input from the environment; see the `env:` block of the calling
# step in .github/workflows/deploy.yml. Runnable by hand:
#
#   TZ=Asia/Jakarta MAIL_FROM=a@b.c MAIL_TO=d@e.f \
#   CLAUDE_CODE_OAUTH_TOKEN=x RESEND_API_KEY=y ./scripts/check-config.sh
#
# This exists because the .env heredoc in deploy.sh writes every value
# unconditionally, so an unset variable becomes an empty line rather than an
# error. That is how the first working deploy shipped with MAIL_FROM blank:
# green build, green deploy, and a briefing written every morning and never
# sent. Fail here instead, where it is visible.
#
# There is very little to check now, and that is the point. Everything an agent
# does — its hour, its days, its model, its turn budget, whether it is enabled
# — is a default in tick.sh and lib/run.sh, versioned with the code that reads
# it. What is left here is the handful of values that genuinely cannot live in
# the repo: the deployment's timezone, where mail goes, and the credentials.

set -euo pipefail

missing=()
[ -n "${TZ:-}" ]                      || missing+=("TZ (variable)")
[ -n "${MAIL_FROM:-}" ]               || missing+=("MAIL_FROM (variable)")
[ -n "${MAIL_TO:-}" ]                 || missing+=("MAIL_TO (variable)")
[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] || missing+=("CLAUDE_CODE_OAUTH_TOKEN (secret)")
[ -n "${RESEND_API_KEY:-}" ]          || missing+=("RESEND_API_KEY (secret)")

if [ "${#missing[@]}" -gt 0 ]; then
  echo "::error::Required configuration is empty. Settings -> Secrets and variables -> Actions."
  printf '  missing: %s\n' "${missing[@]}"
  echo "  Note that Secrets and Variables are separate tabs on that page."
  exit 1
fi

# A typo like Asia/Jakata is not an error anywhere downstream — it just
# silently means UTC, and every brief quietly shifts by hours.
if [ ! -f "/usr/share/zoneinfo/$TZ" ]; then
  echo "::error::TZ='$TZ' is not a zone in the tz database (try Asia/Jakarta, Europe/Berlin)."
  exit 1
fi

# The freelance scout is the only agent that sends anything to another person.
# It needs these only once DRY_RUN is turned off in
# agents/freelance-scout/config.mjs, so a missing pair is a warning rather than
# an error — a dry run uses no credentials at all.
#
# Exactly one of the two being set is an error, because that is the failure
# that would otherwise surface as a login rejection at 07:00 and read like a
# wrong password.
if { [ -n "${FM_EMAIL:-}" ] && [ -z "${FM_PASSWORD:-}" ]; } \
   || { [ -z "${FM_EMAIL:-}" ] && [ -n "${FM_PASSWORD:-}" ]; }; then
  echo "::error::Only one of FM_EMAIL/FM_PASSWORD is set — set both or neither."
  exit 1
fi
if [ -z "${FM_EMAIL:-}" ]; then
  echo "::warning::FM_EMAIL/FM_PASSWORD unset — the freelance scout can score and draft, but cannot submit."
fi

[ -n "${CLAUDE_TOKEN_ISSUED:-}" ] \
  || echo "::warning::CLAUDE_TOKEN_ISSUED is unset — the OAuth token expires after a year with no warning."

echo "configuration OK — TZ=$TZ, mail to $MAIL_TO"
echo
echo "Schedules and limits are not configured here. They are per-agent defaults in:"
echo "  tick.sh      enabled, hour, days, max attempts"
echo "  lib/run.sh   model, effort, max turns"
echo "  agents/freelance-scout/config.mjs   whether the scout SENDS anything"
