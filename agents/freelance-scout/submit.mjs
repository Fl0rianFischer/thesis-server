// Submit the applications the model queued, subject to the limits in config.mjs.
//
//   node agents/freelance-scout/submit.mjs
//   node agents/freelance-scout/submit.mjs --date 2026-08-11
//
// This is the only script in the project that sends anything to another person,
// and it is deliberately the dumbest. It reads one file, applies three numeric
// rules, and posts. There is no model here and nothing it does depends on the
// content of a project description.
//
// That separation is the security design, not a style preference. The model
// upstream reads text written by strangers; if a posting could talk its way
// into this file's behaviour, a project description could name its own
// recipient or rewrite a letter. It cannot, because everything here comes from
// the outbox, and the outbox only holds fields with fixed meanings.
//
// The limits are enforced here rather than trusted upstream for the same
// reason. The model is told what they are, but a model that miscounts, or a
// prompt edit that loosens the wording, changes nothing about what actually
// gets sent.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { readdirSync } from "node:fs";

import { hydrationPayload } from "../../lib/fm-client.mjs";
import { ensureSession } from "./login.mjs";
import {
  DRY_RUN,
  MIN_SCORE,
  MAX_PER_DAY,
  MAX_PER_MONTH,
  EXCEPTIONAL_SCORE,
  MAX_EXCEPTIONAL_PER_DAY,
  MAX_PROJECT_AGE_HOURS,
} from "./config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..", "..");
const DATA = join(APP, "data", "freelance-scout");

function today() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.TZ || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// Same stem collect.mjs used, so submit reads the outbox this run wrote rather
// than an earlier slot's. See runBase() there.
function runBase(date) {
  const slot = process.env.RUN_SLOT || "";
  return slot ? `${date}-${slot}` : date;
}

// Only the shapes that are actually acted on. A malformed entry is skipped
// with a reason rather than throwing, so one bad record cannot cost the other
// two their day — but it is never silently coerced into something sendable.
function validate(application) {
  if (!Number.isInteger(application?.id)) return "no numeric id";
  // Constructed or rewritten URLs are the thing this check exists for. The
  // model is told to copy the URL from the inbox verbatim; this is what makes
  // that instruction load-bearing rather than advisory.
  //
  // Both the localised path (/projekt/ on the German site, /project/ on the
  // English one) and any freelancermap country domain are accepted, because
  // which one appears depends on which site the search in searches.md points
  // at. The host is matched exactly rather than by `includes`, so
  // `freelancermap.com.evil.test` cannot pass.
  if (typeof application.url !== "string") return "no url";
  let parsed;
  try {
    parsed = new URL(application.url);
  } catch {
    return "url is not parseable";
  }
  if (
    parsed.protocol !== "https:" ||
    !/^www\.freelancermap\.[a-z]{2,3}$/.test(parsed.hostname) ||
    !/^\/(project|projekt)\/.+/.test(parsed.pathname)
  ) {
    return "url is not a freelancermap project link";
  }
  if (typeof application.score !== "number") return "no numeric score";
  if (application.decision !== "send") return `decision is ${JSON.stringify(application.decision)}`;
  if (typeof application.cover_letter !== "string" || application.cover_letter.trim().length < 120) {
    return "cover letter is missing or implausibly short";
  }
  return null;
}

// The application form lives inside the ProjectShow payload, and its endpoint
// is published there rather than being guessed at — see `paths` in the payload.
// Which key carries it can only be confirmed against a logged-in page, so this
// reads the payload and says exactly what it found when it cannot proceed.
function findApplicationRoute(payload) {
  const paths = payload?.paths ?? {};
  const candidates = ["application", "apply", "applicationCreate", "createApplication", "applyPath"];
  for (const key of candidates) {
    if (typeof paths[key] === "string" && paths[key]) return paths[key];
  }
  return null;
}

async function submitOne(client, application, { log }) {
  const html = await client.getHtml(application.url);
  const payload = hydrationPayload(html, "ProjectShow");

  if (!payload) return { status: "failed", detail: "no ProjectShow payload — the URL may be dead" };

  // Re-checked here even though collect.mjs already filtered on age. Collection
  // runs at the start of a run and submission at the end, and the model in
  // between takes minutes — long enough for a posting collected at 23h59 to be
  // over the line by the time anything is sent. Read from the live page rather
  // than the inbox record, so it is the site's own timestamp that decides.
  const created = payload.project?.created;
  if (created) {
    const ageHours = (Date.now() - new Date(created).getTime()) / 3600000;
    if (ageHours > MAX_PROJECT_AGE_HOURS) {
      return {
        status: "skipped",
        detail: `posted ${Math.round(ageHours)}h ago, over the ${MAX_PROJECT_AGE_HOURS}h limit`,
      };
    }
  }
  if (!payload.loggedInUser) return { status: "failed", detail: "session is not authenticated on the project page" };
  if (payload.project?.applicationsPaused) return { status: "skipped", detail: "applications are paused on this project" };
  if (payload.project?.disabled) return { status: "skipped", detail: "the project is no longer active" };

  // Captchas are never solved here, and no solving service is integrated. If
  // the form challenges, the application stops and becomes a link for the
  // reader to finish by hand. This is a deliberate ceiling on the automation,
  // not a bug to be worked around later.
  if (payload.reCaptchaSiteKey) {
    return {
      status: "needs_human",
      detail: "the application form is presenting a captcha — send this one by hand",
    };
  }

  const route = findApplicationRoute(payload);
  if (!route) {
    return {
      status: "needs_human",
      detail:
        `no application endpoint in the page payload (paths: ${Object.keys(payload.paths ?? {}).join(", ") || "none"}). ` +
        "Confirm the key against a logged-in project page and update findApplicationRoute().",
    };
  }

  const response = await client.request(route, {
    method: "POST",
    body: new URLSearchParams({
      projectId: String(application.id),
      message: application.cover_letter,
    }).toString(),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Requested-With": "XMLHttpRequest",
      Referer: application.url,
    },
  });

  if (response.status >= 200 && response.status < 400) {
    return { status: "sent", detail: `HTTP ${response.status}` };
  }
  return { status: "failed", detail: `HTTP ${response.status}` };
}

// How many applications have already gone out this calendar month, counted
// from the outbox files themselves rather than from a counter.
//
// A counter would be a second source of truth that drifts: deleting an outbox
// file, or restoring the data directory from a backup, would leave it claiming
// a budget that was never spent. The outbox files *are* the record — one per
// day, each carrying the outcome of every application in it — so counting them
// cannot disagree with what happened.
//
// Only `sent` counts. Dry runs, skips and failures cost nothing at the platform.
export function monthlySpend(month, dir = join(DATA, "outbox")) {
  let spent = 0;
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.startsWith(month) && f.endsWith(".json"));
  } catch {
    return 0;
  }
  for (const file of files) {
    try {
      const { results = [] } = JSON.parse(readFileSync(join(dir, file), "utf8"));
      spent += results.filter((r) => r.result === "sent").length;
    } catch {
      // A malformed outbox file is not worth failing the run over, but it does
      // mean the count is low — say so rather than silently under-counting a
      // budget that cannot be exceeded safely.
      console.error(`submit: WARNING could not read ${file} while counting this month's applications`);
    }
  }
  return spent;
}

export async function submit({ date = today(), log = console.error } = {}) {
  const outboxPath = join(DATA, "outbox", `${runBase(date)}.json`);

  let outbox;
  try {
    outbox = JSON.parse(readFileSync(outboxPath, "utf8"));
  } catch {
    log(`submit: no outbox at ${outboxPath} — nothing to do`);
    return { sent: 0, results: [] };
  }

  const queued = Array.isArray(outbox.applications) ? outbox.applications : [];
  const results = [];

  // Ordered by score so that when the cap bites it keeps the best, not
  // whichever the model happened to list first.
  const eligible = [];
  for (const application of queued) {
    const problem = validate(application);
    if (problem) {
      results.push({ ...application, result: "skipped", detail: problem });
      continue;
    }
    if (application.score < MIN_SCORE) {
      results.push({ ...application, result: "skipped", detail: `score ${application.score} < ${MIN_SCORE}` });
      continue;
    }
    eligible.push(application);
  }
  eligible.sort((a, b) => b.score - a.score);

  // Two daily budgets, then one absolute monthly one.
  //
  // A 10 draws on its own allowance rather than the ordinary daily cap, so a
  // perfect project is never dropped for having arrived on the same morning as
  // another one. Everything below 10 still competes for MAX_PER_DAY.
  const exceptional = eligible.filter((a) => a.score >= EXCEPTIONAL_SCORE);
  const ordinary = eligible.filter((a) => a.score < EXCEPTIONAL_SCORE);

  const dayAllowed = [
    ...exceptional.slice(0, MAX_EXCEPTIONAL_PER_DAY),
    ...ordinary.slice(0, MAX_PER_DAY),
  ].sort((a, b) => b.score - a.score);

  const overDaily = [
    ...exceptional.slice(MAX_EXCEPTIONAL_PER_DAY),
    ...ordinary.slice(MAX_PER_DAY),
  ];
  for (const application of overDaily) {
    results.push({
      ...application,
      result: "skipped",
      detail:
        application.score >= EXCEPTIONAL_SCORE
          ? `over the daily cap of ${MAX_EXCEPTIONAL_PER_DAY} exceptional applications`
          : `over the daily cap of ${MAX_PER_DAY}`,
    });
  }

  // The monthly allowance is the platform's own limit, so nothing overrides it
  // — not a 10, not anything. Applied last, and to the day's list already
  // sorted best-first, so a tight budget is spent on the strongest project
  // rather than on whichever came back first.
  const spent = monthlySpend(date.slice(0, 7));
  const remaining = Math.max(0, MAX_PER_MONTH - spent);

  if (remaining === 0) {
    log(`submit: this month's allowance is spent (${spent}/${MAX_PER_MONTH}) — nothing will be sent`);
  } else if (spent > 0) {
    log(`submit: ${spent} of ${MAX_PER_MONTH} applications used this month, ${remaining} left`);
  }

  for (const application of dayAllowed.slice(remaining)) {
    results.push({
      ...application,
      result: "skipped",
      detail:
        remaining === 0
          ? `this month's allowance of ${MAX_PER_MONTH} is spent`
          : `only ${remaining} of this month's ${MAX_PER_MONTH} applications remain`,
    });
  }

  const toSend = dayAllowed.slice(0, remaining);

  if (DRY_RUN) {
    for (const application of toSend) {
      results.push({ ...application, result: "dry_run", detail: "DRY_RUN is on in config.mjs — not sent" });
      log(`submit: DRY RUN would send ${application.score}/10 — ${application.title} (${application.company})`);
    }
    log(`submit: dry run, ${toSend.length} would have been sent, 0 actually sent`);
    writeFileSync(outboxPath, JSON.stringify({ ...outbox, submitted: new Date().toISOString(), results }, null, 2));
    return { sent: 0, results };
  }

  if (toSend.length === 0) {
    log("submit: nothing cleared the threshold");
    writeFileSync(outboxPath, JSON.stringify({ ...outbox, submitted: new Date().toISOString(), results }, null, 2));
    return { sent: 0, results };
  }

  // The session is only touched once something is genuinely being sent. On a
  // quiet morning — which should be most of them — no credential is used at all.
  const client = await ensureSession({ log });

  let sent = 0;
  for (const application of toSend) {
    let outcome;
    try {
      outcome = await submitOne(client, application, { log });
    } catch (error) {
      outcome = { status: "failed", detail: error.message };
    }
    if (outcome.status === "sent") sent++;
    results.push({ ...application, result: outcome.status, detail: outcome.detail });
    log(`submit: ${outcome.status} — ${application.title} (${application.company}): ${outcome.detail}`);
  }

  log(`submit: ${sent} of ${toSend.length} sent`);
  writeFileSync(outboxPath, JSON.stringify({ ...outbox, submitted: new Date().toISOString(), results }, null, 2));
  return { sent, results };
}

// The digest is written by the model *before* anything is submitted, so on its
// own it can only ever describe an intention. This block is what run.sh appends
// to the archive before mailing it, so the mail states what actually happened —
// including the cases where the intention and the outcome differ, which are
// exactly the ones worth knowing about.
export function report(results) {
  if (results.length === 0) return "";

  const lines = ["", "---", "", "## Delivery", ""];
  const label = {
    sent: "Sent",
    dry_run: "Not sent — dry run",
    needs_human: "Needs you",
    failed: "Failed",
    skipped: "Skipped",
  };

  // Anything the reader might act on first; skipped entries are bookkeeping.
  const order = ["sent", "needs_human", "failed", "dry_run", "skipped"];
  for (const status of order) {
    for (const r of results.filter((x) => x.result === status)) {
      lines.push(`- **${label[status] ?? status}** — [${r.title}](${r.url}) (${r.company}): ${r.detail}`);
    }
  }

  if (DRY_RUN) {
    lines.push(
      "",
      "_Dry run: `DRY_RUN` is `true` in `agents/freelance-scout/config.mjs`. " +
        "Nothing above was sent to anyone._",
    );
  }
  lines.push("");
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const flag = process.argv.indexOf("--date");
  const date = flag > -1 ? process.argv[flag + 1] : today();
  try {
    const { results } = await submit({ date });
    // stdout is the report, stderr is the log — so run.sh can append one to
    // the digest without the other leaking into the email.
    process.stdout.write(report(results));
  } catch (error) {
    console.error(`submit: FAILED — ${error.message}`);
    process.exit(1);
  }
}
