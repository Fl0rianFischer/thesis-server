// Emit the "Right now" block that gets appended to prompt.md at run time.
//
//   node context.mjs            # uses $TZ
//   TZ=Europe/Berlin node context.mjs
//
// prompt.md used to state the reader's timezone in prose — "Jakarta (UTC+7)",
// "11 hours ahead of US Eastern", "tonight" for a session that opens at 21:30
// local. All of that is wrong the moment TZ changes, and wrong silently: the
// briefing still arrives, it just describes someone else's day. So the whole
// time framing is computed here from TZ instead, and TZ is the only place a
// timezone is configured anywhere in this project.
//
// Intl rather than `date`: this also runs on macOS during local prompt tuning,
// where BSD date has no -d and cannot do zone arithmetic at all.

const TZ = process.env.TZ || "UTC";
const MARKET_TZ = "America/New_York";
const OPEN = { h: 9, m: 30 };
const CLOSE = { h: 16, m: 0 };

// Offset of `tz` at a given instant, in ms. Formatting the instant into the
// zone and reading it back as if it were UTC recovers the offset — the one
// primitive everything else here is built from.
function offsetMs(date, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const asUTC = Date.UTC(
    +parts.year,
    +parts.month - 1,
    +parts.day,
    +parts.hour % 24,
    +parts.minute,
    +parts.second,
  );
  // Rounded to the minute: the formatted parts are truncated to whole seconds
  // while getTime() carries milliseconds, and zone offsets are always whole
  // minutes anyway. Without this the offset label reads "UTC+6:59.9988".
  return Math.round((asUTC - date.getTime()) / 60000) * 60000;
}

// Wall-clock time in `tz` -> instant. Applied twice because the offset used to
// interpret the wall clock may itself differ across a DST boundary; the second
// pass settles it.
function instantOf({ y, mo, d, h, mi }, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let ts = guess - offsetMs(new Date(guess), tz);
  const settled = guess - offsetMs(new Date(ts), tz);
  return new Date(settled);
}

function fields(date, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "long",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return {
    y: +parts.year,
    mo: +parts.month,
    d: +parts.day,
    h: +parts.hour % 24,
    mi: +parts.minute,
    weekday: parts.weekday,
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${String(+parts.hour % 24).padStart(2, "0")}:${parts.minute}`,
  };
}

function utcOffsetLabel(date, tz) {
  const mins = offsetMs(date, tz) / 60000;
  const sign = mins < 0 ? "-" : "+";
  const h = Math.floor(Math.abs(mins) / 60);
  const m = Math.abs(mins) % 60;
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}

function addDays({ y, mo, d }, n) {
  const t = new Date(Date.UTC(y, mo - 1, d + n));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function isWeekday({ y, mo, d }) {
  const wd = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return wd >= 1 && wd <= 5;
}

// Weekdays only — US market holidays are not modelled. The agent is told as
// much below, so it can check rather than assume.
function sessionInstant(day, { h, m }) {
  return instantOf({ ...day, h, mi: m }, MARKET_TZ);
}

function lastClose(now) {
  let day = fields(now, MARKET_TZ);
  for (let i = 0; i < 10; i++) {
    const candidate = addDays(day, -i);
    if (!isWeekday(candidate)) continue;
    const at = sessionInstant(candidate, CLOSE);
    if (at <= now) return at;
  }
  return null;
}

function nextOpen(now) {
  let day = fields(now, MARKET_TZ);
  for (let i = 0; i < 10; i++) {
    const candidate = addDays(day, i);
    if (!isWeekday(candidate)) continue;
    const at = sessionInstant(candidate, OPEN);
    if (at > now) return at;
  }
  return null;
}

// The phrase the reader would actually use for this moment. Getting this wrong
// is the visible symptom of a hardcoded timezone: "tonight" for a session that
// opens at 15:30 local reads as a mistake.
function relativeDay(target, now, tz) {
  const t = fields(target, tz);
  const n = fields(now, tz);
  const days = Math.round(
    (Date.UTC(t.y, t.mo - 1, t.d) - Date.UTC(n.y, n.mo - 1, n.d)) / 86400000,
  );
  const partOfDay = t.h < 12 ? "morning" : t.h < 17 ? "afternoon" : "evening";
  if (days === 0) {
    if (t.h < 12) return "this morning";
    if (t.h < 17) return "this afternoon";
    return "tonight";
  }
  if (days === 1) return `tomorrow ${partOfDay}`;
  if (days === -1) return `yesterday ${partOfDay}`;
  if (days < 0) return `${t.weekday} ${partOfDay}, ${Math.abs(days)} days ago`;
  return `${t.weekday} ${partOfDay}, in ${days} days`;
}

function hoursBetween(a, b) {
  return Math.round((Math.abs(a - b) / 3600000) * 10) / 10;
}

const now = new Date();
const here = fields(now, TZ);
const close = lastClose(now);
const open = nextOpen(now);

const lines = [
  "",
  "## Right now",
  "",
  "These values are computed at run time. Everything about timing — what counts",
  "as recent, which session you are describing, what to call it — follows from",
  "them, not from any timezone named elsewhere in these instructions.",
  "",
  `- Reader's timezone: **${TZ}** (${utcOffsetLabel(now, TZ)}).`,
  `- Local date and time: **${here.date} ${here.time}**, ${here.weekday}.`,
  `- The file you are writing today is \`archive/${here.date}.md\`.`,
];

if (close) {
  const c = fields(close, TZ);
  lines.push(
    `- The most recent US session closed **${hoursBetween(now, close)} hours ago**` +
      ` — 16:00 New York, which was ${c.time} your time (${relativeDay(close, now, TZ)}).`,
  );
}

if (open) {
  const o = fields(open, TZ);
  const when = relativeDay(open, now, TZ);
  lines.push(
    `- The next US session opens at **${o.time} your time** — 09:30 New York,` +
      ` ${when}. Call it "${when}" rather than "today".`,
  );
}

lines.push(
  "",
  "Give times in the reader's local zone, naming the zone the first time. US",
  "market holidays are not accounted for above — if a session was closed for a",
  "holiday, say so rather than reporting a flat tape as if it had traded.",
  "",
);

process.stdout.write(lines.join("\n"));
