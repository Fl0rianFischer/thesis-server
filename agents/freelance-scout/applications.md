# Past applications

Applications actually sent, as examples for the agent to write like.

This file does more for the quality of a letter than the prompt does. A prompt
can describe tone in the abstract — "concise, specific, no filler" — and still
produce something that reads like every other application a recruiter deletes.
Real letters show it instead.

## How this file is used

The agent reads it before writing and matches its length, register and shape.
It does not copy sentences from them — a recruiter who sees the same paragraph
twice notices.

**The letters below are verbatim, typos included.** Those are transcription
fidelity, not style: write correct German and English.

**Outcomes are unknown for every entry below.** That is the one thing worth
fixing by hand, and it is worth more than any other edit to this file — the
prompt weights letters that got a reply more heavily, and right now it has
nothing to weight with. When you remember how one went, change its `Outcome`
line.

## The agent never writes here

This file is yours. It ships in the image and is versioned like `cv.md`.

What the agent actually sends is recorded in `data/freelance-scout/archive/`
instead. When one of its letters is good enough to learn from, paste it in here
yourself and note the outcome — that promotion is a deliberate manual step.
Letting the agent append its own output would have it imitating itself a little
more each week, and drifting away from you a little more each week with it.

---

## What these letters have in common

Worth reading before the examples, because it is what the agent is matching:

- **Short.** Two to five short paragraphs. The longest one here is the outlier,
  not the target.
- **Opens with interest, then goes straight to specifics.** No "I am writing to
  express my interest in the position advertised".
- **Names real things.** Union Investment, seedtrace, Deck.gl, React Flow,
  Playwright, DatoCMS. Never "extensive experience with modern frontend
  frameworks".
- **Picks the one or two projects that answer *this* posting**, and leaves the
  rest of the CV out. The supply-chain startup leads when the project is about
  maps or data visualisation; the Union Investment work leads when it is about
  large tables, permissions or microfrontends.
- **Names a gap plainly when there is one**, without apologising for it or
  padding around it.
- **Ends with a plain invitation to talk**, then the signature block.

---

## Template — copy this block per application

### <Short label>

- **Project:** <title, and the one line that made it worth applying to>
- **Sent:** <YYYY-MM-DD>
- **Outcome:** <replied and led to a call / replied, declined / no reply / unknown>
- **Note to the agent:** <optional — what worked or did not>

```
<The letter, verbatim, exactly as it was sent.>
```

---

## English

### Frontend lead, data-intensive UI — the long version

- **Project:** unknown
- **Sent:** unknown
- **Outcome:** unknown
- **Note to the agent:** The most complete of these, and the **longest that
  should ever be written**. Use this shape only when the posting is detailed
  and senior enough to justify it. Note that even here, every paragraph is
  carrying a specific claim — none of it is throat-clearing.

```
Hi, I'm very interested in your project. I've been in frontend development for over 12 years with a strong focus on React and Vue, and I'm comfortable in lead and architectural roles.

Data-intensive UIs are my core strength: in my current project at Union Investment I'm rebuilding a permission management application for a large financial customer, where I've implemented large data set visualization in sortable, virtualized tables with complex filtering logic — including the full authentication and permission concepts behind it. The frontend architecture is a microfrontend approach using web components, and I contribute to a company-wide component library and design system.

I've also built several data visualization heavy products from the ground up, most notably a supply chain tracking application with interactive maps (Deck.gl) and dashboards used by major companies in the nutrition space, where I designed the GraphQL API and led a team of six developers.

On the quality side, I maintain large automated test suites with Playwright and Cypress, where API requests are intercepted and mocked against the spec, and I've set up complete CI/CD pipelines on GitHub and GitLab. For API integration I've built and consumed both REST and GraphQL backends with Node, so frontend/backend collaboration is second nature.

I'm used to working in agile, cross-functional teams alongside product owners and designers, and I'm fluent in English and German.

Would love to chat about this project!

Best,
Florian Fischer

+49 1573 6352518
fischer.florian3@gmail.com
```

### Frontend, React/Vue — the everyday version

- **Project:** unknown
- **Sent:** unknown
- **Outcome:** unknown
- **Note to the agent:** Closer to the default length. Same material as the one
  above, compressed — the startup leads here, the current project follows.

```
Hi, I'm very interested in your project. I've been in frontend development for 12 years now and focus heavily on React and Vue.

I have built multiple products from the ground up, most notably in my own startup where I used React, React Flow to build a supply chain tracking application which was used by major companies in the nutrition space. Here and also in other proects I have setup complete CI/CD pipelines using different providers like Gitlab or Github.

In my current project I've built an internal user management application use VueJS. Here I've implemented large data set visualization in sortable, virtualized tables with complex filtering logic. Also I have created a large test base using Playwright where requests are intercepted and mocked using the API spec. I'm using and contributing to a company wide component library as well as building smaller applications as web components to inegrate into microfrontend approach.

For backend/APIs I have built multiple Express based backend using both REST and GraphQL.

I'm fluent in German and English. Would love to chat about this project!
Best,
Florian Fischer

+4915736352518
fischer.florian3@gmail.com
```

### Headless CMS, fullstack — naming a gap, and a self-rating

- **Project:** Headless/Sanity fullstack role. The posting asked for
  self-rated skill scores.
- **Sent:** unknown
- **Outcome:** unknown
- **Note to the agent:** Two things to learn here. **The gap is stated
  outright** — "I haven't worked with Sanity itself" — immediately followed by
  why it is not a problem, with no apology and no padding. Copy that move
  exactly. And **the skill list is there because the posting asked for one**;
  it is not a house style. Do not add a ratings block unprompted, and when a
  posting does ask, rate honestly — the `sanity: 1` next to `Javascript: 10` is
  what makes the rest of the numbers believable.

```
Hi, I'm really interested in this position.

I have 12 years expreince working with Javascript fullstack, mainly React, Vue and Express/Node. In my own startup I have built an internal headless solution for a supply chain tracking tool, giving users the opportunity to track their supply chains in a custom CMS with GraphQL API and publish them to a NextJS application. Additionally I built a Shopify app so merchants could display their supply chains on their product pages. Furthermore I have developed multiple projects with Prismic CMS and just recently with DatoCMS

I haven't worked with Sanity itself but I do think that with my experience I have no issue being productive from day one.

- headless: 10
- fullstack: 9
- sanity: 1
- frontend: 10
- backend: 8
- Javascript: 10
- Typescript: 10
- Shopify: 8
- Algolia: 4

I'd be super happy to talk about this project.

Best,
Florian Fischer

fischer.florian3@gmail.com
+4915736352518
```

---

## German — informal

This is the default register for a German posting: `Hi` or `Hallo`, no named
recipient, `Viele Grüße`, signed with the first name only.

### Angular to React migration

- **Project:** Migration from Angular to React, Material UI.
- **Sent:** unknown
- **Outcome:** unknown
- **Note to the agent:** Very short, and correctly so — the posting was a
  single clear ask, so the letter answers only that. Note it does **not** claim
  Angular depth; it claims that twelve years across the JavaScript ecosystem
  make the migration comfortable, which is a different and honest claim.

```
Hallo,

ich sehr interessiert an dem Projekt. Mit über 12 Jahren Erfahrung als Frontendentwickler habe ich schon so ziemlich alles gesehen, was es in der Javascript Welt gibt. Daher würde ich mich sehr wohl mit einer Migration von Angular auf React fühlen. Insbesondere mit Material UI habe ich in meiner eigenen Unternehmensgründung mehrere Jahre intensiv gearbeitet.

Über eine Rückmeldung würde ich mich sehr freuen.
Viele Grüße,
Florian Fischer
```

### AI integration

- **Project:** AI integration work.
- **Sent:** unknown
- **Outcome:** unknown
- **Note to the agent:** Leads with **current, specific, unpaid work** rather
  than with the CV — the concrete cost-routing detail across three models is
  what makes it credible. Also the one letter here that **names a rate**
  (85 €/h) unprompted. Follow `cv.md` on whether to do that, not this example.

```
Hi, finde die Ausschreibung super spannend!

Ich arbeite seit 12 Jahren im Javascript Bereich und habe in letzter Zeit begonnen, mich sehr viel mit AI Integrationen auseinander zu setzen. Im Moment baue ich eine Applikation zur Sentiment Analyse von Finanznachrichten. Dabei setze ich OpenAI embedding Modelle ein, um nach Relevanz zu filtern, DeepSeek, um kostengünstige Einschätzungen zu erhalten und Claude, um aussagekräftige Analysen und Zusammenfassungen zu bekommen. Die Challenge ist es, das ganze kostengünstig hinzubekommen und teure Fronteier Modelle nur für das heavy lifting zu nutzen.

Würde mich sehr freuen, über das Projekt zu sprechen. Mein Stundensatz beträgt 85 Euro.
Viele Grüße,
Florian

+49 15736352518
fischer.florian3@gmail.com
```

### Geodata visualisation

- **Project:** Angular frontend with geodata visualisation.
- **Sent:** unknown
- **Outcome:** unknown
- **Note to the agent:** The stack was not an exact match and the letter says so
  in its first line — "Mein Frontend Stack ist React/Vue, aber ich hatte auch
  mit Angular schon viele Berührungspunkte" — then pivots immediately to the
  part that *is* a strong match. That order matters: acknowledge the mismatch,
  then spend the rest of the letter on the strength.

```
Hi, finde die Ausschreibung super interessant.

Mein Frontend Stack ist React/Vue, aber ich hatte auch mit Angular schon viele Berührungspunkte. insbesondere mit Geodaten und deren Visualisierung kenne ich mich ganz gut aus. Habe in meiner eignen Unternehmensgründung im Bereich Supply Chain Tracking sehr viel mit Kartenbezogenen Anwendungen gearbeitet. Dabei habe ich besonders mit Leaflet/OpenStreetMaps gearbeitet und React + Deck.gl zum rendering von Daten und Animationen genutzt.

Ich würde mich freuen, mal zu dem Projekt sprechen zu können.
Viele Grüße,
Florian

+49 15736352518
fischer.florian3@gmail.com
```

---

## German — formal

### AI-native live-streaming platform

- **Project:** Greenfield AI-native live streaming platform, senior frontend.
  The posting named a contact person.
- **Sent:** unknown
- **Outcome:** unknown
- **Note to the agent:** **This is the exception, not the model.** It is formal
  (`Sehr geehrter Herr <Name>`, `Mit freundlichen Grüßen`) because the posting
  was formal and named a person. It is also the most corporate-sounding letter
  here — "spricht mich sofort an", "technische Tiefe und architektonischem
  Weitblick" — and the least like the others. Match this register **only** when
  the posting sets it. Note also the years given as 11 rather than 12: it is
  older, so prefer `cv.md` over any number quoted in these examples.

```
Sehr geehrter Herr Ambos,

die Herausforderung, eine AI-native Live-Streaming-Plattform mit hochinteraktiven Realtime-Interfaces aufzubauen, spricht mich sofort an – und deckt sich präzise mit meiner langjährigen Erfahrung als Senior Frontend Engineer.

Mit 11 Jahren JavaScript-Erfahrung und mehreren Lead-Positionen bringe ich genau die Kombination aus technischer Tiefe und architektonischem Weitblick mit, die dieses Greenfield-Projekt erfordert. Meine relevanten Kernkompetenzen umfassen:

- React, Next.js (SSR, ISR, App Router, Server & Client Components)
- Skalierbare Frontend-Architekturen, inkl. Microfrontend-Implementierungen
- E2E-Testing mit Cypress und Playwright
- GraphQL API Design sowie Backend-Integration mit Node und AWS
- Hochinteraktive UI-Entwicklung unter Performancegesichtspunkten

Als Co-Founder & CTO bei seedtrace habe ich komplexe React/Next.js-Architekturen aufgebaut, Teams geleitet und technische Strategien verantwortet. Bei der German Financial Corporation setzte ich erfolgreich eine skalierbare Microfrontend-Architektur um – Erfahrungen, die direkt auf Ihre Plattformanforderungen einzahlen.

Ich freue mich auf ein Gespräch und stehe für Rückfragen jederzeit zur Verfügung.

Mit freundlichen Grüßen,
Florian Fischer
```
