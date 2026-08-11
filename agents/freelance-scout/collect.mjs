// Collect today's candidate projects into data/freelance-scout/inbox/<date>.json.
//
//   node agents/freelance-scout/collect.mjs
//   node agents/freelance-scout/collect.mjs --no-session   # ignore any login
//
// No model runs here, and that is the point rather than an optimisation.
// Everything this script reads is text written by strangers — project titles
// and descriptions, posted by anyone with a freelancermap account. lib/run.sh
// already withholds Bash from the two existing agents for exactly this reason.
// This agent raises the stakes, because later in the same pipeline there is a
// logged-in session that can send messages. So collection is deterministic:
// the model receives this file as data and never fetches anything itself, and
// the worst a hostile posting can do is argue its own case badly.
//
// Runs logged out by default. The public search payload carries everything the
// matcher needs, so the session — the one credential in this system — is not
// touched until something is actually being submitted.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FmClient, requirePayload } from "../../lib/fm-client.mjs";
import {
  RESULTS_PER_PAGE,
  MAX_PROJECT_AGE_DAYS,
  EXCLUDED_COMPANIES,
  DEALBREAKER_KEYWORDS,
  MIN_REMOTE_PERCENT,
} from "./config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..", "..");
const DATA = join(APP, "data", "freelance-scout");
const SEEN_FILE = join(DATA, "seen.json");

const noSession = process.argv.includes("--no-session");

// Local date, in TZ, matching how every other agent names its files. See the
// note in lib/context.mjs on why this is Intl rather than `date`.
function today() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.TZ || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return parts; // en-CA formats as YYYY-MM-DD
}

// The searches are URLs copied out of the freelancermap UI, so this pulls any
// line that looks like one and ignores everything else — the file is meant to
// be readable, with headings and notes around each URL explaining its intent.
//
// Nothing here interprets the query string. That is the whole design: the
// site's own filter form authored these parameters, so whatever the UI can
// express, this replays exactly. A filter that stops working is fixed by
// pasting a fresh URL, never by editing this file.
export function parseSearches(markdown) {
  const urls = [];
  for (const line of markdown.split("\n")) {
    if (line.trim().startsWith(">")) continue; // quoted examples, not live searches
    const match = line.match(/https?:\/\/(?:www\.)?freelancermap\.[a-z]+\/projects\?[^\s)>\]]*/i);
    // A query string is required, and that is a real filter rather than
    // pedantry: bare /projects is every project on the site. This file
    // necessarily contains prose about freelancermap.com/projects, and without
    // the `?` a sentence pointing at the search page becomes an unfiltered
    // search that quietly floods the inbox.
    if (match) urls.push(match[0]);
  }
  return [...new Set(urls)];
}

// Newest first is what makes a first-page-only scan sound — see RESULTS_PER_PAGE
// in config.mjs. A search sorted any other way puts an arbitrary 22 projects in
// front of the agent and silently hides the recent ones, so it is corrected
// here rather than left to be noticed in a thin digest weeks later.
function normaliseSort(url) {
  const u = new URL(url);
  const corrected = u.searchParams.get("sort") !== "1";
  u.searchParams.set("sort", "1");
  return { url: u.toString(), corrected };
}

// One search result carries a 1024-float `embedding`, the site's own matching
// vector, plus `translations` and a `matching` block. Keeping them would add
// roughly 20KB of noise per project to a file whose entire purpose is to be
// read by a model, so the record is narrowed to what actually decides a match.
function toRecord(raw) {
  const remote = raw.projectContractType?.remoteInPercent ?? null;
  return {
    id: raw.id,
    title: raw.title,
    url: raw.links?.project ? `https://www.freelancermap.com${raw.links.project}` : null,
    company: raw.company || [raw.firstName, raw.lastName].filter(Boolean).join(" ") || null,
    isEndCustomer: raw.endcustomer ?? false,
    country: raw.country?.name ?? null,
    city: raw.city ?? null,
    remotePercent: remote,
    contractType: raw.projectContractType?.type ?? raw.contractType ?? null,
    startsText: raw.beginningText || [raw.beginningMonth, raw.beginningYear].filter(Boolean).join("/") || null,
    durationText: raw.durationText ?? (raw.duration ? `${raw.duration} months` : null),
    extensionPossible: Boolean(raw.verlaengerung),
    budget: raw.budget ?? null,
    industry: raw.industry ?? null,
    skills: Array.isArray(raw.skills) ? raw.skills : [],
    created: raw.created ?? null,
    expires: raw.expires ? new Date(raw.expires * 1000).toISOString() : null,
    description: raw.description ?? "",
  };
}

// The exact exclusions, applied before anything reaches a model. Each returns
// a reason rather than a boolean so a surprisingly empty inbox can be explained
// from the run log instead of guessed at — "42 collected, 39 dropped: 31 too
// old" is a debuggable line, "3 projects" is not.
function rejectionReason(record) {
  const haystack = `${record.title}\n${record.description}`.toLowerCase();

  const company = (record.company ?? "").toLowerCase();
  if (EXCLUDED_COMPANIES.some((c) => company.includes(c.toLowerCase()))) return "excluded company";

  const hit = DEALBREAKER_KEYWORDS.find((k) => haystack.includes(k.toLowerCase()));
  if (hit) return `dealbreaker keyword: ${hit}`;

  // Only when the site actually reports a figure. A null means the poster did
  // not say, which is a question for the matcher, not grounds for dropping.
  if (MIN_REMOTE_PERCENT > 0 && record.remotePercent !== null && record.remotePercent < MIN_REMOTE_PERCENT) {
    return `remote ${record.remotePercent}% < ${MIN_REMOTE_PERCENT}%`;
  }

  if (record.expires && new Date(record.expires) < new Date()) return "already expired";

  if (record.created) {
    const age = (Date.now() - new Date(record.created).getTime()) / 86400000;
    if (age > MAX_PROJECT_AGE_DAYS) return `posted ${Math.round(age)} days ago`;
  }

  return null;
}

function loadSeen() {
  try {
    return new Set(JSON.parse(readFileSync(SEEN_FILE, "utf8")).ids);
  } catch {
    return new Set();
  }
}

export async function collect({ log = console.error } = {}) {
  const searchesFile = join(HERE, "searches.md");
  const searches = parseSearches(readFileSync(searchesFile, "utf8"));

  if (searches.length === 0) {
    throw new Error(
      `no search URLs in ${searchesFile}. Build a search in the freelancermap UI, ` +
        `copy the address bar, and paste it in.`,
    );
  }

  const sessionFile = join(APP, "data", "state", "fm-session.json");
  const client = noSession ? new FmClient() : FmClient.fromSessionFile(sessionFile);

  const seen = loadSeen();
  const coldStart = seen.size === 0;
  const stats = { fetched: 0, alreadySeen: 0, rejected: {} };
  const warnings = [];
  const byId = new Map();

  for (const search of searches) {
    const { url, corrected } = normaliseSort(search);
    if (corrected) log(`collect: WARNING forced sort=1 (newest first) on ${search}`);

    const payload = requirePayload(await client.getHtml(url), "ProjectSearch");
    const results = payload.initialResults ?? [];

    let unseenOnPage = 0;

    for (const raw of results) {
      stats.fetched++;
      const record = toRecord(raw);

      if (seen.has(record.id) || byId.has(record.id)) {
        stats.alreadySeen++;
        continue;
      }
      unseenOnPage++;

      const reason = rejectionReason(record);
      if (reason) {
        stats.rejected[reason] = (stats.rejected[reason] ?? 0) + 1;
        // Recorded as seen anyway: a project rejected for being too old or for
        // naming a dealbreaker will be rejected for the same reason tomorrow,
        // and re-deciding it every day costs a fetch and a log line forever.
        seen.add(record.id);
        continue;
      }

      byId.set(record.id, record);
    }

    // Only one page is available (see RESULTS_PER_PAGE), so a full page of
    // projects the agent has never seen means the search almost certainly has
    // more behind it that cannot be reached. Silence here would look exactly
    // like a quiet day, which is why it is surfaced to the digest and not only
    // to the log.
    //
    // Skipped on a cold start, where every result is new by definition and the
    // warning would fire for every search on the first morning — which is how
    // a signal worth heeding gets learned as noise.
    if (!coldStart && results.length >= RESULTS_PER_PAGE && unseenOnPage === results.length) {
      const warning =
        `every one of the ${results.length} results on the only reachable page was new, ` +
        `so this search is probably truncated — narrow it: ${url}`;
      warnings.push(warning);
      log(`collect: WARNING ${warning}`);
    }
  }

  const candidates = [...byId.values()].sort((a, b) => (b.created ?? "").localeCompare(a.created ?? ""));

  const rejectedSummary = Object.entries(stats.rejected)
    .map(([reason, n]) => `${n} ${reason}`)
    .join(", ");
  log(
    `collect: ${stats.fetched} results from ${searches.length} search(es) — ` +
      `${candidates.length} new candidates, ${stats.alreadySeen} already seen` +
      (rejectedSummary ? `, dropped: ${rejectedSummary}` : ""),
  );

  return { candidates, seen, stats, warnings };
}

// `node collect.mjs` writes the inbox; importing it does not. Same convention
// as lib/context.mjs.
if (import.meta.url === `file://${process.argv[1]}`) {
  const date = today();
  const { candidates, seen, warnings } = await collect();

  mkdirSync(join(DATA, "inbox"), { recursive: true });
  writeFileSync(
    join(DATA, "inbox", `${date}.json`),
    JSON.stringify({ date, collected: new Date().toISOString(), warnings, candidates }, null, 2),
  );

  // Everything that reached the inbox counts as seen from here on. Without
  // this, a project the model scored and applied to on Monday is collected
  // again on Tuesday, scored again, and applied to again — the duplicate
  // application being the part that reaches a recruiter.
  //
  // Written strictly after the inbox, and the order is the safety property: a
  // crash in between leaves projects collected but not marked, so tomorrow
  // re-collects them. The opposite order would mark them seen and lose them
  // before anything had scored them.
  for (const candidate of candidates) seen.add(candidate.id);
  writeFileSync(SEEN_FILE, JSON.stringify({ updated: new Date().toISOString(), ids: [...seen] }, null, 2));

  console.error(`collect: wrote ${candidates.length} candidates to data/freelance-scout/inbox/${date}.json`);
}
