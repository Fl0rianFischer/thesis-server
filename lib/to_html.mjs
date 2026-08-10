// Render a briefing markdown file as an HTML email body on stdout.
//
//   node lib/to_html.mjs data/morning-briefing/archive/2026-08-06.md
//
// The archive stays markdown — it is the model's own memory of what it already
// reported, and markdown is what it reads back. This runs at send time only.
//
// Every rule is an inline style attribute. Gmail drops <style> blocks in the
// web client whenever it decides to clip or quote a message, and there is no
// warning when it does: the mail simply arrives unstyled. Inline attributes are
// the only thing that survives everywhere, so marked's output gets walked and
// each tag stamped as it goes past.

import { readFileSync } from "node:fs";
import { marked } from "marked";

const STYLES = {
  h1: "margin:0 0 4px;font-size:22px;font-weight:600;letter-spacing:-0.01em;color:#111827;",
  h2: "margin:32px 0 12px;padding-bottom:6px;font-size:15px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:#6b7280;border-bottom:1px solid #e5e7eb;",
  h3: "margin:24px 0 8px;font-size:17px;font-weight:600;color:#111827;",
  p: "margin:0 0 14px;",
  ul: "margin:0 0 14px;padding-left:22px;",
  ol: "margin:0 0 14px;padding-left:22px;",
  li: "margin:0 0 6px;",
  a: "color:#1d4ed8;text-decoration:underline;",
  strong: "font-weight:600;color:#111827;",
  em: "font-style:italic;",
  hr: "margin:28px 0;border:0;border-top:1px solid #e5e7eb;",
  blockquote:
    "margin:0 0 14px;padding:2px 0 2px 14px;border-left:3px solid #e5e7eb;color:#4b5563;",
  code: "font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;background:#f3f4f6;padding:1px 4px;border-radius:3px;",
};

// Opening tags only — the pattern requires a letter after `<`, so `</a>` never
// matches. Existing attributes (href on links, mostly) are carried through;
// marked emits no style attributes of its own, so there is nothing to merge.
function inlineStyles(html) {
  return html.replace(
    /<([a-z][a-z0-9]*)((?:\s[^>]*)?)>/g,
    (tag, name, attrs) =>
      STYLES[name] ? `<${name}${attrs} style="${STYLES[name]}">` : tag,
  );
}

const path = process.argv[2];
if (!path) {
  console.error("usage: node lib/to_html.mjs <brief.md>");
  process.exit(2);
}

const body = inlineStyles(marked.parse(readFileSync(path, "utf8")));

// A max-width wrapper rather than a table layout: this is one reader on Gmail,
// not a marketing blast that has to survive Outlook 2013.
process.stdout.write(
  `<div style="max-width:640px;margin:0 auto;padding:8px 4px 32px;` +
    `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;` +
    `font-size:15px;line-height:1.6;color:#374151;">${body}</div>`,
);
