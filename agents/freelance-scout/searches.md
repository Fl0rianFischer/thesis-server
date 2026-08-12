# Searches

**These are URLs you copy out of the freelancermap UI.** Build the search on
the site with its own filters — skills, remote percentage, countries, contract
type, whatever you use — and when the results look right, copy the address bar
and paste it in here under a heading saying what it is for.

Nothing in this project interprets those query parameters. The site's own
filter form wrote them, and `collect.mjs` replays them exactly. That is the
point: anything the UI can express, this agent can search, and there is no
private API being guessed at. When a search stops behaving, fix it by building
it again in the UI and pasting a fresh URL — never by editing code.

Any line containing a `freelancermap.*/projects` URL is treated as a live
search. Everything else is notes for you. Lines starting with `>` are ignored,
so an example can be quoted without being run.

## How to add one

1. Go to <https://www.freelancermap.com/projects> and set your filters.
2. Check the result list is what you would want to read every morning. **Narrow
   is better than broad** — every project collected here is eventually read by
   a model, and a search returning 200 hits a day is one you will stop reading.
3. Sort by newest (`sort=1`). The agent stops paginating once a page holds
   nothing new, which only works if the newest are first.
4. Copy the URL. Paste it below with a heading.

Three or four narrow searches beat one wide one: they keep the reasons separate,
so when the digest fills with noise you know which search to tighten.

---

## Core — frontend and fullstack, fully remote

The main search. Everything in `cv.md` under Core skills, narrowed to what you
will actually accept.

https://www.freelancermap.de/projekte?categories%5B0%5D=1&projectContractTypes%5B0%5D=contracting&remoteInPercent%5B0%5D=100&created=2&sort=1&query=%28React+OR+Vue+OR+Vuejs+OR+Frontend+OR+Typescript+OR+NextJS+OR+GraphQL%29

## Visualisation and geo — the differentiator

Low volume by design — often zero on a given day, occasionally the best project
of the week. Deck.gl, maps and WebGL are the thing almost nobody else on the
platform can claim, and none of these words appear in the core query.

https://www.freelancermap.de/projekte?categories%5B0%5D=1&projectContractTypes%5B0%5D=contracting&remoteInPercent%5B0%5D=100&created=2&sort=1&query=%28Deck.gl+OR+Mapbox+OR+Leaflet+OR+Geodaten+OR+WebGL+OR+Threejs+OR+Data+Visualization%29

---

## Why these are shaped the way they are

Measured against the live site, not guessed.

**`remoteInPercent=100` only.** The previous search also carried
`remoteInPercent[1]=1`, and that value does not mean "remote preferred" — it
means **hybrid, 20–90% remote**. Measured on a sample, the two values together
returned eleven hybrid projects out of twenty-two. Since `cv.md` makes
remote-only a non-negotiable gate, every one of those would have been rejected
after being collected and read. Dropping it roughly doubles the useful density
of the one page that can be read.

**`created=2` is what stops the search truncating.** Only the first page of any
search is reachable — 22 results, see `RESULTS_PER_PAGE` in `config.mjs` — and
the old search returned 22 results all posted within the last fortnight, which
means it was cut off and the tail was never seen. Restricted to the last three
days it returns 15, comfortably inside the cap. Three days rather than one so
that a Monday run still reaches back over the weekend to Friday's postings, and
so a failed run on one morning is picked up the next. Anything already seen is
filtered by `seen.json`, so the overlap costs nothing.

**Single words in the query, never phrases.** freelancermap ORs the individual
words rather than matching a phrase, so `"Lead Frontend"` degrades into matching
"Lead" anywhere — a test of that query returned a Go security role and an SAP
architect. Seniority is judged by the model from the description, not filtered
here.

**`Node` and similar generic words are deliberately left out.** They pull in
Kubernetes and cloud-infrastructure postings by the dozen. The narrower terms
that are actually distinctive — `NextJS`, `Typescript`, `GraphQL` — earn their
place; `Node` does not.

**Two searches rather than one.** Each gets its own 22-result page, so a
low-volume, high-value search cannot be crowded out by a high-volume one. That
is also why the visualisation search exists separately: merged into the core
query, its handful of results would be buried.

**Imprecision here is cheap; missing a project is not.** Both searches return
some obvious noise — a Go role, a .NET role. Those get scored 0–2 and appear in
the digest as a count, not a listing. Filtering them out at the URL level would
risk excluding real matches, and the model is better at that judgement than a
keyword is.

## Keeping them honest

Re-copy a URL from the UI whenever your filters change — never hand-edit the
query string here. If `collect.mjs` starts warning that a search is truncated,
the fix is a narrower `created` window or a tighter query, not a bigger cap.

## Filters that do not live here

Exclusions that need no judgement — companies never to apply to, dealbreaker
keywords, a minimum remote percentage — are in `config.mjs`, applied after
collection and before any model sees the project. They are code because they
are exact and testable.

Anything needing judgement — whether the seniority fits, whether the stack is
close enough, whether the rate is worth it — belongs in `cv.md` and
`prompt.md`, where a model can actually weigh it. Do not try to encode that
here.
