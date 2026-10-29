# Rollout and rollback — SB Social Submission security hardening

Status: **prepared, not applied.** Each production step needs the owner's approval.
`<ANGLE_BRACKETS>` are placeholders; type real values only into Netlify / Supabase, never
into files or chats.

## 0. Before the window (read-only)

1. Netlify → Site configuration → Environment variables: note the names in use. Confirm
   `SITE_PASSWORD` is at least 8 characters (if not, choose a new one — sign-in refuses
   shorter passwords). Note the total size of Functions-scoped variables (AWS limit 4 KB;
   the service-account JSON is most of it).
2. Netlify → Functions: note the function timeout (default 10 s) and Node version (≥ 20).
3. Google Sheet → Share: verify current access and keep the intended sharing (no change is
   part of this rollout). A read-only check on 29 Oct 2026 found **no link sharing** on the
   intake sheet: access is by named accounts only (7 editors including the owner, 1 viewer)
   plus the `sb-intake` service account as Editor. Confirm the service account has Editor on
   **this intake sheet only** and no other files.
4. Content Intelligence: confirm the token in `SUBMIT_TOKEN` is a `submit_signal` token
   (its own rollout rotates it — step 6 there).

## 1. Configure (no effect on the live app yet)

- Add `SESSION_SIGNING_SECRET` = 32+ random characters (e.g. `openssl rand -base64 48`),
  different from the password. Functions scope.
- Optional: `SESSION_EPOCH` = `1`. Only if the site's function timeout was raised:
  `FUNCTION_TIMEOUT_SEC` = that value.
- Netlify Blobs needs no setup (built in; store `sb-social-submission` is created on first write).

## 2. Content Intelligence companion change (recommended before step 3; order matters)

Deliverable: `content-intelligence-submit-signal-idempotency.patch` (identical copy in
`docs/companion/`): two commits on the **hardened** Content Intelligence branch
`security-hardening` at `948047d` (also delivered as a bundle). It keeps that branch's token
auth, validation, `submission_key` dedup, error helpers and clustering budget, and adds:
- `client_submission_id` handling in `submit-signal` (stored ids acknowledged without a new
  row; concurrent same-id inserts re-checked; skipped rows verified before acknowledging;
  ambiguous batches refused; missing migration → 503, never a false success);
- a **separate** migration `supabase/migrations/20261029_signals_client_submission_id.sql`
  (nullable column, UNIQUE, UUID format check, trigger so browser users can't set it; one
  transaction; safe to run twice);
- tests: `npm test` (81) and `tests/db/run.sh` on PostgreSQL (migration twice, conflict
  semantics, unrelated violations, two-session race, browser users denied, fresh install).

Order (part of the Content Intelligence rollout, `docs/SECURITY-ROLLOUT.md` step 5.6):
1. Supabase SQL editor: run the migration **after** `20261028_ci_access_control.sql` and
   **before** deploying the new `submit-signal`.
2. Deploy Content Intelligence (its own review/approval; this does not clear its separate
   review findings).
3. Verify: one Social Submission test entry → one signal with `client_submission_id` set;
   Retry with the same id → `already_received: 1`, no second signal.
4. Only then set `DASHBOARD_IDEMPOTENT=true` on Social Submission (lets the reconciler repeat
   `uncertain` deliveries) and redeploy.

Without this change Social Submission still works: the hardened endpoint already skips an
identical retry by its content key (`submission_key`); the id adds protection that doesn't
depend on content matching exactly. Leave `DASHBOARD_IDEMPOTENT` unset until step 3 passes.

## 3. Deploy (one atomic Netlify deploy)

Merge `security-hardening` into `main`. Netlify publishes the page and all seven functions
together (`auth`, `session`, `logout`, `analyze`, `extract-transcript`, `save`, and the
scheduled `reconcile-submissions`, every 15 min). Old function files are removed in the same
deploy, so no unauthenticated endpoint remains. Netlify → Functions should list
`reconcile-submissions` as *Scheduled*.

## 4. Old browser state

Nothing to do: the page deletes the old `sb_auth_ok` flag on load and shows the password
screen; that flag never authorised anything server-side. Everyone signs in once.

## 5. Verify (replace `<SITE>`)

Anonymous requests must be refused:
```
curl -i -X POST https://<SITE>/.netlify/functions/save -H 'content-type: application/json' -d '{}'                 # 401/403
curl -i -X POST https://<SITE>/.netlify/functions/analyze -H 'content-type: application/json' -d '{}'              # 401/403
curl -i -X POST https://<SITE>/.netlify/functions/extract-transcript -H 'content-type: application/json' -d '{"url":"https://youtu.be/dQw4w9WgXcQ"}'  # 401/403
curl -i https://<SITE>/.netlify/functions/session                                                                   # 401
curl -i -X POST https://<SITE>/.netlify/functions/auth -H 'content-type: application/json' -H 'origin: https://evil.example' -d '{"password":"x"}'  # 403
```
In a browser: wrong password → error; right password → app; reload → still signed in;
DevTools → Application: cookie `__Host-sbs_session` is HttpOnly/Secure/Strict, no auth
value in Local Storage; Sign out → password screen; reload → still signed out.

## 6. Confirm sheet writes and dashboard forwarding (writes one live row — approval needed)

1. Submit one text entry: `TEST – security rollout – delete me`.
2. Sheet: new row; column H header "Submission ID" added once; H holds a UUID; E = `✅ Sent`.
3. Content Intelligence Inbox shows the signal.
4. Click Submit again quickly on a new test entry (double-click): one row, one signal.
5a. Sign out → "Signed out."; reload → password screen. (A failed sign-out shows
   "Could not sign out" and keeps the app open.)
5b. After 15–20 minutes: Netlify → Functions → `reconcile-submissions` log shows
   `reconcile.done` with counts only.
5. One screenshot extraction and one YouTube transcript (uses Claude / possibly Supadata credit).
6. Delete the test rows and signals.
7. Netlify → Functions logs: only event names and status codes; no text, keys or ids.

## Rollback (data-preserving; never reopens the endpoints)

- **Do not republish the previous deploy**: it has unauthenticated write and paid-API
  endpoints.
- **Maintenance mode**: remove `SESSION_SIGNING_SECRET` (or set it to a short value) and
  redeploy → every endpoint returns 503 "not configured" and the scheduled reconciler pauses;
  no external call can happen. Fix forward on the branch, restore the secret, redeploy.
- **Someone can't sign in**: check the login limit (15 min per IP) or set a new
  `SITE_PASSWORD`; to sign everyone out change `SESSION_EPOCH`.
- **Data**: column H is additive (A–G unchanged; the intake Apps Script reads A–F).
  Submission records are never deleted. Incomplete ones are listed under `pending/…` in the
  Netlify Blobs store `sb-social-submission` (`sub/<id>` holds the text until delivered);
  the reconciler resumes them, or they can be retried from the page or re-entered.
- **Reconciliation of rare duplicate rows**: rows flagged "⚠️ Duplicate of row N — safe to
  delete" in the Status column can be deleted by hand; the kept row is the earlier one.
- **Companion change**: the column/index are additive; to undo the code, redeploy
  Content Intelligence's previous `submit-signal` and leave the column in place.

## Credentials and history (separate plan — nothing executed)

Inspected the current source and all 10 reachable commits:
- **No credentials, sheet ids, Apps Script URLs or service-account material** were ever
  committed. The repo never had a `.gitignore`; one is added.
- Commit `5981701` (reverted by the next commit) briefly replaced the page with a copy of
  the Content Intelligence dashboard. It contains that app's Supabase URL and **publishable**
  key — public by design and covered by its own RLS hardening — and no other secret.
- Commit author metadata shows a team email address.
- **Rotation**: nothing in this repo requires rotation. `SUBMIT_TOKEN` is rotated by the
  Content Intelligence rollout (step 6 there). Consider a new `SITE_PASSWORD` at deploy if
  the current one is short or widely shared, because the old endpoints allowed unlimited guesses.
- **History rewrite**: not needed — no credential was ever committed. Rewriting only to drop
  the reverted dashboard copy would force everyone to re-clone and cannot recall forks; not
  recommended.
- **Outside the repo**: the local `Intake` folder on the team computer contains a
  service-account key file (`sb-social-listening-*.json`). It is not in Git; keep it out of
  any upload, and if it is the key used in Netlify, consider replacing the key and deleting
  the local copy (approval needed).

## Legacy Intake Apps Script (outside this repo — separate plan, nothing executed)

The older intake app (`Code.gs` + `intake.html`, the form this site replaced) keeps a Claude API
key in its **Script Properties** (`CLAUDE_API_KEY`). Its setup instructions deploy it as a web
app with *Execute as: Me* and *Who has access: Anyone*.

Why that matters:
- **No sign-in.** Every top-level server function whose name doesn't end in `_` can be called
  from the browser (`google.script.run`) by anyone who opens the web-app URL:
  - `processIntakeWithClaude`: spends the Claude key with no limit (text and images);
  - `appendIntakeRow`: writes to the sheet via `appendRow` (formula-like text can be interpreted);
  - `getDailyBoard`, `getRecentTrackerEntries`, `getSummary`: return sheet data.
- **Framing allowed.** `XFrameOptionsMode.ALLOWALL` lets any site embed the page.
- **Who can read the key.** Script Properties are not sent to visitors, but anyone who can edit
  the script can read them. If the script is bound to the intake sheet, every **named editor**
  of that sheet can read the key (29 Oct 2026 check: no link sharing; 7 named editors).
- **Sheet access ≠ web-app access.** A restricted sheet does not restrict the web app: a
  deployment with *Who has access: Anyone* is reachable by anyone with its URL regardless of
  the sheet's sharing. Its current status must be checked separately (step 1).

Steps (each needs the owner's approval; retiring an Apps Script deployment is the owner's call):
1. Intake sheet → Extensions → Apps Script → **Deploy → Manage deployments**. If a web-app
   deployment is active and this Netlify site has replaced the form, **archive** it.
2. Intake sheet → **Share**: re-verify current access (29 Oct 2026: no link sharing; named
   accounts only) and keep the intended sharing; list who can edit, since editors can read
   the script's Script Properties.
3. **Key:**
   - script no longer used → delete the `CLAUDE_API_KEY` Script Property;
   - still used → give it its own key, separate from this site's `CLAUDE_API_KEY`;
   - if the web app was reachable by anyone, or anyone outside the team could edit the
     sheet/script → **rotate** that key in the Anthropic console and check its usage for
     unexpected calls.
4. If the script must stay deployed: restrict access to the Google Workspace domain, rename server
   functions with a trailing `_` (private) except those the page needs, and add a check
   before any Claude call or sheet write.
5. Confirm afterwards: opening the old web-app URL no longer serves the form (or requires
   sign-in), and `processIntakeWithClaude` can't be called anonymously.
