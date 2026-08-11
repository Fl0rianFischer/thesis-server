# Past applications

Applications you have actually sent, as examples for the agent to write like.

This file does more for the quality of a letter than the prompt does. A prompt
can describe tone in the abstract — "concise, specific, no filler" — and still
produce something that reads like every other application a recruiter deletes.
Three real letters that got a reply show it instead.

## How this file is used

The agent reads it before writing and matches its length, register and shape.
It weights entries marked as having got a reply more heavily. It does not copy
sentences from them — a recruiter who sees the same paragraph twice notices.

## The agent never writes here

This file is yours. It ships in the image and is versioned like `cv.md`.

What the agent actually sends is recorded in `data/freelance-scout/archive/`
instead. When one of its letters is good enough to learn from, paste it in here
yourself and note the outcome — that promotion is a deliberate manual step.
Letting the agent append its own output would have it imitating itself a little
more each week, and drifting away from you a little more each week with it.

## What to put in

Three to six is plenty; ten is not better than five. Prefer:

- Ones that **got a reply**, and say so.
- Ones that **did not**, if you know why — a letter marked as too long is a
  useful boundary.
- **Variety of situation**: a perfect fit, a partial fit where you named a gap,
  a project where the rate needed addressing. The middle one matters most,
  because writing honestly about a gap is the hardest thing to get right and
  the easiest to demonstrate.

Strip client names if you would rather. The shape is what is being learned.

---

## Template — copy this block per application

### <Short label, e.g. "Backend, fintech, fully remote">

- **Project:** <title, and the one line that made it worth applying to>
- **Sent:** <YYYY-MM-DD>
- **Outcome:** <replied and led to a call / replied, declined / no reply / unknown>
- **Note to the agent:** <optional — what worked or did not. e.g. "Opening line
  did the work here." or "Too long; a recruiter would not read past line four.">

```
<The letter, verbatim, exactly as you sent it.>
```

---

## Your applications

Replace everything below this line with real ones. Until you do, the agent is
working from the prompt's description of a good letter and nothing else, which
is the difference between letters that are fine and letters that sound like you.

### Example — remove this

- **Project:** Senior Go Engineer, payments platform, 100% remote
- **Sent:** 2026-01-15
- **Outcome:** replied and led to a call
- **Note to the agent:** The gap in paragraph three did not cost anything —
  naming it plainly was better than hoping it would not come up.

```
Hallo Frau <Name>,

zu Ihrem Projekt: ich habe die letzten sechs Jahre Zahlungssysteme in Go
gebaut, zuletzt ein Ledger mit rund 2.000 Transaktionen pro Sekunde und
doppelter Buchführung — genau die Verlässlichkeitsanforderung, die Sie
beschreiben.

Kafka setze ich seit vier Jahren produktiv ein, inklusive Exactly-once und
Schema-Migration im laufenden Betrieb.

Temporal kenne ich bisher nur aus der Dokumentation. Eingearbeitet wäre ich
darin in wenigen Tagen, aber ich sage lieber vorher, dass es keine Erfahrung
aus einem Produktivsystem ist.

Verfügbar bin ich ab dem 1. Februar mit vier Tagen pro Woche, Tagessatz
€<X>. Für ein kurzes Gespräch diese Woche bin ich flexibel.

Viele Grüße
<Name>
```
