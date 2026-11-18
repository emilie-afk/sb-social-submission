// Google Sheets adapter for the Intake tab.
// Columns A–G are unchanged (the intake Apps Script reads A–F). Column H holds the
// submission id so a retried save can find a row it already appended.
// All user text is written with valueInputOption RAW: nothing is parsed as a formula.

import { google } from 'googleapis';

export const TAB = 'Intake';
export const HEADERS = ['Raw input', 'Source URL', 'Platform', 'Source name', 'Status', 'Submitted at', 'Submitted by', 'Submission ID'];
const MAX_TIMEOUT_MS = 8000;
// Methods take the time left (ms); every Google call gets the smaller of 8 s and the
// time remaining *when that call starts*, so multi-call steps cannot overrun.
const budget = (timeLeftMs) => {
  const end = Date.now() + (timeLeftMs || MAX_TIMEOUT_MS);
  return () => {
    const left = end - Date.now();
    if (left < 300) throw Object.assign(new Error('deadline'), { code: 'DEADLINE' });
    return { timeout: Math.min(MAX_TIMEOUT_MS, left), retry: false };
  };
};

export function createSheetsClient({ sheetId, credentials }) {
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const api = google.sheets({ version: 'v4', auth });
  let ensured = false;

  return {
    async ensureIntake(timeoutMs) {
      const opts = budget(timeoutMs);
      if (ensured) return;
      const meta = await api.spreadsheets.get({ spreadsheetId: sheetId, fields: 'sheets.properties.title' }, opts());
      const has = (meta.data.sheets || []).some((s) => s.properties && s.properties.title === TAB);
      if (!has) {
        await api.spreadsheets.batchUpdate({
          spreadsheetId: sheetId,
          requestBody: { requests: [{ addSheet: { properties: { title: TAB } } }] },
        }, opts());
        await api.spreadsheets.values.update({
          spreadsheetId: sheetId, range: `${TAB}!A1:H1`, valueInputOption: 'RAW',
          requestBody: { values: [HEADERS] },
        }, opts());
      } else {
        const h = await api.spreadsheets.values.get({ spreadsheetId: sheetId, range: `${TAB}!H1` }, opts());
        const v = h.data.values && h.data.values[0] && h.data.values[0][0];
        if (!v) {
          await api.spreadsheets.values.update({
            spreadsheetId: sheetId, range: `${TAB}!H1`, valueInputOption: 'RAW',
            requestBody: { values: [[HEADERS[7]]] },
          }, opts());
        }
      }
      ensured = true;
    },

    /** All row numbers whose column H equals the submission id (usually 0 or 1). */
    async findRowsById(id, timeoutMs) {
      const opts = budget(timeoutMs);
      const r = await api.spreadsheets.values.get({ spreadsheetId: sheetId, range: `${TAB}!H:H` }, opts());
      const rows = r.data.values || [];
      const out = [];
      for (let i = 0; i < rows.length; i++) if (rows[i] && rows[i][0] === id) out.push(i + 1);
      return out;
    },

    async findRowById(id, timeoutMs) {
      return (await this.findRowsById(id, timeoutMs))[0] || null;
    },

    /** Write a system note into the Status column (used to flag duplicate rows) — only after
     *  confirming the row still holds this submission id (rows may have moved). */
    async markRow(rowNumber, text, id, timeoutMs) {
      const opts = budget(timeoutMs);
      const h = await api.spreadsheets.values.get({ spreadsheetId: sheetId, range: `${TAB}!H${rowNumber}` }, opts());
      const v = h.data.values && h.data.values[0] && h.data.values[0][0];
      if (v !== id) return false;
      await api.spreadsheets.values.update({
        spreadsheetId: sheetId, range: `${TAB}!E${rowNumber}`, valueInputOption: 'RAW',
        requestBody: { values: [[text]] },
      }, opts());
    },

    async appendRow(row, timeoutMs) {
      const opts = budget(timeoutMs);
      const r = await api.spreadsheets.values.append({
        spreadsheetId: sheetId, range: `${TAB}!A:H`,
        valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [row] },
      }, opts());
      const m = /![A-Z]+(\d+)(?::[A-Z]+\d+)?$/.exec((r.data.updates && r.data.updates.updatedRange) || '');
      return m ? Number(m[1]) : null;
    },

    /** Status is written only after confirming the row still holds this submission id. */
    async setStatus(rowNumber, text, id, timeoutMs) {
      const end = Date.now() + (timeoutMs || MAX_TIMEOUT_MS);
      const opts = budget(timeoutMs);
      let row = rowNumber;
      const h = await api.spreadsheets.values.get({ spreadsheetId: sheetId, range: `${TAB}!H${row}` }, opts());
      const v = h.data.values && h.data.values[0] && h.data.values[0][0];
      if (v !== id) row = await this.findRowById(id, end - Date.now());
      if (!row) return null;
      await api.spreadsheets.values.update({
        spreadsheetId: sheetId, range: `${TAB}!E${row}`, valueInputOption: 'RAW',
        requestBody: { values: [[text]] },
      }, opts());
      return row;
    },
  };
}
