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

import { hydrationPayload } from "../../lib/fm-client.mjs";
import { ensureSession } from "./login.mjs";
import { DRY_RUN, MIN_SCORE, MAX_PER_DAY } from "./config.mjs";

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

// Only the shapes that are actually acted on. A malformed entry is skipped
// with a reason rather than throwing, so one bad record cannot cost the other
// two their day — but it is never silently coerced into something sendable.
function validate(application) {
  if (!Number.isInteger(application?.id)) return "no numeric id";
  if (typeof application.url !== "string" || !application.url.startsWith("https://www.freelancermap.com/project/")) {
    // Constructed or rewritten URLs are the thing this check exists for. The
    // model is told to copy the URL from the inbox verbatim; this is what makes
    // that instruction load-bearing rather than advisory.
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

export async function submit({ date = today(), log = console.error } = {}) {
  const outboxPath = join(DATA, "outbox", `${date}.json`);

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

  const capped = eligible.slice(MAX_PER_DAY);
  for (const application of capped) {
    results.push({ ...application, result: "skipped", detail: `over the daily cap of ${MAX_PER_DAY}` });
  }

  const toSend = eligible.slice(0, MAX_PER_DAY);

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
