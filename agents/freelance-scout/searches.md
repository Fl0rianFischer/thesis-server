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

## Starter — replace this

A placeholder so a first run does something. It is not tuned to you, and it is
not a suggestion — swap it for your own as soon as you have read one digest.

https://www.freelancermap.com/projects?query=python&remoteInPercent%5B0%5D=100&sort=1

## Your searches

Add them here. A useful shape, one heading each:

> ### Senior backend, fully remote, DACH
> https://www.freelancermap.com/projects?query=...&sort=1
>
> Why: the core of what I do. Should be the highest-signal search.

---

## Filters that do not live here

Exclusions that need no judgement — companies never to apply to, dealbreaker
keywords, a minimum remote percentage — are in `config.mjs`, applied after
collection and before any model sees the project. They are code because they
are exact and testable.

Anything needing judgement — whether the seniority fits, whether the stack is
close enough, whether the rate is worth it — belongs in `cv.md` and
`prompt.md`, where a model can actually weigh it. Do not try to encode that
here.
