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
  MAX_PROJECT_AGE_HOURS,
  EXCLUDED_COMPANIES,
  DEALBREAKER_KEYWORDS,
  PUBLIC_SECTOR_KEYWORDS,
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

// The stem every file of one run shares: the date, plus the slot when the agent
// runs more than once a day. tick.sh sets RUN_SLOT.
//
// The outbox in particular must carry it. Two runs a day writing one
// outbox/<date>.json would have the evening overwrite the morning, and since
// the monthly allowance is counted from those files, a morning application
// would vanish from the count and the month could be overspent.
export function runBase(date = today()) {
  const slot = process.env.RUN_SLOT || "";
  return slot ? `${date}-${slot}` : date;
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
    // Both spellings of the search path. The German site uses /projekte and the
    // English one /projects, and they are the same search over the same data —
    // a URL copied from freelancermap.de would otherwise be silently ignored,
    // leaving a configured search that simply never runs.
    const match = line.match(/https?:\/\/(?:www\.)?freelancermap\.[a-z]+\/(?:projects|projekte)\?[^\s)>\]]*/i);
    // A query string is required, and that is a real filter rather than
    // pedantry: the bare path is every project on the site. This file
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
// `origin` is the host of the search that produced this record, and it has to
// be, because freelancermap localises the project path: a search on
// freelancermap.de returns links like /projekt/<slug>, and the .com site
// returns /project/<slug>. The two are not interchangeable — .com/projekt/…
// is a 404. Hardcoding either origin produces links that look right in the
// digest and are dead when clicked, and an outbox full of URLs that
// submit.mjs correctly refuses.
function toRecord(raw, origin) {
  const remote = raw.projectContractType?.remoteInPercent ?? null;
  return {
    id: raw.id,
    title: raw.title,
    url: raw.links?.project ? `${origin}${raw.links.project}` : null,
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
  const company = (record.company ?? "").toLowerCase();
  if (EXCLUDED_COMPANIES.some((c) => company.includes(c.toLowerCase()))) return "excluded company";

  // Title only — see the note on DEALBREAKER_KEYWORDS in config.mjs. Matching
  // the description would drop good frontend postings that merely mention
  // testing, which is a listed strength rather than a dealbreaker.
  const title = record.title.toLowerCase();
  const hit = DEALBREAKER_KEYWORDS.find((k) => title.includes(k.toLowerCase()));
  if (hit) return `dealbreaker keyword: ${hit}`;

  // Public sector, which cv.md rules out. Title and description both, because
  // the client is usually named in the body rather than the title.
  const body = `${record.title}\n${record.description}`.toLowerCase();
  const publicSector = PUBLIC_SECTOR_KEYWORDS.find((k) => body.includes(k.toLowerCase()));
  if (publicSector) return `public sector: ${publicSector}`;

  // Only when the site actually reports a figure. A null means the poster did
  // not say, which is a question for the matcher, not grounds for dropping.
  if (MIN_REMOTE_PERCENT > 0 && record.remotePercent !== null && record.remotePercent < MIN_REMOTE_PERCENT) {
    return `remote ${record.remotePercent}% < ${MIN_REMOTE_PERCENT}%`;
  }

  if (record.expires && new Date(record.expires) < new Date()) return "already expired";

  if (record.created) {
    const ageHours = (Date.now() - new Date(record.created).getTime()) / 3600000;
    if (ageHours > MAX_PROJECT_AGE_HOURS) {
      // Bucketed rather than exact, so the run log reads "6 posted over 24h
      // ago" instead of six separate lines differing by minutes.
      return `posted over ${MAX_PROJECT_AGE_HOURS}h ago`;
    }
  }

  return null;
}

// --------------------------------------------------------------------------
// Near-duplicate detection
// --------------------------------------------------------------------------
//
// The same underlying project is routinely posted several times on one morning
// by different agencies, all shopping the same client brief. They are not
// caught by the id check — different postings, different ids — and left alone
// they cost twice over: the model scores the same work repeatedly, and with a
// submission budget measured in applications per month, two applications to
// one project is a wasted one.
//
// Compared on the description rather than the title, because the title is
// where recruiters differ most (and where the typos are — one real pair
// differed only by "Python" versus "Phyton"). Measured on live data, a true
// duplicate pair scored 0.57 while the nearest unrelated pair scored 0.38, so
// the threshold sits in that gap. Three genuinely different Angular roles from
// the same agency scored 0.36 and stay separate, which is the case that
// matters: merging distinct projects would silently hide one.
const DUPLICATE_DESCRIPTION = 0.5;
const DUPLICATE_TITLE = 0.75;
const SHORT_DESCRIPTION_TOKENS = 25;

function tokenSet(text) {
  return new Set(
    (text || "")
      .toLowerCase()
      .replace(/[^a-z0-9äöüß]+/gi, " ")
      .split(/\s+/)
      // Short words are shared by every German job posting ("und", "mit",
      // "wir") and only push unrelated pairs together.
      .filter((word) => word.length >= 4),
  );
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

function isDuplicate(a, b) {
  const titleScore = jaccard(a._title, b._title);
  // A very short description carries too few tokens for the similarity to mean
  // anything, so the title has to carry the decision on its own.
  if (a._desc.size < SHORT_DESCRIPTION_TOKENS || b._desc.size < SHORT_DESCRIPTION_TOKENS) {
    return titleScore >= DUPLICATE_TITLE;
  }
  return jaccard(a._desc, b._desc) >= DUPLICATE_DESCRIPTION || titleScore >= DUPLICATE_TITLE;
}

// Groups near-identical records and returns one representative each, with the
// others attached as `alsoPostedBy`. That list is not bookkeeping — a brief
// being shopped by four agencies at once is worth knowing before applying, and
// the digest says so.
export function dedupe(records) {
  const prepared = records.map((r) => ({
    ...r,
    _desc: tokenSet(r.description),
    _title: tokenSet(r.title),
  }));

  const kept = [];
  const merged = [];

  for (const record of prepared) {
    const match = kept.find((k) => isDuplicate(k, record));
    if (!match) {
      kept.push(record);
      continue;
    }

    // Prefer the end customer over an agency — applying direct is worth more
    // than applying through a middleman for the same work. Failing that, the
    // earliest posting, which is most likely the original.
    const incumbentIsBetter =
      match.isEndCustomer !== record.isEndCustomer
        ? match.isEndCustomer
        : (match.created ?? "") <= (record.created ?? "");

    const winner = incumbentIsBetter ? match : record;
    const loser = incumbentIsBetter ? record : match;

    if (!incumbentIsBetter) kept[kept.indexOf(match)] = record;

    winner.alsoPostedBy = [
      ...(winner.alsoPostedBy ?? []),
      ...(loser.alsoPostedBy ?? []),
      { company: loser.company, url: loser.url, id: loser.id },
    ];
    merged.push(loser.id);
  }

  // The private token sets never reach the inbox file — they would double its
  // size and mean nothing to a reader.
  const clean = kept.map(({ _desc, _title, ...rest }) => rest);
  return { candidates: clean, mergedIds: merged };
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
    const origin = new URL(url).origin;

    let unseenOnPage = 0;

    for (const raw of results) {
      stats.fetched++;
      const record = toRecord(raw, origin);

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

  const { candidates: deduped, mergedIds } = dedupe([...byId.values()]);
  const candidates = deduped.sort((a, b) => (b.created ?? "").localeCompare(a.created ?? ""));

  // Merged postings are marked seen so the same brief under a different
  // agency's name does not come back tomorrow as something new.
  for (const id of mergedIds) seen.add(id);
  if (mergedIds.length > 0) {
    log(`collect: merged ${mergedIds.length} duplicate posting(s) of projects already in today's list`);
  }

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
  const base = runBase(date);
  const { candidates, seen, warnings } = await collect();

  mkdirSync(join(DATA, "inbox"), { recursive: true });
  writeFileSync(
    join(DATA, "inbox", `${base}.json`),
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

  console.error(`collect: wrote ${candidates.length} candidates to data/freelance-scout/inbox/${base}.json`);
}
