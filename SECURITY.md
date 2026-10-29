# Security — SB Social Submission

Branch `security-hardening`. Implemented and verified **locally only**: nothing has been
deployed, no production setting has changed, and the live app is **not secured until the
rollout in [ROLLOUT.md](ROLLOUT.md) is done and its checks pass.**

## 1. Earlier findings — verified against the latest code (commit 14c59b0)

| Finding | Confirmed in source? | Now |
|---|---|---|
| `auth.js` returned `{success:true}` without a session | Yes | Signed, expiring, server-checked session cookie |
| `save.js` had no authentication before Google + `SUBMIT_TOKEN` forwarding | Yes | Session + CSRF checked first |
| `analyze.js` had no authentication before Claude | Yes | Same |
| `extract-transcript.js` had no authentication before YouTube/TikTok/Supadata (paid) | Yes, and it sent `Access-Control-Allow-Origin: *` | Same; CORS header removed |
| Browser `localStorage` flag `sb_auth_ok` was the only "login" | Yes — editable in DevTools; the endpoints never checked anything | Flag removed (and deleted from browsers on load); it never authorises |
| `USER_ENTERED` sheet writes (formula injection) | Yes | `RAW` for every write |

Additional findings during this review (fixed): substring host matching in
`extract-transcript` (`/youtube\.com/` matched `youtube.com.evil.example`); raw provider /
Google error messages returned to the browser; no request-size or image validation; no
retry safety (double-click = duplicate row and duplicate dashboard signal); no timeouts on
outbound calls; `DASHBOARD_URL` could send the submission token to any host; no `.gitignore`.

Production settings **not verified** (no access was used): Netlify env values, whether a
Netlify password wall exists, function timeout, Node version, the service account's
sharing on the sheet, the token's scope in Content Intelligence.

## 2. Authentication design

- **Login** (`POST /.netlify/functions/auth`): password compared server-side in constant
  time (SHA-256 digests + `timingSafeEqual`). Never returned, stored or logged.
- **Session cookie** `__Host-sbs_session=v1.<sid>.<expiry>.<HMAC>` — `Secure; HttpOnly;
  SameSite=Strict; Path=/`, 7 days (same as the old unlock).
  - HMAC key = HMAC(`SESSION_SIGNING_SECRET`, sha256(`SITE_PASSWORD`) + `SESSION_EPOCH`).
  - Server record `sessions/<sid>` in Netlify Blobs; expiry checked from both the signed
    value and the record on **every** request.
- **Restore**: `GET /.netlify/functions/session` → `{authenticated, csrfToken}`.
- **Logout**: `POST /.netlify/functions/logout` deletes the server record (a copied cookie
  stops working) and clears the cookie. A "Sign out" button was added to the header; the
  page shows "Signed out." only after the server confirms, otherwise it stays in the app
  with "Could not sign out … tap Sign out again".
- **Invalidation**: change `SESSION_EPOCH` (signs everyone out), or rotate
  `SESSION_SIGNING_SECRET`, or change `SITE_PASSWORD` — each invalidates every session
  after the redeploy that applies the env change.
- **CSRF**: every POST needs `X-CSRF-Token` = HMAC(key, sid) (kept in page memory only),
  a JSON content type (forces CORS preflight), and passes Origin / `Sec-Fetch-Site` checks.
  Login also requires same-origin.
- **Login limits** (durable): each attempt is reserved atomically *before* the password is
  compared; a correct password refunds it. 8 per IP (IPv6 grouped per /64) per 15 min,
  300 per hour site-wide.
- **Fail closed**: missing `SITE_PASSWORD` (or < 8 chars), missing `SESSION_SIGNING_SECRET`
  (or < 32 chars, or containing the password) → every endpoint returns 503.
- "Submitted by" is **self-reported attribution** typed by the user, not a verified identity
  (one shared password = no individual identity).

## 3. Endpoint protection

`netlify/lib/guard.mjs#requireSession` runs first in every protected function, before any
body parsing that matters and before any external call.

| Endpoint | Auth | Durable limits | Size / validation | External calls (only after auth + limits) |
|---|---|---|---|---|
| `auth` (POST) | same-origin | login limits above | 4 KB | none |
| `session` (GET) | cookie | — | — | none |
| `logout` (POST) | cookie + CSRF | — | — | none |
| `analyze` (POST) | cookie + CSRF | 40/session/h, 300/day | ≤ 5.9 MB body, ≤ 10 images, JPEG/PNG/WebP/GIF, magic bytes, ≤ 3.5 MB each / 4.3 MB total decoded | Claude |
| `extract-transcript` (POST) | cookie + CSRF | 60/session/h, 400/day; **paid** 30/session/h, 150/day | 8 KB; exact host allow-list | YouTube (free), Supadata (paid), TikTok oEmbed |
| `save` (POST) | cookie + CSRF | 120/session/h, 1500/day | 256 KB; raw input ≤ 40 000 chars; platform allow-list; public http(s) source link | Google Sheets, Content Intelligence |

Errors are generic (`{error, code}`); provider messages, sheet ids, tokens and stacks are
never returned. Logs carry event names and status codes only, with configured secrets
redacted as a second line of defence. Responses are `Cache-Control: no-store`.

## 4. Durable state (Netlify Blobs store `sb-social-submission`)

No new service: Netlify Blobs is built into the site. All read-modify-write uses
conditional writes (ETag compare-and-swap, `onlyIfNew` / `onlyIfMatch`, strong reads), so
concurrent invocations cannot lose updates; a missing ETag or any storage error fails closed.
Netlify Blobs has **no conditional delete**, so keys that another request could reuse are
never deleted: they are released or retired with an ETag-checked replace (a write that loses
a race simply fails and the newer entry survives).

| Prefix | Holds | Lifetime |
|---|---|---|
| `sessions/` | session expiry (random, never-reused id) | deleted at logout / after expiry |
| `rl/` | fixed-window counters (IP hashed) | deleted after the window ended |
| `sub/` | submission + delivery state | **never deleted**; text dropped when both destinations succeed (tombstone keeps id, fingerprint, row, states) |
| `pending/` | index of incomplete submissions for the reconciler; written **before** the record and refreshed on every attempt | removed only after the record is complete (terminal). Entries whose record was never created (a crash between the two writes) are **kept**: deleting them on a "record missing" read races with a retry that creates the record at that moment. Trade-off: a few tiny orphan entries remain; the reconciler skips them (counted as `orphans`) |
| `tx/`, `txjob/` | transcript cache (7 days; "no transcript" 1 h; provider errors not cached), pending Supadata job id | retired in place by CAS (marker), never deleted |
| `txlock/` | per-video extraction lock | released by owner-checked CAS; never deleted |

Screenshots are never stored or logged.

## 5. Saving and retries

The browser sends a `submissionId` (UUID) that stays the same for the same content across
retries and double-clicks (kept in `sessionStorage`); changed content gets a new id.

1. **Claim** `sub/<id>` with a lease (30 s). Same id + different content → 409. Already
   complete → replay the stored result (tombstones are kept forever). Another request holds
   the lease → 409 `in_progress` (the page waits and asks again).
2. **Sheet** (Google's append is not idempotent):
   - Every attempt first ensures the tab and **looks the row up by id in column H
     "Submission ID"** — also when the record is new (covers a lost record).
   - Before an append the record is set to **`inflight`** (persisted first, so a crash, a
     lost response or a failed record update after the append are all recoverable).
   - If the append's outcome is unknown (timeout / network / 5xx / crash) the submission is
     **verifying**: no new append is made while it is `inflight` and its row is not visible,
     until **10 minutes** have passed since the append started. Google documents a 180 s
     maximum request processing time; the 10-minute window is that limit plus margin.
     Only a definite refusal (4xx) returns it to `pending` immediately.
   - After the window, an unseen append is retried once. Because an append slower than every
     documented limit could still land later, such a submission gets a **duplicate re-check**
     10 minutes later: any extra row with the same id is marked in the Status column
     "⚠️ Duplicate of row N — safe to delete" (never deleted automatically).
3. **Dashboard**: only if not yet delivered. Sent only to the allow-listed
   `https://sb-content-intelligence.netlify.app/.netlify/functions/submit-signal`
   (redirects refused) with `Idempotency-Key` and `client_submission_id` = the id.
   The record is set to `inflight` **before** sending, so a crash or a store failure after
   sending is later treated like `uncertain`. At most one immediate repeat, and only when the
   first attempt certainly never arrived (connection refused / DNS / 429 / 503). States:
   `delivered`, `failed` (never arrived), `uncertain` / `inflight` (may have arrived),
   `rejected` (4xx: configuration), `not_configured`.
4. **Status cell** (column E, system text only) and duplicate flags are written only after
   checking that column H of that row still holds this id; the record keeps the earliest row.
5. **Reconciler** (`reconcile-submissions`, Netlify Scheduled Function every 15 min, no
   public URL, no input): resumes incomplete submissions without the user — resolves
   verifying sheet appends, retries `failed`/`pending` deliveries, runs the duplicate
   re-check. It repeats an `uncertain`/`inflight` delivery **only** when
   `DASHBOARD_IDEMPOTENT=true` (set after the Content Intelligence change is live). It skips
   records with a live lease and records it cannot progress (e.g. `rejected`) without using
   its budget, starts each scan at a random offset, and reads at most 500 index entries and
   processes at most 20 records per run. The pending index entry is written before the record.
6. One time budget per invocation (default 8.5 s, under Netlify's 10 s; set
   `FUNCTION_TIMEOUT_SEC` if the site's limit is raised).

Responses: **200** both done · **202** sheet saved, dashboard not (warning + "Retry dashboard
delivery"; never shown as success) · **503** `sheet_unavailable` (not saved; entry kept) or
`sheet_verifying` (outcome unknown; entry kept; re-checked after the 10-minute settle window, automatically within 15 minutes after that) · **409** in
progress / id conflict.

**What is and is not guaranteed**
- Sheet: one row per submission id under Google's documented processing limit; beyond it, a
  rare extra row is detected and flagged for manual deletion, not prevented.
- Dashboard: **not exactly-once from this app alone.** The pre-hardening Content
  Intelligence endpoint deduplicates only by source URL. The hardened endpoint also
  deduplicates identical content through `submission_key`. With the companion migration and
  endpoint deployed and verified, `client_submission_id` provides independent retry
  deduplication. Which version is deployed must be verified on the live site — a branch
  merge does not show it. Keep `DASHBOARD_IDEMPOTENT` unset until the companion migration and
  endpoint are live and verified.
- If the Blobs store itself were lost, the sheet is still protected by the column-H lookup,
  but dashboard state is unknown and a retry would re-send the signal (deduplicated only
  with the companion change).

## 6. Spreadsheet formula injection

All writes use `valueInputOption: RAW`; `=…`, `+…`, `-…`, `@…` are stored as text. Text,
Unicode and line breaks are preserved (control characters other than tab/newline removed).
System values (status, timestamp, id) are separate columns from user text.
Limit: anything that later copies these cells onward (CSV export opened in Excel, an Apps
Script using `setValue`) must treat them as text too.

## 7. External fetching

- URLs parsed with `URL`; only `http(s)`, no credentials, no custom ports, ≤ 2048 chars.
- Exact hosts: `youtube.com, www/m.youtube.com, youtu.be`, `tiktok.com, www/m/vm/vt.tiktok.com`,
  `instagram.com, www.instagram.com`. Anything else (look-alikes, IPs, localhost, metadata)
  is "unsupported" and never fetched. Only a canonical URL rebuilt from validated parts is
  forwarded to Supadata.
- Outbound fetches go only to allow-listed https hosts with timeouts, size caps and manual
  redirects re-checked hop by hop (Supadata: no redirects; the YouTube library gets a
  restricted `fetch`).
- Paid calls: per-video lock, cache, durable limits; long videos reuse the Supadata job id
  (polling is free) instead of starting new paid jobs.

## 8. Prompts

The screenshot prompt is generic transcription only — no SB-confidential rules — so it stays
public. A system instruction tells the model that screenshot content is untrusted data and
never instructions; the response is parsed into two capped fields. No prompt is returned.

## 9. Configuration (Netlify → Site configuration → Environment variables, Functions scope)

| Name | Required | Notes |
|---|---|---|
| `SITE_PASSWORD` | yes | ≥ 8 characters (shorter → sign-in refused) |
| `SESSION_SIGNING_SECRET` | **new**, yes | ≥ 32 random characters, different from the password |
| `SESSION_EPOCH` | optional | any short value; change it to sign everyone out |
| `CLAUDE_API_KEY` | yes (screenshots) | |
| `SUPADATA_API_KEY` | optional | paid transcripts |
| `GOOGLE_SHEET_ID` | yes | |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | yes | share **only** the intake sheet with this account (Editor) |
| `SUBMIT_TOKEN` | yes (dashboard) | ≥ 16 chars; a Content Intelligence token with action `submit_signal` only |
| `DASHBOARD_URL` | optional | must be `https://sb-content-intelligence.netlify.app` (allow-list) |
| `FUNCTION_TIMEOUT_SEC` | optional | only if the site's function timeout was raised (10–26) |
| `DASHBOARD_IDEMPOTENT` | optional | `true` only after the Content Intelligence idempotency change is live; lets the reconciler repeat `uncertain` deliveries |

Values go only into Netlify. Never into the repo, the page, fixtures or docs.

## 10. Tests

| Command | What it proves | Result |
|---|---|---|
| `npm test` (84 tests) | missing/invalid/expired/forged/tampered/revoked sessions rejected; browser flag never authorises; every protected endpoint × 7 unauthorised callers never calls Google/Claude/Supadata/YouTube/TikTok/dashboard (no network at all); logout + epoch/secret/password invalidation; CSRF; missing config denies; login limit incl. parallel bursts and across separate processes; analyze limit across processes; unsafe URLs/redirects; oversized/invalid images before Claude; formula text stored literally; double-click / concurrent / replayed saves → one row, one signal; **late Google commit after > 30 s, invocation killed mid-append, record update failing after append, append slower than the settle window (flagged as duplicate)**; tombstones and lost records → no extra row; reconciler recovers stale partial saves, is not starved by unrecoverable records, and never repeats `uncertain` or mid-flight deliveries unless enabled; index written before the record; **cleanup vs. lock takeover and old-owner release races** (interleaved backend); live lock survives housekeeping; partial delivery + retry; deadline; no secrets in responses/logs/repo/page | pass |
| `npm run build` | Netlify's bundler packages all 7 functions (v2; `reconcile-submissions` carries its schedule) and each bundle loads | pass |
| `npm run check` | syntax + module load of 20 files | pass |
| `npm run test:browser` (32 checks, Chromium) | real page with production CSP: forged flag, login, cookie flags, nothing in storage, reload restore, text / screenshot / YouTube transcript submit, partial failure → retry, double-click, sheet outage → retry, **failed sign-out (network error / 403 / 503) never shown as signed out and the session stays as reported**, confirmed logout, old cookie rejected, server-side revoke | pass |
| Companion (`content-intelligence…patch`) `npm test` (7) + PostgreSQL 16 | same-id retry and concurrent inserts → one row; unrelated 23505 not acknowledged; missing migration → 500 for id rows while callers without an id keep working (the fake rejects unknown columns like PostgREST); overlapping batches; migration idempotent; `ON CONFLICT` semantics checked in real PostgreSQL | pass |

Tests use synthetic data and fakes for every external service. Durable state uses
`tests/blobs-test-server.mjs`, a small implementation of the Blobs HTTP API with atomic
conditional writes and ETags (the bundled local server does neither).

An independent review (separate agent) found 8 defects in the first version, all fixed and
re-verified. The team's second review found 5 more (late Sheets commits after the 30 s hold,
record cleanup removing dedup protection, cleanup/lock races, failed sign-out shown as
success, companion patch acknowledging unrelated uniqueness errors); each now has the
regression tests listed above.

## 11. Remaining limitations

- **Dashboard idempotency** depends on the companion change (§5); keep
  `DASHBOARD_IDEMPOTENT` unset until it is live.
- **Sheet duplicates beyond Google's documented limit** are flagged for manual deletion, not
  prevented (§5). The reconciler and every retry look rows up by id first.
- **Verifying window**: after an unknown append outcome the entry can take up to ~10 minutes
  (+ up to 15 min for the reconciler) to be confirmed in the sheet; the page says so.
- **Sheet access.** A read-only check on 29 Oct 2026 found no link sharing on the intake
  sheet: named accounts only (7 editors, 1 viewer) plus the service account. Keeping its id out
  of responses and logs reduces discovery; access itself is governed by the sheet's sharing,
  which should be re-verified rather than assumed. Named editors can also read Script
  Properties of a script bound to the sheet (see ROLLOUT, legacy Apps Script).
- **One shared password**: no per-person identity; "Submitted by" is self-reported.
- **Global login limit** (300/h): a determined attacker can still slow everyone's *new*
  sign-ins; existing sessions keep working.
- **Screenshot reading** must finish within the function budget; very large batches may need
  `FUNCTION_TIMEOUT_SEC` (if the site limit is raised) or fewer images per extraction.
- **Source links** are checked for internal-looking hosts only; whatever fetches
  `source_url` later (Content Intelligence) must do its own SSRF protection.
- **CSP** keeps `'unsafe-inline'` for the page's existing inline handlers (no redesign).
- **Storage growth**: submission tombstones and transcript markers are kept (small; no
  user text in tombstones). Netlify Blobs is assumed to return ETags on strong reads and
  apply conditional writes atomically (documented behaviour; tests use a conformant stand-in,
  and the store refuses to write if an ETag is missing).
- `googleapis@140` has a moderate advisory in a transitive `uuid` (buffer bounds with a
  caller-supplied buffer); not reachable from this code. Upgrading is a separate change.
