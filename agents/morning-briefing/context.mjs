// The morning briefing's own time framing, appended after lib/context.mjs.
//
//   TZ=Asia/Jakarta node agents/morning-briefing/context.mjs
//
// This is the block that says which US session just closed, how long ago, when
// the next one opens in the reader's zone, and what to call it. It lives here
// rather than in lib/ deliberately: it is a session-close countdown, and
// handing that to the opportunities agent would make a multi-year brief read
// like a day-trading note. Shared code is for facts every agent needs; this is
// not one of them.

import {
  TZ,
  fields,
  hoursBetween,
  lastClose,
  nextOpen,
  relativeDay,
} from "../../lib/context.mjs";

const now = new Date();
const close = lastClose(now);
const open = nextOpen(now);

// Leading blank line: this block is concatenated straight onto the shared one,
// and a heading without a blank line above it is not a heading.
const lines = ["", "## The session you are describing", ""];

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
  "US market holidays are not accounted for above — if a session was closed for",
  "a holiday, say so rather than reporting a flat tape as if it had traded.",
  "",
);

process.stdout.write(lines.join("\n"));
