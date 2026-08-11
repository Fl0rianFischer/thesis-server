// The freelancermap transport: an HTTP client with a cookie jar, and a reader
// for the JSON the site already embeds in its own pages.
//
// There is no browser here and there is nothing to click. freelancermap is a
// React front end over server-rendered HTML, and every page ships the data its
// components hydrate from as plain JSON in a <script type="application/json">
// tag. A browser would parse that JSON, render it into a DOM, and then we
// would scrape it back out — strictly more work, strictly more fragile, and
// ~400MB of Chromium in an image that currently has none. So we read the JSON.
//
// The practical consequence, and the reason this is not a fragile scraper:
// nothing here depends on CSS selectors, class names or layout. A visual
// redesign changes none of it. Only a change to the hydration payload's shape
// would, and that is the same thing that would break the site's own front end.
//
// Every request in this project goes through here, so if freelancermap ever
// does require executing JavaScript — see the note on the login contract in
// login.mjs — this is the one module that gets swapped for a headless shell,
// not the three scripts above it.

import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

export const ORIGIN = "https://www.freelancermap.com";

// A real browser's UA. Not an attempt to evade anything — freelancermap serves
// the same public HTML either way — but a default Node UA is the kind of thing
// that gets rate-limited by generic infrastructure rules, and a run that is
// silently throttled looks exactly like a day with no matching projects.
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// One request at a time with a gap between them. This agent runs once a day
// and reads a few dozen pages; there is no reason to go faster, and pacing is
// what keeps a daily scan from looking like something worth blocking.
const MIN_GAP_MS = 700;

export class FmClient {
  // `jar` is name -> value. Deliberately not a full RFC 6265 store: this talks
  // to exactly one origin over HTTPS, so paths, domains and secure flags would
  // all hold the same value on every cookie.
  constructor({ jar = new Map(), sessionFile = null } = {}) {
    this.jar = jar;
    this.sessionFile = sessionFile;
    this._lastRequest = 0;
  }

  static fromSessionFile(path) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8"));
      return new FmClient({ jar: new Map(Object.entries(raw.cookies ?? {})), sessionFile: path });
    } catch {
      // A missing or corrupt session is not an error here. Collection runs
      // logged out by design, and login.mjs is what creates this file.
      return new FmClient({ sessionFile: path });
    }
  }

  // Mode 600 because this file is a bearer credential: anything holding these
  // cookies is logged in as the reader, with no password needed.
  saveSession(path = this.sessionFile) {
    if (!path) throw new Error("saveSession: no path");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ saved: new Date().toISOString(), cookies: Object.fromEntries(this.jar) }, null, 2),
    );
    chmodSync(path, 0o600);
  }

  get isAuthenticated() {
    // PHPSESSID is handed to anonymous visitors too, so its presence proves
    // nothing. The remember-me cookie is the one that only exists after a
    // successful login. Callers should still treat this as a hint and verify
    // against a real response — see `loggedInUser` in the ProjectShow payload.
    return [...this.jar.keys()].some((k) => /remember|REMEMBER/.test(k));
  }

  _storeCookies(response) {
    // getSetCookie() keeps multiple Set-Cookie headers separate. Reading
    // headers.get("set-cookie") instead joins them with commas, which is
    // unparseable the moment a cookie carries an Expires date — those contain
    // a comma of their own.
    for (const line of response.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq < 1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      // An expiry in the past is the server deleting a cookie — usually the
      // session being invalidated. Honouring it is what lets an expired login
      // be detected rather than retried with a cookie the server has forgotten.
      if (/;\s*(max-age=0|expires=Thu, 01 Jan 1970)/i.test(line)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  _cookieHeader() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  async _pace() {
    const wait = this._lastRequest + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this._lastRequest = Date.now();
  }

  // Retries only on 429 and 5xx — transient conditions where the same request
  // may succeed later. A 403 is not retried: that is the site saying no, and
  // hammering it is both rude and the fastest way to turn a soft block into a
  // hard one.
  async request(path, { method = "GET", body = null, headers = {}, retries = 3 } = {}) {
    const url = path.startsWith("http") ? path : `${ORIGIN}${path}`;

    for (let attempt = 0; ; attempt++) {
      await this._pace();

      const response = await fetch(url, {
        method,
        body,
        redirect: "manual",
        headers: {
          "User-Agent": UA,
          "Accept-Language": "en-US,en;q=0.9",
          ...(this._cookieHeader() ? { Cookie: this._cookieHeader() } : {}),
          ...headers,
        },
      });

      this._storeCookies(response);

      if ((response.status === 429 || response.status >= 500) && attempt < retries) {
        // Exponential, and honouring Retry-After when the server bothers to
        // send one.
        const after = Number(response.headers.get("retry-after"));
        const delay = Number.isFinite(after) && after > 0 ? after * 1000 : 2000 * 2 ** attempt;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      return response;
    }
  }

  // redirect: "manual" above, so redirects are followed here instead. Doing it
  // by hand is what makes the login check possible: the difference between a
  // successful login and a rejected one is a 302 to the dashboard versus one
  // back to /login, and automatic following erases that distinction.
  async get(path, { maxRedirects = 5 } = {}) {
    let target = path;
    for (let i = 0; i <= maxRedirects; i++) {
      const response = await this.request(target);
      if (response.status < 300 || response.status >= 400) return response;
      const location = response.headers.get("location");
      if (!location) return response;
      target = location.startsWith("http") ? location : `${ORIGIN}${location}`;
    }
    throw new Error(`too many redirects from ${path}`);
  }

  async getHtml(path) {
    const response = await this.get(path);
    if (!response.ok) throw new Error(`GET ${path} -> ${response.status}`);
    return response.text();
  }
}

// Pull one react-on-rails hydration payload out of a page.
//
// The markup is:
//   <script type="application/json" class="js-react-on-rails-component"
//           data-component-name="ProjectSearch" data-dom-id="...">{...}</script>
//
// The body is raw JSON, not HTML-escaped — script content is not parsed as
// HTML — and react-on-rails escapes any literal "</script>" inside it as
// "</script", which JSON.parse decodes natively. So a non-greedy match up
// to the closing tag cannot truncate a payload early.
export function hydrationPayload(html, componentName) {
  const pattern = new RegExp(
    `<script[^>]*data-component-name="${componentName}"[^>]*>([\\s\\S]*?)</script>`,
  );
  const match = html.match(pattern);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch (error) {
    // Naming the component matters: "unexpected token" against 1.4MB of HTML
    // is unactionable, and this is the failure that means the site changed.
    throw new Error(`could not parse the ${componentName} payload: ${error.message}`);
  }
}

// The same, but treats a missing payload as fatal. Used where absence means
// something has genuinely changed rather than "this page has no such section"
// — a project page without a ProjectShow block is not a project page.
export function requirePayload(html, componentName) {
  const payload = hydrationPayload(html, componentName);
  if (!payload) {
    throw new Error(
      `no ${componentName} payload found. Either the URL was wrong, the response ` +
        `was a login wall or an error page, or freelancermap changed its markup.`,
    );
  }
  return payload;
}
