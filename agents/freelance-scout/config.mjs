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
export const DRY_RUN = false;

// The floor for sending. Anything below appears in the digest as a suggestion
// with its letter attached, and is never submitted.
//
// 9 rather than 8 because the freelancermap plan allows only ten applications
// a month. When applications are scarce the question stops being "is this a
// good fit" and becomes "is this one of the ten best things I will see this
// month" — and an 8, by the definition in prompt.md, is a fit with a known gap.
// Those are worth reading about in the digest and applying to by hand if you
// disagree; they are not worth spending a tenth of the budget on unprompted.
export const MIN_SCORE = 9;

// A hard cap per run, enforced by submit.mjs regardless of how many projects
// clear MIN_SCORE. This is the backstop for the scoring going wrong in the
// direction that costs the most: a bug or a prompt change that suddenly rates
// everything a 9 spends one application, not the whole month's budget.
export const MAX_PER_DAY = 1;

// A 10 does not count against MAX_PER_DAY.
//
// The daily cap exists to ration a scarce budget across a month, but rationing
// has a failure mode of its own: two genuinely perfect projects landing on the
// same morning, and one of them being dropped for arriving second. A 10 is
// defined in prompt.md as leaving nothing to argue about, and those are rare
// enough — none at all in the sample days used to build this — that letting
// them through is cheaper than missing one.
export const EXCEPTIONAL_SCORE = 10;

// But bounded, because "rare" is an assumption about the scoring rather than a
// guarantee. If a prompt change ever starts handing out tens freely, this is
// what keeps a single morning from spending the month.
export const MAX_EXCEPTIONAL_PER_DAY = 2;

// The real constraint. The freelancermap plan allows ten applications a month,
// and MAX_PER_DAY alone does not protect it: one a day across twenty-two
// working days is twenty-two applications, more than twice the allowance.
//
// Eight rather than ten deliberately. Applications you send by hand come out of
// the same platform allowance and are invisible to this agent, so the gap is
// the headroom that keeps the agent from consuming a budget you were also
// spending yourself — and keeps a genuinely excellent project on the 28th from
// finding the month already spent.
//
// Counted from the outbox files of the current calendar month; see
// monthlySpend() in submit.mjs.
export const MAX_PER_MONTH = 8;

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

// Projects older than this are skipped even if a search returns them.
//
// Hours rather than days because 24 is the point: on freelancermap the good
// projects are answered within a day, and an application to a three-day-old
// posting arrives after the shortlist is drawn. The agent runs twice daily, so
// a 24-hour window is covered twice over and nothing has to be caught first
// time.
//
// It is enforced twice: collect.mjs drops stale postings before they cost a
// model token, and submit.mjs checks again at send time, because a run that
// starts at 18:00 and finishes at 18:05 can carry a project over the line
// while it works.
export const MAX_PROJECT_AGE_HOURS = 24;

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

// Matched case-insensitively against the **title only**, not the description.
// That distinction is load-bearing: "Playwright" and "Test" appear in the body
// of plenty of good frontend postings — they are strengths in cv.md — and
// matching the description would throw those away. A QA role announces itself
// in its title.
export const DEALBREAKER_KEYWORDS = [
  "quality assurance",
  "qa engineer",
  "qa-engineer",
  "test engineer",
  "testmanager",
  "test manager",
  "testautomatisierer",
  "softwaretester",
  "software tester",
];

// Public sector work, which cv.md rules out. Matched case-insensitively
// against **title and description**, unlike DEALBREAKER_KEYWORDS above — a
// public client is usually named in the body ("für einen öffentlichen
// Auftraggeber"), not in the job title.
//
// Every term is a full phrase or an unambiguous compound, and that is not
// fussiness. Measured against real postings, the obvious short stems are
// unusable: "land" matches Deutschland and Poland, "kommun" matches
// Kommunikation, "amt" matches gesamt. Any of them would have silently deleted
// good projects, and the symptom — a slightly shorter digest — is invisible.
//
// Test any addition the same way before committing it:
//   node -e '...' over data/freelance-scout/inbox/<date>.json
export const PUBLIC_SECTOR_KEYWORDS = [
  "public sector",
  "government agency",
  "öffentlicher dienst",
  "öffentliche verwaltung",
  "öffentlichen sektor",
  "öffentlicher auftraggeber",
  "öffentliche auftraggeber",
  "behörde",
  "behörden",
  "bundesamt",
  "bundesbehörde",
  "bundesministerium",
  "bundeswehr",
  "landesamt",
  "landesbehörde",
  "kommunalverwaltung",
  "evb-it",
  "vergabeverfahren",
];

// Dropped unless the project is at least this remote. freelancermap reports
// this as projectContractType.remoteInPercent.
//
// 100 because cv.md makes remote-only a non-negotiable gate. The searches in
// searches.md already filter to 100% at the URL, so this rarely fires — it is
// the backstop for a search that gets re-copied from the UI one day without
// that filter set, which is exactly the kind of mistake that would otherwise
// take a month to notice.
export const MIN_REMOTE_PERCENT = 100;
