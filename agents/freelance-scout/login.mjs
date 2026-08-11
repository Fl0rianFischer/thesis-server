// Establish a logged-in freelancermap session and persist it.
//
//   node agents/freelance-scout/login.mjs
//   node agents/freelance-scout/login.mjs --check   # report status, log in only if needed
//
// Credentials come from FM_EMAIL and FM_PASSWORD in the environment, which on
// the box arrive from .env, which the deploy writes from GitHub secrets — the
// same path RESEND_API_KEY already takes. They are never written to disk here,
// never logged, and never included in an error message: a failure prints the
// status and what to check, not what was sent.
//
// The contract below was established by observation rather than assumed:
//
//   POST /login, application/x-www-form-urlencoded, fields `login`, `password`
//   and `_remember_me`. No CSRF token — the form ships without a hidden field
//   and the endpoint accepts a post without one. A rejected login answers 302
//   to /login itself; a successful one answers 302 somewhere else.
//
// That last detail is the whole reason lib/fm-client.mjs sets redirect:"manual"
// and follows redirects by hand. Letting fetch follow them automatically
// collapses "logged in" and "rejected" into the same 200 and the difference
// becomes unrecoverable.

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { FmClient, hydrationPayload } from "../../lib/fm-client.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..", "..");
export const SESSION_FILE = join(APP, "data", "state", "fm-session.json");

// Any project page carries a ProjectShow payload whose `loggedInUser` is null
// for anonymous visitors and populated otherwise. That is the authoritative
// check, and it is why success is not inferred from the redirect alone: a
// cookie can survive in the jar long after the server has forgotten the
// session, and every symptom of that is indistinguishable from "no good
// projects today".
const PROBE_PATH = "/project/rest-api-developer";

export async function isLoggedIn(client) {
  try {
    const payload = hydrationPayload(await client.getHtml(PROBE_PATH), "ProjectShow");
    return Boolean(payload?.loggedInUser);
  } catch {
    return false;
  }
}

export async function login(client, { log = console.error } = {}) {
  const email = process.env.FM_EMAIL;
  const password = process.env.FM_PASSWORD;

  if (!email || !password) {
    throw new Error(
      "FM_EMAIL and FM_PASSWORD are not set. On the box they come from .env, " +
        "written by the deploy from the GitHub secrets of the same name. Locally: " +
        "set -a; . ./.env; set +a",
    );
  }

  // Fetches the login page first for the PHPSESSID the POST is expected to
  // carry, and to read the captcha state while anonymous. The component is
  // `Login`, and its `reCaptchaSiteKey` is null on the ordinary path — that is
  // what makes an automated form post possible at all.
  const loginPage = await client.getHtml("/login");
  const config = hydrationPayload(loginPage, "Login");

  // A missing payload is reported rather than ignored. Reading it as "no
  // captcha" would be the wrong default in the one place where being wrong
  // means walking into a challenge and retrying against it.
  if (!config) {
    log("login: WARNING no Login payload on /login — cannot check for a captcha before trying");
  }

  if (config?.reCaptchaSiteKey) {
    throw new Error(
      "the login form is presenting a captcha, so this cannot proceed. " +
        "Log in once by hand in a browser to clear it. If it persists, the " +
        "account or the address may be flagged and automated login is over.",
    );
  }

  const response = await client.request("/login", {
    method: "POST",
    body: new URLSearchParams({ login: email, password, _remember_me: "on" }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  // A rejected login is a 302 straight back to /login. Anything else — a 200
  // with the form re-rendered, a 403 — is not a wrong password but a changed
  // contract, and is worth reporting as such rather than sending the reader to
  // re-check a password that was fine.
  const location = response.headers.get("location") ?? "";

  if (response.status !== 302 || /\/login\b/.test(location)) {
    throw new Error(
      `login was rejected (status ${response.status}, redirected to ${location || "nowhere"}). ` +
        "Check FM_EMAIL and FM_PASSWORD, and that the account is not locked. " +
        "The password is not printed here by design.",
    );
  }

  // The redirect said yes; this confirms the server agrees.
  if (!(await isLoggedIn(client))) {
    throw new Error(
      "login appeared to succeed but the session does not read as authenticated. " +
        "This usually means freelancermap has added a step the form post does not " +
        "satisfy — see the note on chromium-headless-shell in the plan.",
    );
  }

  client.saveSession(SESSION_FILE);
  log(`login: signed in as ${email.replace(/(.).*(@.*)/, "$1***$2")}, session saved`);
  return client;
}

// What everything else calls. Reuses the stored session and only spends a real
// login when it has actually lapsed — a login per run would be both slower and
// far more conspicuous than one a month.
export async function ensureSession({ log = console.error } = {}) {
  const client = FmClient.fromSessionFile(SESSION_FILE);

  if (client.jar.size > 0 && (await isLoggedIn(client))) {
    log("login: reusing the stored session");
    return client;
  }

  log("login: no usable session, signing in");
  return login(client, { log });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const client = FmClient.fromSessionFile(SESSION_FILE);

  if (process.argv.includes("--check")) {
    const ok = client.jar.size > 0 && (await isLoggedIn(client));
    console.error(`login: stored session is ${ok ? "valid" : "missing or expired"}`);
    if (ok) process.exit(0);
  }

  // The message, not a stack trace. This runs from cron into a shared log, and
  // every failure here has an actionable sentence attached to it already.
  try {
    await login(client);
  } catch (error) {
    console.error(`login: FAILED — ${error.message}`);
    process.exit(1);
  }
}
