// The opportunities agent's own framing, appended after lib/context.mjs.
//
//   TZ=Asia/Jakarta node agents/opportunities/context.mjs
//
// Deliberately says nothing about when the last US session closed or when the
// next one opens. This brief runs twice a week on a multi-year horizon; a
// session-close countdown would frame it as something to act on before the
// open, which is the failure mode the whole separate-agent design exists to
// prevent. The morning briefing has that block; this one has this.
//
// What matters here instead is the gap: when the last brief was written, and
// therefore what window "what changed" covers. That gap is not fixed — a
// Monday brief looks back over a weekend, a Thursday one over two sessions —
// so it is computed rather than stated in prose.

import { readdirSync } from "node:fs";
import { TZ, daysBetweenDates, fields } from "../../lib/context.mjs";

const ARCHIVE = process.env.AGENT_ARCHIVE || "data/opportunities/archive";

const now = new Date();
const today = fields(now, TZ).date;

// Newest last. Anything not named YYYY-MM-DD.md is ignored rather than sorted
// into the middle of the history.
let briefs = [];
try {
  briefs = readdirSync(ARCHIVE)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort();
} catch {
  briefs = [];
}

const previous = briefs.filter((f) => f.slice(0, 10) < today);
// Leading blank line: this block is concatenated straight onto the shared one,
// and a heading without a blank line above it is not a heading.
const lines = ["", "## What window this brief covers", ""];

if (previous.length === 0) {
  lines.push(
    "- **This is the first brief.** There is no prior history to diff against, so",
    "  there is no \"what changed\" — establish the baseline instead. Say plainly in",
    "  the brief that it is the first one, and describe where each name stands now",
    "  rather than how it moved.",
  );
} else {
  const last = previous[previous.length - 1].slice(0, 10);
  const gap = daysBetweenDates(last, today);
  lines.push(
    `- Your last brief was **${last}**, ${gap} day${gap === 1 ? "" : "s"} ago.` +
      ` "What changed" means since then — not since yesterday, and not since the`,
    "  most recent market close.",
    `- Read these before writing, newest last: ${previous
      .slice(-3)
      .map((f) => `\`${ARCHIVE}/${f}\``)
      .join(", ")}.`,
    "- Anything you already reported in those is not news again unless a number,",
    "  a confirmation, or a reversal has landed since. A position that is still",
    "  cheap for the same reason is not a development.",
  );
}

lines.push(
  "",
  "A gap of a few days over a multi-year horizon usually contains nothing that",
  "changes a thesis. That is the expected case, not a failed run — say so and",
  "keep the brief short rather than filling it.",
  "",
);

process.stdout.write(lines.join("\n"));
