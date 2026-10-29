// Idempotent save: one browser submission id → at most one sheet row and one dashboard
// delivery sequence, with durable per-destination state in Netlify Blobs.
//
//   sub/<id> = { fingerprint, fields, submittedAt,
//                sheet:     { state: pending|inflight|done, row, attempts, inflightSince },
//                dashboard: { state: pending|delivered|failed|uncertain|rejected|not_configured, attempts, httpStatus },
//                statusCell, lease: { owner, until } }
//   pending/<id> = { at, gen }   index of records that are not complete (for the reconciler).
//     Refreshed on every user attempt; deleted only after the record is complete (terminal).
//     Entries without a record (crash between the two writes) are kept, never deleted on a
//     "record missing" read — a concurrent retry may be creating that record right now.
//
// Sheet appends are not idempotent at Google, so:
// • Before every append the record is set to `inflight` (persisted first — survives a
//   function crash, a lost response, or a failed record update after the append).
// • Every attempt looks the row up by submission id (column H) before appending.
// • While an append is `inflight` and its row is not visible, NO new append is made until
//   SETTLE_MS has passed since it started (Google documents a 180 s maximum request
//   processing time; SETTLE_MS is 10 minutes). Until then the save reports "verifying".
// • If a duplicate row is ever found (e.g. an append slower than every documented limit),
//   the extra rows are marked in the Status column for manual deletion — never auto-deleted.
// • Records are never deleted: once complete they shrink to a tombstone (no text) that
//   still answers replays of the same id.

import { createHash, randomBytes } from 'node:crypto';

export const LEASE_MS = 30_000;              // > the longest invocation budget (24.5 s)
export const SETTLE_MS = 10 * 60 * 1000;     // after this an unseen in-flight append is treated as not committed
const key = (id) => `sub/${id}`;
const pendingKey = (id) => `pending/${id}`;

export const STATUS_TEXT = {
  delivered: '✅ Sent',
  not_configured: '⚠️ No token',
  failed: '❌ Error',
  uncertain: '❌ Error',
  inflight: '❌ Error',
  rejected: '❌ Error',
};
export const DUPLICATE_TEXT = (row) => `⚠️ Duplicate of row ${row} — safe to delete`;

export function fingerprint(fields) {
  const canon = JSON.stringify([fields.rawInput, fields.sourceUrl, fields.platform, fields.sourceName, fields.submittedBy]);
  return createHash('sha256').update(canon).digest('hex');
}

const complete = (r) => r.sheet.state === 'done' && r.dashboard.state === 'delivered';

const MESSAGES = {
  done: 'Saved to the sheet and sent to the dashboard.',
  not_configured: 'Saved to the sheet. Dashboard delivery is not configured — please tell the team admin. Your entry is kept.',
  rejected: 'Saved to the sheet, but the dashboard refused it (a configuration problem) — please tell the team admin. Your entry is kept.',
  uncertain: 'Saved to the sheet. The dashboard did not confirm it received the entry — tap Retry.',
  inflight: 'Saved to the sheet. The dashboard did not confirm it received the entry — tap Retry.',
  failed: 'Saved to the sheet, but the dashboard did not receive it yet. Tap Retry — the sheet row will not be duplicated.',
  pending: 'Saved to the sheet; sending to the dashboard did not finish in time. Tap Retry — the sheet row will not be duplicated.',
  notSaved: 'Could not save to the sheet yet. Your entry is kept — tap Retry.',
  verifying: 'The save is being verified. Your entry is kept; check again later. Google did not confirm the write, so it is re-checked after a 10-minute settle window (the automatic check runs every 15 minutes), or tap Retry later.',
};

function summary(r, extra = {}) {
  const delivered = r.dashboard.state === 'delivered';
  const saved = r.sheet.state === 'done';
  const verifying = r.sheet.state === 'inflight';
  const message = saved ? (delivered ? MESSAGES.done : MESSAGES[r.dashboard.state] || MESSAGES.failed)
    : verifying ? MESSAGES.verifying : MESSAGES.notSaved;
  return {
    success: saved && delivered,
    partial: saved && !delivered,
    submissionId: r.id,
    sheet: { saved, state: r.sheet.state },
    dashboard: { state: r.dashboard.state, delivered },
    retryable: !(saved && delivered),
    message,
    ...extra,
  };
}

const busy = (retryAfter = 3) => ({
  status: 409,
  body: { error: 'This submission is still being saved — retrying shortly.', code: 'in_progress', retryAfter: Math.max(1, Math.ceil(retryAfter)) },
});

// Errors after which Google certainly did NOT write the row: a 4xx response, or our own
// deadline guard firing before the request was sent.
function definitelyNotWritten(err) {
  if (err && err.code === 'DEADLINE') return true;
  const status = err && (err.status || (err.response && err.response.status) || (typeof err.code === 'number' ? err.code : null));
  return !!(status && status >= 400 && status < 500 && status !== 408);
}

/**
 * @param store      durable store (createStore API)
 * @param sheets     () => sheets client (lazy)
 * @param forward    (args) => forwardSignal result, or null when not configured
 * @param deadline   epoch ms by which all work must be finished
 * @param system     true when called by the reconciler (uses the stored fields; never
 *                   repeats an `uncertain` dashboard delivery unless retryUncertain)
 */
export async function processSubmission({ id, fields, store, sheets, forward, now: nowArg, deadline = Date.now() + 8500, log, system = false, retryUncertain = true }) {
  const owner = randomBytes(12).toString('hex');
  // `now` may be injected (test clocks); otherwise the real time at claim.
  const now = nowArg ?? Date.now();
  const left = () => deadline - Date.now();

  // ── 1. Create or claim the record ────────────────────────────────────────
  // Index for the reconciler FIRST (it ignores index entries without a record), so a crash
  // between the two writes can never leave a record the reconciler does not know about.
  // Only removed once the record is complete (terminal).
  if (!system) {
    const existing = await store.get(key(id));
    if (!existing || !existing.data || !complete(existing.data)) {
      // Always refresh (new timestamp + generation), so the entry reflects this attempt.
      await store.update(pendingKey(id), () => ({ at: now, gen: randomBytes(6).toString('hex') }));
    }
  }
  let outcome = null; let wait = 3;
  const fp = fields ? fingerprint(fields) : null;
  const claimed = await store.update(key(id), (cur) => {
    outcome = null;
    if (!cur) {
      if (system) { outcome = 'missing'; return undefined; }
      return {
        v: 2, id, fingerprint: fp, fields,
        createdAt: now, submittedAt: new Date(now).toISOString(),
        sheet: { state: 'pending', row: null, attempts: 0, inflightSince: null },
        dashboard: { state: 'pending', attempts: 0, httpStatus: null },
        statusCell: null, lease: { owner, until: now + LEASE_MS }, updatedAt: now,
      };
    }
    if (!system && cur.fingerprint !== fp) { outcome = 'conflict'; return undefined; }
    if (complete(cur)) { outcome = 'replay'; return undefined; }
    if (cur.lease && cur.lease.until > now && cur.lease.owner !== owner) {
      outcome = 'busy'; wait = Math.min(10, (cur.lease.until - now) / 1000); return undefined;
    }
    return { ...cur, lease: { owner, until: now + LEASE_MS }, updatedAt: now };
  });
  if (outcome === 'missing') return { status: 404, body: { code: 'missing' } };
  if (outcome === 'conflict') return { status: 409, body: { error: 'This submission id was already used for different content.', code: 'id_conflict' } };
  if (outcome === 'replay') return { status: 200, body: summary(claimed.data, { replay: true }) };
  if (outcome === 'busy') return busy(wait);

  let rec = claimed.data;
  let lost = false;
  const mutate = async (fn) => {
    const r = await store.update(key(id), (cur) => {
      if (!cur || !cur.lease || cur.lease.owner !== owner) { lost = true; return undefined; }
      return { ...fn(cur), updatedAt: Date.now() };
    });
    if (lost) throw Object.assign(new Error('lease_lost'), { code: 'lease_lost' });
    rec = r.data;
    return rec;
  };
  const release = async () => {
    try {
      await mutate((cur) => {
        const done = complete(cur);
        // Completed records become tombstones: no text, but they still answer replays.
        return { ...cur, lease: null, fields: done ? null : cur.fields, completedAt: done ? Date.now() : cur.completedAt };
      });
      // The pending index entry is only ever removed after the record is complete
      // (a terminal state), so a concurrent writer can never need it again.
      if (complete(rec) && !rec.sheet.recheckAt) await store.delete(pendingKey(id)).catch(() => {});
    } catch { /* lease expired: nothing to release */ }
  };

  try {
    // ── 2. Sheet (one row per submission id) ─────────────────────────────────
    if (rec.sheet.state !== 'done') {
      const client = sheets();
      let rows;
      try {
        await client.ensureIntake(left());
        rows = await client.findRowsById(id, left());      // always reconcile with column H first
      } catch (err) {
        log && log.error('sheet_lookup_failed', { code: err && (err.code || err.status) });
        await release();
        return { status: 503, body: { ...summary(rec), error: 'Could not reach the sheet — your entry is kept. Please retry.', code: 'sheet_unavailable', retryAfter: 5 } };
      }

      if (rows.length) {
        const keep = Math.min(...rows);
        await mutate((cur) => ({ ...cur, sheet: { ...cur.sheet, state: 'done', row: keep, inflightSince: null } }));
        if (rows.length > 1) await markDuplicates(client, id, rows, left, log);
      } else if (rec.sheet.state === 'inflight' && now - rec.sheet.inflightSince < SETTLE_MS) {
        // A previous append may still commit: never append again inside the settle window.
        const retryAfter = Math.ceil((rec.sheet.inflightSince + SETTLE_MS - now) / 1000);
        await release();
        return { status: 503, body: { ...summary(rec), error: MESSAGES.verifying, code: 'sheet_verifying', retryAfter: Math.min(retryAfter, 60) } };
      } else {
        if (left() < 2500) {
          await release();
          return { status: 503, body: { ...summary(rec), error: MESSAGES.notSaved, code: 'sheet_unavailable', retryAfter: 3 } };
        }
        // Persist "in flight" BEFORE sending the append.
        await mutate((cur) => ({ ...cur, sheet: { ...cur.sheet, state: 'inflight', inflightSince: Date.now(), attempts: cur.sheet.attempts + 1 } }));
        let row = null;
        try {
          const f = rec.fields;
          row = await client.appendRow([f.rawInput, f.sourceUrl, f.platform, f.sourceName, '', rec.submittedAt, f.submittedBy, id], left());
        } catch (err) {
          const notWritten = definitelyNotWritten(err);
          log && log.error('sheet_append_failed', { code: err && (err.code || err.status), kind: err && err.name, ambiguous: !notWritten });
          if (notWritten) await mutate((cur) => ({ ...cur, sheet: { ...cur.sheet, state: 'pending', inflightSince: null } })).catch(() => {});
          await release();
          return notWritten
            ? { status: 503, body: { ...summary(rec), error: MESSAGES.notSaved, code: 'sheet_unavailable', retryAfter: 3 } }
            : { status: 503, body: { ...summary(rec), error: MESSAGES.verifying, code: 'sheet_verifying', retryAfter: 60 } };
        }
        if (!row) {
          try { row = (await client.findRowsById(id, left()))[0] || null; } catch { /* resolved on the next attempt */ }
        }
        // A re-append after the settle window is the only path that could ever double up:
        // schedule a later duplicate re-check (run by the reconciler) for that case.
        await mutate((cur) => ({ ...cur, sheet: { ...cur.sheet, state: 'done', row, inflightSince: null, recheckAt: cur.sheet.attempts > 1 ? Date.now() + SETTLE_MS : null } }));
        if (rec.sheet.attempts > 1 && left() > 2000) {
          try {
            const all = await client.findRowsById(id, left());
            if (all.length > 1) {
              const keep = await markDuplicates(client, id, all, left, log);
              await mutate((cur) => ({ ...cur, sheet: { ...cur.sheet, row: keep }, statusCell: cur.sheet.row === keep ? cur.statusCell : null }));
            }
          } catch { /* best effort */ }
        }
      }
    }

    // ── 3. Dashboard ─────────────────────────────────────────────────────────
    const d = rec.dashboard.state;
    // `inflight` = a previous send started but its outcome was never recorded (crash or
    // store failure after sending): it may have arrived, so it is treated as uncertain.
    const skipUncertain = (d === 'uncertain' || d === 'inflight') && !retryUncertain;
    if (d !== 'delivered' && !skipUncertain && !(system && d === 'rejected')) {
      if (!forward) {
        // Keep a possibly-delivered state; it must not later look safe to send again.
        await mutate((cur) => (['inflight', 'uncertain'].includes(cur.dashboard.state) ? cur
          : { ...cur, dashboard: { ...cur.dashboard, state: 'not_configured' } }));
      } else if (left() > 2000) {
        await mutate((cur) => ({ ...cur, dashboard: { ...cur.dashboard, state: 'inflight', attempts: cur.dashboard.attempts + 1, lastAttemptAt: Date.now() } }));
        const r = await forward({ id, fields: rec.fields, submittedAtIso: rec.submittedAt, deadline: deadline - 800 });
        const state = r.outcome === 'delivered' ? 'delivered'
          : r.outcome === 'rejected' ? 'rejected'
          // Timeouts, resets and 5xx may have been processed downstream → "uncertain";
          // only requests that certainly never arrived (refused / DNS / 429 / 503) are "failed".
          : (r.safeToRepeat ? 'failed' : 'uncertain');
        if (state !== 'delivered') log && log.warn('dashboard_failed', { status: r.httpStatus, error: r.error, outcome: r.outcome });
        await mutate((cur) => ({ ...cur, dashboard: { ...cur.dashboard, state, httpStatus: r.httpStatus ?? null, deliveredAt: state === 'delivered' ? Date.now() : cur.dashboard.deliveredAt } }));
      }
    }

    // ── 4. Status cell (best effort; system-generated, never user text) ──────
    const desired = STATUS_TEXT[rec.dashboard.state];
    if (rec.sheet.row && desired && rec.statusCell !== desired && left() > 1500) {
      try {
        const row = await sheets().setStatus(rec.sheet.row, desired, id, left() - 300);
        await mutate((cur) => ({ ...cur, statusCell: desired, sheet: row ? { ...cur.sheet, row } : cur.sheet }));
      } catch (err) {
        log && log.warn('status_cell_failed', { code: err && (err.code || err.status) });
      }
    }

    await release();
    const body = summary(rec);
    return { status: body.success ? 200 : 202, body };
  } catch (err) {
    if (err && err.code === 'lease_lost') return busy(3);
    await release();
    throw err;
  }
}

// Flags every row except the earliest; markRow re-checks column H before writing.
async function markDuplicates(client, id, rows, left, log) {
  const [keep, ...extra] = [...rows].sort((a, b) => a - b);
  log && log.error('sheet_duplicate_rows', { count: extra.length });
  for (const r of extra) {
    if (left() < 1500) break;
    try { await client.markRow(r, DUPLICATE_TEXT(keep), id, left()); } catch { /* best effort */ }
  }
  return keep;
}

/** Whether the reconciler can make progress on a record without a person. */
function actionable(d, { retryUncertain, canForward, at }) {
  if (!d || !d.fields) return false;                                   // tombstone
  if (d.sheet.state !== 'done') return true;                           // pending / verifying
  const ds = d.dashboard.state;
  if (ds === 'pending' || ds === 'failed') return canForward;
  if (ds === 'uncertain' || ds === 'inflight') return retryUncertain && canForward;
  if (ds === 'not_configured') return canForward;                      // token added since
  return false;                                                        // rejected: needs an admin; user retry still works
}

/**
 * Reconciler: resumes incomplete submissions without a user (scheduled function).
 * • only records it can actually progress are processed (others don't use the budget),
 * • the scan starts at a rotating offset so no subset can starve the rest,
 * • at most `maxKeys` index entries are read and `max` records processed per run,
 * • settled in-flight sheet appends are resolved; deliveries that certainly never arrived
 *   are retried; `uncertain`/`inflight` deliveries only when the dashboard is idempotent.
 */
export async function reconcilePending({ store, sheets, forward, deadline, log, retryUncertain = false, minAgeMs = 2 * 60 * 1000, max = 20, maxKeys = 500, clock = Date.now }) {
  const results = { scanned: 0, checked: 0, completed: 0, stillPending: 0, skipped: 0, orphans: 0, duplicatesFlagged: 0 };
  const keys = await store.list('pending/');
  const start = keys.length ? Math.floor(Math.random() * keys.length) : 0;
  for (let i = 0; i < keys.length && i < maxKeys; i++) {
    if (results.checked >= max || deadline - Date.now() < 4000) break;
    const k = keys[(start + i) % keys.length];
    results.scanned++;
    const id = k.slice('pending/'.length);
    const rec = await store.get(key(id));
    const at = clock();
    if (!rec || !rec.data) {
      // No record (yet): keep the index entry. Deleting it here would race with a retry
      // that creates the record after this read and relies on the entry for recovery.
      results.orphans++;
      continue;
    }
    if (complete(rec.data)) {
      const due = rec.data.sheet.recheckAt;
      if (due && due > at) continue;
      if (due) {
        // Late duplicate check for a submission whose append was repeated.
        results.checked++;
        try {
          const rows = await sheets().findRowsById(id, deadline - Date.now());
          if (rows.length > 1) {
            const keep = await markDuplicates(sheets(), id, rows, () => deadline - Date.now(), log);
            results.duplicatesFlagged += rows.length - 1;
            await store.update(key(id), (cur) => (cur ? { ...cur, sheet: { ...cur.sheet, row: keep } } : undefined));
          }
        } catch { continue; }
        await store.update(key(id), (cur) => (cur && cur.sheet.recheckAt ? { ...cur, sheet: { ...cur.sheet, recheckAt: null } } : undefined));
      }
      await store.delete(k).catch(() => {});
      continue;
    }
    if (!actionable(rec.data, { retryUncertain, canForward: !!forward, at })) { results.skipped++; continue; }
    if (rec.data.lease && rec.data.lease.until > at) { results.skipped++; continue; }
    if (at - (rec.data.updatedAt || 0) < minAgeMs) { results.skipped++; continue; }
    results.checked++;
    const r = await processSubmission({
      id, fields: rec.data.fields, store, sheets, forward, log, system: true, retryUncertain, now: clock(),
      deadline: Math.min(deadline, Date.now() + 8000),
    });
    if (r.status === 200) results.completed++; else results.stillPending++;
  }
  return results;
}
