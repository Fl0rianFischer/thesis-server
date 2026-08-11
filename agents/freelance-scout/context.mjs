// The scout's own framing, appended after lib/context.mjs.
//
//   TZ=Asia/Jakarta node agents/freelance-scout/context.mjs
//
// Deliberately says nothing about market sessions — that block belongs to the
// morning briefing. What matters here instead is what collection actually
// found this morning, and what this run is permitted to do with it.
//
// The permissions are stated to the model rather than merely enforced around
// it. submit.mjs enforces them regardless of what the model writes, so this
// block cannot loosen anything. It exists so the digest can tell the truth
// about itself: a dry-run digest that says "applied" would be a lie the reader
// has no way to catch, and one that hides the cap would have them wondering
// where the fourth application went.

import { readFileSync, readdirSync } from "node:fs";
import { TZ, daysBetweenDates, fields } from "../../lib/context.mjs";
import { DRY_RUN, MIN_SCORE, MAX_PER_DAY } from "./config.mjs";

const DATA = process.env.AGENT_DATA || "data/freelance-scout";
const ARCHIVE = process.env.AGENT_ARCHIVE || `${DATA}/archive`;

const now = new Date();
const today = fields(now, TZ).date;

const inboxPath = `${DATA}/inbox/${today}.json`;
let inbox = null;
try {
  inbox = JSON.parse(readFileSync(inboxPath, "utf8"));
} catch {
  inbox = null;
}

let previous = [];
try {
  previous = readdirSync(ARCHIVE)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort()
    .filter((f) => f.slice(0, 10) < today);
} catch {
  previous = [];
}

const lines = ["", "## This run", ""];

if (!inbox) {
  // Reached only if run.sh's collect step failed but the run continued. Say so
  // plainly rather than letting the model infer a quiet market from an absent
  // file — "no projects today" and "the scan did not happen" are the same
  // digest to a reader, and only one of them is worth acting on.
  lines.push(
    `- **Collection did not run.** There is no \`${inboxPath}\`, so there is nothing`,
    "  to score. Write a digest saying exactly that and nothing else. Do not",
    "  describe it as a quiet day — this is a failed scan, not an empty one.",
  );
} else {
  const n = inbox.candidates.length;
  lines.push(
    `- Candidates collected this morning: **${n}**.`,
    `- Read them from \`${inboxPath}\`. That file is your only source of projects;`,
    "  do not search the web for more.",
    `- Write the digest to \`${ARCHIVE}/${today}.md\` and the machine-readable`,
    `  queue to \`${DATA}/outbox/${today}.json\`. **Both files, every run**, even`,
    "  when nothing scores well enough to send — an empty queue is still a queue.",
  );

  if (n === 0) {
    lines.push(
      "",
      "- **Nothing new was collected.** This is a normal morning, not a failure.",
      "  Say so in a line and stop. Do not go looking for something to write about.",
    );
  }

  for (const warning of inbox.warnings ?? []) {
    lines.push(`- **Collection warning:** ${warning}`, "  Repeat this in the digest so it gets fixed.");
  }
}

lines.push(
  "",
  "### What this run may do",
  "",
  `- Submission threshold: **${MIN_SCORE}/10**. Below it, nothing is sent.`,
  `- Hard cap: **${MAX_PER_DAY}** submission${MAX_PER_DAY === 1 ? "" : "s"} per run.`,
);

if (DRY_RUN) {
  lines.push(
    "- **Dry run: nothing will be submitted today, whatever you decide.**",
    "  Write every letter exactly as you would if it were being sent — the point",
    "  of a dry run is that the reader can judge the real output. But the digest",
    "  must say clearly at the top that nothing was sent and that these are",
    "  proposals. Never write that you applied to anything.",
  );
} else {
  lines.push(
    "- **Live: applications scoring at or above the threshold will be sent.**",
    "  A letter you write today reaches a person who is deciding whether to work",
    `  with the reader. Where you are unsure, score below ${MIN_SCORE} and say why —`,
    "  a project correctly passed over costs nothing, and an application that",
    "  misrepresents the reader cannot be withdrawn.",
  );
}

if (previous.length === 0) {
  lines.push(
    "",
    "- **This is the first digest.** There is no history to compare against.",
  );
} else {
  const last = previous[previous.length - 1].slice(0, 10);
  const gap = daysBetweenDates(last, today);
  lines.push(
    "",
    `- Your last digest was **${last}**, ${gap} day${gap === 1 ? "" : "s"} ago.`,
    `- Read these before writing, newest last: ${previous
      .slice(-3)
      .map((f) => `\`${ARCHIVE}/${f}\``)
      .join(", ")}.`,
    "- They are there so you can see which letters you have already written and",
    "  keep from sending three near-identical ones to the same agency in a week.",
  );
}

lines.push("");

process.stdout.write(lines.join("\n"));
