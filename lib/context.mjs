// Shared time context, plus the zone primitives both agents build on.
//
//   AGENT=morning-briefing node lib/context.mjs
//   TZ=Europe/Berlin AGENT=opportunities node lib/context.mjs
//
// Run directly it emits the "Right now" block that gets appended to the
// agent's prompt.md. Imported, it exports the zone helpers each agent's own
// context.mjs uses to add its framing on top.
//
// prompt.md used to state the reader's timezone in prose — "Jakarta (UTC+7)",
// "11 hours ahead of US Eastern", "tonight" for a session that opens at 21:30
// local. All of that is wrong the moment TZ changes, and wrong silently: the
// briefing still arrives, it just describes someone else's day. So the whole
// time framing is computed here from TZ instead, and TZ is the only place a
// timezone is configured anywhere in this project.
//
// What lives here is only what is true for *every* agent: the zone, the local
// clock, the file to write. Anything about market sessions belongs to the
// morning briefing and lives in its own context.mjs — see the note there.
//
// Intl rather than `date`: this also runs on macOS during local prompt tuning,
// where BSD date has no -d and cannot do zone arithmetic at all.

export const TZ = process.env.TZ || "UTC";
export const MARKET_TZ = "America/New_York";
export const OPEN = { h: 9, m: 30 };
export const CLOSE = { h: 16, m: 0 };

// Offset of `tz` at a given instant, in ms. Formatting the instant into the
// zone and reading it back as if it were UTC recovers the offset — the one
// primitive everything else here is built from.
export function offsetMs(date, tz) {
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
export function instantOf({ y, mo, d, h, mi }, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const ts = guess - offsetMs(new Date(guess), tz);
  const settled = guess - offsetMs(new Date(ts), tz);
  return new Date(settled);
}

export function fields(date, tz) {
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

export function utcOffsetLabel(date, tz) {
  const mins = offsetMs(date, tz) / 60000;
  const sign = mins < 0 ? "-" : "+";
  const h = Math.floor(Math.abs(mins) / 60);
  const m = Math.abs(mins) % 60;
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}

export function addDays({ y, mo, d }, n) {
  const t = new Date(Date.UTC(y, mo - 1, d + n));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export function isWeekday({ y, mo, d }) {
  const wd = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return wd >= 1 && wd <= 5;
}

// Weekdays only — US market holidays are not modelled. Agents that use these
// are told as much in their own block, so they can check rather than assume.
export function sessionInstant(day, { h, m }) {
  return instantOf({ ...day, h, mi: m }, MARKET_TZ);
}

export function lastClose(now) {
  const day = fields(now, MARKET_TZ);
  for (let i = 0; i < 10; i++) {
    const candidate = addDays(day, -i);
    if (!isWeekday(candidate)) continue;
    const at = sessionInstant(candidate, CLOSE);
    if (at <= now) return at;
  }
  return null;
}

export function nextOpen(now) {
  const day = fields(now, MARKET_TZ);
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
export function relativeDay(target, now, tz) {
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

export function hoursBetween(a, b) {
  return Math.round((Math.abs(a - b) / 3600000) * 10) / 10;
}

// Days between two YYYY-MM-DD strings, as whole calendar days.
export function daysBetweenDates(fromISO, toISO) {
  const [fy, fm, fd] = fromISO.split("-").map(Number);
  const [ty, tm, td] = toISO.split("-").map(Number);
  return Math.round(
    (Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000,
  );
}

// The shared block. Everything here is true for every agent; anything about
// market sessions is the morning briefing's business, not this file's.
export function sharedBlock(now = new Date()) {
  const agent = process.env.AGENT || "morning-briefing";
  const here = fields(now, TZ);
  return [
    "",
    "## Right now",
    "",
    "These values are computed at run time. Everything about timing — what counts",
    "as recent, which window you are describing, what to call it — follows from",
    "them, not from any timezone named elsewhere in these instructions.",
    "",
    `- Reader's timezone: **${TZ}** (${utcOffsetLabel(now, TZ)}).`,
    `- Local date and time: **${here.date} ${here.time}**, ${here.weekday}.`,
    `- The file you are writing today is \`data/${agent}/archive/${here.date}.md\`.`,
    "",
    "Give times in the reader's local zone, naming the zone the first time.",
    "",
  ].join("\n");
}

// `node lib/context.mjs` prints the shared block; importing it does not.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(sharedBlock());
}
