// What this agent is allowed to do, as constants rather than as environment
// variables.
//
// This agent adds no GitHub Variables at all. Its schedule, model and turn
// budget are the per-agent defaults in tick.sh and lib/run.sh, alongside the
// other two agents' — with nothing set in the environment, those defaults are
// simply what runs. Changing the hour is an edit to tick.sh; there is no
// settings page to keep in sync, and no name that can go missing from the
// deploy's variable list and be silently empty on the box.
//
// What lives here instead is the part that has nothing to do with scheduling:
// whether anything is sent, to whom, and how much. Changing one of these is an
// edit, a commit and a deploy — the same path as changing a prompt, with a diff
// and a date attached. That is deliberate for values that decide whether
// messages go to strangers on your behalf.
//
// The two freelancermap credentials are the deliberate exception and stay in
// the environment as GitHub secrets: this file is committed, and a password in
// git is a password you have published.

// ---------------------------------------------------------------------------
// The submission gate
// ---------------------------------------------------------------------------

// Nothing is ever sent while this is true. The agent still collects, still
// scores, and still mails you the full digest including every cover letter it
// would have sent — so a dry run tells you exactly what a live run would do.
//
// Leave this on until the scores have matched your own judgement for a couple
// of weeks. An application cannot be withdrawn once it is sent, and the failure
// you are watching for is not a crash: it is the agent confidently scoring 9
// something you would never have applied to.
export const DRY_RUN = true;

// The floor for sending. Anything below appears in the digest as a suggestion
// with its letter attached, and is never submitted.
export const MIN_SCORE = 8;

// A hard cap per run, enforced by submit.mjs regardless of how many projects
// clear MIN_SCORE. This is the backstop for the scoring going wrong in the
// direction that costs the most: a bug or a prompt change that suddenly rates
// everything a 9 gets you three unwanted applications, not forty.
export const MAX_PER_DAY = 3;

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

// Each search returns its first page only — 22 projects, newest first.
//
// This is a constraint of the site, not a choice. freelancermap renders only
// page one server-side; `pagenr=2` is ignored even when the full canonical
// parameter set from the site's own paginator is replayed verbatim, and the
// anchors in that paginator exist for crawlers. Pages beyond the first are
// fetched by the front end through a request that is not reachable without
// executing its JavaScript.
//
// For a daily run this is close to irrelevant, and measurably so: page one of a
// deliberately broad "python" search held three projects newer than
// MAX_PROJECT_AGE_DAYS. A narrow search producing more than 22 genuinely new
// projects in 24 hours is rare.
//
// The failure that matters is not the cap — it is not noticing the cap. So
// collect.mjs warns when a page comes back entirely new, which is the signature
// of a search whose tail is being silently truncated. The fix is a narrower
// search, which is the same advice searches.md already gives for other reasons.
export const RESULTS_PER_PAGE = 22;

// Projects created more than this many days ago are skipped even if a search
// returns them. The first run of a new search would otherwise sweep up months
// of backlog and score all of it.
export const MAX_PROJECT_AGE_DAYS = 14;

// ---------------------------------------------------------------------------
// Deterministic filters
// ---------------------------------------------------------------------------
//
// These are the exclusions that need no judgement, applied before a model ever
// sees the project — they cost nothing and they are exact. Anything requiring
// judgement ("is this seniority right", "is this stack close enough") belongs
// in prompt.md and cv.md instead, where a model can weigh it.

// Matched case-insensitively against the company name. Agencies you have had a
// bad experience with, recruiters who repost the same role weekly, your own
// current client.
export const EXCLUDED_COMPANIES = [];

// Matched case-insensitively against title and description. A project matching
// any of these is dropped outright. Keep this list to things that are always
// disqualifying regardless of the rest of the posting.
export const DEALBREAKER_KEYWORDS = [];

// Dropped unless the project is at least this remote. freelancermap reports
// this as projectContractType.remoteInPercent. Set to 0 to disable.
export const MIN_REMOTE_PERCENT = 0;
